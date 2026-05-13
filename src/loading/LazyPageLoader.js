import { SHARED_PREVIEW_SIZE } from "../previewSizing.js";
import { loadImageFile } from "./imageLoader.js";
import { renderPdfPage, requestPdfDocumentCleanup } from "./pdfLoader.js";

function closeBitmap(bitmap) {
  if (bitmap && typeof bitmap.close === "function") bitmap.close();
}

export class LazyPageLoader {
  constructor(book, onPageReady, { pdfRenderScale = 1.5, pdfPreviewSourceScale = 0.25, pdfPreviewMaxEdge = SHARED_PREVIEW_SIZE } = {}) {
    this.book = book;
    this.onPageReady = onPageReady;
    this.pdfRenderScale = pdfRenderScale;
    this.pdfPreviewSourceScale = pdfPreviewSourceScale;
    this.pdfPreviewMaxEdge = pdfPreviewMaxEdge;
    this.lastEnsuredSpread = -1;
    this.lastEnsuredPreviewZoom = 1;
    this.keepPageIndexes = new Set();
    this.previewQueue = [];
    this.previewQueued = new Set();
    this.previewRendering = false;
    this.pageReadyWaiters = new Map();
  }

  #getHighResPixelRatio() {
    return Math.max(1, globalThis.devicePixelRatio || 1);
  }

  #getTargetPdfRenderScale(previewZoom = 1) {
    return this.pdfRenderScale
      * Math.max(1, previewZoom || 1)
      * this.#getHighResPixelRatio();
  }

  #getRequiredPageRenderScale(pageIndex, previewZoom = 1) {
    const page = this.book.pages[pageIndex];
    if (!page || page.source?.type !== "pdf") return 0;
    const minimumHighResScale = this.pdfRenderScale * this.#getHighResPixelRatio();
    return Math.max(
      minimumHighResScale,
      this.#getTargetPdfRenderScale(previewZoom)
    ) * 1.5;
  }

  #resolvePageReadyWaiters(pageIndex) {
    const waiters = this.pageReadyWaiters.get(pageIndex);
    if (!waiters?.length) return;
    const pending = [];
    for (const waiter of waiters) {
      if (this.isPageHighResReady(pageIndex, waiter.previewZoom)) {
        waiter.resolve(true);
      } else {
        pending.push(waiter);
      }
    }
    if (pending.length) this.pageReadyWaiters.set(pageIndex, pending);
    else this.pageReadyWaiters.delete(pageIndex);
  }

  reset() {
    this.lastEnsuredSpread = -1;
    this.lastEnsuredPreviewZoom = 1;
    this.keepPageIndexes = new Set();
    this.previewQueue = [];
    this.previewQueued.clear();
    this.previewRendering = false;
  }

  #buildKeepSet(spreadIndex, extraSpreadIndexes = []) {
    const keep = new Set();
    const spreads = new Set([spreadIndex, ...extraSpreadIndexes]);
    for (const keptSpreadIndex of spreads) {
      if (keptSpreadIndex < 0 || keptSpreadIndex >= this.book.numSpreads()) continue;
      const { left, right } = this.book.spreadPageEntries(keptSpreadIndex);
      if (left.pageIndex >= 0) keep.add(left.pageIndex);
      if (right.pageIndex >= 0) keep.add(right.pageIndex);
    }
    return keep;
  }

  ensureSpreadLoaded(spreadIndex, previewZoom = 1, { allowHighRes = true, extraKeepSpreadIndexes = [] } = {}) {
    this.lastEnsuredSpread = spreadIndex;
    this.lastEnsuredPreviewZoom = Math.max(1, previewZoom || 1);
    const targetPdfRenderScale = this.#getTargetPdfRenderScale(this.lastEnsuredPreviewZoom);
    const spreadCount = this.book.numSpreads();
    const keep = this.#buildKeepSet(spreadIndex, extraKeepSpreadIndexes);
    this.keepPageIndexes = keep;
    for (
      let spread = Math.max(0, spreadIndex - 1);
      spread <= Math.min(spreadCount - 1, spreadIndex + 1);
      spread += 1
    ) {
      const { left, right } = this.book.spreadPageEntries(spread);
      if (left.pageIndex >= 0) {
        this.#ensurePreviewLoaded(left.pageIndex, spread === spreadIndex);
        if (allowHighRes && spread === spreadIndex) {
          this.#ensurePageLoaded(left.pageIndex, targetPdfRenderScale);
        }
      }
      if (right.pageIndex >= 0 && right.pageIndex < this.book.pages.length) {
        this.#ensurePreviewLoaded(right.pageIndex, spread === spreadIndex);
        if (allowHighRes && spread === spreadIndex) {
          this.#ensurePageLoaded(right.pageIndex, targetPdfRenderScale);
        }
      }
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

  ensurePageHighRes(pageIndex, previewZoom = 1) {
    if (pageIndex < 0 || pageIndex >= this.book.pages.length) return Promise.resolve(false);
    const targetPdfRenderScale = this.#getTargetPdfRenderScale(previewZoom);
    this.#ensurePreviewLoaded(pageIndex, true);
    const loadPromise = this.#ensurePageLoaded(pageIndex, targetPdfRenderScale);
    if (this.isPageHighResReady(pageIndex, previewZoom)) return Promise.resolve(true);
    return new Promise(resolve => {
      const waiters = this.pageReadyWaiters.get(pageIndex) || [];
      waiters.push({ previewZoom, resolve });
      this.pageReadyWaiters.set(pageIndex, waiters);
      Promise.resolve(loadPromise).then(() => this.#resolvePageReadyWaiters(pageIndex));
    });
  }

  isPageHighResReady(pageIndex, previewZoom = 1) {
    const page = this.book.pages[pageIndex];
    if (!page) return false;
    if (page.source?.type === "image") {
      return !!page.srcCanvas;
    }
    if (page.source?.type !== "pdf") return !!page.displayCanvas;
    const requiredScale = this.#getRequiredPageRenderScale(pageIndex, previewZoom);
    return !!page.srcCanvas && (page.loadedPdfRenderScale || 0) >= requiredScale;
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
        const previewBitmap = await renderPdfPage(
          page.source.pdfDoc,
          page.source.pageNum,
          this.pdfPreviewSourceScale,
          { downscaleTo: this.pdfPreviewMaxEdge }
        );
        page.previewCanvas = previewBitmap;
        if (!page.thumbnailSourceCanvas) page.thumbnailSourceCanvas = previewBitmap;
        this.onPageReady?.(pageIndex);
        this.#resolvePageReadyWaiters(pageIndex);
      } catch (error) {
        console.error(`Failed to render PDF preview ${page.source?.pageNum}:`, error);
      }
    }
    this.previewRendering = false;
  }

  async #ensurePageLoaded(pageIndex, targetPdfRenderScale = this.pdfRenderScale) {
    const page = this.book.pages[pageIndex];
    if (page?.source?.type === "image") {
      await this.#ensureImagePageLoaded(pageIndex);
      return;
    }
    const minimumHighResScale = this.pdfRenderScale * this.#getHighResPixelRatio();
    const requestedScale = Math.max(
      minimumHighResScale,
      targetPdfRenderScale || minimumHighResScale
    ) * 1.5;
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
      const bitmap = await renderPdfPage(page.source.pdfDoc, page.source.pageNum, renderScale);
      if (!this.keepPageIndexes.has(pageIndex)) {
        page.loading = false;
        closeBitmap(bitmap);
        requestPdfDocumentCleanup(page.source.pdfDoc);
        return;
      }
      if (page.srcCanvas && page.srcCanvas !== bitmap) {
        closeBitmap(page.srcCanvas);
      }
      page.srcCanvas = bitmap;
      if (!page.previewCanvas) {
        page.previewCanvas = await renderPdfPage(
          page.source.pdfDoc,
          page.source.pageNum,
          this.pdfPreviewSourceScale,
          { downscaleTo: this.pdfPreviewMaxEdge }
        );
        if (!page.thumbnailSourceCanvas) page.thumbnailSourceCanvas = page.previewCanvas;
      } else if (!page.thumbnailSourceCanvas) {
        page.thumbnailSourceCanvas = page.previewCanvas;
      }
      page.loadedPdfRenderScale = renderScale;
      page.aspectRatio = bitmap.width / bitmap.height;
      page.loading = false;
      this.onPageReady?.(pageIndex);
      this.#resolvePageReadyWaiters(pageIndex);
      this.#requestSpreadCleanupIfReady(pageIndex, requestedScale);
      if ((page.requestedPdfRenderScale || renderScale) > renderScale + 1e-3) {
        setTimeout(() => this.#ensurePageLoaded(pageIndex, page.requestedPdfRenderScale), 0);
      }
    } catch (error) {
      page.loading = false;
      console.error(`Failed to render PDF page ${page.source?.pageNum}:`, error);
    }
  }

  async #ensureImagePageLoaded(pageIndex) {
    const page = this.book.pages[pageIndex];
    if (!page || page.source?.type !== "image" || page.loading || page.srcCanvas) return;

    page.loading = true;
    try {
      const bitmap = await loadImageFile(page.source.file);
      if (!this.keepPageIndexes.has(pageIndex)) {
        page.loading = false;
        closeBitmap(bitmap);
        return;
      }
      page.srcCanvas = bitmap;
      page.aspectRatio = bitmap.width / bitmap.height;
      page.loading = false;
      this.onPageReady?.(pageIndex);
      this.#resolvePageReadyWaiters(pageIndex);
    } catch (error) {
      page.loading = false;
      console.error(`Failed to load image page ${page.source?.file?.name || pageIndex}:`, error);
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
    if (!page || !page.srcCanvas) return;
    closeBitmap(page.srcCanvas);
    page.srcCanvas = null;
    page.displayCanvasOverride = null;
    // interactivePreviewCanvas is either an aliased bitmap (already closed
    // above) or a freshly allocated HTMLCanvasElement (GC handles it).
    page.interactivePreviewCanvas = null;
    page.interactivePreviewSourceCanvas = null;
    page.interactivePreviewMaxEdge = 0;
    if (page.source?.type === "pdf") {
      page.loadedPdfRenderScale = 0;
      page.requestedPdfRenderScale = 0;
    }
  }
}
