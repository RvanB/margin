import { SHARED_PREVIEW_SIZE } from "../previewSizing.js";
import { loadImageFile } from "./imageLoader.js";
import { renderPdfPage, requestPdfDocumentCleanup } from "./pdfLoader.js";

function closeBitmap(bitmap) {
  if (bitmap && typeof bitmap.close === "function") bitmap.close();
}

/**
 * Lazily loads PDF/image page bitmaps and tracks high-res memory via an LRU.
 *
 * Capacity is the maximum number of pages held at high resolution at once
 * (default 8 ≈ 4 spreads). Requesting a page (`ensurePageHighRes` or via
 * `ensureSpreadLoaded`) "touches" it, moving it to the most-recent slot;
 * over-capacity entries at the oldest slot are evicted (bitmap closed,
 * `page.srcCanvas` cleared). Previews are kept loaded indefinitely — they're
 * cheap and the page strip depends on them.
 *
 * Eviction can be deferred via `setEvictionsDeferred(true)` to avoid closing
 * a bitmap whose texture is still in use by an in-flight WebGPU animation.
 * Call `flushEvictions()` (or `setEvictionsDeferred(false)`) once it's safe.
 */
export class LazyPageLoader {
  constructor(book, onPageReady, {
    maxHighResPages = 8,
    pdfRenderScale = 1.5,
    pdfPreviewSourceScale = 0.25,
    pdfPreviewMaxEdge = SHARED_PREVIEW_SIZE,
  } = {}) {
    this.book = book;
    this.onPageReady = onPageReady;
    this.pdfRenderScale = pdfRenderScale;
    this.pdfPreviewSourceScale = pdfPreviewSourceScale;
    this.pdfPreviewMaxEdge = pdfPreviewMaxEdge;
    this.maxHighResPages = maxHighResPages;
    this.lastEnsuredPreviewZoom = 1;
    // LRU: pageIndex -> {} (Map iteration is insertion-order; re-insert to bump).
    this.highResLru = new Map();
    this.evictionsDeferred = false;
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

  #touchHighRes(pageIndex) {
    if (pageIndex < 0) return;
    if (this.highResLru.has(pageIndex)) this.highResLru.delete(pageIndex);
    this.highResLru.set(pageIndex, {});
    this.#evictOverCapacity();
  }

  #isWantedHighRes(pageIndex) {
    return this.highResLru.has(pageIndex);
  }

  #evictOverCapacity() {
    if (this.evictionsDeferred) return;
    while (this.highResLru.size > this.maxHighResPages) {
      const oldestIndex = this.highResLru.keys().next().value;
      this.highResLru.delete(oldestIndex);
      this.#unloadPage(oldestIndex);
    }
  }

  setEvictionsDeferred(deferred) {
    const wasDeferred = this.evictionsDeferred;
    this.evictionsDeferred = !!deferred;
    if (wasDeferred && !this.evictionsDeferred) {
      this.#evictOverCapacity();
    }
  }

  flushEvictions() {
    this.setEvictionsDeferred(false);
  }

  reset() {
    this.lastEnsuredPreviewZoom = 1;
    this.previewQueue = [];
    this.previewQueued.clear();
    this.previewRendering = false;
    for (const pageIndex of this.highResLru.keys()) {
      this.#unloadPage(pageIndex);
    }
    this.highResLru.clear();
    this.evictionsDeferred = false;
  }

  ensureSpreadLoaded(spreadIndex, previewZoom = 1, { allowHighRes = true, priority = false } = {}) {
    this.lastEnsuredPreviewZoom = Math.max(1, previewZoom || 1);
    const targetPdfRenderScale = this.#getTargetPdfRenderScale(this.lastEnsuredPreviewZoom);
    const spreadCount = this.book.numSpreads();
    for (
      let spread = Math.max(0, spreadIndex - 1);
      spread <= Math.min(spreadCount - 1, spreadIndex + 1);
      spread += 1
    ) {
      const { left, right } = this.book.spreadPageEntries(spread);
      if (left.pageIndex >= 0) {
        this.#ensurePreviewLoaded(left.pageIndex, spread === spreadIndex);
        if (allowHighRes && spread === spreadIndex) {
          this.#ensurePageLoaded(left.pageIndex, targetPdfRenderScale, { priority });
        }
      }
      if (right.pageIndex >= 0 && right.pageIndex < this.book.pages.length) {
        this.#ensurePreviewLoaded(right.pageIndex, spread === spreadIndex);
        if (allowHighRes && spread === spreadIndex) {
          this.#ensurePageLoaded(right.pageIndex, targetPdfRenderScale, { priority });
        }
      }
    }
  }

  warmAllPreviews() {
    for (let pageIndex = 0; pageIndex < this.book.pages.length; pageIndex += 1) {
      this.#ensurePreviewLoaded(pageIndex);
    }
  }

  ensurePageHighRes(pageIndex, previewZoom = 1, { priority = true } = {}) {
    if (pageIndex < 0 || pageIndex >= this.book.pages.length) return Promise.resolve(false);
    const targetPdfRenderScale = this.#getTargetPdfRenderScale(previewZoom);
    this.#ensurePreviewLoaded(pageIndex, true);
    const loadPromise = this.#ensurePageLoaded(pageIndex, targetPdfRenderScale, { priority });
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

  async #ensurePageLoaded(pageIndex, targetPdfRenderScale = this.pdfRenderScale, { priority = false } = {}) {
    const page = this.book.pages[pageIndex];
    if (!page) return;
    if (page.source?.type === "image") {
      this.#touchHighRes(pageIndex);
      await this.#ensureImagePageLoaded(pageIndex);
      return;
    }
    if (page.source?.type !== "pdf") return;

    // Touch the LRU first so the page is marked as wanted before we kick off
    // (or check for) a render. If a previously in-flight render for this page
    // lands, the LRU-membership check at completion will recognize it as
    // still wanted.
    this.#touchHighRes(pageIndex);

    const minimumHighResScale = this.pdfRenderScale * this.#getHighResPixelRatio();
    const requestedScale = Math.max(
      minimumHighResScale,
      targetPdfRenderScale || minimumHighResScale
    ) * 1.5;
    page.requestedPdfRenderScale = Math.max(page.requestedPdfRenderScale || 0, requestedScale);
    if (page.loading) return;
    if (page.srcCanvas && (page.loadedPdfRenderScale || this.pdfRenderScale) >= requestedScale) return;

    page.loading = true;
    try {
      const renderScale = Math.max(
        minimumHighResScale,
        page.requestedPdfRenderScale || requestedScale
      );
      const bitmap = await renderPdfPage(page.source.pdfDoc, page.source.pageNum, renderScale, { priority });
      if (!this.#isWantedHighRes(pageIndex)) {
        // Page was evicted from the LRU while we were rendering.
        page.loading = false;
        closeBitmap(bitmap);
        requestPdfDocumentCleanup(page.source.pdfDoc);
        return;
      }
      const previousSrcCanvas = page.srcCanvas && page.srcCanvas !== bitmap ? page.srcCanvas : null;
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
      // Close the previous bitmap AFTER onPageReady so that the renderer has
      // a chance to swing its scene-pinned source refs onto the new bitmap
      // first. Otherwise an in-flight animation that still references the
      // old bitmap would see it become unreadable mid-frame.
      if (previousSrcCanvas) closeBitmap(previousSrcCanvas);
      this.#resolvePageReadyWaiters(pageIndex);
      if ((page.requestedPdfRenderScale || renderScale) > renderScale + 1e-3) {
        setTimeout(() => this.#ensurePageLoaded(pageIndex, page.requestedPdfRenderScale, { priority: false }), 0);
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
      if (!this.#isWantedHighRes(pageIndex)) {
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
      requestPdfDocumentCleanup(page.source.pdfDoc);
    }
  }
}
