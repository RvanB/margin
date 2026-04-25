export class PageStrip {
  constructor(container, { onPageClick, getEffectEntry, getDisplay, getLayout }) {
    this.container = container;
    this.onPageClick = onPageClick;
    this.getEffectEntry = getEffectEntry;
    this.getDisplay = getDisplay;
    this.getLayout = getLayout;
    this.thumbnailCache = new WeakMap();
  }

  invalidateThumbnail(page) {
    if (!page) return;
    this.thumbnailCache.delete(page);
  }

  invalidateAllThumbnails() {
    this.thumbnailCache = new WeakMap();
  }

  scrollToStart() {
    this.container.scrollLeft = 0;
  }

  update(book, uiState, renderer) {
    this.container.innerHTML = "";
    if (!book.pages.length) {
      this.container.style.display = "none";
      return;
    }

    this.container.style.display = "";
    const spread = uiState.effectiveSpread;
    const leftIndex = spread * 2 - 1;
    const rightIndex = spread * 2;

    let activeThumb = null;

    book.pages.forEach((page, index) => {
      const thumb = document.createElement("div");
      thumb.className = "strip-thumb";
      const inSpread = index === leftIndex || index === rightIndex;
      const isActive = uiState.appMode === "content" && index === uiState.editingPageIdx;
      const isSelected = uiState.appMode === "content" && uiState.selectedPageIdxs.has(index);
      thumb.classList.toggle("in-spread", inSpread);
      thumb.classList.toggle("active", isActive);
      thumb.classList.toggle("selected", isSelected);

      const thumbCanvas = this.#makeThumbCanvas(page, index, renderer);
      const label = document.createElement("span");
      label.textContent = String(index + 1);
      thumb.append(thumbCanvas, label);
      thumb.addEventListener("click", event => this.onPageClick(index, event));
      this.container.appendChild(thumb);
      if (isActive || (uiState.appMode === "layout" && inSpread && !activeThumb)) activeThumb = thumb;
    });

    activeThumb?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  updateThumbnail(pageIndex, page, renderer) {
    const thumb = this.container.querySelectorAll(".strip-thumb")[pageIndex];
    if (!thumb) return;
    this.invalidateThumbnail(page);
    const nextCanvas = this.#makeThumbCanvas(page, pageIndex, renderer);
    const currentCanvas = thumb.querySelector("canvas");
    if (currentCanvas) currentCanvas.replaceWith(nextCanvas);
  }

  #makeThumbCanvas(page, pageIndex, renderer) {
    const thumbHeight = 56;
    const layout = this.getLayout();
    const thumbWidth = layout
      ? Math.max(1, Math.round(thumbHeight * (layout.pw / layout.ph)))
      : Math.max(1, Math.round(thumbHeight * (page.aspectRatio || 1)));
    const canvas = document.createElement("canvas");
    canvas.width = thumbWidth;
    canvas.height = thumbHeight;
    const ctx = canvas.getContext("2d");
    const display = this.getDisplay();
    ctx.fillStyle = display.paperColor;
    ctx.fillRect(0, 0, thumbWidth, thumbHeight);

    const source = this.#getThumbnailSource(page, pageIndex, renderer);
    if (source) ctx.drawImage(source, 0, 0, thumbWidth, thumbHeight);
    return canvas;
  }

  #getThumbnailSource(page, pageIndex, renderer) {
    const display = this.getDisplay();
    const effectEntry = this.getEffectEntry(page);
    const layout = this.getLayout();
    const side = pageIndex % 2 === 1 ? "left" : "right";
    const layoutKey = layout
      ? `${layout.pw},${layout.ph},${layout.ratio},${layout.b},${layout.mInner},${layout.mTop},${layout.mBottom}`
      : "";
    const key = `${effectEntry.key}|${display.paperColor}|${display.contentBlendMode}|${layoutKey}|${side}`;
    const cached = this.thumbnailCache.get(page);

    const sourceCanvas = page.placedPreviewCanvas;
    if (sourceCanvas && (!cached || cached.key !== key)) {
      const next = { key, canvas: sourceCanvas };
      this.thumbnailCache.set(page, next);
      return next.canvas;
    }

    return cached?.canvas ?? null;
  }
}
