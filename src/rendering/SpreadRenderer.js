import { drawPageBorder } from "./primitives.js";
import { autoCrop } from "../effects/cpu.js";
import { applyEffectsToCanvas } from "../effects/pipeline.js";
import { SHARED_PREVIEW_SIZE } from "../previewSizing.js";
import { computeMargins } from "./layout.js";

const TURN_EASING_POWER = 3;
const TURN_DURATION_MS = 750;

function get2dContext(canvas, options) {
  return canvas.getContext("2d", options);
}

function easeTurnProgress(progress) {
  const t = Math.max(0, Math.min(1, progress));
  return 1 - Math.pow(1 - t, TURN_EASING_POWER);
}

export class SpreadRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = get2dContext(canvas);
    this.backendName = "2d";
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

  getPlacedPagePreview(page, effectEntry, display, options = {}) {
    const sourceCanvas = options.sourceCanvas ?? page?.previewCanvas ?? page?.displayCanvas;
    const layout = options.layout ?? null;
    const side = options.side === "left" ? "left" : "right";
    const pageHeight = Math.max(1, Math.round(options.pageHeight || SHARED_PREVIEW_SIZE));
    const pageWidth = layout
      ? Math.max(1, Math.round(pageHeight * (layout.pw / layout.ph)))
      : Math.max(1, Math.round(pageHeight * (page.aspectRatio || 1)));
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = pageWidth;
    pageCanvas.height = pageHeight;
    const pageCtx = get2dContext(pageCanvas, { willReadFrequently: true });
    pageCtx.fillStyle = display.paperColor;
    pageCtx.fillRect(0, 0, pageWidth, pageHeight);

    if (!sourceCanvas || !layout) return pageCanvas;

    const margins = computeMargins(layout, pageHeight / layout.ph);
    const fitMode = page?.fitAxis === "width" || page?.fitAxis === "height" || page?.fitAxis === "inside"
      ? page.fitAxis
      : "inside";
    const contentRect = page?.cover
      ? { x: 0, y: 0, w: pageWidth, h: pageHeight }
      : {
          x: side === "left" ? margins.outerPx : margins.innerPx,
          y: margins.topPx,
          w: margins.twPx,
          h: margins.thPx,
        };
    this.#drawPageContent(
      pageCtx,
      page,
      contentRect.x,
      contentRect.y,
      contentRect.w,
      contentRect.h,
      effectEntry,
      display.contentBlendMode,
      {
        mode: page?.cover
          ? "fill"
          : fitMode === "width"
            ? "fit-width"
            : fitMode === "height"
              ? "fit-height"
              : "fit",
        clipToRect: !!page?.cover,
        sourceCanvas,
        crop: this.#getThumbnailCrop(page, sourceCanvas, effectEntry),
      }
    );
    return pageCanvas;
  }

  getThumbnail(page, effectEntry, display, options = {}) {
    const sourceCanvas = options.sourceCanvas ?? page?.thumbnailCanvas ?? page?.displayCanvas;
    const layout = options.layout ?? null;
    const side = options.side === "left" ? "left" : "right";
    const thumbHeight = SHARED_PREVIEW_SIZE;
    const thumbWidth = layout
      ? Math.max(1, Math.round(thumbHeight * (layout.pw / layout.ph)))
      : Math.max(1, Math.round(thumbHeight * (page.aspectRatio || 1)));
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = thumbWidth;
    thumbCanvas.height = thumbHeight;
    const thumbCtx = get2dContext(thumbCanvas, { willReadFrequently: true });
    thumbCtx.fillStyle = display.paperColor;
    thumbCtx.fillRect(0, 0, thumbWidth, thumbHeight);

    if (sourceCanvas) {
      if (layout) {
        const placedPreview = this.getPlacedPagePreview(page, effectEntry, display, {
          sourceCanvas,
          layout,
          side,
          pageHeight: thumbHeight,
        });
        thumbCtx.drawImage(placedPreview, 0, 0, thumbWidth, thumbHeight);
      } else {
        const processedCanvas = this.#getProcessedCanvas(page, thumbWidth, thumbHeight, effectEntry, sourceCanvas);
        if (processedCanvas) {
          const prevBlend = thumbCtx.globalCompositeOperation;
          thumbCtx.globalCompositeOperation = display.contentBlendMode;
          thumbCtx.drawImage(processedCanvas, 0, 0, thumbWidth, thumbHeight);
          thumbCtx.globalCompositeOperation = prevBlend;
        }
      }
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
          sideState.drawnRect = !sideState.page.srcCanvas && sideState.page.placedPreviewCanvas
            ? this.#drawPlacedPreview(ctx, sideState, effectEntry)
            : this.#drawPageContent(
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
    const sourceCanvas = options.sourceCanvas ?? page?.displayCanvas;
    if (!sourceCanvas) return null;

    const crop = options.crop ?? page.getCropFor(sourceCanvas);
    const measurement = this.#measurePageContent(sourceCanvas, crop, x, y, w, h, options);
    if (!measurement) return null;
    const { drawX, drawY, drawW, drawH, cropX, cropY, cropRight, cropBottom, clipX0, clipY0, clipX1, clipY1, scale } = measurement;
    const processedCanvas = this.#getProcessedCanvas(page, drawW, drawH, effectEntry, sourceCanvas);

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

  #drawPlacedPreview(ctx, sideState, effectEntry) {
    const previewCanvas = sideState.page?.placedPreviewCanvas;
    if (!previewCanvas) return null;
    const measurement = this.#measurePageContent(
      sideState.page.previewCanvas || sideState.page.displayCanvas,
      sideState.page.getCropFor(sideState.page.previewCanvas || sideState.page.displayCanvas),
      sideState.contentRect.x,
      sideState.contentRect.y,
      sideState.contentRect.w,
      sideState.contentRect.h,
      {
        mode: sideState.contentMode,
        clipToRect: sideState.clipContent,
      }
    );
    ctx.drawImage(
      previewCanvas,
      Math.round(sideState.pageRect.x),
      Math.round(sideState.pageRect.y),
      Math.round(sideState.pageRect.w),
      Math.round(sideState.pageRect.h)
    );
    if (!measurement) {
      return {
        x: Math.round(sideState.pageRect.x),
        y: Math.round(sideState.pageRect.y),
        w: Math.round(sideState.pageRect.w),
        h: Math.round(sideState.pageRect.h),
        fitScale: 1,
        sw: previewCanvas.width,
        sh: previewCanvas.height,
      };
    }
    return {
      x: measurement.visibleX,
      y: measurement.visibleY,
      w: Math.max(0, measurement.visibleRight - measurement.visibleX),
      h: Math.max(0, measurement.visibleBottom - measurement.visibleY),
      fitScale: measurement.scale,
      sw: measurement.sourceWidthPx,
      sh: measurement.sourceHeightPx,
    };
  }

  #getProcessedCanvas(page, targetWidth, targetHeight, effectEntry, sourceCanvas = page?.displayCanvas) {
    if (!sourceCanvas) return null;

    const previewWidth = Math.max(1, Math.min(sourceCanvas.width, Math.round(targetWidth || sourceCanvas.width)));
    const previewHeight = Math.max(1, Math.min(sourceCanvas.height, Math.round(targetHeight || sourceCanvas.height)));
    const cacheKey = `${effectEntry.key}|${previewWidth}x${previewHeight}`;

    let pageCache = this.effectCache.get(page);
    if (!pageCache || pageCache.srcCanvas !== sourceCanvas) {
      pageCache = {
        srcCanvas: sourceCanvas,
        variants: new Map(),
      };
      this.effectCache.set(page, pageCache);
    }

    const cached = pageCache.variants.get(cacheKey);
    if (cached) return cached;

    const base = document.createElement("canvas");
    base.width = previewWidth;
    base.height = previewHeight;
    get2dContext(base, { willReadFrequently: true }).drawImage(sourceCanvas, 0, 0, previewWidth, previewHeight);

    const out = applyEffectsToCanvas(
      base,
      effectEntry.effects ?? page.effects,
      effectEntry.layerCache || null,
      `${previewWidth}x${previewHeight}`
    );

    pageCache.variants.set(cacheKey, out);
    if (pageCache.variants.size > 8) {
      const oldestKey = pageCache.variants.keys().next().value;
      pageCache.variants.delete(oldestKey);
    }
    return out;
  }

  #measurePageContent(sourceCanvas, crop, x, y, w, h, options) {
    if (!sourceCanvas) return null;
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
    const cropX = Math.round(drawX + crop.left * drawW / sourceCanvas.width);
    const cropY = Math.round(drawY + crop.top * drawH / sourceCanvas.height);
    const cropRight = Math.round(drawX + (sourceCanvas.width - crop.right) * drawW / sourceCanvas.width);
    const cropBottom = Math.round(drawY + (sourceCanvas.height - crop.bottom) * drawH / sourceCanvas.height);
    const clipX0 = Math.round(x);
    const clipY0 = Math.round(y);
    const clipX1 = Math.round(x + w);
    const clipY1 = Math.round(y + h);

    return {
      sourceWidthPx: sourceCanvas.width,
      sourceHeightPx: sourceCanvas.height,
      scale,
      drawX,
      drawY,
      drawW,
      drawH,
      cropX,
      cropY,
      cropRight,
      cropBottom,
      clipX0,
      clipY0,
      clipX1,
      clipY1,
      visibleX: options.clipToRect ? Math.max(cropX, clipX0) : cropX,
      visibleY: options.clipToRect ? Math.max(cropY, clipY0) : cropY,
      visibleRight: options.clipToRect ? Math.min(cropRight, clipX1) : cropRight,
      visibleBottom: options.clipToRect ? Math.min(cropBottom, clipY1) : cropBottom,
    };
  }

  #getThumbnailCrop(page, sourceCanvas, effectEntry) {
    if (!sourceCanvas) return { top: 0, left: 0, right: 0, bottom: 0 };
    if (!page?.cropInitialized) {
      const processedCanvas = this.#getProcessedCanvas(
        page,
        sourceCanvas.width,
        sourceCanvas.height,
        effectEntry,
        sourceCanvas
      );
      return autoCrop(processedCanvas, page?.tolerance);
    }

    return page.getCropFor(sourceCanvas);
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
      const progress = Math.min(1, (now - animation.start) / TURN_DURATION_MS);
      const easedProgress = easeTurnProgress(progress);
      const phaseProgress = easedProgress < 0.5 ? easedProgress / 0.5 : (easedProgress - 0.5) / 0.5;

      if (progress < 1) {
        remaining.push(animation);
        if (easedProgress < 0.5) {
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
