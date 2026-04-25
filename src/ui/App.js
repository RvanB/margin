import { Book } from "../model/Book.js";
import { Page, makeDefaultPageEffects, normalizeFitAxis } from "../model/Page.js";
import { autoCrop, getSelectionGate, normalizeHexColor, normalizeLevels } from "../effects/cpu.js";
import { applyEffectsToCanvas, buildGpuEffectConfig, buildPipeline, effectKey } from "../effects/pipeline.js";
import { downscaleCanvasToMaxEdge } from "../loading/downscaleCanvas.js";
import { loadImageFile } from "../loading/imageLoader.js";
import { LazyPageLoader } from "../loading/LazyPageLoader.js";
import { loadPdfDocument } from "../loading/pdfLoader.js";
import { computeMargins, computeScale } from "../rendering/layout.js";
import { CROP_HANDLE_LEN, CROP_HANDLE_PAD, CROP_HANDLE_THICK } from "../rendering/primitives.js";
import { renderOverlay } from "../rendering/OverlayRenderer.js";
import { SpreadRenderer } from "../rendering/SpreadRenderer.js";
import { PageStrip } from "./PageStrip.js";

function cloneSet(set) {
  return new Set([...set]);
}

function formatSliderValue(value, suffix = "") {
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text}${suffix}`;
}

const CONTENT_ZOOM_MIN = 0.5;
const CONTENT_ZOOM_MAX = 6;
const CONTENT_ZOOM_STEP = 1.25;
const MAX_RENDER_CANVAS_EDGE = 8192;
const PLACED_PREVIEW_PAGE_HEIGHT = 96;

function formatMeasuredRgb({ r, g, b }) {
  return `rgb ${r}, ${g}, ${b}`;
}

function getMeasuredHue(r, g, b) {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const delta = max - min;
  if (delta <= 1e-6) return 0;

  let hue;
  if (max === rf) hue = ((gf - bf) / delta) % 6;
  else if (max === gf) hue = (bf - rf) / delta + 2;
  else hue = (rf - gf) / delta + 4;
  return ((hue * 60) + 360) % 360;
}

function getMeasuredSaturation(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : ((max - min) / max) * 100;
}

function getMeasuredValue(r, g, b) {
  return (Math.max(r, g, b) / 255) * 100;
}

function buildMeasuredColor(hex) {
  const normalized = normalizeHexColor(hex) || "#ffffff";
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  return {
    hex: normalized,
    r,
    g,
    b,
    hue: getMeasuredHue(r, g, b),
    saturation: getMeasuredSaturation(r, g, b),
    value: getMeasuredValue(r, g, b),
  };
}

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
      showMarginArrows: true,
      showLayoutContent: true,
      showVdG: false,
    };
    this.layoutControlsState = {
      preset: "",
      preserveRatio: false,
      ratioSameAsPage: true,
    };
    this.listeners = [];
    this.dragHandle = null;
    this.contentEffectCaches = new WeakMap();
    this.measuredColor = buildMeasuredColor("#ffffff");
    this.contentZoom = 1;
    this.renderZoom = 1;
    this.previewRedrawTimer = 0;
    this.lastMargins = computeMargins(this.book.layout, 1);
    this.previewLayoutKey = "";
    this.animationCompletionScheduled = false;
    this.animationDirection = 0;
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
    this.applyVdGLayoutValues();
    this.syncBookLayoutFromInputs();
    this.initLayoutListeners();
    this.bindGlobalListeners();
    this.redraw();
  }

  mountToolbar(mode) {
    const template = document.getElementById(`tpl-${mode}`);
    this.toolbar.innerHTML = "";
    this.toolbar.appendChild(template.content.cloneNode(true));
    globalThis.htmx?.process(this.toolbar);
    document.querySelectorAll(".mode-tab").forEach(button => {
      button.classList.toggle("active", button.dataset.mode === mode);
    });
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

  getEffectEntry(page) {
    if (!page) return { pipeline: [], key: "" };
    return {
      pipeline: buildPipeline(page.effects),
      key: effectKey(page.effects),
      effects: page.effects,
      gpu: buildGpuEffectConfig(page.effects),
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
    const paperColor = document.getElementById("paper-color")?.value;
    if (paperColor) this.book.display.paperColor = paperColor;
    const blendMode = document.getElementById("content-blend")?.value;
    if (blendMode) this.book.display.contentBlendMode = blendMode;
    this.layoutControlsState.preset = document.getElementById("preset")?.value || "";
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
    setValue("preset", this.layoutControlsState.preset);
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
    const vdg = document.getElementById("vdg");
    if (vdg) vdg.checked = this.uiState.showVdG;
    const paperColor = document.getElementById("paper-color");
    if (paperColor) paperColor.value = this.book.display.paperColor;
    const blendMode = document.getElementById("content-blend");
    if (blendMode) blendMode.value = this.book.display.contentBlendMode;
    this.syncInputs();
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
    this.addListener("paper-color", "input", () => {
      this.syncBookLayoutFromInputs();
      this.pageStrip.invalidateAllThumbnails();
      this.redraw();
    });

    this.addListener("content-blend", "change", () => {
      this.syncBookLayoutFromInputs();
      this.pageStrip.invalidateAllThumbnails();
      this.redraw();
    });

    this.addListener("preset", "change", event => {
      if (!event.target.value) return;
      const [w, h] = event.target.value.split(",").map(Number);
      document.getElementById("pw").value = w;
      document.getElementById("ph").value = h;
      document.getElementById("page-ratio").value = (w / h).toFixed(3);
      this.applyVdGLayoutValues();
      this.redraw();
    });

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
    this.addListener("vdg", "change", () => this.redraw());
    this.addListener("ratio-same-as-page", "change", () => this.redraw());
    this.addListener("preserve-ratio", "change", () => this.redraw());
    this.addListener("show-margin-arrows", "change", event => {
      this.uiState.showMarginArrows = event.target.checked;
      this.redraw();
    });
    this.addListener("show-layout-content", "change", event => {
      this.uiState.showLayoutContent = event.target.checked;
      this.redraw();
    });
    this.addListener("vdg-snap", "click", () => {
      this.applyVdGLayoutValues();
      this.redraw();
    });
    this.addListener("print-btn", "click", () => this.printCurrentSpread());
  }

  initContentListeners() {
    const marginToggle = document.getElementById("show-margin-arrows");
    if (marginToggle) marginToggle.checked = this.uiState.showMarginArrows;
    this.addListener("show-margin-arrows", "change", event => {
      this.uiState.showMarginArrows = event.target.checked;
      this.redraw();
    });

    this.addListener("trim-slider", "input", () => {
      for (const page of this.getSelectedPages()) this.applyTrimToPage(page);
      this.redraw();
    });

    this.addListener("measure-color", "input", event => {
      this.measuredColor = buildMeasuredColor(event.target.value);
      this.setMeasuredColorUI(this.measuredColor);
    });

    const applySelectionFromUI = () => {
      const selection = this.readSelectionUI();
      const page = this.getEditingPage();
      this.applySelectionToPage(page, selection);
      this.redraw();
    };

    ["selection-sat-low", "selection-sat-high", "selection-hue-low", "selection-hue-high"].forEach(id => {
      [id, `${id}-num`].forEach(controlId => {
        this.addListener(controlId, "input", event => {
          if (event.target.value === "" || Number.isNaN(Number(event.target.value))) return;
          this.setSelectionControlUI(id, event.target.value);
          applySelectionFromUI();
        });
        this.addListener(controlId, "change", event => {
          if (event.target.value === "" || Number.isNaN(Number(event.target.value))) {
            this.setSelectionUI(getSelectionGate(this.getEditingPage()?.effects));
            return;
          }
          this.setSelectionControlUI(id, event.target.value);
          const selection = this.readSelectionUI();
          this.setSelectionUI(selection);
          const pages = this.getSelectedPages();
          for (const page of pages) {
            this.applySelectionToPage(page, selection);
            this.recomputeTrimFromEffects(page);
          }
          this.refreshAffectedThumbnails(pages);
          this.redraw();
        });
      });
    });

    this.addListener("bw-enabled", "change", event => {
      const enabled = !!event.target.checked;
      const pages = this.getSelectedPages();
      for (const page of pages) {
        this.applyBwEnabledToPage(page, enabled);
        this.recomputeTrimFromEffects(page);
      }
      this.refreshAffectedThumbnails(this.getSelectedPages());
      this.redraw();
    });

    this.addListener("neutralize-clear", "click", () => {
      const pages = this.getSelectedPages();
      for (const page of pages) {
        this.applyNeutralizeColorToPage(page, null);
        this.recomputeTrimFromEffects(page);
      }
      this.syncPageUI();
      this.refreshAffectedThumbnails(pages);
      this.redraw();
    });

    this.addListener("neutralize-color", "input", () => {
      const page = this.getEditingPage();
      this.applyNeutralizeColorToPage(page, document.getElementById("neutralize-color").value);
      this.redraw();
    });

    this.addListener("neutralize-color", "change", () => {
      const color = document.getElementById("neutralize-color").value;
      const pages = this.getSelectedPages();
      for (const page of pages) {
        this.applyNeutralizeColorToPage(page, color);
        this.recomputeTrimFromEffects(page);
      }
      this.syncPageUI();
      this.refreshAffectedThumbnails(pages);
      this.redraw();
    });

    const applyLevelsFromUI = changedId => {
      let black = parseInt(document.getElementById("levels-black").value, 10);
      let gray = parseInt(document.getElementById("levels-gray").value, 10);
      let white = parseInt(document.getElementById("levels-white").value, 10);

      if (black >= white) {
        if (changedId === "levels-white") black = Math.max(0, white - 1);
        else white = Math.min(255, black + 1);
      }

      if (gray <= black) gray = black + 1;
      if (gray >= white) gray = white - 1;

      const levels = normalizeLevels(black, gray, white);
      this.setLevelsUI(levels);
      const page = this.getEditingPage();
      this.applyLevelsToPage(page, levels);
      this.redraw();
    };

    ["levels-black", "levels-gray", "levels-white"].forEach(id => {
      this.addListener(id, "input", () => applyLevelsFromUI(id));
      this.addListener(id, "change", () => {
        const levels = normalizeLevels(
          parseInt(document.getElementById("levels-black").value, 10),
          parseInt(document.getElementById("levels-gray").value, 10),
          parseInt(document.getElementById("levels-white").value, 10)
        );
        const pages = this.getSelectedPages();
        for (const page of pages) {
          this.applyLevelsToPage(page, levels);
          this.recomputeTrimFromEffects(page);
        }
        this.refreshAffectedThumbnails(pages);
        this.redraw();
      });
    });

    this.addListener("cover-check", "change", event => {
      for (const page of this.getSelectedPages()) page.cover = event.target.checked;
      this.refreshAffectedThumbnails(this.getSelectedPages());
      this.syncPageUI();
      this.redraw();
    });

    this.addListener("fit-axis", "change", event => {
      const fitAxis = normalizeFitAxis(event.target.value);
      for (const page of this.getSelectedPages()) page.fitAxis = fitAxis;
      this.refreshAffectedThumbnails(this.getSelectedPages());
      this.redraw();
    });

    if (this.book.pages.length) this.syncPageUI();
  }

  refreshAffectedThumbnails(pages) {
    for (const page of pages) this.refreshPlacedPreview(page);
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
        pageHeight: PLACED_PREVIEW_PAGE_HEIGHT,
      }
    );
    this.pageStrip.invalidateThumbnail(page);
  }

  refreshAllPlacedPreviews() {
    this.book.pages.forEach((_, pageIndex) => this.refreshPlacedPreview(pageIndex));
    this.pageStrip.invalidateAllThumbnails();
  }

  syncPageUI() {
    const section = document.getElementById("trim-section");
    if (section) section.style.display = "";
    const page = this.getEditingPage();
    if (!page) return;

    this.setTrimUI(page.tolerance);
    this.setSelectionUI(getSelectionGate(page.effects, page.effects.bwThreshold));
    this.setBwUI(page.effects);
    this.setNeutralizeUI(page.effects.neutralizeColor);
    this.setLevelsUI({
      black: page.effects.levelsBlack,
      gray: page.effects.levelsGray,
      white: page.effects.levelsWhite,
    });

    const cover = document.getElementById("cover-check");
    if (cover) cover.checked = page.cover;
    const fitAxis = document.getElementById("fit-axis");
    if (fitAxis) {
      fitAxis.value = normalizeFitAxis(page.fitAxis);
      fitAxis.disabled = !!page.cover;
    }
    const selectionCount = document.getElementById("selection-count");
    if (selectionCount) {
      const count = this.uiState.selectedPageIdxs.size;
      selectionCount.textContent = count > 1 ? `${count} pages` : "";
    }
    this.setMeasuredColorUI(this.measuredColor);
  }

  setTrimUI(tolerance) {
    const slider = document.getElementById("trim-slider");
    const value = document.getElementById("trim-val");
    if (slider) slider.value = tolerance;
    if (value) value.textContent = tolerance;
  }

  setSelectionUI(selection = {}) {
    const gate = getSelectionGate(selection, selection?.bwThreshold);
    const mappings = [
      ["selection-sat-low", gate.satLow],
      ["selection-sat-high", gate.satHigh],
      ["selection-hue-low", gate.hueLow],
      ["selection-hue-high", gate.hueHigh],
    ];
    mappings.forEach(([id, value]) => {
      this.setSelectionControlUI(id, value);
    });
  }

  setSelectionControlUI(id, value) {
    [id, `${id}-num`].forEach(controlId => {
      const el = document.getElementById(controlId);
      if (el) el.value = value;
    });
  }

  setMeasuredColorUI(sample = null) {
    const picker = document.getElementById("measure-color");
    if (picker) picker.value = sample?.hex || "#ffffff";

    const mappings = [
      ["measure-status", "reference"],
      ["measure-hex", sample?.hex || "#ffffff"],
      ["measure-rgb", sample ? formatMeasuredRgb(sample) : "rgb 255, 255, 255"],
      ["measure-hue", sample ? formatSliderValue(sample.hue, "\u00b0") : "0\u00b0"],
      ["measure-sat", sample ? formatSliderValue(sample.saturation, "%") : "0%"],
      ["measure-value", sample ? formatSliderValue(sample.value, "%") : "100%"],
    ];
    mappings.forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(value);
    });
  }

  readSelectionUI() {
    return {
      selectionSatLow: parseFloat(document.getElementById("selection-sat-low")?.value),
      selectionSatHigh: parseFloat(document.getElementById("selection-sat-high")?.value),
      selectionHueLow: parseFloat(document.getElementById("selection-hue-low")?.value),
      selectionHueHigh: parseFloat(document.getElementById("selection-hue-high")?.value),
    };
  }

  setBwUI(effects = {}) {
    const checkbox = document.getElementById("bw-enabled");
    if (checkbox) {
      checkbox.checked = typeof effects.bwEnabled === "boolean"
        ? effects.bwEnabled
        : Math.max(0, Math.min(100, Math.round(effects.bwThreshold || 0))) > 0;
    }
  }

  setNeutralizeUI(color) {
    const normalized = normalizeHexColor(color);
    const colorInput = document.getElementById("neutralize-color");
    const value = document.getElementById("neutralize-val");
    if (colorInput) colorInput.value = normalized || "#ffffff";
    if (value) value.textContent = normalized || "none";
  }

  setLevelsUI({ black = 0, gray = 128, white = 255 } = {}) {
    const levels = normalizeLevels(black, gray, white);
    const mappings = [
      ["levels-black", levels.black],
      ["levels-gray", levels.gray],
      ["levels-white", levels.white],
      ["levels-black-val", levels.black],
      ["levels-gray-val", levels.gray],
      ["levels-white-val", levels.white],
    ];
    mappings.forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (!el) return;
      if ("value" in el) el.value = value;
      else el.textContent = String(value);
    });
  }

  applyTrimToPage(page) {
    if (!page) return;
    const tolerance = parseInt(document.getElementById("trim-slider")?.value, 10);
    page.tolerance = tolerance;
    this.recomputeTrimFromEffects(page, tolerance);
    this.refreshPlacedPreview(page);
    this.setTrimUI(tolerance);
  }

  recomputeTrimFromEffects(page, tolerance = page?.tolerance) {
    if (!page) return;
    const sourceCanvas = page.displayCanvas;
    if (sourceCanvas) {
      page.setCropFor(sourceCanvas, autoCrop(
        applyEffectsToCanvas(
          sourceCanvas,
          page.effects,
          this.getContentEffectLayerCache(page),
          `${sourceCanvas.width}x${sourceCanvas.height}`
        ),
        tolerance
      ));
      page.cropInitialized = true;
    } else {
      page.cropInitialized = false;
    }
  }

  applySelectionToPage(page, selection) {
    if (!page) return;
    const gate = getSelectionGate(selection, page.effects.bwThreshold);
    page.effects.selectionSatLow = gate.satLow;
    page.effects.selectionSatHigh = gate.satHigh;
    page.effects.selectionHueLow = gate.hueLow;
    page.effects.selectionHueHigh = gate.hueHigh;
    this.refreshPlacedPreview(page);
  }

  applyBwEnabledToPage(page, enabled = false) {
    if (!page) return;
    page.effects.bwEnabled = !!enabled;
    this.refreshPlacedPreview(page);
  }

  applyNeutralizeColorToPage(page, color) {
    if (!page) return;
    page.effects.neutralizeColor = normalizeHexColor(color);
    this.refreshPlacedPreview(page);
  }

  applyLevelsToPage(page, levels) {
    if (!page) return;
    page.effects.levelsBlack = levels.black;
    page.effects.levelsGray = levels.gray;
    page.effects.levelsWhite = levels.white;
    this.refreshPlacedPreview(page);
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
        const from = Math.min(this.uiState.editingPageIdx, pageIndex);
        const to = Math.max(this.uiState.editingPageIdx, pageIndex);
        for (let i = from; i <= to; i += 1) this.uiState.selectedPageIdxs.add(i);
        this.uiState.editingPageIdx = pageIndex;
        this.syncPageUI();
        this.redraw();
        return;
      }

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
    this.uiState.editingPageIdx = pageIndex;
    this.uiState.selectedPageIdxs = new Set([pageIndex]);
    this.syncPageUI();
  }

  navigateTo(targetSpread, preferredPageIndex = null) {
    const clampedTarget = Math.max(0, Math.min(targetSpread, this.book.numSpreads() - 1));
    if (clampedTarget === this.getEffectiveSpread()) return;

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
    const items = Array.from(files);
    if (!items.length) return;

    for (const file of items) {
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      if (isPdf) {
        const pdfDoc = await loadPdfDocument(await file.arrayBuffer());
        const aspectRatios = await Promise.all(
          Array.from({ length: pdfDoc.numPages }, (_, index) =>
            pdfDoc.getPage(index + 1).then(page => {
              const viewport = page.getViewport({ scale: 1 });
              return viewport.width / viewport.height;
            })
          )
        );
        aspectRatios.forEach((aspectRatio, index) => {
          this.book.addPage(new Page({
            source: { type: "pdf", pdfDoc, pageNum: index + 1 },
            aspectRatio,
            effects: makeDefaultPageEffects(),
          }));
        });
        continue;
      }

      const canvas = await loadImageFile(file);
      const thumbnailSourceCanvas = await downscaleCanvasToMaxEdge(canvas, 96);
      this.book.addPage(new Page({
        source: { type: "image", file },
        srcCanvas: canvas,
        previewCanvas: thumbnailSourceCanvas,
        thumbnailSourceCanvas,
        aspectRatio: canvas.width / canvas.height,
        crop: autoCrop(applyEffectsToCanvas(canvas, makeDefaultPageEffects()), 128),
        cropSourceWidth: canvas.width,
        cropSourceHeight: canvas.height,
        cropInitialized: true,
        tolerance: 128,
        effects: makeDefaultPageEffects(),
      }));
    }

    this.lazyPageLoader.reset();
    this.spreadRenderer.stopAnimation();
    this.animationCompletionScheduled = false;
    this.animationDirection = 0;
    this.contentEffectCaches = new WeakMap();
    this.measuredColor = buildMeasuredColor(this.measuredColor?.hex);
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
    if (this.uiState.appMode === "content") this.syncPageUI();
    this.redraw();
    this.schedulePreviewRedraw();
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
    if (mode === this.uiState.appMode) return;
    this.spreadRenderer.stopAnimation();
    this.animationCompletionScheduled = false;
    this.animationDirection = 0;
    this.contentEffectCaches = new WeakMap();
    this.measuredColor = null;
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
    document.addEventListener("dragover", event => event.preventDefault());
    document.addEventListener("drop", event => {
      event.preventDefault();
      this.appendFiles(event.dataTransfer.files);
    });
    document.addEventListener("keydown", event => this.handleKeyDown(event), true);
    document.querySelectorAll(".mode-tab").forEach(button =>
      button.addEventListener("click", () => this.switchMode(button.dataset.mode))
    );
    this.resizeObserver = new ResizeObserver(() => {
      if (this.spreadRenderer.isAnimating) return;
      this.redraw();
    });
    this.resizeObserver.observe(this.canvasArea);
  }

  handleKeyDown(event) {
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
    if (this.spreadRenderer.isAnimating) return;
    const { x, y } = this.getCanvasCoords(event);

    if (this.uiState.appMode === "layout") {
      const hit = this.getSpreadHitTarget(x, y);
      if (hit?.rect?.pageIndex >= 0) {
        this.uiState.editingPageIdx = hit.rect.pageIndex;
        this.uiState.selectedPageIdxs = new Set([hit.rect.pageIndex]);
        this.switchMode("content");
      }
      return;
    }

    if (this.uiState.appMode !== "content") return;

    const handleHit = this.getHandleHitTarget(x, y);
    const spreadHit = handleHit ?? this.getSpreadHitTarget(x, y);
    if (!spreadHit?.rect) {
      this.switchMode("layout");
      return;
    }

    const pageIndex = spreadHit.rect.pageIndex;
    if (this.uiState.editingPageIdx !== pageIndex || this.uiState.selectedPageIdxs.size > 1) {
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
    if (this.dragHandle) {
      const sideRect = this.uiState.spreadRects?.[this.dragHandle.side];
      if (sideRect?.pageIndex >= 0) this.refreshPlacedPreview(sideRect.pageIndex);
    }
    this.dragHandle = null;
    if (!this.uiState.hoverHandle) this.setCanvasCursor("default");
  }

  handleCanvasMouseLeave() {
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
