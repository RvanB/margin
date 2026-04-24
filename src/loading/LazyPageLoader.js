import { autoCrop } from "../effects/cpu.js";
import { renderPdfPage } from "./pdfLoader.js";

export class LazyPageLoader {
  constructor(book, onPageReady, { pdfRenderScale = 1.5 } = {}) {
    this.book = book;
    this.onPageReady = onPageReady;
    this.pdfRenderScale = pdfRenderScale;
    this.lastEnsuredSpread = -1;
  }

  reset() {
    this.lastEnsuredSpread = -1;
  }

  ensureSpreadLoaded(spreadIndex) {
    this.lastEnsuredSpread = spreadIndex;
    const spreadCount = this.book.numSpreads();
    for (
      let spread = Math.max(0, spreadIndex - 1);
      spread <= Math.min(spreadCount - 1, spreadIndex + 1);
      spread += 1
    ) {
      const { left, right } = this.book.spreadPageEntries(spread);
      if (left.pageIndex >= 0) this.#ensurePageLoaded(left.pageIndex);
      if (right.pageIndex >= 0 && right.pageIndex < this.book.pages.length) this.#ensurePageLoaded(right.pageIndex);
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

  async #ensurePageLoaded(pageIndex) {
    const page = this.book.pages[pageIndex];
    if (!page || page.srcCanvas || page.loading || page.source?.type !== "pdf") return;

    page.loading = true;
    try {
      const canvas = await renderPdfPage(page.source.pdfDoc, page.source.pageNum, this.pdfRenderScale);
      page.srcCanvas = canvas;
      page.aspectRatio = canvas.width / canvas.height;
      page.loading = false;
      if (!page.cropInitialized) {
        page.crop = autoCrop(canvas, page.tolerance);
        page.cropInitialized = true;
      }
      this.onPageReady?.(pageIndex);
    } catch (error) {
      page.loading = false;
      console.error(`Failed to render PDF page ${page.source?.pageNum}:`, error);
    }
  }

  #unloadPage(pageIndex) {
    const page = this.book.pages[pageIndex];
    if (!page || !page.srcCanvas || page.source?.type !== "pdf") return;
    page.srcCanvas = null;
  }
}
