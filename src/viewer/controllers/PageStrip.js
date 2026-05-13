import { PAGE_STRIP_DISPLAY_HEIGHT, SHARED_PREVIEW_SIZE } from "../../previewSizing.js";

export class PageStrip {
  constructor(container, { onPageClick, getEffectEntry, getDisplay, getLayout }) {
    this.container = container;
    this.onPageClick = onPageClick;
    this.getEffectEntry = getEffectEntry;
    this.getDisplay = getDisplay;
    this.getLayout = getLayout;
    this.thumbs = [];
  }

  invalidateThumbnail(page) {
    if (!page) return;
    for (const record of this.thumbs) {
      if (record.page === page) {
        record.paintedSource = null;
        record.paintedKey = null;
      }
    }
  }

  invalidateAllThumbnails() {
    for (const record of this.thumbs) {
      record.paintedSource = null;
      record.paintedKey = null;
    }
  }

  scrollToStart() {
    this.container.scrollLeft = 0;
  }

  update(book, uiState) {
    if (!book.pages.length) {
      this.#clear();
      this.container.style.display = "none";
      return;
    }
    this.container.style.display = "";

    while (this.thumbs.length < book.pages.length) this.#appendThumb();
    while (this.thumbs.length > book.pages.length) this.#popThumb();

    const spread = uiState.effectiveSpread;
    const leftIndex = spread * 2 - 1;
    const rightIndex = spread * 2;

    book.pages.forEach((page, index) => {
      const record = this.thumbs[index];
      const inSpread = index === leftIndex || index === rightIndex;
      const isActive = uiState.appMode === "content" && index === uiState.editingPageIdx;
      const isSelected = uiState.appMode === "content" && uiState.selectedPageIdxs.has(index);
      record.thumb.classList.toggle("in-spread", inSpread);
      record.thumb.classList.toggle("active", isActive);
      record.thumb.classList.toggle("selected", isSelected);

      const labelText = String(index + 1);
      if (record.label.textContent !== labelText) record.label.textContent = labelText;

      this.#refreshThumbCanvas(record, page, index);
    });

    this.#centerOnSpread(leftIndex, rightIndex);
  }

  #centerOnSpread(leftIndex, rightIndex) {
    const leftThumb = leftIndex >= 0 ? this.thumbs[leftIndex]?.thumb : null;
    const rightThumb = rightIndex >= 0 ? this.thumbs[rightIndex]?.thumb : null;
    const anchor = leftThumb ?? rightThumb;
    if (!anchor) return;
    const spreadLeft = leftThumb ? leftThumb.offsetLeft : rightThumb.offsetLeft;
    const spreadRight = rightThumb
      ? rightThumb.offsetLeft + rightThumb.offsetWidth
      : leftThumb.offsetLeft + leftThumb.offsetWidth;
    const spreadCenter = (spreadLeft + spreadRight) / 2;
    const target = spreadCenter - this.container.clientWidth / 2;
    const maxScroll = Math.max(0, this.container.scrollWidth - this.container.clientWidth);
    const clamped = Math.max(0, Math.min(maxScroll, target));
    if (Math.abs(clamped - this.container.scrollLeft) < 0.5) return;
    this.container.scrollTo({ left: clamped, behavior: "smooth" });
  }

  updateThumbnail(pageIndex, page) {
    const record = this.thumbs[pageIndex];
    if (!record) return;
    // Force a repaint by clearing the source marker, then refresh.
    record.paintedSource = null;
    record.paintedKey = null;
    this.#refreshThumbCanvas(record, page, pageIndex);
  }

  #clear() {
    this.container.innerHTML = "";
    this.thumbs = [];
  }

  #appendThumb() {
    const thumb = document.createElement("div");
    thumb.className = "strip-thumb";
    const canvas = document.createElement("canvas");
    const label = document.createElement("span");
    thumb.append(canvas, label);
    const record = {
      thumb,
      canvas,
      label,
      page: null,
      paintedSource: null,
      paintedKey: null,
    };
    thumb.addEventListener("click", event => {
      const index = this.thumbs.indexOf(record);
      if (index >= 0) this.onPageClick(index, event);
    });
    this.container.appendChild(thumb);
    this.thumbs.push(record);
  }

  #popThumb() {
    const record = this.thumbs.pop();
    if (record) record.thumb.remove();
  }

  #refreshThumbCanvas(record, page, pageIndex) {
    const display = this.getDisplay();
    const effectEntry = this.getEffectEntry(page);
    const layout = this.getLayout();
    const side = pageIndex % 2 === 1 ? "left" : "right";
    const layoutKey = layout
      ? `${layout.pw},${layout.ph},${layout.ratio},${layout.b},${layout.mInner},${layout.mTop},${layout.mBottom}`
      : "";
    const key = `${effectEntry.key}|${display.paperColor}|${display.contentBlendMode}|${layoutKey}|${side}`;
    const source = page.placedPreviewCanvas ?? null;

    if (record.page === page && record.paintedSource === source && record.paintedKey === key) {
      return;
    }

    const thumbHeight = SHARED_PREVIEW_SIZE;
    const thumbWidth = layout
      ? Math.max(1, Math.round(thumbHeight * (layout.pw / layout.ph)))
      : Math.max(1, Math.round(thumbHeight * (page.aspectRatio || 1)));
    const displayWidth = Math.max(1, Math.round(thumbWidth * (PAGE_STRIP_DISPLAY_HEIGHT / thumbHeight)));

    const canvas = record.canvas;
    if (canvas.width !== thumbWidth) canvas.width = thumbWidth;
    if (canvas.height !== thumbHeight) canvas.height = thumbHeight;
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${PAGE_STRIP_DISPLAY_HEIGHT}px`;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, thumbWidth, thumbHeight);
    ctx.fillStyle = display.paperColor;
    ctx.fillRect(0, 0, thumbWidth, thumbHeight);
    if (source) ctx.drawImage(source, 0, 0, thumbWidth, thumbHeight);

    record.page = page;
    record.paintedSource = source;
    record.paintedKey = key;
  }
}
