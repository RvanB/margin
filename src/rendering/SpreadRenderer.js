import { fillLorem } from "./text.js";
import { drawPageBorder } from "./primitives.js";

function get2dContext(canvas, options) {
  return canvas.getContext("2d", options);
}

export class SpreadRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = get2dContext(canvas);
    this.effectCache = new WeakMap();
    this.animationFrame = 0;
    this.animations = [];
    this.baseCanvas = null;
    this.doneCallbacks = [];
  }

  get isAnimating() {
    return this.animations.length > 0 || this.animationFrame !== 0;
  }

  stopAnimation() {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.animations = [];
    this.baseCanvas = null;
    this.doneCallbacks = [];
  }

  render(pages, margins, effects, display, options = {}) {
    this.canvas.width = Math.round(2 * margins.pagePxW);
    this.canvas.height = Math.round(margins.pagePxH);
    this.ctx = get2dContext(this.canvas);
    return this.#paint(this.canvas, pages, margins, effects, display, options);
  }

  snapshot(pages, margins, effects, display, options = {}) {
    const offscreen = document.createElement("canvas");
    offscreen.width = Math.round(2 * margins.pagePxW);
    offscreen.height = Math.round(margins.pagePxH);
    const result = this.#paint(offscreen, pages, margins, effects, display, options);
    return { canvas: offscreen, ...result };
  }

  getThumbnail(page, effectEntry, display) {
    const thumbHeight = 56;
    const thumbWidth = Math.max(1, Math.round(thumbHeight * (page.aspectRatio || 1)));
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = thumbWidth;
    thumbCanvas.height = thumbHeight;
    const thumbCtx = get2dContext(thumbCanvas, { willReadFrequently: true });
    thumbCtx.fillStyle = display.paperColor;
    thumbCtx.fillRect(0, 0, thumbWidth, thumbHeight);

    const processedCanvas = this.#getProcessedCanvas(page, thumbWidth, thumbHeight, effectEntry);
    if (processedCanvas) {
      const prevBlend = thumbCtx.globalCompositeOperation;
      thumbCtx.globalCompositeOperation = display.contentBlendMode;
      thumbCtx.drawImage(processedCanvas, 0, 0, thumbWidth, thumbHeight);
      thumbCtx.globalCompositeOperation = prevBlend;
    }

    return thumbCanvas;
  }

  animateTo(from, to, direction, onDone) {
    if (!this.animations.length) this.baseCanvas = from;
    this.animations.push({ fromCanvas: from, toCanvas: to, direction, start: performance.now() });
    if (onDone) this.doneCallbacks.push(onDone);

    if (!this.animationFrame) {
      this.animationFrame = requestAnimationFrame(now => this.#tick(now));
    }
  }

  #paint(targetCanvas, pages, margins, effects, display, options) {
    const ctx = get2dContext(targetCanvas);
    const showPlaceholder = !!options.showPlaceholder;
    const hasPlacedPages = !!pages;
    const sideStates = this.#buildSideStates(margins, pages, hasPlacedPages);

    ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    ctx.fillStyle = display.paperColor;
    ctx.fillRect(0, 0, margins.pagePxW * 2, margins.pagePxH);

    if (margins.ok) {
      for (const [sideName, sideState] of Object.entries(sideStates)) {
        const effectEntry = effects[sideName];
        if (sideState.page) {
          sideState.drawnRect = this.#drawPageContent(
            ctx,
            sideState.page,
            sideState.contentRect.x,
            sideState.contentRect.y,
            sideState.contentRect.w,
            sideState.contentRect.h,
            effectEntry,
            display.contentBlendMode,
            {
              mode: sideState.contentMode,
              clipToRect: sideState.clipContent,
            }
          );
        } else if (showPlaceholder) {
          fillLorem(
            ctx,
            sideState.textblockRect.x,
            sideState.textblockRect.y,
            sideState.textblockRect.w,
            sideState.textblockRect.h
          );
        }
      }
    }

    drawPageBorder(ctx, margins.pagePxW);

    return {
      spreadRects: {
        left: sideStates.left.drawnRect
          ? { ...sideStates.left.drawnRect, pageIndex: sideStates.left.pageIndex }
          : null,
        right: sideStates.right.drawnRect
          ? { ...sideStates.right.drawnRect, pageIndex: sideStates.right.pageIndex }
          : null,
        pagePxW: margins.pagePxW,
      },
      sideStates,
    };
  }

  #buildSideStates(margins, pages, hasPlacedPages) {
    const build = (sideName, entry) => {
      const isLeft = sideName === "left";
      const page = entry?.page ?? null;
      const fitMode = page?.fitAxis === "width" || page?.fitAxis === "height" || page?.fitAxis === "inside"
        ? page.fitAxis
        : "inside";
      const pageRect = {
        x: isLeft ? 0 : margins.pagePxW,
        y: 0,
        w: margins.pagePxW,
        h: margins.pagePxH,
      };
      const textblockRect = {
        x: isLeft ? margins.outerPx : margins.pagePxW + margins.innerPx,
        y: margins.topPx,
        w: margins.twPx,
        h: margins.thPx,
      };
      const isBlank = hasPlacedPages && !page;
      const isCover = !!page?.cover;

      return {
        side: sideName,
        page,
        pageIndex: entry?.pageIndex ?? -1,
        isBlank,
        isCover,
        overlayVisible: !isBlank && !isCover,
        pageRect,
        textblockRect,
        contentRect: isCover ? pageRect : textblockRect,
        contentMode: isCover
          ? "fill"
          : fitMode === "width"
            ? "fit-width"
            : fitMode === "height"
              ? "fit-height"
              : "fit",
        clipContent: isCover,
        drawnRect: null,
      };
    };

    return {
      left: build("left", pages?.left),
      right: build("right", pages?.right),
    };
  }

  #drawPageContent(ctx, page, x, y, w, h, effectEntry, blendMode, options) {
    if (!page?.srcCanvas) return null;

    const { crop } = page;
    const sourceCanvas = page.srcCanvas;
    const sourceWidth = sourceCanvas.width - crop.left - crop.right;
    const sourceHeight = sourceCanvas.height - crop.top - crop.bottom;
    if (sourceWidth <= 0 || sourceHeight <= 0) return null;

    const scale = options.mode === "fill"
      ? Math.max(w / sourceWidth, h / sourceHeight)
      : options.mode === "fit-width"
        ? w / sourceWidth
        : options.mode === "fit-height"
          ? h / sourceHeight
          : Math.min(w / sourceWidth, h / sourceHeight);

    const drawX = Math.round(x + (w - sourceWidth * scale) / 2 - crop.left * scale);
    const drawY = Math.round(y + (h - sourceHeight * scale) / 2 - crop.top * scale);
    const drawW = Math.max(1, Math.round(sourceCanvas.width * scale));
    const drawH = Math.max(1, Math.round(sourceCanvas.height * scale));
    const processedCanvas = this.#getProcessedCanvas(page, drawW, drawH, effectEntry);

    const cropX = Math.round(drawX + crop.left * drawW / sourceCanvas.width);
    const cropY = Math.round(drawY + crop.top * drawH / sourceCanvas.height);
    const cropRight = Math.round(drawX + (sourceCanvas.width - crop.right) * drawW / sourceCanvas.width);
    const cropBottom = Math.round(drawY + (sourceCanvas.height - crop.bottom) * drawH / sourceCanvas.height);

    const clipX0 = Math.round(x);
    const clipY0 = Math.round(y);
    const clipX1 = Math.round(x + w);
    const clipY1 = Math.round(y + h);

    if (options.clipToRect) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(clipX0, clipY0, clipX1 - clipX0, clipY1 - clipY0);
      ctx.clip();
    }

    const prevBlend = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = blendMode;
    ctx.drawImage(processedCanvas, drawX, drawY, drawW, drawH);
    ctx.globalCompositeOperation = prevBlend;

    if (options.clipToRect) ctx.restore();

    const visibleX = options.clipToRect ? Math.max(cropX, clipX0) : cropX;
    const visibleY = options.clipToRect ? Math.max(cropY, clipY0) : cropY;
    const visibleRight = options.clipToRect ? Math.min(cropRight, clipX1) : cropRight;
    const visibleBottom = options.clipToRect ? Math.min(cropBottom, clipY1) : cropBottom;

    return {
      x: visibleX,
      y: visibleY,
      w: Math.max(0, visibleRight - visibleX),
      h: Math.max(0, visibleBottom - visibleY),
      fitScale: scale,
      sw: sourceCanvas.width,
      sh: sourceCanvas.height,
    };
  }

  #getProcessedCanvas(page, targetWidth, targetHeight, effectEntry) {
    if (!page?.srcCanvas) return null;

    const previewWidth = Math.max(1, Math.min(page.srcCanvas.width, Math.round(targetWidth || page.srcCanvas.width)));
    const previewHeight = Math.max(1, Math.min(page.srcCanvas.height, Math.round(targetHeight || page.srcCanvas.height)));
    const cacheKey = `${effectEntry.key}|${previewWidth}x${previewHeight}`;

    let pageCache = this.effectCache.get(page);
    if (!pageCache || pageCache.srcCanvas !== page.srcCanvas) {
      pageCache = {
        srcCanvas: page.srcCanvas,
        variants: new Map(),
      };
      this.effectCache.set(page, pageCache);
    }

    const cached = pageCache.variants.get(cacheKey);
    if (cached) return cached;

    const base = document.createElement("canvas");
    base.width = previewWidth;
    base.height = previewHeight;
    get2dContext(base, { willReadFrequently: true }).drawImage(page.srcCanvas, 0, 0, previewWidth, previewHeight);

    let out = base;
    for (const effect of effectEntry.pipeline) {
      out = effect(out);
    }

    pageCache.variants.set(cacheKey, out);
    if (pageCache.variants.size > 8) {
      const oldestKey = pageCache.variants.keys().next().value;
      pageCache.variants.delete(oldestKey);
    }
    return out;
  }

  #drawPageSlice(img, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
    this.ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  #tick(now) {
    const width = this.canvas.width;
    const height = this.canvas.height;
    const pageWidth = width / 2;
    this.ctx.clearRect(0, 0, width, height);
    if (this.baseCanvas) this.ctx.drawImage(this.baseCanvas, 0, 0);

    const remaining = [];
    const liftAnimations = [];
    const landAnimations = [];

    for (const animation of this.animations) {
      const progress = Math.min(1, (now - animation.start) / 420);
      const phaseProgress = progress < 0.5 ? progress / 0.5 : (progress - 0.5) / 0.5;

      if (progress < 1) {
        remaining.push(animation);
        if (progress < 0.5) {
          liftAnimations.push({ animation, liftW: Math.max(0, pageWidth * (1 - phaseProgress)) });
        } else {
          landAnimations.push({ animation, landW: Math.max(0, pageWidth * phaseProgress) });
        }
      } else {
        this.baseCanvas = animation.toCanvas;
      }
    }

    for (const { animation, landW } of landAnimations) {
      if (animation.direction > 0) {
        this.#drawPageSlice(animation.toCanvas, pageWidth, 0, pageWidth, height, pageWidth, 0, pageWidth, height);
        this.#drawPageSlice(animation.toCanvas, 0, 0, pageWidth, height, pageWidth - landW, 0, landW, height);
      } else {
        this.#drawPageSlice(animation.toCanvas, 0, 0, pageWidth, height, 0, 0, pageWidth, height);
        this.#drawPageSlice(animation.toCanvas, pageWidth, 0, pageWidth, height, pageWidth, 0, landW, height);
      }
    }

    for (const { animation } of liftAnimations) {
      if (animation.direction > 0) {
        this.#drawPageSlice(animation.toCanvas, pageWidth, 0, pageWidth, height, pageWidth, 0, pageWidth, height);
      } else {
        this.#drawPageSlice(animation.toCanvas, 0, 0, pageWidth, height, 0, 0, pageWidth, height);
      }
    }

    for (let i = liftAnimations.length - 1; i >= 0; i -= 1) {
      const { animation, liftW } = liftAnimations[i];
      if (animation.direction > 0) {
        this.#drawPageSlice(animation.fromCanvas, pageWidth, 0, pageWidth, height, pageWidth, 0, liftW, height);
      } else {
        this.#drawPageSlice(animation.fromCanvas, 0, 0, pageWidth, height, pageWidth - liftW, 0, liftW, height);
      }
    }

    drawPageBorder(this.ctx, pageWidth);
    this.animations = remaining;

    if (remaining.length) {
      this.animationFrame = requestAnimationFrame(nextNow => this.#tick(nextNow));
      return;
    }

    this.animationFrame = 0;
    const callbacks = [...this.doneCallbacks];
    this.doneCallbacks = [];
    for (const callback of callbacks) callback();
  }
}
