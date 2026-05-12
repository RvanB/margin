import { Book } from "../model/Book.js";
import { Page, normalizeContentAlignX, normalizeContentAlignY, normalizeFitAxis } from "../model/Page.js";
import { applyPaperPreset, getPaperPresetIdForColor, getPaperPresetOptions, normalizePaperPreset } from "../model/paper.js";
import { buildGpuEffectConfig, buildPipeline, effectKey } from "../effects/pipeline.js";
import { downscaleCanvasToMaxEdgeSync } from "../loading/downscaleCanvas.js";
import { loadImageFile, loadImagePreview } from "../loading/imageLoader.js";
import { LazyPageLoader } from "../loading/LazyPageLoader.js";
import { getPdfPageAspectRatio, getPdfPageRasterSourceInfo, loadPdfDocument, renderPdfPage } from "../loading/pdfLoader.js";
import { SHARED_PREVIEW_SIZE } from "../previewSizing.js";
import { computeMargins, computeScale, getPageGeometry } from "../rendering/layout.js";
import { CROP_HANDLE_LEN, CROP_HANDLE_PAD, CROP_HANDLE_THICK } from "../rendering/primitives.js";
import { renderOverlay } from "../rendering/OverlayRenderer.js";
import { SpreadRenderer } from "../rendering/SpreadRenderer.js";
import { PageStrip } from "./PageStrip.js";

function cloneSet(set) {
  return new Set([...set]);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isProjectJsonFile(file) {
  return !!file && (
    file.type === "application/json"
    || file.name.toLowerCase().endsWith(".json")
  );
}

function isZipFile(file) {
  return !!file && (
    file.type === "application/zip"
    || file.type === "application/x-zip-compressed"
    || file.name.toLowerCase().endsWith(".zip")
  );
}

function inferMimeTypeFromName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  return "";
}

function shouldImportZipEntry(name) {
  const normalized = String(name || "").replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length) return false;
  if (segments.some(segment => segment.startsWith(".") || segment.startsWith("_"))) return false;
  return true;
}

function getZipEntryFileName(name) {
  const normalized = String(name || "").replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] || normalized;
}

function normalizeCrop(crop) {
  return {
    top: Math.max(0, Math.round(parseNumber(crop?.top))),
    left: Math.max(0, Math.round(parseNumber(crop?.left))),
    right: Math.max(0, Math.round(parseNumber(crop?.right))),
    bottom: Math.max(0, Math.round(parseNumber(crop?.bottom))),
  };
}

function canvasToBlob(canvas, type = "image/png") {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("Failed to create image blob"));
    }, type);
  });
}


const CONTENT_ZOOM_MIN = 0.5;
const CONTENT_ZOOM_MAX = 6;
const CONTENT_ZOOM_STEP = 1.25;
const MAX_RENDER_CANVAS_EDGE = 8192;
const INTERACTIVE_PREVIEW_SCALE = 0.25;


export class App {
  constructor(spreadCanvas, overlayCanvas, stripContainer, { rendererClass = SpreadRenderer } = {}) {
    this.spreadCanvas = spreadCanvas;
    this.overlayCanvas = overlayCanvas;
    this.overlayCtx = overlayCanvas.getContext("2d");
    this.canvasWrap = document.getElementById("canvas-wrap");
    this.canvasArea = document.getElementById("canvas-area");
    this.canvasAreaInner = document.getElementById("canvas-area-inner");
    this.canvasStage = document.getElementById("canvas-stage");
    this.toolbar = document.getElementById("toolbar");
    this.modalHost = document.getElementById("app-modal");
    this.book = new Book();
    this.uiState = {
      appMode: "layout",
      currentSpread: 0,
      effectiveSpread: 0,
      editingPageIdx: 0,
      selectedPageIdxs: new Set([0]),
      hoverHandle: null,
      spreadRects: null,
      spreadSideStates: null,
      showMarginArrows: false,
      showLayoutContent: true,
      showCenterLine: true,
      showVdG: false,
    };
    this.layoutControlsState = {
      preserveRatio: false,
      ratioSameAsPage: true,
    };
    this.listeners = [];
    this.dragHandle = null;
    this.contentEffectCaches = new WeakMap();
    this.dirtyPlacedPreviewPageIndexes = new Set();
    this.contentZoom = 1;
    this.renderZoom = 1;
    this.previewRedrawTimer = 0;
    this.interactivePreviewTimer = 0;
    this.exportingPages = false;
    this.exportProgress = { current: 0, total: 0, label: "" };
    this.loadingFiles = false;
    this.loadProgress = { current: 0, total: 0, label: "" };
    this.exportSettings = {
      resolutionMode: "source",
      dpi: 300,
      includePageColor: true,
    };
    this.lastMargins = computeMargins(this.book.layout, 1);
    this.previewLayoutKey = "";
    this.animationCompletionScheduled = false;
    this.animationDirection = 0;
    this.panOrigin = null;
    this.isPanning = false;
    this.pendingCanvasClick = null;
    this.spreadRenderer = new rendererClass(spreadCanvas);
    globalThis.__rendererBackend = this.spreadRenderer.backendName;
    document.documentElement.dataset.rendererBackend = this.spreadRenderer.backendName;
    this.lazyPageLoader = new LazyPageLoader(this.book, pageIndex => this.onPageReady(pageIndex));
    this.pageStrip = new PageStrip(stripContainer, {
      onPageClick: (pageIndex, event) => this.handlePageStripClick(pageIndex, event),
      getEffectEntry: page => this.getEffectEntry(page),
      getDisplay: () => this.book.display,
      getLayout: () => this.book.layout,
    });
  }

  init() {
    this.canvasWrap.dataset.mode = "layout";
    this.mountToolbar("layout");
    this.populatePaperPresetMenu();
    this.applyVdGLayoutValues();
    this.syncBookLayoutFromInputs();
    this.initLayoutListeners();
    this.bindGlobalListeners();
    this.redraw();
  }

  buildProjectData() {
    if (this.uiState.appMode === "layout") this.syncBookLayoutFromInputs();
    return {
      version: 4,
      layout: { ...this.book.layout },
      display: {
        paperPreset: this.book.display.paperPreset,
        contentBlendMode: this.book.display.contentBlendMode,
      },
      layoutControls: { ...this.layoutControlsState },
      pageCount: this.book.pages.length,
      pages: this.book.pages.map(page => ({
        crop: { ...page.crop },
        cropSourceWidth: page.cropSourceWidth,
        cropSourceHeight: page.cropSourceHeight,
        cover: !!page.cover,
        spread: !!page.spread,
        fitAxis: normalizeFitAxis(page.fitAxis),
        contentAlignX: normalizeContentAlignX(page.contentAlignX),
        contentAlignY: normalizeContentAlignY(page.contentAlignY),
      })),
    };
  }

  saveProject() {
    const project = this.buildProjectData();
    const blob = new Blob([`${JSON.stringify(project, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "margins-project.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async handleContentFileInput(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    await this.appendFiles(files);
  }

  getPageSide(pageIndex) {
    return pageIndex % 2 === 1 ? "left" : "right";
  }

  syncExportUI() {
    document.body.dataset.exporting = this.exportingPages ? "true" : "false";
    const overlay = document.getElementById("busy-overlay");
    if (overlay) overlay.hidden = !this.exportingPages;
    const status = document.getElementById("export-status");
    const statusText = document.getElementById("export-status-text");
    const progressFill = document.getElementById("export-progress-fill");
    const showingExportProgress = this.exportingPages;
    const showingLoadProgress = this.loadingFiles && !showingExportProgress;
    if (status) status.hidden = !(showingExportProgress || showingLoadProgress);
    if (statusText) {
      const progressState = showingExportProgress ? this.exportProgress : this.loadProgress;
      const { current, total, label } = progressState;
      statusText.textContent = (showingExportProgress || showingLoadProgress)
        ? `${label}${total > 0 ? ` ${current} / ${total}` : ""}`
        : "";
    }
    if (progressFill) {
      const progressState = showingExportProgress ? this.exportProgress : this.loadProgress;
      const { current, total } = progressState;
      const progress = total > 0 ? (current / total) * 100 : 0;
      progressFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    }
    [
      "load-content-btn",
      "export-pages-btn",
      "save-project-btn",
      "load-project-btn",
      "canvas-zoom-in",
      "canvas-zoom-out",
      "show-layout-content",
      "show-margin-arrows",
      "show-center-line",
      "vdg",
    ].forEach(id => {
      const control = document.getElementById(id);
      if (control) control.disabled = this.exportingPages;
    });
    document.querySelectorAll(".paper-preset-item").forEach(button => {
      button.disabled = this.exportingPages;
    });
    document.querySelectorAll(".mode-menu-item").forEach(button => {
      button.disabled = this.exportingPages;
    });
  }

  setExportProgress(label, current = 0, total = 0) {
    this.exportProgress = { label, current, total };
    this.syncExportUI();
  }

  setLoadProgress(label, current = 0, total = 0) {
    this.loadProgress = { label, current, total };
    this.syncExportUI();
  }

  closeModal() {
    if (!this.modalHost) return;
    if (this.modalHost.open) this.modalHost.close();
    this.modalHost.innerHTML = "";
  }

  showModal({ title, templateId, onOpen = null } = {}) {
    if (!this.modalHost) return null;
    this.closeModal();

    const shellTemplate = document.getElementById("tpl-modal-shell");
    const bodyTemplate = document.getElementById(templateId);
    if (!shellTemplate || !bodyTemplate) return null;

    const shell = shellTemplate.content.firstElementChild.cloneNode(true);
    shell.querySelector(".modal-title").textContent = title || "";
    const content = shell.querySelector(".modal-content");
    content.appendChild(bodyTemplate.content.cloneNode(true));
    this.modalHost.appendChild(shell);

    const controller = new AbortController();
    const { signal } = controller;
    const close = () => this.modalHost?.close();

    shell.querySelectorAll("[data-modal-close]").forEach(button => {
      button.addEventListener("click", close, { signal });
    });
    this.modalHost.addEventListener("click", event => {
      if (event.target === this.modalHost) close();
    }, { signal });
    this.modalHost.addEventListener("close", () => {
      controller.abort();
      this.modalHost.innerHTML = "";
    }, { once: true, signal });
    this.modalHost.showModal();

    onOpen?.({ dialog: this.modalHost, shell, content, signal });
    return { dialog: this.modalHost, shell, content, signal };
  }

  closeOpenMenus() {
    document.querySelectorAll(".menu-dropdown[open], .menu-submenu[open]").forEach(menu => menu.removeAttribute("open"));
  }

  syncMenuState() {
    this.populatePaperPresetMenu();
    const activePaperPreset = normalizePaperPreset(this.book.display.paperPreset);
    document.querySelectorAll(".paper-preset-item").forEach(button => {
      const isActive = button.dataset.paperPreset === activePaperPreset;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
    const showMarginArrows = document.getElementById("show-margin-arrows");
    if (showMarginArrows) showMarginArrows.checked = this.uiState.showMarginArrows;
    const showLayoutContent = document.getElementById("show-layout-content");
    if (showLayoutContent) showLayoutContent.checked = this.uiState.showLayoutContent;
    const showCenterLine = document.getElementById("show-center-line");
    if (showCenterLine) showCenterLine.checked = this.uiState.showCenterLine;
    const vdg = document.getElementById("vdg");
    if (vdg) vdg.checked = this.uiState.showVdG;
    document.querySelectorAll(".mode-menu-item").forEach(button => {
      button.classList.toggle("active", button.dataset.mode === this.uiState.appMode);
    });
  }

  populatePaperPresetMenu() {
    const list = document.getElementById("paper-color-list");
    if (!list || list.children.length) return;
    getPaperPresetOptions().forEach(({ id, label }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu-list-item paper-preset-item";
      button.dataset.paperPreset = id;
      button.textContent = label;
      button.addEventListener("click", () => {
        this.setPaperPreset(id);
        this.closeOpenMenus();
      });
      list.appendChild(button);
    });
  }

  setPaperPreset(presetId) {
    applyPaperPreset(this.book.display, presetId);
    const nextPreviewLayoutKey = this.getPlacedPreviewLayoutKey();
    if (nextPreviewLayoutKey !== this.previewLayoutKey) {
      this.previewLayoutKey = nextPreviewLayoutKey;
      this.refreshAllPlacedPreviews();
    } else {
      this.pageStrip.invalidateAllThumbnails();
    }
    this.syncMenuState();
    this.redraw();
    this.schedulePreviewRedraw();
  }

  getNativeExportScale(page, sourceCanvas, side) {
    const margins = computeMargins(this.book.layout, 1);
    const geometry = getPageGeometry(margins, side, page, 0);
    const rect = geometry.contentRect;
    const crop = page.getCropFor(sourceCanvas);
    const sourceWidth = sourceCanvas.width - crop.left - crop.right;
    const sourceHeight = sourceCanvas.height - crop.top - crop.bottom;
    if (!rect?.w || !rect?.h || sourceWidth <= 0 || sourceHeight <= 0) return 1;
    const minScale = 1 / Math.max(rect.w, rect.h, sourceWidth, sourceHeight, 1);

    if (geometry.contentMode === "fill") {
      return Math.max(minScale, Math.min(sourceWidth / rect.w, sourceHeight / rect.h));
    }
    if (geometry.contentMode === "fit-width") {
      return Math.max(minScale, sourceWidth / rect.w);
    }
    if (geometry.contentMode === "fit-height") {
      return Math.max(minScale, sourceHeight / rect.h);
    }
    return Math.max(minScale, sourceWidth / rect.w, sourceHeight / rect.h);
  }

  getExportScale(page, sourceCanvas, side, settings = this.exportSettings) {
    if (settings?.resolutionMode === "custom") {
      return Math.max(1, parseNumber(settings.dpi, 0));
    }
    return this.getNativeExportScale(page, sourceCanvas, side);
  }

  async getNativeExportSourceCanvas(page) {
    if (page?.source?.type === "image" && page.source.file) {
      return { canvas: await loadImageFile(page.source.file), temporary: true };
    }
    if (page?.source?.type === "pdf" && page.source.pdfDoc && page.source.pageNum) {
      const rasterInfo = await getPdfPageRasterSourceInfo(page.source.pdfDoc, page.source.pageNum);
      return {
        canvas: await renderPdfPage(page.source.pdfDoc, page.source.pageNum, rasterInfo.renderScale),
        temporary: true,
      };
    }
    return { canvas: page?.srcCanvas || page?.previewCanvas || null, temporary: false };
  }

  async getExportPageEffectiveDpiInfo(pageIndex, signal = null) {
    const page = this.book.pages[pageIndex];
    if (!page) return null;
    if (page?.source?.type === "pdf" && page.source.pdfDoc && page.source.pageNum) {
      const rasterInfo = await getPdfPageRasterSourceInfo(page.source.pdfDoc, page.source.pageNum);
      if (signal?.aborted) return null;
      if (!rasterInfo.hasRasterImage) {
        return { pageIndex, kind: "pdf-vector" };
      }
    }
    const side = this.getPageSide(pageIndex);
    const { canvas: sourceCanvas, temporary } = await this.getNativeExportSourceCanvas(page);
    if (!sourceCanvas || signal?.aborted) {
      if (temporary && sourceCanvas) {
        sourceCanvas.width = 0;
        sourceCanvas.height = 0;
      }
      return null;
    }

    try {
      return {
        pageIndex,
        kind: "raster",
        dpi: this.getNativeExportScale(page, sourceCanvas, side),
      };
    } finally {
      if (temporary) {
        sourceCanvas.width = 0;
        sourceCanvas.height = 0;
      }
    }
  }

  formatExportEffectiveDpiLabel(info) {
    if (!info) return "—";
    if (info.kind === "pdf-vector") return `Page ${info.pageIndex + 1} — vector PDF`;
    const dpi = Number(info.dpi.toFixed(info.dpi >= 100 ? 1 : 2));
    return `Page ${info.pageIndex + 1} — ${dpi} DPI`;
  }

  async getExportEffectiveDpiStats(signal = null) {
    const infos = [];
    for (let pageIndex = 0; pageIndex < this.book.pages.length; pageIndex += 1) {
      if (signal?.aborted) return null;
      const info = await this.getExportPageEffectiveDpiInfo(pageIndex, signal);
      if (info?.kind === "raster" && info.dpi > 0) infos.push(info);
    }
    if (!infos.length) return { lowest: null, highest: null };
    return {
      lowest: infos.reduce((lowest, current) => (current.dpi < lowest.dpi ? current : lowest)),
      highest: infos.reduce((highest, current) => (current.dpi > highest.dpi ? current : highest)),
    };
  }

  async showExportModal() {
    if (this.exportingPages) return;
    if (!this.book.pages.length) {
      window.alert("Load pages before exporting.");
      return;
    }

    this.showModal({
      title: "Export pages",
      templateId: "tpl-export-modal",
      onOpen: ({ content, dialog, signal }) => {
        const form = content.querySelector("#export-modal-form");
        const sourceRadio = form?.querySelector('input[name="export-resolution-mode"][value="source"]');
        const customRadio = form?.querySelector('input[name="export-resolution-mode"][value="custom"]');
        const dpiInput = form?.querySelector("#export-dpi");
        const includePageColor = form?.querySelector("#export-include-page-color");
        const lowestDpi = form?.querySelector("#export-lowest-effective-dpi");
        const highestDpi = form?.querySelector("#export-highest-effective-dpi");
        if (!form || !sourceRadio || !customRadio || !dpiInput || !includePageColor) return;

        sourceRadio.checked = this.exportSettings.resolutionMode !== "custom";
        customRadio.checked = this.exportSettings.resolutionMode === "custom";
        dpiInput.value = String(this.exportSettings.dpi);
        includePageColor.checked = this.exportSettings.includePageColor !== false;

        const syncResolutionInputs = () => {
          dpiInput.disabled = !customRadio.checked;
        };

        sourceRadio.addEventListener("change", syncResolutionInputs, { signal });
        customRadio.addEventListener("change", syncResolutionInputs, { signal });
        syncResolutionInputs();

        form.addEventListener("submit", async event => {
          event.preventDefault();
          const resolutionMode = customRadio.checked ? "custom" : "source";
          const dpi = Math.round(parseNumber(dpiInput.value, 0));
          if (resolutionMode === "custom" && dpi <= 0) {
            window.alert("Enter a DPI greater than 0.");
            dpiInput.focus();
            return;
          }

          this.exportSettings = {
            resolutionMode,
            dpi: resolutionMode === "custom" ? dpi : this.exportSettings.dpi,
            includePageColor: includePageColor.checked,
          };
          dialog.close();
          await this.exportAllPagesNative(this.exportSettings);
        }, { signal });

        this.getExportEffectiveDpiStats(signal).then(stats => {
          if (signal.aborted || !stats) return;
          if (lowestDpi) lowestDpi.textContent = this.formatExportEffectiveDpiLabel(stats.lowest);
          if (highestDpi) highestDpi.textContent = this.formatExportEffectiveDpiLabel(stats.highest);
        });
      },
    });
  }

  async renderNativeExportPage(pageIndex, settings = this.exportSettings) {
    const page = this.book.pages[pageIndex];
    if (!page) return null;
    const side = this.getPageSide(pageIndex);
    const { canvas: sourceCanvas, temporary } = await this.getNativeExportSourceCanvas(page);
    if (!sourceCanvas) return null;

    try {
      const exportScale = this.getExportScale(page, sourceCanvas, side, settings);
      const margins = computeMargins(this.book.layout, exportScale);
      const previewRenderer = typeof this.spreadRenderer.getPlacedPagePreview === "function"
        ? this.spreadRenderer
        : new SpreadRenderer(document.createElement("canvas"));
      return previewRenderer.getPlacedPagePreview(
        page,
        this.getEffectEntry(page),
        this.book.display,
        {
          sourceCanvas,
          layout: this.book.layout,
          side,
          pageHeight: margins.pagePxH,
          includePageColor: settings?.includePageColor !== false,
        }
      );
    } finally {
      if (temporary) {
        sourceCanvas.width = 0;
        sourceCanvas.height = 0;
      }
    }
  }

  async writeExportBlob(handle, name, blob) {
    const fileHandle = await handle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  downloadExportBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async exportAllPagesNative(settings = this.exportSettings) {
    if (this.exportingPages) return;
    if (!this.book.pages.length) {
      window.alert("Load pages before exporting.");
      return;
    }

    this.closeModal();
    this.exportingPages = true;
    this.setExportProgress("Preparing export", 0, this.book.pages.length);
    try {
      let directoryHandle = null;
      const zip = typeof globalThis.JSZip === "function" ? new globalThis.JSZip() : null;
      if (typeof globalThis.showDirectoryPicker === "function") {
        try {
          this.setExportProgress("Choose export folder", 0, this.book.pages.length);
          directoryHandle = await globalThis.showDirectoryPicker({ mode: "readwrite" });
        } catch (error) {
          if (error?.name === "AbortError") return;
          console.error("Directory picker failed:", error);
        }
      }

      for (let pageIndex = 0; pageIndex < this.book.pages.length; pageIndex += 1) {
        this.setExportProgress("Rendering page", pageIndex, this.book.pages.length);
        const exportCanvas = await this.renderNativeExportPage(pageIndex, settings);
        if (!exportCanvas) continue;
        try {
          const blob = await canvasToBlob(exportCanvas);
          const fileName = `page-${String(pageIndex + 1).padStart(4, "0")}.png`;
          if (directoryHandle) {
            this.setExportProgress("Writing page", pageIndex + 1, this.book.pages.length);
            await this.writeExportBlob(directoryHandle, fileName, blob);
          } else {
            if (!zip) throw new Error("JSZip unavailable");
            zip.file(fileName, blob);
            this.setExportProgress("Adding to ZIP", pageIndex + 1, this.book.pages.length);
          }
        } finally {
          exportCanvas.width = 0;
          exportCanvas.height = 0;
        }
      }

      if (!directoryHandle && zip) {
        this.setExportProgress("Building ZIP", this.book.pages.length, this.book.pages.length);
        const zipBlob = await zip.generateAsync({ type: "blob" });
        this.setExportProgress("Downloading ZIP", this.book.pages.length, this.book.pages.length);
        this.downloadExportBlob("pages.zip", zipBlob);
      }
    } catch (error) {
      console.error("Failed to export pages:", error);
      window.alert("Could not export pages.");
    } finally {
      this.exportingPages = false;
      this.setExportProgress("", 0, 0);
    }
  }

  async handleProjectFileInput(event) {
    const file = event.target.files?.[0] || null;
    event.target.value = "";
    if (!file) return;
    await this.loadProjectFile(file);
  }

  async loadProjectFile(file) {
    if (!file) return false;
    try {
      this.applyProjectData(JSON.parse(await file.text()));
      return true;
    } catch (error) {
      console.error("Failed to load project:", error);
      window.alert("Could not load project JSON.");
      return false;
    }
  }

  async expandImportFiles(files) {
    const expandedFiles = [];

    for (const file of Array.from(files)) {
      if (!isZipFile(file)) {
        expandedFiles.push(file);
        continue;
      }

      if (typeof globalThis.JSZip !== "function") {
        console.error("JSZip unavailable for ZIP import");
        window.alert(`Could not read "${file.name}".`);
        continue;
      }

      try {
        const zip = await globalThis.JSZip.loadAsync(await file.arrayBuffer());
        const entries = [];
        zip.forEach((_, entry) => {
          if (!entry.dir && shouldImportZipEntry(entry.name)) entries.push(entry);
        });

        for (const entry of entries) {
          const blob = await entry.async("blob");
          const fileName = getZipEntryFileName(entry.name);
          expandedFiles.push(new File(
            [blob],
            fileName,
            { type: blob.type || inferMimeTypeFromName(fileName) }
          ));
        }
      } catch (error) {
        console.error("Failed to read ZIP file:", error);
        window.alert(`Could not read "${file.name}".`);
      }
    }

    return expandedFiles;
  }

  applyProjectPageState(page, pageState) {
    if (!page || !pageState || typeof pageState !== "object") return;
    page.crop = normalizeCrop(pageState.crop);
    page.cropSourceWidth = Math.max(0, Math.round(parseNumber(pageState.cropSourceWidth)));
    page.cropSourceHeight = Math.max(0, Math.round(parseNumber(pageState.cropSourceHeight)));
    page.cover = !!pageState.cover;
    page.spread = !!pageState.spread;
    page.fitAxis = normalizeFitAxis(pageState.fitAxis);
    page.contentAlignX = normalizeContentAlignX(pageState.contentAlignX);
    page.contentAlignY = normalizeContentAlignY(pageState.contentAlignY);
    this.markPlacedPreviewDirty(page);
  }

  applyProjectData(project) {
    if (!project || typeof project !== "object") {
      throw new Error("Invalid project data");
    }

    if (this.uiState.appMode === "content") this.flushDirtyPlacedPreviews();
    this.endInteractiveContentPreview({ redraw: false });
    this.spreadRenderer.stopAnimation();
    this.animationCompletionScheduled = false;
    this.animationDirection = 0;
    this.contentEffectCaches = new WeakMap();
    this.overlayCanvas.style.visibility = "";

    const layout = project.layout && typeof project.layout === "object" ? project.layout : {};
    this.book.layout.pw = finiteNumber(parseNumber(layout.pw, this.book.layout.pw), this.book.layout.pw);
    this.book.layout.ph = finiteNumber(parseNumber(layout.ph, this.book.layout.ph), this.book.layout.ph);
    this.book.layout.ratio = finiteNumber(parseNumber(layout.ratio, this.book.layout.ratio), this.book.layout.ratio);
    this.book.layout.b = finiteNumber(parseNumber(layout.b, this.book.layout.b), this.book.layout.b);
    this.book.layout.mInner = finiteNumber(parseNumber(layout.mInner, this.book.layout.mInner), this.book.layout.mInner);
    this.book.layout.mTop = finiteNumber(parseNumber(layout.mTop, this.book.layout.mTop), this.book.layout.mTop);
    this.book.layout.mBottom = finiteNumber(parseNumber(layout.mBottom, this.book.layout.mBottom), this.book.layout.mBottom);

    const layoutControls = project.layoutControls && typeof project.layoutControls === "object"
      ? project.layoutControls
      : {};
    this.layoutControlsState = {
      preserveRatio: !!layoutControls.preserveRatio,
      ratioSameAsPage: "ratioSameAsPage" in layoutControls
        ? !!layoutControls.ratioSameAsPage
        : this.layoutControlsState.ratioSameAsPage,
    };
    const display = project.display && typeof project.display === "object"
      ? project.display
      : {};
    if (typeof display.contentBlendMode === "string" && display.contentBlendMode) {
      this.book.display.contentBlendMode = display.contentBlendMode;
    }
    if ("paperPreset" in display || "paperColor" in display) {
      const presetId = "paperPreset" in display
        ? normalizePaperPreset(display.paperPreset)
        : getPaperPresetIdForColor(display.paperColor);
      applyPaperPreset(this.book.display, presetId);
    }

    const pageStates = Array.isArray(project.pages) ? project.pages : [];
    const appliedPageCount = Math.min(this.book.pages.length, pageStates.length);
    for (let pageIndex = 0; pageIndex < appliedPageCount; pageIndex += 1) {
      this.applyProjectPageState(this.book.pages[pageIndex], pageStates[pageIndex]);
    }

    const maxSpread = Math.max(0, this.book.numSpreads() - 1);
    this.uiState.currentSpread = clamp(this.uiState.currentSpread, 0, maxSpread);
    this.uiState.effectiveSpread = this.uiState.currentSpread;
    this.uiState.editingPageIdx = this.book.pages.length
      ? clamp(this.uiState.editingPageIdx, 0, this.book.pages.length - 1)
      : 0;
    this.uiState.selectedPageIdxs = new Set(
      [...this.uiState.selectedPageIdxs].filter(index => index >= 0 && index < this.book.pages.length)
    );
    if (!this.uiState.selectedPageIdxs.size && this.book.pages.length) {
      this.uiState.selectedPageIdxs = new Set([this.uiState.editingPageIdx]);
    }

    this.previewLayoutKey = this.getPlacedPreviewLayoutKey();
    this.pageStrip.invalidateAllThumbnails();
    this.refreshAllPlacedPreviews();
    this.lazyPageLoader.reset();
    if (this.book.pages.length) {
      this.lazyPageLoader.ensureSpreadLoaded(this.uiState.currentSpread, 1, { allowHighRes: false });
      this.lazyPageLoader.warmAllPreviews();
    }

    this.syncMenuState();
    if (this.uiState.appMode === "layout") this.restoreLayoutInputs();
    else this.syncPageUI();
    this.redraw();
    this.schedulePreviewRedraw();
  }

  mountToolbar(mode) {
    const template = document.getElementById(`tpl-${mode}`);
    this.toolbar.innerHTML = "";
    this.toolbar.appendChild(template.content.cloneNode(true));
    globalThis.htmx?.process(this.toolbar);
    this.syncMenuState();
  }

  addListener(elOrId, type, fn) {
    const el = typeof elOrId === "string" ? document.getElementById(elOrId) : elOrId;
    if (!el) return;
    el.addEventListener(type, fn);
    this.listeners.push({ el, type, fn });
  }

  clearListeners() {
    for (const { el, type, fn } of this.listeners) {
      el.removeEventListener(type, fn);
    }
    this.listeners = [];
  }

  getToolbarControl(id) {
    return this.toolbar?.querySelector(`#${id}`) || document.getElementById(id);
  }

  getEffectiveContentAlignX(page) {
    if (!page) return "center";
    if (page.contentAlignX) return page.contentAlignX;
    const pageIndex = this.book.pages.indexOf(page);
    const side = this.getPageSide(pageIndex);
    return page.spread && !page.cover
      ? (side === "left" ? "right" : "left")
      : "center";
  }

  getEffectiveContentAlignY(page) {
    return page?.contentAlignY || "center";
  }

  markPlacedPreviewDirty(pageOrIndex) {
    const pageIndex = typeof pageOrIndex === "number"
      ? pageOrIndex
      : this.book.pages.indexOf(pageOrIndex);
    if (pageIndex < 0) return;
    this.dirtyPlacedPreviewPageIndexes.add(pageIndex);
  }

  flushDirtyPlacedPreviews() {
    if (!this.dirtyPlacedPreviewPageIndexes.size) return;
    const dirtyPageIndexes = [...this.dirtyPlacedPreviewPageIndexes];
    this.dirtyPlacedPreviewPageIndexes.clear();
    dirtyPageIndexes.forEach(pageIndex => this.refreshPlacedPreview(pageIndex));
  }

  getSelectedPages() {
    if (!this.uiState.selectedPageIdxs.size) {
      return [this.book.pages[this.uiState.editingPageIdx]].filter(Boolean);
    }
    return [...this.uiState.selectedPageIdxs]
      .map(index => this.book.pages[index])
      .filter(Boolean);
  }

  getEditingPage() {
    return this.book.pages[this.uiState.editingPageIdx] ?? null;
  }

  getInteractivePreviewCanvas(page) {
    if (!page) return null;
    if (!page.srcCanvas) return page.previewCanvas || null;
    const targetMaxEdge = Math.max(1, Math.round(Math.max(page.srcCanvas.width, page.srcCanvas.height) * INTERACTIVE_PREVIEW_SCALE));
    if (
      page.interactivePreviewCanvas &&
      page.interactivePreviewSourceCanvas === page.srcCanvas &&
      page.interactivePreviewMaxEdge === targetMaxEdge
    ) {
      return page.interactivePreviewCanvas;
    }
    const interactiveCanvas = downscaleCanvasToMaxEdgeSync(page.srcCanvas, targetMaxEdge) || page.previewCanvas || page.srcCanvas;
    page.interactivePreviewCanvas = interactiveCanvas;
    page.interactivePreviewSourceCanvas = page.srcCanvas;
    page.interactivePreviewMaxEdge = targetMaxEdge;
    return interactiveCanvas;
  }

  beginInteractiveContentPreview(pages = this.getSelectedPages(), delay = 120) {
    let activated = false;
    for (const page of pages) {
      const interactiveCanvas = this.getInteractivePreviewCanvas(page);
      if (!interactiveCanvas) continue;
      if (page.displayCanvasOverride === interactiveCanvas) continue;
      page.displayCanvasOverride = interactiveCanvas;
      activated = true;
    }
    if (!activated && !this.interactivePreviewTimer) return;
    if (this.interactivePreviewTimer) clearTimeout(this.interactivePreviewTimer);
    this.interactivePreviewTimer = setTimeout(() => {
      this.interactivePreviewTimer = 0;
      this.endInteractiveContentPreview();
    }, delay);
  }

  endInteractiveContentPreview({ redraw = true } = {}) {
    if (this.interactivePreviewTimer) {
      clearTimeout(this.interactivePreviewTimer);
      this.interactivePreviewTimer = 0;
    }
    let changed = false;
    for (const page of this.book.pages) {
      if (!page?.displayCanvasOverride) continue;
      page.displayCanvasOverride = null;
      changed = true;
    }
    if (changed && redraw) this.redraw();
  }

  getEffectEntry(page) {
    if (!page) return { pipeline: [], key: "" };
    return {
      pipeline: buildPipeline(),
      key: effectKey(),
      gpu: buildGpuEffectConfig(),
      layerCache: this.uiState.appMode === "content" ? this.getContentEffectLayerCache(page) : null,
    };
  }

  getEffectiveSpread() {
    return this.spreadRenderer.isAnimating ? this.uiState.effectiveSpread : this.uiState.currentSpread;
  }

  redraw() {
    globalThis.__rendererBackend = this.spreadRenderer.backendName;
    document.documentElement.dataset.rendererBackend = this.spreadRenderer.backendName;

    if (this.uiState.appMode === "layout") {
      this.syncBookLayoutFromInputs();
    }

    const scale = this.getRenderScale();
    const margins = computeMargins(this.book.layout, scale);
    this.lastMargins = margins;
    this.uiState.currentSpread = Math.min(this.uiState.currentSpread, this.book.numSpreads() - 1);
    this.uiState.effectiveSpread = this.getEffectiveSpread();
    this.updateComputedRows(margins);
    this.setCanvasCursor(this.dragHandle ? this.cursorForEdge(this.dragHandle.edge) : "default");

    if (
      this.book.pages.length &&
      (this.uiState.appMode === "content" || this.uiState.showLayoutContent)
    ) {
      this.lazyPageLoader.ensureSpreadLoaded(this.uiState.currentSpread, 1, { allowHighRes: false });
    }

    const spreadPages = this.getRenderableSpreadPages(this.uiState.currentSpread);

    const renderResult = this.spreadRenderer.render(
      spreadPages,
      margins,
      {
        left: spreadPages?.left?.page ? this.getEffectEntry(spreadPages.left.page) : { pipeline: [], key: "" },
        right: spreadPages?.right?.page ? this.getEffectEntry(spreadPages.right.page) : { pipeline: [], key: "" },
      },
      this.book.display,
      {
        showPlaceholder: this.shouldShowPlaceholder(),
        previewZoom: this.renderZoom,
        showCenterLine: this.uiState.showCenterLine,
      }
    );

    this.overlayCanvas.width = this.spreadCanvas.width;
    this.overlayCanvas.height = this.spreadCanvas.height;
    this.uiState.spreadSideStates = renderResult.sideStates;
    this.uiState.spreadRects = this.shouldExposeSpreadRects() ? renderResult.spreadRects : null;
    this.syncCanvasStage();

    if (!this.spreadRenderer.isAnimating) {
      renderOverlay(this.overlayCtx, margins, this.uiState);
    }

    this.pageStrip.update(this.book, {
      ...this.uiState,
      selectedPageIdxs: cloneSet(this.uiState.selectedPageIdxs),
      effectiveSpread: this.getEffectiveSpread(),
    }, this.spreadRenderer);
  }

  shouldExposeSpreadRects() {
    if (!this.book.pages.length) return false;
    if (this.uiState.appMode === "content") return true;
    return this.uiState.showLayoutContent;
  }

  shouldShowPlaceholder() {
    return this.uiState.appMode === "layout" && !this.book.pages.length && this.uiState.showLayoutContent;
  }

  getRenderableSpreadPages(spreadIndex) {
    if (this.uiState.appMode === "layout" && (!this.uiState.showLayoutContent || !this.book.pages.length)) {
      return null;
    }
    return this.book.spreadPageEntries(spreadIndex);
  }

  updateComputedRows(margins) {
    const bValue = document.getElementById("b-val");
    if (bValue) bValue.textContent = `${margins.b.toFixed(2)}″`;
    this.setComputed("c-inner", `${margins.inner.toFixed(3)}″`);
    this.setComputed("c-top", `${margins.top.toFixed(3)}″`);
    this.setComputed("c-outer", margins.ok ? `${margins.outer.toFixed(3)}″` : "invalid", !margins.ok);
    this.setComputed("c-bottom", `${margins.bottom.toFixed(3)}″`);
    this.setComputed("c-tw", margins.ok ? `${margins.tw.toFixed(3)}″` : "invalid", !margins.ok);
    this.setComputed("c-th", margins.ok ? `${margins.th.toFixed(3)}″` : "invalid", !margins.ok);
  }

  setComputed(id, value, warn = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value;
    const row = el.closest(".computed-row");
    row?.classList.toggle("warn", !!warn);
  }

  syncInputs() {
    const ratioInput = document.getElementById("ratio");
    const sameAsPage = document.getElementById("ratio-same-as-page")?.checked;
    if (ratioInput) ratioInput.disabled = !!sameAsPage;
    if (sameAsPage && ratioInput) ratioInput.value = (this.getNumber("pw") / this.getNumber("ph")).toFixed(3);
  }

  syncBookLayoutFromInputs() {
    this.syncInputs();
    this.book.layout.pw = this.getNumber("pw");
    this.book.layout.ph = this.getNumber("ph");
    this.book.layout.ratio = this.getNumber("ratio");
    this.book.layout.b = this.getNumber("b-slider");
    this.book.layout.mInner = this.getNumber("m-inner");
    this.book.layout.mTop = this.getNumber("m-top");
    this.book.layout.mBottom = this.getNumber("m-bottom");
    this.layoutControlsState.preserveRatio = !!document.getElementById("preserve-ratio")?.checked;
    this.layoutControlsState.ratioSameAsPage = !!document.getElementById("ratio-same-as-page")?.checked;
    this.uiState.showVdG = !!document.getElementById("vdg")?.checked;
    const nextPreviewLayoutKey = this.getPlacedPreviewLayoutKey();
    if (nextPreviewLayoutKey !== this.previewLayoutKey) {
      this.previewLayoutKey = nextPreviewLayoutKey;
      this.refreshAllPlacedPreviews();
    }
  }

  restoreLayoutInputs() {
    const setValue = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value;
    };
    setValue("pw", this.book.layout.pw);
    setValue("ph", this.book.layout.ph);
    setValue("page-ratio", (this.book.layout.pw / this.book.layout.ph).toFixed(3));
    setValue("ratio", this.book.layout.ratio);
    setValue("b-slider", this.book.layout.b);
    setValue("m-inner", this.book.layout.mInner);
    setValue("m-top", this.book.layout.mTop);
    setValue("m-bottom", this.book.layout.mBottom);
    const preserveRatio = document.getElementById("preserve-ratio");
    if (preserveRatio) preserveRatio.checked = this.layoutControlsState.preserveRatio;
    const ratioSameAsPage = document.getElementById("ratio-same-as-page");
    if (ratioSameAsPage) ratioSameAsPage.checked = this.layoutControlsState.ratioSameAsPage;
    const showMarginArrows = document.getElementById("show-margin-arrows");
    if (showMarginArrows) showMarginArrows.checked = this.uiState.showMarginArrows;
    const showLayoutContent = document.getElementById("show-layout-content");
    if (showLayoutContent) showLayoutContent.checked = this.uiState.showLayoutContent;
    const showCenterLine = document.getElementById("show-center-line");
    if (showCenterLine) showCenterLine.checked = this.uiState.showCenterLine;
    const vdg = document.getElementById("vdg");
    if (vdg) vdg.checked = this.uiState.showVdG;
    this.syncInputs();
    this.syncMenuState();
  }

  applyVdGLayoutValues() {
    const pageWidth = this.getNumber("pw") || 5.5;
    const pageHeight = this.getNumber("ph") || 8.5;
    const b = pageWidth / 9;
    const setValue = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value;
    };
    setValue("b-slider", b.toFixed(3));
    setValue("m-inner", "1");
    setValue("m-top", (pageHeight / pageWidth).toFixed(3));
    setValue("m-bottom", (2 * pageHeight / pageWidth).toFixed(3));
    setValue("ratio", (pageWidth / pageHeight).toFixed(3));
    const ratioSameAsPage = document.getElementById("ratio-same-as-page");
    if (ratioSameAsPage) ratioSameAsPage.checked = true;
  }

  initLayoutListeners() {
    this.addListener("page-ratio", "change", event => {
      const ratio = parseFloat(event.target.value);
      if (!ratio || ratio <= 0) return;
      const pw = this.getNumber("pw");
      const ph = this.getNumber("ph");
      if (ratio < pw / ph) {
        document.getElementById("pw").value = (ph * ratio).toFixed(3);
      } else {
        document.getElementById("ph").value = (pw / ratio).toFixed(3);
      }
      this.redraw();
    });

    this.addListener("pw", "input", () => {
      const pw = this.getNumber("pw");
      if (document.getElementById("preserve-ratio")?.checked) {
        const ratio = parseFloat(document.getElementById("page-ratio")?.value);
        if (ratio) document.getElementById("ph").value = (pw / ratio).toFixed(3);
      } else {
        document.getElementById("page-ratio").value = (pw / this.getNumber("ph")).toFixed(3);
      }
      this.redraw();
    });

    this.addListener("ph", "input", () => {
      const ph = this.getNumber("ph");
      if (document.getElementById("preserve-ratio")?.checked) {
        const ratio = parseFloat(document.getElementById("page-ratio")?.value);
        if (ratio) document.getElementById("pw").value = (ph * ratio).toFixed(3);
      } else {
        document.getElementById("page-ratio").value = (this.getNumber("pw") / ph).toFixed(3);
      }
      this.redraw();
    });

    ["ratio", "m-inner", "m-top", "m-bottom"].forEach(id => this.addListener(id, "input", () => this.redraw()));
    this.addListener("b-slider", "input", () => this.redraw());
    this.addListener("ratio-same-as-page", "change", () => this.redraw());
    this.addListener("preserve-ratio", "change", () => this.redraw());
    this.addListener("vdg-snap", "click", () => {
      this.applyVdGLayoutValues();
      this.redraw();
    });
    this.addListener("print-btn", "click", () => this.printCurrentSpread());
  }

  initContentListeners() {
    this.addListener("cover-check", "change", event => {
      for (const page of this.getSelectedPages()) page.cover = event.target.checked;
      this.refreshAffectedThumbnails(this.getSelectedPages());
      this.syncPageUI();
      this.redraw();
    });

    this.addListener("spread-check", "change", event => {
      for (const page of this.getSelectedPages()) page.spread = event.target.checked;
      this.refreshAffectedThumbnails(this.getSelectedPages());
      this.syncPageUI();
      this.redraw();
    });

    this.addListener("content-align-x", "change", event => {
      const value = normalizeContentAlignX(event.target.value);
      for (const page of this.getSelectedPages()) page.contentAlignX = value;
      this.refreshAffectedThumbnails(this.getSelectedPages());
      this.syncPageUI();
      this.redraw();
    });

    this.addListener("content-align-y", "change", event => {
      const value = normalizeContentAlignY(event.target.value);
      for (const page of this.getSelectedPages()) page.contentAlignY = value;
      this.refreshAffectedThumbnails(this.getSelectedPages());
      this.syncPageUI();
      this.redraw();
    });

    if (this.book.pages.length) this.syncPageUI();
  }

  refreshAffectedThumbnails(pages) {
    for (const page of pages) this.markPlacedPreviewDirty(page);
  }

  getPlacedPreviewLayoutKey() {
    const { layout, display } = this.book;
    return [
      layout.pw,
      layout.ph,
      layout.ratio,
      layout.b,
      layout.mInner,
      layout.mTop,
      layout.mBottom,
      display.paperColor,
      display.contentBlendMode,
    ].join("|");
  }

  refreshPlacedPreview(pageOrIndex) {
    const pageIndex = typeof pageOrIndex === "number"
      ? pageOrIndex
      : this.book.pages.indexOf(pageOrIndex);
    const page = this.book.pages[pageIndex];
    if (!page) return;
    const sourceCanvas = page.previewCanvas || page.thumbnailSourceCanvas || null;
    if (!sourceCanvas) {
      page.placedPreviewCanvas = null;
      this.pageStrip.invalidateThumbnail(page);
      return;
    }
    const previewRenderer = typeof this.spreadRenderer.getPlacedPagePreview === "function"
      ? this.spreadRenderer
      : new SpreadRenderer(document.createElement("canvas"));
    page.placedPreviewCanvas = previewRenderer.getPlacedPagePreview(
      page,
      this.getEffectEntry(page),
      this.book.display,
      {
        sourceCanvas,
        layout: this.book.layout,
        side: pageIndex % 2 === 1 ? "left" : "right",
        pageHeight: SHARED_PREVIEW_SIZE,
      }
    );
    this.dirtyPlacedPreviewPageIndexes.delete(pageIndex);
    this.pageStrip.invalidateThumbnail(page);
  }

  refreshAllPlacedPreviews() {
    this.book.pages.forEach((_, pageIndex) => this.refreshPlacedPreview(pageIndex));
    this.pageStrip.invalidateAllThumbnails();
  }

  syncPageUI() {
    const section = this.getToolbarControl("toolbar");
    if (section) section.style.display = "";
    if (!this.getEditingPage()) return;
    const selectedPages = this.getSelectedPages();
    const syncToggle = (id, key) => {
      const input = this.getToolbarControl(id);
      if (!input) return;
      const allEnabled = selectedPages.every(selectedPage => !!selectedPage?.[key]);
      const allDisabled = selectedPages.every(selectedPage => !selectedPage?.[key]);
      input.checked = allEnabled;
      input.indeterminate = !allEnabled && !allDisabled;
    };

    syncToggle("cover-check", "cover");
    syncToggle("spread-check", "spread");
    const syncSelect = (id, getter) => {
      const input = this.getToolbarControl(id);
      if (!input) return;
      const values = selectedPages.map(getter);
      const first = values[0] || "";
      input.value = values.every(value => value === first) ? first : "";
    };
    syncSelect("content-align-x", page => this.getEffectiveContentAlignX(page));
    syncSelect("content-align-y", page => this.getEffectiveContentAlignY(page));
    const selectionCount = this.getToolbarControl("selection-count");
    if (selectionCount) {
      const count = this.uiState.selectedPageIdxs.size;
      selectionCount.textContent = count > 1 ? `${count} pages` : "";
    }
  }

  getContentEffectLayerCache(page) {
    const sourceCanvas = page?.displayCanvas;
    let cached = this.contentEffectCaches.get(page);
    if (!cached || cached.srcCanvas !== sourceCanvas) {
      cached = {
        srcCanvas: sourceCanvas,
        variants: new Map(),
      };
      this.contentEffectCaches.set(page, cached);
    }
    return cached.variants;
  }

  handlePageStripClick(pageIndex, event) {
    const targetSpread = Math.floor((pageIndex + 1) / 2);
    if (this.uiState.appMode === "content") {
      if (event.metaKey || event.ctrlKey) {
        this.endInteractiveContentPreview({ redraw: false });
        this.flushDirtyPlacedPreviews();
        if (this.uiState.selectedPageIdxs.has(pageIndex)) {
          this.uiState.selectedPageIdxs.delete(pageIndex);
          if (this.uiState.editingPageIdx === pageIndex) {
            const last = [...this.uiState.selectedPageIdxs].pop();
            if (last !== undefined) this.uiState.editingPageIdx = last;
          }
        } else {
          this.uiState.selectedPageIdxs.add(pageIndex);
          this.uiState.editingPageIdx = pageIndex;
        }
        this.syncPageUI();
        this.redraw();
        return;
      }

      if (event.shiftKey) {
        this.endInteractiveContentPreview({ redraw: false });
        this.flushDirtyPlacedPreviews();
        const from = Math.min(this.uiState.editingPageIdx, pageIndex);
        const to = Math.max(this.uiState.editingPageIdx, pageIndex);
        for (let i = from; i <= to; i += 1) this.uiState.selectedPageIdxs.add(i);
        this.uiState.editingPageIdx = pageIndex;
        this.syncPageUI();
        this.redraw();
        return;
      }

      this.endInteractiveContentPreview({ redraw: false });
      this.flushDirtyPlacedPreviews();
      this.uiState.editingPageIdx = pageIndex;
      this.uiState.selectedPageIdxs = new Set([pageIndex]);
      this.syncPageUI();
      if (targetSpread === this.getEffectiveSpread()) {
        this.redraw();
        return;
      }
    }

    this.navigateTo(targetSpread, pageIndex);
  }

  selectSpreadPage(spreadIndex, preferredPageIndex = null) {
    if (this.uiState.appMode !== "content" || !this.book.pages.length) return;
    const { left, right } = this.book.spreadPageEntries(spreadIndex);
    const spreadPageIndexes = [left.pageIndex, right.pageIndex].filter(index => index >= 0);
    const pageIndex = spreadPageIndexes.includes(preferredPageIndex)
      ? preferredPageIndex
      : (left.pageIndex >= 0 ? left.pageIndex : right.pageIndex);
    if (pageIndex < 0 || pageIndex >= this.book.pages.length) return;
    this.endInteractiveContentPreview({ redraw: false });
    this.flushDirtyPlacedPreviews();
    this.uiState.editingPageIdx = pageIndex;
    this.uiState.selectedPageIdxs = new Set([pageIndex]);
    this.syncPageUI();
  }

  navigateTo(targetSpread, preferredPageIndex = null) {
    const clampedTarget = Math.max(0, Math.min(targetSpread, this.book.numSpreads() - 1));
    if (clampedTarget === this.getEffectiveSpread()) return;

    this.endInteractiveContentPreview({ redraw: false });
    this.lazyPageLoader.ensureSpreadLoaded(clampedTarget, 1, { allowHighRes: false });
    this.selectSpreadPage(clampedTarget, preferredPageIndex);

    if (!this.lastMargins || !this.book.pages.length) {
      this.uiState.currentSpread = clampedTarget;
      this.uiState.effectiveSpread = clampedTarget;
      this.animationDirection = 0;
      this.spreadRenderer.stopAnimation();
      this.animationCompletionScheduled = false;
      this.overlayCanvas.style.visibility = "";
      this.redraw();
      return;
    }

    const fromSpread = this.getEffectiveSpread();
    const direction = clampedTarget > fromSpread ? 1 : -1;
    if (this.spreadRenderer.isAnimating && this.animationDirection && direction !== this.animationDirection) return;

    this.uiState.effectiveSpread = clampedTarget;
    this.animationDirection = direction;
    const fromCanvas = this.createSpreadSnapshot(fromSpread);
    const toCanvas = this.createSpreadSnapshot(clampedTarget);
    this.overlayCanvas.style.visibility = "hidden";

    const onDone = this.animationCompletionScheduled
      ? null
      : () => {
          this.animationCompletionScheduled = false;
          this.animationDirection = 0;
          this.uiState.currentSpread = this.uiState.effectiveSpread;
          this.overlayCanvas.style.visibility = "";
          this.redraw();
          this.schedulePreviewRedraw();
        };

    this.animationCompletionScheduled = true;
    this.spreadRenderer.animateTo(fromCanvas, toCanvas, direction, onDone);
    this.schedulePreviewRedraw();
    this.pageStrip.update(this.book, {
      ...this.uiState,
      selectedPageIdxs: cloneSet(this.uiState.selectedPageIdxs),
      effectiveSpread: this.uiState.effectiveSpread,
    }, this.spreadRenderer);
  }

  createSpreadSnapshot(spreadIndex, scaleOverride = null) {
    const margins = scaleOverride
      ? computeMargins(this.book.layout, scaleOverride)
      : computeMargins(
          this.book.layout,
          this.getRenderScale()
        );
    const pages = this.getRenderableSpreadPages(spreadIndex);
    const effectEntries = {
      left: pages?.left?.page ? this.getEffectEntry(pages.left.page) : { pipeline: [], key: "" },
      right: pages?.right?.page ? this.getEffectEntry(pages.right.page) : { pipeline: [], key: "" },
    };
    const { canvas: snapshot, sideStates } = this.spreadRenderer.snapshot(
      pages,
      margins,
      effectEntries,
      this.book.display,
      {
        showPlaceholder: this.shouldShowPlaceholder(),
        previewZoom: this.renderZoom,
        showCenterLine: this.uiState.showCenterLine,
      }
    );

    if (this.uiState.appMode === "layout") {
      const overlayCanvas = document.createElement("canvas");
      overlayCanvas.width = snapshot.width;
      overlayCanvas.height = snapshot.height;
      const overlayCtx = overlayCanvas.getContext("2d");
      renderOverlay(overlayCtx, margins, {
        ...this.uiState,
        spreadRects: null,
        spreadSideStates: sideStates,
      });
      const composite = document.createElement("canvas");
      composite.width = snapshot.width;
      composite.height = snapshot.height;
      const compositeCtx = composite.getContext("2d");
      compositeCtx.drawImage(snapshot, 0, 0);
      compositeCtx.drawImage(overlayCanvas, 0, 0);
      this.spreadRenderer.rememberSnapshotScene?.(composite, snapshot);
      return composite;
    }

    return snapshot;
  }

  getCanvasViewportSize() {
    const rect = this.canvasArea.getBoundingClientRect();
    return {
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    };
  }

  getRenderScale() {
    const viewport = this.getCanvasViewportSize();
    const containerWidth = Math.max(1, viewport.width - 64);
    const containerHeight = Math.max(1, viewport.height - 64);
    const baseScale = computeScale(this.book.layout, containerWidth, containerHeight);
    return baseScale * this.renderZoom;
  }

  getSafeRenderZoom(targetZoom = this.contentZoom) {
    const viewport = this.getCanvasViewportSize();
    const containerWidth = Math.max(1, viewport.width - 64);
    const containerHeight = Math.max(1, viewport.height - 64);
    const baseScale = computeScale(this.book.layout, containerWidth, containerHeight);
    const baseMargins = computeMargins(this.book.layout, baseScale);
    const maxWidthZoom = (2 * baseMargins.pagePxW) > 0
      ? MAX_RENDER_CANVAS_EDGE / (2 * baseMargins.pagePxW)
      : targetZoom;
    const maxHeightZoom = baseMargins.pagePxH > 0
      ? MAX_RENDER_CANVAS_EDGE / baseMargins.pagePxH
      : targetZoom;
    return Math.max(CONTENT_ZOOM_MIN, Math.min(targetZoom, maxWidthZoom, maxHeightZoom));
  }

  syncCanvasStage() {
    if (this.canvasStage) {
      const displayScale = this.renderZoom > 0 ? this.contentZoom / this.renderZoom : this.contentZoom;
      this.canvasStage.style.width = `${Math.max(1, Math.round(this.spreadCanvas.width * displayScale))}px`;
      this.canvasStage.style.height = `${Math.max(1, Math.round(this.spreadCanvas.height * displayScale))}px`;
    }
    this.canvasWrap.dataset.mode = this.uiState.appMode;
    this.syncCanvasZoomUI();
  }

  syncCanvasZoomUI() {
    const zoomIn = document.getElementById("canvas-zoom-in");
    const zoomOut = document.getElementById("canvas-zoom-out");
    if (!zoomIn || !zoomOut) return;
    zoomIn.disabled = this.contentZoom >= CONTENT_ZOOM_MAX;
    zoomOut.disabled = this.contentZoom <= CONTENT_ZOOM_MIN;
  }

  adjustContentZoom(direction) {
    const multiplier = direction > 0 ? CONTENT_ZOOM_STEP : 1 / CONTENT_ZOOM_STEP;
    const nextZoom = Math.max(CONTENT_ZOOM_MIN, Math.min(CONTENT_ZOOM_MAX, this.contentZoom * multiplier));
    if (Math.abs(nextZoom - this.contentZoom) < 0.0001) return;

    const viewportWidth = this.canvasArea.clientWidth;
    const viewportHeight = this.canvasArea.clientHeight;
    const centerX = this.canvasArea.scrollLeft + viewportWidth / 2;
    const centerY = this.canvasArea.scrollTop + viewportHeight / 2;
    const zoomRatio = nextZoom / this.contentZoom;

    this.contentZoom = nextZoom;
    this.syncCanvasStage();
    requestAnimationFrame(() => {
      this.canvasArea.scrollLeft = Math.max(0, centerX * zoomRatio - viewportWidth / 2);
      this.canvasArea.scrollTop = Math.max(0, centerY * zoomRatio - viewportHeight / 2);
    });
    this.schedulePreviewRedraw();
  }

  resetContentZoom() {
    if (Math.abs(this.contentZoom - 1) < 0.0001) return;
    const viewportWidth = this.canvasArea.clientWidth;
    const viewportHeight = this.canvasArea.clientHeight;
    const centerX = this.canvasArea.scrollLeft + viewportWidth / 2;
    const centerY = this.canvasArea.scrollTop + viewportHeight / 2;
    const zoomRatio = 1 / this.contentZoom;

    this.contentZoom = 1;
    this.syncCanvasStage();
    requestAnimationFrame(() => {
      this.canvasArea.scrollLeft = Math.max(0, centerX * zoomRatio - viewportWidth / 2);
      this.canvasArea.scrollTop = Math.max(0, centerY * zoomRatio - viewportHeight / 2);
    });
    this.schedulePreviewRedraw();
  }

  schedulePreviewRedraw() {
    if (this.previewRedrawTimer) clearTimeout(this.previewRedrawTimer);
    this.previewRedrawTimer = setTimeout(() => {
      this.previewRedrawTimer = 0;
      const targetSpread = this.getEffectiveSpread();
      if (this.book.pages.length) {
        this.lazyPageLoader.ensureSpreadLoaded(targetSpread, this.contentZoom, { allowHighRes: true });
      }
      const nextRenderZoom = this.getSafeRenderZoom(this.contentZoom);
      if (Math.abs(this.renderZoom - nextRenderZoom) < 0.0001) return;
      this.renderZoom = nextRenderZoom;
      this.redraw();
    }, 500);
  }

  printCurrentSpread() {
    const dpi = 300;
    const margins = computeMargins(this.book.layout, dpi);
    const pages = this.getRenderableSpreadPages(this.uiState.currentSpread);
    const effectEntries = {
      left: pages?.left?.page ? this.getEffectEntry(pages.left.page) : { pipeline: [], key: "" },
      right: pages?.right?.page ? this.getEffectEntry(pages.right.page) : { pipeline: [], key: "" },
    };
    const { canvas: spreadCanvas, sideStates } = this.spreadRenderer.snapshot(
      pages,
      margins,
      effectEntries,
      this.book.display,
      {
        showPlaceholder: this.shouldShowPlaceholder(),
        previewZoom: 1,
        showCenterLine: this.uiState.showCenterLine,
      }
    );
    const overlayCanvas = document.createElement("canvas");
    overlayCanvas.width = spreadCanvas.width;
    overlayCanvas.height = spreadCanvas.height;
    const overlayCtx = overlayCanvas.getContext("2d");
    renderOverlay(overlayCtx, margins, {
      ...this.uiState,
      spreadRects: null,
      spreadSideStates: sideStates,
    });

    const composite = document.createElement("canvas");
    composite.width = spreadCanvas.width;
    composite.height = spreadCanvas.height;
    composite.getContext("2d").drawImage(spreadCanvas, 0, 0);
    composite.getContext("2d").drawImage(overlayCanvas, 0, 0);

    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      @page { size: ${2 * this.book.layout.pw}in ${this.book.layout.ph}in; margin: 0; }
      body { width: ${2 * this.book.layout.pw}in; height: ${this.book.layout.ph}in; }
      img { width: ${2 * this.book.layout.pw}in; height: ${this.book.layout.ph}in; display: block; }
    </style></head><body>
      <img src="${composite.toDataURL("image/png")}">
      <script>window.onload = function () { window.print(); window.close(); };<\/script>
    </body></html>`);
    win.document.close();
  }

  async appendFiles(files) {
    this.loadingFiles = true;
    this.setLoadProgress("Preparing load", 0, 0);
    try {
      const items = await this.expandImportFiles(files);
      if (!items.length) return;
      const contentFiles = items.filter(file => !isProjectJsonFile(file));
      const projectFiles = items.filter(file => isProjectJsonFile(file));
      const totalFiles = contentFiles.length + projectFiles.length;
      let processedFiles = 0;
      let appendedPages = false;

      for (const file of contentFiles) {
        this.setLoadProgress("Loading content", processedFiles, totalFiles);
        const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
        if (isPdf) {
          const pdfDoc = await loadPdfDocument(await file.arrayBuffer());
          const aspectRatios = await Promise.all(
            Array.from({ length: pdfDoc.numPages }, (_, index) =>
              getPdfPageAspectRatio(pdfDoc, index + 1)
            )
          );
          aspectRatios.forEach((aspectRatio, index) => {
            this.book.addPage(new Page({
              source: { type: "pdf", pdfDoc, pageNum: index + 1 },
              aspectRatio,
            }));
          });
          appendedPages = true;
          processedFiles += 1;
          continue;
        }

        try {
          const { canvas: thumbnailSourceCanvas, width, height } = await loadImagePreview(file, SHARED_PREVIEW_SIZE);
          this.book.addPage(new Page({
            source: { type: "image", file },
            previewCanvas: thumbnailSourceCanvas,
            thumbnailSourceCanvas,
            aspectRatio: width / height,
          }));
          appendedPages = true;
        } catch (error) {
          console.error("Failed to load dropped file:", error);
          window.alert(`Could not load "${file.name}".`);
        }
        processedFiles += 1;
      }

      if (!appendedPages) {
        for (const file of projectFiles) {
          this.setLoadProgress("Loading settings", processedFiles, totalFiles);
          await this.loadProjectFile(file);
          processedFiles += 1;
        }
        return;
      }

      this.setLoadProgress("Finalizing load", processedFiles, totalFiles);
      this.lazyPageLoader.reset();
      this.spreadRenderer.stopAnimation();
      this.animationCompletionScheduled = false;
      this.animationDirection = 0;
      this.contentEffectCaches = new WeakMap();
      this.overlayCanvas.style.visibility = "";
      this.uiState.currentSpread = 0;
      this.uiState.effectiveSpread = 0;
      this.uiState.editingPageIdx = 0;
      this.uiState.selectedPageIdxs = this.book.pages.length ? new Set([0]) : new Set();
      this.pageStrip.invalidateAllThumbnails();
      this.pageStrip.scrollToStart();
      this.refreshAllPlacedPreviews();
      this.lazyPageLoader.ensureSpreadLoaded(0, 1, { allowHighRes: false });
      this.lazyPageLoader.warmAllPreviews();
      if (projectFiles.length) {
        for (const file of projectFiles) {
          this.setLoadProgress("Loading settings", processedFiles, totalFiles);
          await this.loadProjectFile(file);
          processedFiles += 1;
        }
        return;
      }
      if (this.uiState.appMode === "content") this.syncPageUI();
      this.redraw();
      this.schedulePreviewRedraw();
    } finally {
      this.loadingFiles = false;
      this.setLoadProgress("", 0, 0);
    }
  }

  onPageReady(pageIndex) {
    const page = this.book.pages[pageIndex];
    if (!page) return;
    this.refreshPlacedPreview(pageIndex);
    this.pageStrip.updateThumbnail(pageIndex, page, this.spreadRenderer);
    if (this.spreadRenderer.isAnimating) return;
    const { left, right } = this.book.spreadPageEntries(this.uiState.currentSpread);
    if (pageIndex === left.pageIndex || pageIndex === right.pageIndex) {
      this.redraw();
      this.schedulePreviewRedraw();
    }
  }

  switchMode(mode) {
    if (this.exportingPages) return;
    if (mode === this.uiState.appMode) return;
    if (this.uiState.appMode === "content") this.flushDirtyPlacedPreviews();
    this.endInteractiveContentPreview({ redraw: false });
    this.spreadRenderer.stopAnimation();
    this.animationCompletionScheduled = false;
    this.animationDirection = 0;
    this.contentEffectCaches = new WeakMap();
    this.overlayCanvas.style.visibility = "";
    this.clearListeners();
    this.uiState.appMode = mode;
    this.uiState.hoverHandle = null;
    this.canvasWrap.dataset.mode = mode;
    this.mountToolbar(mode);

    if (mode === "layout") {
      this.restoreLayoutInputs();
      this.initLayoutListeners();
    } else {
      this.initContentListeners();
    }

    this.redraw();
  }

  bindGlobalListeners() {
    this.spreadCanvas.addEventListener("mousedown", event => this.handleCanvasMouseDown(event));
    this.spreadCanvas.addEventListener("mousemove", event => this.handleCanvasMouseMove(event));
    this.spreadCanvas.addEventListener("mouseup", () => this.handleCanvasMouseUp());
    this.spreadCanvas.addEventListener("mouseleave", () => this.handleCanvasMouseLeave());
    document.getElementById("canvas-zoom-in")?.addEventListener("click", () => this.adjustContentZoom(1));
    document.getElementById("canvas-zoom-out")?.addEventListener("click", () => this.adjustContentZoom(-1));
    document.getElementById("export-pages-btn")?.addEventListener("click", () => {
      this.closeOpenMenus();
      this.showExportModal();
    });
    document.getElementById("save-project-btn")?.addEventListener("click", () => {
      this.closeOpenMenus();
      this.saveProject();
    });
    document.getElementById("content-file-input")?.addEventListener("change", event => this.handleContentFileInput(event));
    document.getElementById("project-file-input")?.addEventListener("change", event => this.handleProjectFileInput(event));
    document.querySelectorAll(".mode-menu-item").forEach(button =>
      button.addEventListener("click", () => {
        this.switchMode(button.dataset.mode);
        this.closeOpenMenus();
      })
    );
    document.getElementById("show-layout-content")?.addEventListener("change", event => {
      this.uiState.showLayoutContent = event.target.checked;
      this.closeOpenMenus();
      this.redraw();
    });
    document.getElementById("show-margin-arrows")?.addEventListener("change", event => {
      this.uiState.showMarginArrows = event.target.checked;
      this.closeOpenMenus();
      this.redraw();
    });
    document.getElementById("show-center-line")?.addEventListener("change", event => {
      this.uiState.showCenterLine = event.target.checked;
      this.closeOpenMenus();
      this.redraw();
    });
    document.getElementById("vdg")?.addEventListener("change", event => {
      this.uiState.showVdG = event.target.checked;
      this.closeOpenMenus();
      this.redraw();
    });
    document.querySelectorAll(".menu-dropdown, .menu-submenu").forEach(menu =>
      menu.addEventListener("toggle", () => {
        if (!menu.open) return;
        const parent = menu.parentElement;
        if (!parent) return;
        Array.from(parent.children).forEach(sibling => {
          if (sibling !== menu && sibling.matches?.(".menu-dropdown[open], .menu-submenu[open]")) {
            sibling.removeAttribute("open");
          }
        });
      })
    );
    document.addEventListener("click", event => {
      if (event.target.closest(".menu-dropdown")) return;
      this.closeOpenMenus();
    });
    document.addEventListener("dragover", event => {
      event.preventDefault();
    });
    document.addEventListener("drop", event => {
      event.preventDefault();
      if (this.exportingPages) return;
      this.appendFiles(event.dataTransfer.files);
    });
    document.addEventListener("keydown", event => this.handleKeyDown(event), true);
    document.addEventListener("mousemove", event => {
      if (this.isPanning && this.panOrigin) {
        const dx = event.clientX - this.panOrigin.clientX;
        const dy = event.clientY - this.panOrigin.clientY;
        this.canvasArea.scrollLeft = this.panOrigin.scrollLeft - dx;
        this.canvasArea.scrollTop = this.panOrigin.scrollTop - dy;
      }
    });
    document.addEventListener("mouseup", () => {
      if (this.isPanning) {
        this.isPanning = false;
        this.panOrigin = null;
        this.pendingCanvasClick = null;
        this.setCanvasCursor("default");
      }
    });
    this.resizeObserver = new ResizeObserver(() => {
      if (this.spreadRenderer.isAnimating) return;
      this.redraw();
    });
    this.resizeObserver.observe(this.canvasArea);
  }

  handleKeyDown(event) {
    if (this.exportingPages) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (this.modalHost?.open) return;
    if (event.target.matches("input, select, textarea")) return;
    const key = typeof event.key === "string" ? event.key.toLowerCase() : event.key;
    const base = this.getEffectiveSpread();
    const max = this.book.numSpreads() - 1;

    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      if (key === "+" || key === "=") {
        event.preventDefault();
        event.stopPropagation();
        this.adjustContentZoom(1);
        return;
      }
      if (key === "-" || key === "_") {
        event.preventDefault();
        event.stopPropagation();
        this.adjustContentZoom(-1);
        return;
      }
      if (key === "0") {
        event.preventDefault();
        event.stopPropagation();
        this.resetContentZoom();
        return;
      }
    }

    if (key === "arrowleft" && base > 0) this.navigateTo(base - 1);
    if (key === "arrowright" && base < max) this.navigateTo(base + 1);

    if ((event.metaKey || event.ctrlKey) && key === "a" && this.book.pages.length) {
      event.preventDefault();
      event.stopPropagation();
      this.uiState.selectedPageIdxs = new Set(this.book.pages.map((_, index) => index));
      if (this.uiState.appMode === "layout") this.switchMode("content");
      else {
        this.syncPageUI();
        this.redraw();
      }
      return;
    }

    if (!event.metaKey && !event.ctrlKey && !event.altKey && this.uiState.appMode === "layout") {
      const toggleId = key === "m"
        ? "show-margin-arrows"
        : key === "c"
          ? "show-layout-content"
          : key === "v"
            ? "vdg"
            : null;
      if (toggleId) {
        event.preventDefault();
        document.getElementById(toggleId)?.click();
      }
    }
  }

  handleCanvasMouseDown(event) {
    if (this.exportingPages) return;
    if (this.spreadRenderer.isAnimating) return;
    this.endInteractiveContentPreview({ redraw: false });
    const { x, y } = this.getCanvasCoords(event);

    this.panOrigin = {
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: this.canvasArea.scrollLeft,
      scrollTop: this.canvasArea.scrollTop,
    };
    this.isPanning = false;
    this.pendingCanvasClick = null;

    if (this.uiState.appMode === "layout") {
      const hit = this.getSpreadHitTarget(x, y);
      if (hit?.rect?.pageIndex >= 0) {
        this.pendingCanvasClick = { type: "layout-to-content", pageIndex: hit.rect.pageIndex };
      }
      return;
    }

    if (this.uiState.appMode !== "content") return;

    const handleHit = this.getHandleHitTarget(x, y);
    const spreadHit = handleHit ?? this.getSpreadHitTarget(x, y);
    if (!spreadHit?.rect) {
      this.pendingCanvasClick = { type: "content-to-layout" };
      return;
    }

    const pageIndex = spreadHit.rect.pageIndex;
    if (this.uiState.editingPageIdx !== pageIndex || this.uiState.selectedPageIdxs.size > 1) {
      this.flushDirtyPlacedPreviews();
      this.uiState.editingPageIdx = pageIndex;
      this.uiState.selectedPageIdxs = new Set([pageIndex]);
      this.syncPageUI();
      this.redraw();
    }

    const handle = handleHit?.handle ?? this.hitTestHandle(x, y, spreadHit.rect);
    if (handle) {
      const page = this.book.pages[pageIndex];
      this.dragHandle = {
        edge: handle.edge,
        startX: x,
        startY: y,
        startCrop: page.getCropFor(page.displayCanvas),
        side: spreadHit.side,
      };
      this.setCanvasCursor(this.cursorForEdge(handle.edge));
      event.preventDefault();
    }
  }

  handleCanvasMouseMove(event) {
    if (this.exportingPages) return;
    if (this.panOrigin && !this.dragHandle) {
      const dx = event.clientX - this.panOrigin.clientX;
      const dy = event.clientY - this.panOrigin.clientY;
      if (!this.isPanning && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        this.isPanning = true;
        this.pendingCanvasClick = null;
        this.setCanvasCursor("grabbing");
      }
      if (this.isPanning) {
        this.canvasArea.scrollLeft = this.panOrigin.scrollLeft - dx;
        this.canvasArea.scrollTop = this.panOrigin.scrollTop - dy;
        return;
      }
    }

    if (this.spreadRenderer.isAnimating || this.uiState.appMode !== "content") return;
    const { x, y } = this.getCanvasCoords(event);

    if (this.dragHandle) {
      const sideRect = this.uiState.spreadRects?.[this.dragHandle.side];
      if (!sideRect) return;
      const page = this.book.pages[sideRect.pageIndex];
      if (!page) return;
      const dx = x - this.dragHandle.startX;
      const dy = y - this.dragHandle.startY;
      const crop = { ...this.dragHandle.startCrop };
      if (this.dragHandle.edge === "top") {
        crop.top = Math.max(0, Math.min(sideRect.sh - crop.bottom - 1, Math.round(this.dragHandle.startCrop.top + dy / sideRect.fitScale)));
      } else if (this.dragHandle.edge === "bottom") {
        crop.bottom = Math.max(0, Math.min(sideRect.sh - crop.top - 1, Math.round(this.dragHandle.startCrop.bottom - dy / sideRect.fitScale)));
      } else if (this.dragHandle.edge === "left") {
        crop.left = Math.max(0, Math.min(sideRect.sw - crop.right - 1, Math.round(this.dragHandle.startCrop.left + dx / sideRect.fitScale)));
      } else {
        crop.right = Math.max(0, Math.min(sideRect.sw - crop.left - 1, Math.round(this.dragHandle.startCrop.right - dx / sideRect.fitScale)));
      }
      page.setCropFor(page.displayCanvas, crop);
      this.redraw();
      return;
    }

    const handleHit = this.getHandleHitTarget(x, y);
    const nextHover = handleHit
      ? { side: handleHit.side, edge: handleHit.handle.edge }
      : null;
    const prevHover = this.uiState.hoverHandle;
    if (nextHover?.side !== prevHover?.side || nextHover?.edge !== prevHover?.edge) {
      this.uiState.hoverHandle = nextHover;
      this.setCanvasCursor(nextHover ? this.cursorForEdge(nextHover.edge) : "default");
      this.redraw();
    }
  }

  handleCanvasMouseUp() {
    if (this.exportingPages) return;
    const wasPanning = this.isPanning;
    this.isPanning = false;
    this.panOrigin = null;

    if (this.dragHandle) {
      const sideRect = this.uiState.spreadRects?.[this.dragHandle.side];
      if (sideRect?.pageIndex >= 0) this.refreshPlacedPreview(sideRect.pageIndex);
      this.dragHandle = null;
      if (!this.uiState.hoverHandle) this.setCanvasCursor("default");
      return;
    }

    if (!wasPanning) {
      const pending = this.pendingCanvasClick;
      this.pendingCanvasClick = null;
      if (pending?.type === "layout-to-content") {
        this.uiState.editingPageIdx = pending.pageIndex;
        this.uiState.selectedPageIdxs = new Set([pending.pageIndex]);
        this.switchMode("content");
      } else if (pending?.type === "content-to-layout") {
        this.flushDirtyPlacedPreviews();
        this.switchMode("layout");
      }
    }

    this.pendingCanvasClick = null;
    if (!this.uiState.hoverHandle) this.setCanvasCursor("default");
  }

  handleCanvasMouseLeave() {
    if (this.exportingPages) return;
    if (!this.isPanning) {
      this.panOrigin = null;
      this.pendingCanvasClick = null;
    }
    this.dragHandle = null;
    if (this.uiState.hoverHandle) {
      this.uiState.hoverHandle = null;
      this.setCanvasCursor("default");
      this.redraw();
    }
  }

  getCanvasCoords(event) {
    const rect = this.spreadCanvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (this.spreadCanvas.width / rect.width),
      y: (event.clientY - rect.top) * (this.spreadCanvas.height / rect.height),
    };
  }

  pointInRect(x, y, rect, pad = 0) {
    return !!rect &&
      x >= rect.x - pad &&
      x <= rect.x + rect.w + pad &&
      y >= rect.y - pad &&
      y <= rect.y + rect.h + pad;
  }

  getSpreadHitTarget(x, y, pad = 0) {
    const rects = this.uiState.spreadRects;
    if (!rects) return null;
    if (this.pointInRect(x, y, rects.left, pad)) return { side: "left", rect: rects.left };
    if (this.pointInRect(x, y, rects.right, pad)) return { side: "right", rect: rects.right };
    return null;
  }

  hitTestHandle(x, y, rect) {
    if (!rect) return null;
    const handles = [
      { edge: "top", hx: rect.x + rect.w / 2, hy: rect.y, dx: CROP_HANDLE_LEN / 2 + CROP_HANDLE_PAD, dy: CROP_HANDLE_THICK / 2 + CROP_HANDLE_PAD },
      { edge: "right", hx: rect.x + rect.w, hy: rect.y + rect.h / 2, dx: CROP_HANDLE_THICK / 2 + CROP_HANDLE_PAD, dy: CROP_HANDLE_LEN / 2 + CROP_HANDLE_PAD },
      { edge: "bottom", hx: rect.x + rect.w / 2, hy: rect.y + rect.h, dx: CROP_HANDLE_LEN / 2 + CROP_HANDLE_PAD, dy: CROP_HANDLE_THICK / 2 + CROP_HANDLE_PAD },
      { edge: "left", hx: rect.x, hy: rect.y + rect.h / 2, dx: CROP_HANDLE_THICK / 2 + CROP_HANDLE_PAD, dy: CROP_HANDLE_LEN / 2 + CROP_HANDLE_PAD },
    ];
    return handles.find(handle => Math.abs(x - handle.hx) <= handle.dx && Math.abs(y - handle.hy) <= handle.dy) || null;
  }

  getHandleHitTarget(x, y) {
    const rects = this.uiState.spreadRects;
    if (!rects) return null;
    const matches = [];
    for (const side of ["left", "right"]) {
      const rect = rects[side];
      const handle = this.hitTestHandle(x, y, rect);
      if (!handle) continue;
      const dx = x - handle.hx;
      const dy = y - handle.hy;
      matches.push({ side, rect, handle, distanceSq: dx * dx + dy * dy });
    }
    if (!matches.length) return null;
    matches.sort((a, b) => a.distanceSq - b.distanceSq);
    return matches[0];
  }

  cursorForEdge(edge) {
    return edge === "left" || edge === "right" ? "ew-resize" : "ns-resize";
  }

  setCanvasCursor(cursor = "default") {
    const applied = cursor === "default" ? "" : cursor;
    document.documentElement.style.setProperty("cursor", applied, "important");
    document.body.style.setProperty("cursor", applied, "important");
    this.spreadCanvas.style.cursor = cursor;
    this.canvasWrap.style.cursor = cursor;
  }

  getNumber(id) {
    return parseFloat(document.getElementById(id)?.value) || 0;
  }
}
