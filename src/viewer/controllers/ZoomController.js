import { computeMargins, computeScale } from "../rendering/layout.js";

const CONTENT_ZOOM_MIN = 0.5;
const CONTENT_ZOOM_MAX = 6;
const CONTENT_ZOOM_STEP = 1.25;
const MAX_RENDER_CANVAS_EDGE = 8192;

export class ZoomController {
  constructor(app) {
    this.app = app;
    this.contentZoom = 1;
    this.renderZoom = 1;
  }

  getCanvasViewportSize() {
    const rect = this.app.canvasArea.getBoundingClientRect();
    return {
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    };
  }

  getRenderScale() {
    const viewport = this.getCanvasViewportSize();
    const containerWidth = Math.max(1, viewport.width - 64);
    const containerHeight = Math.max(1, viewport.height - 64);
    const baseScale = computeScale(this.app.book.layout, containerWidth, containerHeight);
    return baseScale * this.renderZoom;
  }

  getSafeRenderZoom(targetZoom = this.contentZoom) {
    const viewport = this.getCanvasViewportSize();
    const containerWidth = Math.max(1, viewport.width - 64);
    const containerHeight = Math.max(1, viewport.height - 64);
    const baseScale = computeScale(this.app.book.layout, containerWidth, containerHeight);
    const baseMargins = computeMargins(this.app.book.layout, baseScale);
    const maxWidthZoom = (2 * baseMargins.pagePxW) > 0
      ? MAX_RENDER_CANVAS_EDGE / (2 * baseMargins.pagePxW)
      : targetZoom;
    const maxHeightZoom = baseMargins.pagePxH > 0
      ? MAX_RENDER_CANVAS_EDGE / baseMargins.pagePxH
      : targetZoom;
    return Math.max(CONTENT_ZOOM_MIN, Math.min(targetZoom, maxWidthZoom, maxHeightZoom));
  }

  syncCanvasStage() {
    const { canvasStage, canvasWrap, spreadCanvas, uiState } = this.app;
    if (canvasStage) {
      const displayScale = this.renderZoom > 0 ? this.contentZoom / this.renderZoom : this.contentZoom;
      canvasStage.style.width = `${Math.max(1, Math.round(spreadCanvas.width * displayScale))}px`;
      canvasStage.style.height = `${Math.max(1, Math.round(spreadCanvas.height * displayScale))}px`;
      canvasStage.classList.toggle("show-page-shadow", uiState.showPageBorder);
    }
    canvasWrap.dataset.mode = uiState.appMode;
    this.syncZoomUI();
  }

  syncZoomUI() {
    const zoomIn = document.getElementById("canvas-zoom-in");
    const zoomOut = document.getElementById("canvas-zoom-out");
    if (!zoomIn || !zoomOut) return;
    zoomIn.disabled = this.contentZoom >= CONTENT_ZOOM_MAX;
    zoomOut.disabled = this.contentZoom <= CONTENT_ZOOM_MIN;
  }

  #zoomTo(nextZoom) {
    if (Math.abs(nextZoom - this.contentZoom) < 0.0001) return;
    const { canvasArea } = this.app;
    const viewportWidth = canvasArea.clientWidth;
    const viewportHeight = canvasArea.clientHeight;
    const centerX = canvasArea.scrollLeft + viewportWidth / 2;
    const centerY = canvasArea.scrollTop + viewportHeight / 2;
    const zoomRatio = nextZoom / this.contentZoom;

    this.contentZoom = nextZoom;
    // Update the canvas's CSS dimensions immediately so the existing pixel
    // buffer is shown stretched (or shrunk) to the new zoom. No redraw and
    // no renderZoom change here — the existing surface textures stay in
    // place and WebGPU bilinearly samples them onto the new pageRect. When
    // higher-res bitmaps land via the worker, App.onPageReady updates
    // renderZoom and redraws against the new bitmap.
    this.syncCanvasStage();
    requestAnimationFrame(() => {
      canvasArea.scrollLeft = Math.max(0, centerX * zoomRatio - viewportWidth / 2);
      canvasArea.scrollTop = Math.max(0, centerY * zoomRatio - viewportHeight / 2);
    });
    this.#requestHighResAtCurrentZoom();
  }

  #requestHighResAtCurrentZoom() {
    const app = this.app;
    const targetSpread = app.navigationController.getEffectiveSpread();
    if (targetSpread < 0 || targetSpread >= app.viewerBook.numSpreads()) return;
    const { left, right } = app.viewerBook.spreadPageEntries(targetSpread);
    for (const pageIndex of [left.pageIndex, right.pageIndex]) {
      if (pageIndex < 0) continue;
      if (app.lazyPageLoader.isPageHighResReady(pageIndex, this.contentZoom)) continue;
      app.lazyPageLoader.ensurePageHighRes(pageIndex, this.contentZoom);
    }
  }

  adjustContentZoom(direction) {
    const multiplier = direction > 0 ? CONTENT_ZOOM_STEP : 1 / CONTENT_ZOOM_STEP;
    const nextZoom = Math.max(CONTENT_ZOOM_MIN, Math.min(CONTENT_ZOOM_MAX, this.contentZoom * multiplier));
    this.#zoomTo(nextZoom);
  }

  resetContentZoom() {
    this.#zoomTo(1);
  }

  applySafeRenderZoom() {
    const next = this.getSafeRenderZoom(this.contentZoom);
    if (Math.abs(this.renderZoom - next) < 0.0001) return false;
    this.renderZoom = next;
    return true;
  }

  isSpreadHighResReady(spreadIndex, previewZoom = this.contentZoom) {
    const { viewerBook, lazyPageLoader } = this.app;
    if (spreadIndex < 0 || spreadIndex >= viewerBook.numSpreads()) return true;
    const { left, right } = viewerBook.spreadPageEntries(spreadIndex);
    return [left.pageIndex, right.pageIndex]
      .filter(index => index >= 0)
      .every(index => lazyPageLoader.isPageHighResReady(index, previewZoom));
  }
}
