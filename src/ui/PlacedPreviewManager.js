import { downscaleCanvasToMaxEdgeSync, SpreadRenderer } from "riffle";
import { SHARED_PREVIEW_SIZE } from "../previewSizing.js";
import { getSelectedPages } from "../util/helpers.js";

const INTERACTIVE_PREVIEW_SCALE = 0.25;
const PRIORITY_REFRESH_RADIUS = 12;
const SETTLED_REFRESH_COUNT = 6;
const SETTLED_REFRESH_BUDGET_MS = 8;
const INTERACTIVE_REFRESH_COUNT = 1;
const INTERACTIVE_REFRESH_BUDGET_MS = 2;

export class PlacedPreviewManager {
  constructor(app) {
    this.app = app;
    this.dirtyPageIndexes = new Set();
    this.layoutKey = "";
    this.interactiveTimer = 0;
    this.refreshAllTimer = 0;
    this.pendingRefreshAll = false;
    this.refreshAllQueue = [];
    this.refreshAllQueueTimer = 0;
  }

  getLayoutKey() {
    const { layout, display } = this.app.book;
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

  rememberLayoutKey() {
    this.layoutKey = this.getLayoutKey();
  }

  get isRefreshAllQueued() {
    return this.pendingRefreshAll || this.refreshAllQueue.length > 0 || !!this.refreshAllQueueTimer;
  }

  /**
   * Refreshes all placed previews if the layout has changed since the last
   * remembered key. Returns true if a refresh ran, false otherwise.
   */
  refreshIfLayoutChanged() {
    const next = this.getLayoutKey();
    if (next === this.layoutKey) return false;
    this.layoutKey = next;
    if (this.app.isInteractiveEdit) {
      this.pendingRefreshAll = true;
      if (!this.refreshAllQueue.length) this.refreshAllQueue = this.#getPrioritizedPageIndexes();
      this.#scheduleRefreshAllChunk();
      return true;
    }
    // Rate-limit refreshAll — for large books each call is hundreds of
    // canvas paints. Live updates feel responsive at ~12 Hz; queued ticks
    // pick up whatever the most recent layout is via this.layoutKey.
    if (this.refreshAllTimer) return true;
    this.refreshAllTimer = setTimeout(() => {
      this.refreshAllTimer = 0;
      this.refreshAll({ chunked: true });
    }, 80);
    return true;
  }

  flushPendingRefreshAll() {
    if (!this.pendingRefreshAll) return;
    this.pendingRefreshAll = false;
    this.refreshAll({ chunked: true });
  }

  pauseBackgroundRefresh() {
    if (this.refreshAllTimer) {
      clearTimeout(this.refreshAllTimer);
      this.refreshAllTimer = 0;
      this.pendingRefreshAll = true;
    }
    if (this.pendingRefreshAll && !this.refreshAllQueue.length) {
      this.refreshAllQueue = this.#getPrioritizedPageIndexes();
    }
    if (this.refreshAllQueue.length) this.#scheduleRefreshAllChunk();
  }

  markDirty(pageOrIndex) {
    const pageIndex = typeof pageOrIndex === "number"
      ? pageOrIndex
      : this.app.book.pages.indexOf(pageOrIndex);
    if (pageIndex < 0) return;
    this.dirtyPageIndexes.add(pageIndex);
  }

  markPagesDirty(pages) {
    for (const page of pages) this.markDirty(page);
  }

  flushDirty() {
    if (!this.dirtyPageIndexes.size) return;
    const dirty = [...this.dirtyPageIndexes];
    this.dirtyPageIndexes.clear();
    dirty.forEach(pageIndex => this.refresh(pageIndex));
  }

  refresh(pageOrIndex, { repaintThumbnail = false } = {}) {
    const app = this.app;
    const pageIndex = typeof pageOrIndex === "number"
      ? pageOrIndex
      : app.book.pages.indexOf(pageOrIndex);
    const page = app.book.pages[pageIndex];
    if (!page) return;
    const sourceCanvas = page.previewCanvas || page.thumbnailSourceCanvas || null;
    if (!sourceCanvas) {
      page.placedPreviewCanvas = null;
      app.pageStrip.invalidateThumbnail(pageIndex);
      return;
    }
    const previewRenderer = typeof app.spreadRenderer.getPlacedPagePreview === "function"
      ? app.spreadRenderer
      : new SpreadRenderer(document.createElement("canvas"));
    page.placedPreviewCanvas = previewRenderer.getPlacedPagePreview(
      page,
      app.spreadComposer.getEffectEntry(page),
      app.book.display,
      {
        sourceCanvas,
        layout: app.book.layout,
        side: pageIndex % 2 === 1 ? "left" : "right",
        pageHeight: SHARED_PREVIEW_SIZE,
      }
    );
    this.dirtyPageIndexes.delete(pageIndex);
    if (repaintThumbnail) {
      const viewerPage = app.viewerBook.pages[pageIndex];
      if (viewerPage) app.pageStrip.updateThumbnail(pageIndex, viewerPage);
    } else {
      app.pageStrip.invalidateThumbnail(pageIndex);
    }
  }

  refreshAll({ chunked = false } = {}) {
    this.pendingRefreshAll = false;
    if (this.refreshAllQueueTimer) {
      cancelAnimationFrame(this.refreshAllQueueTimer);
      this.refreshAllQueueTimer = 0;
    }
    const app = this.app;
    if (chunked) {
      this.refreshAllQueue = this.#getPrioritizedPageIndexes();
      this.#scheduleRefreshAllChunk();
      return;
    }
    this.refreshAllQueue = [];
    app.book.pages.forEach((_, pageIndex) => this.refresh(pageIndex));
    app.pageStrip.invalidateAllThumbnails();
  }

  #scheduleRefreshAllChunk() {
    if (this.refreshAllQueueTimer) return;
    this.refreshAllQueueTimer = requestAnimationFrame(() => {
      this.refreshAllQueueTimer = 0;
      this.#runRefreshAllChunk();
    });
  }

  #runRefreshAllChunk() {
    const started = performance.now();
    const interactive = this.app.isInteractiveEdit;
    const maxCount = interactive ? INTERACTIVE_REFRESH_COUNT : SETTLED_REFRESH_COUNT;
    const maxMs = interactive ? INTERACTIVE_REFRESH_BUDGET_MS : SETTLED_REFRESH_BUDGET_MS;
    let count = 0;
    while (this.refreshAllQueue.length && count < maxCount && performance.now() - started < maxMs) {
      const pageIndex = this.refreshAllQueue.shift();
      this.refresh(pageIndex, { repaintThumbnail: true });
      count += 1;
    }
    if (this.refreshAllQueue.length) {
      this.#scheduleRefreshAllChunk();
      return;
    }
  }

  #getPriorityCenterPageIndex() {
    const app = this.app;
    if (
      app.uiState.appMode === "content" &&
      app.uiState.editingPageIdx >= 0 &&
      app.uiState.editingPageIdx < app.book.pages.length
    ) {
      return app.uiState.editingPageIdx;
    }
    const spreadIndex = app.navigationController.getEffectiveSpread();
    const { left, right } = app.viewerBook.spreadPageEntries(spreadIndex);
    if (left.pageIndex >= 0) return left.pageIndex;
    if (right.pageIndex >= 0) return right.pageIndex;
    return 0;
  }

  #getPrioritizedPageIndexes() {
    const pageCount = this.app.book.pages.length;
    if (!pageCount) return [];
    const center = Math.max(0, Math.min(pageCount - 1, this.#getPriorityCenterPageIndex()));
    const indexes = [];
    const seen = new Set();
    const push = pageIndex => {
      if (pageIndex < 0 || pageIndex >= pageCount || seen.has(pageIndex)) return;
      seen.add(pageIndex);
      indexes.push(pageIndex);
    };

    push(center);
    for (let offset = 1; offset <= PRIORITY_REFRESH_RADIUS; offset += 1) {
      push(center - offset);
      push(center + offset);
    }
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) push(pageIndex);
    return indexes;
  }

  #getInteractiveCanvas(page) {
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

  beginInteractive(pages = getSelectedPages(this.app.book, this.app.uiState), delay = 120) {
    this.pauseBackgroundRefresh();
    let activated = false;
    for (const page of pages) {
      const interactiveCanvas = this.#getInteractiveCanvas(page);
      if (!interactiveCanvas) continue;
      if (page.displayCanvasOverride === interactiveCanvas) continue;
      page.displayCanvasOverride = interactiveCanvas;
      activated = true;
    }
    if (!activated && !this.interactiveTimer) return;
    if (this.interactiveTimer) clearTimeout(this.interactiveTimer);
    this.interactiveTimer = setTimeout(() => {
      this.interactiveTimer = 0;
      this.endInteractive();
    }, delay);
  }

  endInteractive({ redraw = true } = {}) {
    if (this.interactiveTimer) {
      clearTimeout(this.interactiveTimer);
      this.interactiveTimer = 0;
    }
    let changed = false;
    for (const page of this.app.book.pages) {
      if (!page?.displayCanvasOverride) continue;
      page.displayCanvasOverride = null;
      changed = true;
    }
    if (changed && redraw) this.app.redraw();
  }
}
