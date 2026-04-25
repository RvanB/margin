import { autoCrop } from "../effects/cpu.js";
import { applyEffectsToCanvas } from "../effects/pipeline.js";
import { downscaleCanvasToMaxEdge } from "./downscaleCanvas.js";
import { renderPdfPage, requestPdfDocumentCleanup } from "./pdfLoader.js";

export class LazyPageLoader {
  constructor(book, onPageReady, { pdfRenderScale = 1.5, pdfPreviewSourceScale = 0.25, pdfPreviewMaxEdge = 96 } = {}) {
    this.book = book;
    this.onPageReady = onPageReady;
    this.pdfRenderScale = pdfRenderScale;
    this.pdfPreviewSourceScale = pdfPreviewSourceScale;
    this.pdfPreviewMaxEdge = pdfPreviewMaxEdge;
    this.lastEnsuredSpread = -1;
    this.lastEnsuredPreviewZoom = 1;
    this.previewQueue = [];
    this.previewQueued = new Set();
    this.previewRendering = false;
  }

  #getHighResPixelRatio() {
    return Math.max(1, globalThis.devicePixelRatio || 1);
  }

  reset() {
    this.lastEnsuredSpread = -1;
    this.lastEnsuredPreviewZoom = 1;
    this.previewQueue = [];
    this.previewQueued.clear();
    this.previewRendering = false;
  }

  ensureSpreadLoaded(spreadIndex, previewZoom = 1, { allowHighRes = true } = {}) {
    this.lastEnsuredSpread = spreadIndex;
    this.lastEnsuredPreviewZoom = Math.max(1, previewZoom || 1);
    const targetPdfRenderScale = this.pdfRenderScale
      * this.lastEnsuredPreviewZoom
      * this.#getHighResPixelRatio();
    const spreadCount = this.book.numSpreads();
    for (
      let spread = Math.max(0, spreadIndex - 1);
      spread <= Math.min(spreadCount - 1, spreadIndex + 1);
      spread += 1
    ) {
      const { left, right } = this.book.spreadPageEntries(spread);
      if (left.pageIndex >= 0) {
        this.#ensurePreviewLoaded(left.pageIndex, spread === spreadIndex);
        if (allowHighRes) this.#ensurePageLoaded(left.pageIndex, targetPdfRenderScale);
      }
      if (right.pageIndex >= 0 && right.pageIndex < this.book.pages.length) {
        this.#ensurePreviewLoaded(right.pageIndex, spread === spreadIndex);
        if (allowHighRes) this.#ensurePageLoaded(right.pageIndex, targetPdfRenderScale);
      }
    }

    const keep = new Set();
    const keepWindow = 3;
    for (
      let spread = Math.max(0, spreadIndex - keepWindow);
      spread <= Math.min(spreadCount - 1, spreadIndex + keepWindow);
      spread += 1
    ) {
      const { left, right } = this.book.spreadPageEntries(spread);
      if (left.pageIndex >= 0) keep.add(left.pageIndex);
      if (right.pageIndex >= 0) keep.add(right.pageIndex);
    }

    this.book.pages.forEach((_, pageIndex) => {
      if (!keep.has(pageIndex)) this.#unloadPage(pageIndex);
    });
  }

  warmAllPreviews() {
    for (let pageIndex = 0; pageIndex < this.book.pages.length; pageIndex += 1) {
      this.#ensurePreviewLoaded(pageIndex);
    }
  }

  #ensurePreviewLoaded(pageIndex, prioritize = false) {
    const page = this.book.pages[pageIndex];
    if (!page || page.source?.type !== "pdf" || page.previewCanvas || this.previewQueued.has(pageIndex)) return;
    this.previewQueued.add(pageIndex);
    if (prioritize) this.previewQueue.unshift(pageIndex);
    else this.previewQueue.push(pageIndex);
    this.#drainPreviewQueue();
  }

  async #drainPreviewQueue() {
    if (this.previewRendering) return;
    this.previewRendering = true;
    while (this.previewQueue.length) {
      const pageIndex = this.previewQueue.shift();
      this.previewQueued.delete(pageIndex);
      const page = this.book.pages[pageIndex];
      if (!page || page.previewCanvas || page.source?.type !== "pdf") continue;
      try {
        const previewSource = await renderPdfPage(
          page.source.pdfDoc,
          page.source.pageNum,
          this.pdfPreviewSourceScale
        );
        if (!page.cropInitialized || page.cropDirty) {
          page.setCropFor(
            previewSource,
            autoCrop(applyEffectsToCanvas(previewSource, page.effects), page.tolerance)
          );
          page.cropInitialized = true;
          page.cropDirty = true;
        }
        const previewCanvas = await downscaleCanvasToMaxEdge(previewSource, this.pdfPreviewMaxEdge);
        page.previewCanvas = previewCanvas;
        if (!page.thumbnailSourceCanvas) page.thumbnailSourceCanvas = previewCanvas;
        if (previewSource !== previewCanvas) {
          previewSource.width = 0;
          previewSource.height = 0;
        }
        this.onPageReady?.(pageIndex);
      } catch (error) {
        console.error(`Failed to render PDF preview ${page.source?.pageNum}:`, error);
      }
    }
    this.previewRendering = false;
  }

  async #ensurePageLoaded(pageIndex, targetPdfRenderScale = this.pdfRenderScale) {
    const page = this.book.pages[pageIndex];
    const minimumHighResScale = this.pdfRenderScale * this.#getHighResPixelRatio();
    const requestedScale = Math.max(
      minimumHighResScale,
      targetPdfRenderScale || minimumHighResScale
    ) * 2;
    if (!page || page.source?.type !== "pdf") return;
    page.requestedPdfRenderScale = Math.max(page.requestedPdfRenderScale || 0, requestedScale);
    if (page.loading) return;
    if (page.srcCanvas && (page.loadedPdfRenderScale || this.pdfRenderScale) >= requestedScale) return;

    page.loading = true;
    try {
      const renderScale = Math.max(
        minimumHighResScale,
        page.requestedPdfRenderScale || requestedScale
      );
      const prevCanvas = page.srcCanvas;
      const prevSource = prevCanvas || page.previewCanvas;
      const prevWidth = prevSource?.width || 0;
      const prevHeight = prevSource?.height || 0;
      const canvas = await renderPdfPage(page.source.pdfDoc, page.source.pageNum, renderScale);
      page.srcCanvas = canvas;
      if (!page.previewCanvas) {
        const previewCanvas = await downscaleCanvasToMaxEdge(canvas, this.pdfPreviewMaxEdge);
        page.previewCanvas = previewCanvas;
        if (!page.thumbnailSourceCanvas) page.thumbnailSourceCanvas = previewCanvas;
      } else if (!page.thumbnailSourceCanvas) {
        page.thumbnailSourceCanvas = page.previewCanvas;
      }
      page.loadedPdfRenderScale = renderScale;
      page.aspectRatio = canvas.width / canvas.height;
      page.loading = false;
      if (!page.cropInitialized || page.cropDirty) {
        page.setCropFor(canvas, autoCrop(applyEffectsToCanvas(canvas, page.effects), page.tolerance));
        page.cropInitialized = true;
      }
      this.onPageReady?.(pageIndex);
      this.#requestSpreadCleanupIfReady(pageIndex, requestedScale);
      if ((page.requestedPdfRenderScale || renderScale) > renderScale + 1e-3) {
        setTimeout(() => this.#ensurePageLoaded(pageIndex, page.requestedPdfRenderScale), 0);
      }
    } catch (error) {
      page.loading = false;
      console.error(`Failed to render PDF page ${page.source?.pageNum}:`, error);
    }
  }

  #requestSpreadCleanupIfReady(pageIndex, targetPdfRenderScale) {
    const spreadIndex = Math.floor((pageIndex + 1) / 2);
    if (spreadIndex !== this.lastEnsuredSpread) return;
    const { left, right } = this.book.spreadPageEntries(spreadIndex);
    const pages = [left.pageIndex, right.pageIndex]
      .filter(index => index >= 0)
      .map(index => this.book.pages[index])
      .filter(page => page?.source?.type === "pdf");
    if (!pages.length) return;
    const spreadReady = pages.every(page =>
      !!page.srcCanvas &&
      !page.loading &&
      (page.loadedPdfRenderScale || 0) >= targetPdfRenderScale
    );
    if (!spreadReady) return;
    const docs = new Set(pages.map(page => page.source?.pdfDoc).filter(Boolean));
    docs.forEach(pdfDoc => requestPdfDocumentCleanup(pdfDoc));
  }

  #unloadPage(pageIndex) {
    const page = this.book.pages[pageIndex];
    if (!page || !page.srcCanvas || page.source?.type !== "pdf") return;
    page.srcCanvas = null;
    page.loadedPdfRenderScale = 0;
    page.requestedPdfRenderScale = 0;
  }
}
