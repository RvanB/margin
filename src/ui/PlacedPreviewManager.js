import { downscaleCanvasToMaxEdgeSync } from "../loading/downscaleCanvas.js";
import { SHARED_PREVIEW_SIZE } from "../previewSizing.js";
import { SpreadRenderer } from "../rendering/SpreadRenderer.js";
import { getSelectedPages } from "../util/helpers.js";

const INTERACTIVE_PREVIEW_SCALE = 0.25;

export class PlacedPreviewManager {
  constructor(app) {
    this.app = app;
    this.dirtyPageIndexes = new Set();
    this.layoutKey = "";
    this.interactiveTimer = 0;
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

  /**
   * Refreshes all placed previews if the layout has changed since the last
   * remembered key. Returns true if a refresh ran, false otherwise.
   */
  refreshIfLayoutChanged() {
    const next = this.getLayoutKey();
    if (next === this.layoutKey) return false;
    this.layoutKey = next;
    this.refreshAll();
    return true;
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

  refresh(pageOrIndex) {
    const app = this.app;
    const pageIndex = typeof pageOrIndex === "number"
      ? pageOrIndex
      : app.book.pages.indexOf(pageOrIndex);
    const page = app.book.pages[pageIndex];
    if (!page) return;
    const sourceCanvas = page.previewCanvas || page.thumbnailSourceCanvas || null;
    if (!sourceCanvas) {
      page.placedPreviewCanvas = null;
      app.pageStrip.invalidateThumbnail(page);
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
    app.pageStrip.invalidateThumbnail(page);
  }

  refreshAll() {
    const app = this.app;
    app.book.pages.forEach((_, pageIndex) => this.refresh(pageIndex));
    app.pageStrip.invalidateAllThumbnails();
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
