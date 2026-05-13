import { Book } from "../model/Book.js";
import { LazyPageLoader } from "../loading/LazyPageLoader.js";
import { computeMargins } from "../rendering/layout.js";
import { renderOverlay } from "../rendering/OverlayRenderer.js";
import { SpreadRenderer } from "../rendering/SpreadRenderer.js";
import { PageStrip } from "./PageStrip.js";
import { BusyIndicator } from "./BusyIndicator.js";
import { CanvasInteraction } from "./CanvasInteraction.js";
import { ExportController } from "./ExportController.js";
import { InterfaceColors } from "./InterfaceColors.js";
import { ModalManager } from "./ModalManager.js";
import { NavigationController } from "./NavigationController.js";
import { PlacedPreviewManager } from "./PlacedPreviewManager.js";
import { SpreadComposer } from "./SpreadComposer.js";
import { ToolbarController } from "./ToolbarController.js";
import { ZoomController } from "./ZoomController.js";
import {
  applyProjectDataToBook,
  downloadProjectJson,
  expandImportFiles,
  isPdfFile,
  readImagePageFromFile,
  readPdfPagesFromFile,
  readProjectJsonFile,
  serializeProject,
} from "./projectIO.js";
import {
  clamp,
  cloneSet,
  isProjectJsonFile,
} from "../util/helpers.js";


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
    this.modalManager = new ModalManager(document.getElementById("app-modal"));
    this.book = new Book();
    this.interfaceColors = new InterfaceColors({
      onChange: () => {
        this.spreadRenderer?.chromeCache?.clear?.();
        this.redraw();
      },
    });
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
      showPageBorder: true,
      showVdG: false,
    };
    this.layoutControlsState = {
      preserveRatio: false,
      ratioSameAsPage: true,
    };
    this.previewRedrawTimer = 0;
    this.busyIndicator = new BusyIndicator();
    this.lastMargins = computeMargins(this.book.layout, 1);
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
    this.exportController = new ExportController({
      book: this.book,
      spreadRenderer: this.spreadRenderer,
      modalManager: this.modalManager,
      busyIndicator: this.busyIndicator,
      getEffectEntry: page => this.getEffectEntry(page),
    });
    this.canvasInteraction = new CanvasInteraction(this);
    this.navigationController = new NavigationController(this);
    this.zoomController = new ZoomController(this);
    this.toolbarController = new ToolbarController(this);
    this.spreadComposer = new SpreadComposer(this);
    this.placedPreviewManager = new PlacedPreviewManager(this);
  }

  get contentZoom() {
    return this.zoomController.contentZoom;
  }

  get renderZoom() {
    return this.zoomController.renderZoom;
  }

  getEffectEntry(page) {
    return this.spreadComposer.getEffectEntry(page);
  }

  init() {
    this.interfaceColors.apply();
    this.canvasWrap.dataset.mode = "layout";
    this.toolbarController.mountToolbar("layout");
    this.toolbarController.populatePaperPresetMenu();
    this.toolbarController.applyVdGLayoutValues();
    this.toolbarController.syncBookLayoutFromInputs();
    this.toolbarController.initLayoutListeners();
    this.bindGlobalListeners();
    this.redraw();
  }

  buildProjectData() {
    if (this.uiState.appMode === "layout") this.toolbarController.syncBookLayoutFromInputs();
    return serializeProject(this.book, { layoutControlsState: this.layoutControlsState });
  }

  saveProject() {
    downloadProjectJson(this.buildProjectData());
  }

  async handleContentFileInput(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    await this.appendFiles(files);
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
      this.applyProjectData(await readProjectJsonFile(file));
      return true;
    } catch (error) {
      console.error("Failed to load project:", error);
      window.alert("Could not load project JSON.");
      return false;
    }
  }

  applyProjectData(project) {
    if (this.uiState.appMode === "content") this.placedPreviewManager.flushDirty();
    this.placedPreviewManager.endInteractive({ redraw: false });
    this.navigationController.cancelQueuedSpreadTurns();
    this.spreadRenderer.stopAnimation();
    this.navigationController.resetAnimationState();
    this.spreadComposer.reset();
    this.overlayCanvas.style.visibility = "";

    const { layoutControlsState } = applyProjectDataToBook(this.book, project, {
      layoutControlsState: this.layoutControlsState,
      onPageApplied: page => this.placedPreviewManager.markDirty(page),
    });
    this.layoutControlsState = layoutControlsState;

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

    this.placedPreviewManager.rememberLayoutKey();
    this.pageStrip.invalidateAllThumbnails();
    this.placedPreviewManager.refreshAll();
    this.lazyPageLoader.reset();
    if (this.book.pages.length) {
      this.lazyPageLoader.ensureSpreadLoaded(this.uiState.currentSpread, 1, { allowHighRes: false });
      this.lazyPageLoader.warmAllPreviews();
    }

    this.toolbarController.syncMenuState();
    if (this.uiState.appMode === "layout") this.toolbarController.restoreLayoutInputs();
    else this.toolbarController.syncPageUI();
    this.redraw();
    this.schedulePreviewRedraw();
  }

  redraw() {
    globalThis.__rendererBackend = this.spreadRenderer.backendName;
    document.documentElement.dataset.rendererBackend = this.spreadRenderer.backendName;

    if (this.uiState.appMode === "layout") {
      this.toolbarController.syncBookLayoutFromInputs();
    }

    const scale = this.zoomController.getRenderScale();
    const margins = computeMargins(this.book.layout, scale);
    this.lastMargins = margins;
    this.uiState.currentSpread = Math.min(this.uiState.currentSpread, this.book.numSpreads() - 1);
    this.uiState.effectiveSpread = this.navigationController.getEffectiveSpread();
    this.toolbarController.updateComputedRows(margins);
    this.canvasInteraction.refreshDragCursor();

    if (
      this.book.pages.length &&
      (this.uiState.appMode === "content" || this.uiState.showLayoutContent)
    ) {
      this.lazyPageLoader.ensureSpreadLoaded(this.uiState.currentSpread, 1, {
        allowHighRes: false,
        extraKeepSpreadIndexes: this.navigationController.getLoaderKeepSpreadIndexes(this.uiState.currentSpread),
      });
    }

    const spreadPages = this.spreadComposer.getRenderableSpreadPages(this.uiState.currentSpread);

    const renderResult = this.spreadRenderer.render(
      spreadPages,
      margins,
      {
        left: spreadPages?.left?.page ? this.getEffectEntry(spreadPages.left.page) : { pipeline: [], key: "" },
        right: spreadPages?.right?.page ? this.getEffectEntry(spreadPages.right.page) : { pipeline: [], key: "" },
      },
      this.book.display,
      {
        showPlaceholder: this.spreadComposer.shouldShowPlaceholder(),
        previewZoom: this.renderZoom,
        showPageBorder: this.uiState.showPageBorder,
      }
    );

    this.overlayCanvas.width = this.spreadCanvas.width;
    this.overlayCanvas.height = this.spreadCanvas.height;
    this.uiState.spreadSideStates = renderResult.sideStates;
    this.uiState.spreadRects = this.spreadComposer.shouldExposeSpreadRects() ? renderResult.spreadRects : null;
    this.zoomController.syncCanvasStage();

    if (!this.spreadRenderer.isAnimating) {
      renderOverlay(this.overlayCtx, margins, this.uiState, {
        paperColor: this.book.display.paperColor,
      });
    }

    this.pageStrip.update(this.book, {
      ...this.uiState,
      selectedPageIdxs: cloneSet(this.uiState.selectedPageIdxs),
      effectiveSpread: this.navigationController.getEffectiveSpread(),
    });
  }

  handlePageStripClick(pageIndex, event) {
    const targetSpread = Math.floor((pageIndex + 1) / 2);
    if (this.uiState.appMode === "content") {
      if (event.metaKey || event.ctrlKey) {
        this.placedPreviewManager.endInteractive({ redraw: false });
        this.placedPreviewManager.flushDirty();
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
        this.toolbarController.syncPageUI();
        this.redraw();
        return;
      }

      if (event.shiftKey) {
        this.placedPreviewManager.endInteractive({ redraw: false });
        this.placedPreviewManager.flushDirty();
        const from = Math.min(this.uiState.editingPageIdx, pageIndex);
        const to = Math.max(this.uiState.editingPageIdx, pageIndex);
        for (let i = from; i <= to; i += 1) this.uiState.selectedPageIdxs.add(i);
        this.uiState.editingPageIdx = pageIndex;
        this.toolbarController.syncPageUI();
        this.redraw();
        return;
      }

      this.placedPreviewManager.endInteractive({ redraw: false });
      this.placedPreviewManager.flushDirty();
      this.uiState.editingPageIdx = pageIndex;
      this.uiState.selectedPageIdxs = new Set([pageIndex]);
      this.toolbarController.syncPageUI();
      if (targetSpread === this.navigationController.getEffectiveSpread()) {
        this.redraw();
        return;
      }
    }

    if (Math.abs(targetSpread - this.navigationController.getEffectiveSpread()) > 1) {
      this.navigationController.queueSpreadTurnsTo(targetSpread, pageIndex);
      return;
    }
    this.navigationController.navigateTo(targetSpread, pageIndex);
  }

  schedulePreviewRedraw() {
    if (this.previewRedrawTimer) clearTimeout(this.previewRedrawTimer);
    this.previewRedrawTimer = setTimeout(() => {
      this.previewRedrawTimer = 0;
      // High-res loading kicks off many worker round-trips; each result
      // landing on main thread runs a Task between rAF frames. Hold off
      // entirely while a turn is animating — the post-animation onDone
      // calls schedulePreviewRedraw again.
      if (this.spreadRenderer.isAnimating) return;
      const targetSpread = this.navigationController.getEffectiveSpread();
      const pendingSettledKeepSpreadIndexes = [...this.navigationController.pendingSettledKeepSpreadIndexes];
      const pendingKeepSpreadIndexes = this.navigationController.getLoaderKeepSpreadIndexes(targetSpread);
      if (this.book.pages.length) {
        this.lazyPageLoader.ensureSpreadLoaded(targetSpread, this.contentZoom, {
          allowHighRes: true,
          extraKeepSpreadIndexes: pendingKeepSpreadIndexes,
        });
        const canTrimSettledKeep = pendingSettledKeepSpreadIndexes.length
          && !this.spreadRenderer.isAnimating
          && targetSpread === this.uiState.currentSpread
          && this.zoomController.isSpreadHighResReady(targetSpread, this.contentZoom);
        if (canTrimSettledKeep) {
          this.navigationController.clearSettledKeepSpreadIndexes();
          this.lazyPageLoader.ensureSpreadLoaded(targetSpread, this.contentZoom, { allowHighRes: true });
        }
      }
      if (this.zoomController.applySafeRenderZoom()) this.redraw();
    }, 100);
  }

  async appendFiles(files) {
    this.busyIndicator.setLoading(true);
    this.busyIndicator.setLoadProgress("Preparing load", 0, 0);
    try {
      const items = await expandImportFiles(files);
      if (!items.length) return;
      const contentFiles = items.filter(file => !isProjectJsonFile(file));
      const projectFiles = items.filter(file => isProjectJsonFile(file));
      const totalFiles = contentFiles.length + projectFiles.length;
      let processedFiles = 0;
      let appendedPages = false;

      for (const file of contentFiles) {
        this.busyIndicator.setLoadProgress("Loading content", processedFiles, totalFiles);
        if (isPdfFile(file)) {
          const pages = await readPdfPagesFromFile(file);
          pages.forEach(page => this.book.addPage(page));
          appendedPages = true;
          processedFiles += 1;
          continue;
        }

        try {
          this.book.addPage(await readImagePageFromFile(file));
          appendedPages = true;
        } catch (error) {
          console.error("Failed to load dropped file:", error);
          window.alert(`Could not load "${file.name}".`);
        }
        processedFiles += 1;
      }

      if (!appendedPages) {
        for (const file of projectFiles) {
          this.busyIndicator.setLoadProgress("Loading settings", processedFiles, totalFiles);
          await this.loadProjectFile(file);
          processedFiles += 1;
        }
        return;
      }

      this.busyIndicator.setLoadProgress("Finalizing load", processedFiles, totalFiles);
      this.lazyPageLoader.reset();
      this.navigationController.cancelQueuedSpreadTurns();
      this.spreadRenderer.stopAnimation();
      this.navigationController.resetAnimationState();
      this.spreadComposer.reset();
      this.overlayCanvas.style.visibility = "";
      this.uiState.currentSpread = 0;
      this.uiState.effectiveSpread = 0;
      this.uiState.editingPageIdx = 0;
      this.uiState.selectedPageIdxs = this.book.pages.length ? new Set([0]) : new Set();
      this.pageStrip.invalidateAllThumbnails();
      this.pageStrip.scrollToStart();
      this.placedPreviewManager.refreshAll();
      this.lazyPageLoader.ensureSpreadLoaded(0, 1, { allowHighRes: false });
      this.lazyPageLoader.warmAllPreviews();
      if (projectFiles.length) {
        for (const file of projectFiles) {
          this.busyIndicator.setLoadProgress("Loading settings", processedFiles, totalFiles);
          await this.loadProjectFile(file);
          processedFiles += 1;
        }
        return;
      }
      if (this.uiState.appMode === "content") this.toolbarController.syncPageUI();
      this.redraw();
      this.schedulePreviewRedraw();
    } finally {
      this.busyIndicator.setLoading(false);
    }
  }

  onPageReady(pageIndex) {
    const page = this.book.pages[pageIndex];
    if (!page) return;
    if (this.spreadRenderer.isAnimating) {
      // Defer placed-preview rebuild and thumbnail repaint until the turn
      // settles — both are main-thread 2D paints, and a warming book floods
      // this callback hundreds of times during user navigation.
      this.placedPreviewManager.markDirty(pageIndex);
      return;
    }
    this.placedPreviewManager.refresh(pageIndex);
    this.pageStrip.updateThumbnail(pageIndex, page);
    const { left, right } = this.book.spreadPageEntries(this.uiState.currentSpread);
    if (pageIndex === left.pageIndex || pageIndex === right.pageIndex) {
      this.redraw();
      this.schedulePreviewRedraw();
    }
  }

  switchMode(mode) {
    if (this.busyIndicator.isExporting) return;
    if (mode === this.uiState.appMode) return;
    if (this.uiState.appMode === "content") this.placedPreviewManager.flushDirty();
    this.placedPreviewManager.endInteractive({ redraw: false });
    this.navigationController.cancelQueuedSpreadTurns();
    this.spreadRenderer.stopAnimation();
    this.navigationController.resetAnimationState();
    this.spreadComposer.reset();
    this.overlayCanvas.style.visibility = "";
    this.toolbarController.clearListeners();
    this.uiState.appMode = mode;
    this.uiState.hoverHandle = null;
    this.canvasWrap.dataset.mode = mode;
    this.toolbarController.mountToolbar(mode);

    if (mode === "layout") {
      this.toolbarController.restoreLayoutInputs();
      this.toolbarController.initLayoutListeners();
    } else {
      this.toolbarController.initContentListeners();
    }

    this.redraw();
  }

  bindGlobalListeners() {
    this.canvasInteraction.bindListeners();
    document.getElementById("canvas-zoom-in")?.addEventListener("click", () => this.zoomController.adjustContentZoom(1));
    document.getElementById("canvas-zoom-out")?.addEventListener("click", () => this.zoomController.adjustContentZoom(-1));
    document.getElementById("export-pages-btn")?.addEventListener("click", () => {
      this.toolbarController.closeOpenMenus();
      this.exportController.openModal();
    });
    document.getElementById("save-project-btn")?.addEventListener("click", () => {
      this.toolbarController.closeOpenMenus();
      this.saveProject();
    });
    document.getElementById("interface-colors-btn")?.addEventListener("click", () => {
      this.toolbarController.closeOpenMenus();
      this.interfaceColors.openEditor(this.modalManager);
    });
    document.getElementById("content-file-input")?.addEventListener("change", event => this.handleContentFileInput(event));
    document.getElementById("project-file-input")?.addEventListener("change", event => this.handleProjectFileInput(event));
    document.querySelectorAll(".mode-menu-item").forEach(button =>
      button.addEventListener("click", () => {
        this.switchMode(button.dataset.mode);
        this.toolbarController.closeOpenMenus();
      })
    );
    document.getElementById("show-layout-content")?.addEventListener("change", event => {
      this.uiState.showLayoutContent = event.target.checked;
      this.toolbarController.closeOpenMenus();
      this.redraw();
    });
    document.getElementById("show-margin-arrows")?.addEventListener("change", event => {
      this.uiState.showMarginArrows = event.target.checked;
      this.toolbarController.closeOpenMenus();
      this.redraw();
    });
    document.getElementById("show-page-border")?.addEventListener("change", event => {
      this.uiState.showPageBorder = event.target.checked;
      this.toolbarController.closeOpenMenus();
      this.redraw();
    });
    document.getElementById("paper-thickness")?.addEventListener("input", event => {
      const value = Number(event.target.value);
      if (!Number.isFinite(value)) return;
      this.book.display.paperThickness = Math.max(0, Math.min(1, value));
      this.redraw();
    });
    document.getElementById("paper-texture-strength")?.addEventListener("input", event => {
      const value = Number(event.target.value);
      if (!Number.isFinite(value)) return;
      this.book.display.paperTextureStrength = Math.max(0, Math.min(1, value));
      this.redraw();
    });
    document.getElementById("vdg")?.addEventListener("change", event => {
      this.uiState.showVdG = event.target.checked;
      this.toolbarController.closeOpenMenus();
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
    document.querySelectorAll(".menu-dropdown").forEach(menu => {
      menu.addEventListener("click", event => {
        if (event.target.closest(".menu-panel")) return;
        event.preventDefault();
        menu.open = !menu.open;
      });
    });
    document.addEventListener("click", event => {
      if (event.target.closest(".menu-dropdown")) return;
      this.toolbarController.closeOpenMenus();
    });
    document.addEventListener("dragover", event => {
      event.preventDefault();
    });
    document.addEventListener("drop", event => {
      event.preventDefault();
      if (this.busyIndicator.isExporting) return;
      this.appendFiles(event.dataTransfer.files);
    });
    document.addEventListener("keydown", event => this.canvasInteraction.handleKeyDown(event), true);
    document.addEventListener("mousemove", event => {
      if (this.canvasInteraction.isPanning && this.canvasInteraction.panOrigin) {
        const dx = event.clientX - this.canvasInteraction.panOrigin.clientX;
        const dy = event.clientY - this.canvasInteraction.panOrigin.clientY;
        this.canvasArea.scrollLeft = this.canvasInteraction.panOrigin.scrollLeft - dx;
        this.canvasArea.scrollTop = this.canvasInteraction.panOrigin.scrollTop - dy;
      }
    });
    document.addEventListener("mouseup", () => {
      if (this.canvasInteraction.isPanning) {
        this.canvasInteraction.isPanning = false;
        this.canvasInteraction.panOrigin = null;
        this.canvasInteraction.pendingCanvasClick = null;
        this.canvasInteraction.setCursor("default");
      }
    });
    this.resizeObserver = new ResizeObserver(() => {
      if (this.spreadRenderer.isAnimating) return;
      this.redraw();
    });
    this.resizeObserver.observe(this.canvasArea);
  }

}
