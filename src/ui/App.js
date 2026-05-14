import { Book } from "../model/Book.js";
import { composePageCanvas } from "../composition/PageComposer.js";
import {
  BookViewer,
  ImagePageSource,
  PageStrip,
  computeMargins,
  SpreadRenderer,
} from "riffle";
import { renderOverlay } from "./OverlayRenderer.js";
import { BusyIndicator } from "./BusyIndicator.js";
import { CanvasInteraction } from "./CanvasInteraction.js";
import { ExportController } from "./ExportController.js";
import { InterfaceColors } from "./InterfaceColors.js";
import { ModalManager } from "./ModalManager.js";
import { PlacedPreviewManager } from "./PlacedPreviewManager.js";
import { SpreadComposer } from "./SpreadComposer.js";
import { ToolbarController } from "./ToolbarController.js";
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
      showMarginArrows: false,
      showLayoutContent: true,
      showPageBorder: true,
      showVdG: false,
    };
    this.layoutControlsState = {
      preserveRatio: false,
      ratioSameAsPage: true,
    };
    this.busyIndicator = new BusyIndicator();
    this.lastMargins = computeMargins(this.book.layout, 1);
    // The page source bridges the margin app's Book/Page model to the viewer.
    // Until Phase 3 decouples composition, the metadata's `passthrough` field
    // is the app's Page instance — the renderer reads its placement fields
    // (crop, fitAxis, etc.) and the lazy loader writes bitmaps onto it.
    this.pageSource = new ImagePageSource({
      getPageCount: () => this.book.pages.length,
      getPageMetadata: index => {
        const page = this.book.pages[index] ?? null;
        if (!page) return null;
        return { aspectRatio: page.aspectRatio, passthrough: page };
      },
      // The viewer's LazyPageLoader writes srcCanvas/previewCanvas onto our
      // app.book.Page instances; expose the book so it can find them.
      internalBook: this.book,
    });
    this.bookViewer = new BookViewer({
      spreadCanvas,
      viewport: document.getElementById("canvas-area"),
      rendererClass,
      source: this.pageSource,
      layout: this.book.layout,
      display: this.book.display,
    });
    this.pageStrip = new PageStrip(stripContainer, {
      onPageClick: (pageIndex, event) => this.handlePageStripClick(pageIndex, event),
      getEffectEntry: page => this.getEffectEntry(page),
      getDisplay: () => this.book.display,
      getLayout: () => this.book.layout,
    });
    // Wire viewer events to keep the margin-owned page strip in sync.
    this.bookViewer.on("sourcechange", () => this.pageStrip.update(this.viewerBook, this.#stripState()));
    this.bookViewer.on("spreadchange", ({ spreadIndex }) => {
      this.uiState.currentSpread = spreadIndex;
      this.uiState.effectiveSpread = spreadIndex;
      // Move the editing selection onto the new spread's pages so crop
      // handles, the per-page toolbar, etc. apply to the newly-visible
      // page. Prefer the right page (or the only page on the cover).
      this.#selectSpreadForEditing(spreadIndex);
      this.pageStrip.update(this.viewerBook, this.#stripState());
    });
    // Scroll-track the strip with each in-flight navigation step (including
    // every spread of a queued multi-spread turn).
    this.bookViewer.on("effectivespreadchange", ({ spreadIndex }) => {
      this.uiState.effectiveSpread = spreadIndex;
      this.pageStrip.update(this.viewerBook, this.#stripState());
    });
    this.bookViewer.on("pageready", ({ pageIndex }) => {
      // Compose first so the viewer's subsequent redraw reads through
      // composedDisplayCanvas / composedPreviewCanvas instead of the raw
      // PDF rasterization. (Riffle emits "pageready" before its internal
      // redraw exactly so hosts can do this.)
      this.composePage(pageIndex);
      const viewerPage = this.viewerBook.pages[pageIndex];
      if (viewerPage) this.pageStrip.updateThumbnail(pageIndex, viewerPage);
      this.placedPreviewManager.refresh(pageIndex);
    });
    this.spreadRenderer = this.bookViewer.spreadRenderer;
    this.lazyPageLoader = this.bookViewer.lazyPageLoader;
    this.navigationController = this.bookViewer.navigationController;
    this.zoomController = this.bookViewer.zoomController;
    globalThis.__rendererBackend = this.spreadRenderer.backendName;
    document.documentElement.dataset.rendererBackend = this.spreadRenderer.backendName;
    this.exportController = new ExportController({
      book: this.book,
      spreadRenderer: this.spreadRenderer,
      modalManager: this.modalManager,
      busyIndicator: this.busyIndicator,
      getEffectEntry: page => this.getEffectEntry(page),
    });
    this.canvasInteraction = new CanvasInteraction(this);
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

  // The viewer's view of the book — exposes ViewerPages with bitmap getters
  // proxied to the app's Page. Code that asks "what spread is this", "what
  // are the pages on this spread", or "how many spreads exist" should read
  // through this so the viewer's data flow is single-source.
  get viewerBook() {
    return this.bookViewer.book;
  }

  // Spread rects from the viewer's latest render, gated by whether
  // interactions should be live (i.e., content mode or layout mode with
  // content shown). Used by CanvasInteraction for hit-testing.
  getInteractionSpreadRects() {
    if (!this.spreadComposer.shouldExposeSpreadRects()) return null;
    return this.bookViewer.getSpreadGeometry()?.spreadRects ?? null;
  }

  #stripState() {
    return {
      ...this.uiState,
      selectedPageIdxs: cloneSet(this.uiState.selectedPageIdxs),
      effectiveSpread: this.navigationController.getEffectiveSpread(),
    };
  }

  #selectSpreadForEditing(spreadIndex) {
    if (this.uiState.appMode !== "content") return;
    const { left, right } = this.viewerBook.spreadPageEntries(spreadIndex);
    const candidates = [left.pageIndex, right.pageIndex].filter(i => i >= 0 && i < this.viewerBook.pages.length);
    if (!candidates.length) return;
    // Keep the previously-edited page if it's on this spread; otherwise
    // default to the left page (or the right one if there's no left).
    const previous = this.uiState.editingPageIdx;
    const next = candidates.includes(previous) ? previous : candidates[0];
    if (next === previous && this.uiState.selectedPageIdxs.size === 1 && this.uiState.selectedPageIdxs.has(next)) return;
    this.placedPreviewManager.endInteractive({ redraw: false });
    this.placedPreviewManager.flushDirty();
    this.uiState.editingPageIdx = next;
    this.uiState.selectedPageIdxs = new Set([next]);
    this.toolbarController.syncPageUI();
  }

  getEffectEntry(page) {
    return this.spreadComposer.getEffectEntry(page);
  }

  // Compose a page's bitmaps into "ready to display" canvases. Called when
  // a fresh source bitmap arrives via LazyPageLoader, and whenever
  // layout/page settings change. The viewer reads these via ViewerPage's
  // displayCanvas / previewCanvas getters.
  composePage(pageIndex) {
    const page = this.book.pages[pageIndex];
    if (!page) return;
    const sideName = pageIndex % 2 === 1 ? "left" : "right";
    const layout = this.book.layout;
    if (page.srcCanvas) {
      page.composedDisplayCanvas = composePageCanvas({
        page,
        sourceBitmap: page.srcCanvas,
        layout,
        sideName,
      });
    } else {
      page.composedDisplayCanvas = null;
    }
    if (page.previewCanvas) {
      page.composedPreviewCanvas = composePageCanvas({
        page,
        sourceBitmap: page.previewCanvas,
        layout,
        sideName,
      });
    } else {
      page.composedPreviewCanvas = null;
    }
  }

  composeAllLoadedPages() {
    this.book.pages.forEach((_, pageIndex) => this.composePage(pageIndex));
  }

  #composeVisibleSpread() {
    // bookViewer owns the navigation state; margin's uiState.currentSpread
    // is stale unless we explicitly sync it. Read from the viewer.
    const spreadIndex = this.bookViewer.currentSpread;
    if (spreadIndex < 0) return;
    const { left, right } = this.viewerBook.spreadPageEntries(spreadIndex);
    if (left?.pageIndex >= 0) this.composePage(left.pageIndex);
    if (right?.pageIndex >= 0) this.composePage(right.pageIndex);
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

    const maxSpread = Math.max(0, this.viewerBook.numSpreads() - 1);
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
    this.uiState.currentSpread = Math.min(this.uiState.currentSpread, this.viewerBook.numSpreads() - 1);
    this.uiState.effectiveSpread = this.navigationController.getEffectiveSpread();
    this.toolbarController.updateComputedRows(margins);
    this.canvasInteraction.refreshDragCursor();

    // Push margin-owned settings into the viewer in case they changed.
    this.bookViewer.layout = this.book.layout;
    this.bookViewer.display = this.book.display;
    this.bookViewer.showPageBorder = this.uiState.showPageBorder;

    // Compose visible pages so their composedDisplayCanvas is fresh before
    // the viewer reads through ViewerPage.displayCanvas during its render.
    this.#composeVisibleSpread();

    // Viewer renders. It uses its internal LazyPageLoader against our
    // app.book (because ImagePageSource.getInternalBook returns it) and
    // reads display/layout off bookViewer (which we just synced).
    this.bookViewer.redraw();

    const geometry = this.bookViewer.getSpreadGeometry();
    this.overlayCanvas.width = this.spreadCanvas.width;
    this.overlayCanvas.height = this.spreadCanvas.height;

    if (!this.spreadRenderer.isAnimating) {
      renderOverlay(this.overlayCtx, margins, this.uiState, {
        paperColor: this.book.display.paperColor,
        spreadRects: this.spreadComposer.shouldExposeSpreadRects()
          ? geometry?.spreadRects ?? null
          : null,
        spreadSideStates: geometry?.sideStates ?? null,
      });
    }

    this.pageStrip.update(this.viewerBook, this.#stripState());
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
    // Delegate to the viewer — it does the same work (LRU prefetch +
    // safe-render-zoom + redraw) and is also called internally on
    // navigation/zoom changes.
    this.bookViewer.schedulePreviewRedraw();
  }

  #prefetchAdjacentHighRes(targetSpread) {
    // While settled on a spread, pre-render high-res for ±1 spreads at low
    // priority so next/prev navigation feels instant. If the user navigates
    // before the prefetch finishes, the queued render either jumps ahead
    // (via priority on the new kickoff) or, if already in flight, is what
    // the navigation is waiting on anyway — same as if we hadn't prefetched.
    const numSpreads = this.viewerBook.numSpreads();
    for (const adj of [targetSpread - 1, targetSpread + 1]) {
      if (adj < 0 || adj >= numSpreads) continue;
      const { left, right } = this.viewerBook.spreadPageEntries(adj);
      for (const pageIndex of [left.pageIndex, right.pageIndex]) {
        if (pageIndex < 0) continue;
        if (this.lazyPageLoader.isPageHighResReady(pageIndex, this.contentZoom)) continue;
        this.lazyPageLoader.ensurePageHighRes(pageIndex, this.contentZoom, { priority: false });
      }
    }
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
      this.pageSource.notifyPageCountChanged();
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
    const viewerPage = this.viewerBook.pages[pageIndex] ?? null;
    if (!page) return;
    // Always compose on bitmap arrival — this is how pages that aren't the
    // current spread (e.g., intermediate spreads in a queued multi-spread
    // turn, or any neighbor whose preview just loaded) end up with margins
    // applied. Composing the preview alone is cheap; the visible spread
    // gets composed again in #composeVisibleSpread but the cost is small.
    this.composePage(pageIndex);
    if (this.spreadRenderer.isAnimating) {
      // Re-point active scenes' pinned source canvases at the new bitmap.
      // Scenes hold ViewerPage refs, so we pass the ViewerPage (not the
      // app's Page). The next `#drawPageSurface` for an affected side will
      // rebuild its texture upload once (a one-frame cost), then steady-
      // state resumes.
      if (viewerPage) this.spreadRenderer.refreshPageSource?.(viewerPage);
      // Defer placed-preview rebuild and thumbnail repaint until the turn
      // settles — both are main-thread 2D paints, and a warming book floods
      // this callback hundreds of times during user navigation.
      this.placedPreviewManager.markDirty(pageIndex);
      return;
    }
    // Swap the visible spread to the new bitmap first so the user sees the
    // upgrade immediately. The placed-preview rebuild + strip thumbnail
    // repaint follow — they're main-thread 2D paints and would otherwise
    // delay the perceived swap by ~5–30 ms.
    const { left, right } = this.viewerBook.spreadPageEntries(this.uiState.currentSpread);
    const isOnCurrentSpread = pageIndex === left.pageIndex || pageIndex === right.pageIndex;
    if (isOnCurrentSpread) {
      // Catch renderZoom up to contentZoom now that a sharper bitmap is in
      // hand. Doing this *before* the redraw means the surface canvases are
      // built once at the new dims with the new bitmap, instead of redrawing
      // at the old renderZoom and then redrawing again from
      // schedulePreviewRedraw.
      this.zoomController.applySafeRenderZoom();
      this.redraw();
    }
    this.placedPreviewManager.refresh(pageIndex);
    if (viewerPage) this.pageStrip.updateThumbnail(pageIndex, viewerPage);
    if (isOnCurrentSpread) this.schedulePreviewRedraw();
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
