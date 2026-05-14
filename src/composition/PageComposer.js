import { computeMargins, getPageGeometry } from "riffle";

// Maximum offscreen-canvas edge for a single composed page. Mirrors the cap
// the viewer used to enforce. WebGPU implementations sometimes refuse
// textures larger than 8192 on a side, and Firefox flags OffscreenCanvas
// errors at extreme sizes.
const MAX_PAGE_SURFACE_EDGE = 8192;

// Where on a logical page-sized rectangle does the source bitmap end up
// after applying crop / fit / align? The viewer used to compute this inside
// the renderer to know how to paint a content canvas; the same numbers are
// what PageComposer needs to do the painting now.
function measurePageDraw(page, rect, mode, alignX = "center", alignY = "center", sourceBitmap) {
  if (!sourceBitmap) return null;

  const crop = page.getCropFor(sourceBitmap);
  const sourceWidth = sourceBitmap.width - crop.left - crop.right;
  const sourceHeight = sourceBitmap.height - crop.top - crop.bottom;
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;

  const scale = mode === "fill"
    ? Math.max(rect.w / sourceWidth, rect.h / sourceHeight)
    : mode === "fit-width"
      ? rect.w / sourceWidth
      : mode === "fit-height"
        ? rect.h / sourceHeight
        : Math.min(rect.w / sourceWidth, rect.h / sourceHeight);
  const alignedX = alignX === "start"
    ? rect.x
    : alignX === "end"
      ? rect.x + rect.w - sourceWidth * scale
      : rect.x + (rect.w - sourceWidth * scale) / 2;
  const alignedY = alignY === "start"
    ? rect.y
    : alignY === "end"
      ? rect.y + rect.h - sourceHeight * scale
      : rect.y + (rect.h - sourceHeight * scale) / 2;

  const drawRect = {
    x: Math.round(alignedX - crop.left * scale),
    y: Math.round(alignedY - crop.top * scale),
    w: Math.max(1, Math.round(sourceBitmap.width * scale)),
    h: Math.max(1, Math.round(sourceBitmap.height * scale)),
  };

  const clipRect = mode === "fill"
    ? {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.x + rect.w) - Math.round(rect.x),
      h: Math.round(rect.y + rect.h) - Math.round(rect.y),
    }
    : null;

  return {
    drawRect,
    clipRect,
    visibleSourceWidth: sourceBitmap.width,
    visibleSourceHeight: sourceBitmap.height,
    scale,
  };
}

function get2dContext(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return ctx;
}

// Choose a composition scale (pixels per layout unit) that keeps the source
// bitmap close to 1:1 with the page rect — so no detail is lost when the
// content is placed. Capped so the composed canvas's longest edge stays
// within MAX_PAGE_SURFACE_EDGE.
function chooseCompositionScale(layout, sideName, page, sourceBitmap) {
  const baseMargins = computeMargins(layout, 1);
  const baseGeometry = getPageGeometry(baseMargins, sideName, page, 0);
  const baseMeasurement = measurePageDraw(
    page,
    baseGeometry.contentRect,
    baseGeometry.contentMode,
    baseGeometry.contentAlignX,
    baseGeometry.contentAlignY,
    sourceBitmap,
  );
  // Fallback when measurement fails (e.g., source has zero usable area):
  // produce a canvas at roughly preview resolution.
  if (!baseMeasurement || baseMeasurement.drawRect.w <= 0) {
    const fallback = 96; // ~96 px per layout unit ≈ a 528×816 canvas at 5.5×8.5
    return Math.min(fallback, MAX_PAGE_SURFACE_EDGE / Math.max(baseMargins.pagePxW, baseMargins.pagePxH));
  }
  // At scale 1 the source draws into baseMeasurement.drawRect.w *unit*-wide
  // space. The natural-resolution scale is the factor that maps source
  // pixels 1:1 onto the page rect.
  const naturalScale = sourceBitmap.width / baseMeasurement.drawRect.w;
  const maxEdge = Math.max(baseMargins.pagePxW, baseMargins.pagePxH);
  const maxByEdge = MAX_PAGE_SURFACE_EDGE / maxEdge;
  return Math.max(1, Math.min(naturalScale, maxByEdge));
}

// Compose a single page into an offscreen canvas. The output's dimensions
// are proportional to `layout.pw × layout.ph` at a resolution chosen so the
// source bitmap is at (or near) 1:1 with its placed rect on the page.
//
// By default the canvas has a transparent background — paper color and
// content-blend mode happen at render time in the viewer's shader. Pass
// `includePaperColor: true` (and an optional `contentBlendMode`) to bake
// the paper background and blend mode into the canvas (used for thumbnails
// where there's no shader downstream).
export function composePageCanvas({
  page,
  sourceBitmap,
  layout,
  sideName = "right",
  scaleOverride = null,
  includePaperColor = false,
  paperColor = "#ffffff",
  contentBlendMode = "source-over",
}) {
  if (!page || !sourceBitmap || !layout) return null;

  const compositionScale = scaleOverride
    ?? chooseCompositionScale(layout, sideName, page, sourceBitmap);
  const margins = computeMargins(layout, compositionScale);
  const geometry = getPageGeometry(margins, sideName, page, 0);
  const measurement = measurePageDraw(
    page,
    geometry.contentRect,
    geometry.contentMode,
    geometry.contentAlignX,
    geometry.contentAlignY,
    sourceBitmap,
  );
  if (!measurement) return null;

  const pageRect = geometry.pageRect;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.min(MAX_PAGE_SURFACE_EDGE, Math.round(pageRect.w)));
  canvas.height = Math.max(1, Math.min(MAX_PAGE_SURFACE_EDGE, Math.round(pageRect.h)));

  const ctx = get2dContext(canvas);

  if (includePaperColor) {
    ctx.fillStyle = paperColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (measurement.clipRect) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      Math.round(measurement.clipRect.x - pageRect.x),
      Math.round(measurement.clipRect.y - pageRect.y),
      Math.round(measurement.clipRect.w),
      Math.round(measurement.clipRect.h),
    );
    ctx.clip();
  }

  const prevBlend = ctx.globalCompositeOperation;
  if (includePaperColor && contentBlendMode !== "source-over") {
    ctx.globalCompositeOperation = contentBlendMode;
  }
  ctx.drawImage(
    sourceBitmap,
    0,
    0,
    sourceBitmap.width,
    sourceBitmap.height,
    Math.round(measurement.drawRect.x - pageRect.x),
    Math.round(measurement.drawRect.y - pageRect.y),
    Math.round(measurement.drawRect.w),
    Math.round(measurement.drawRect.h),
  );
  ctx.globalCompositeOperation = prevBlend;

  if (measurement.clipRect) ctx.restore();

  return canvas;
}

// Compose a thumbnail-sized canvas with paper color and content blend mode
// applied. Used by PageStrip/PlacedPreviewManager. Output height is
// `targetHeight` (default 1024); width follows layout's paper aspect.
export function composeThumbnailCanvas({
  page,
  sourceBitmap,
  layout,
  display,
  sideName = "right",
  targetHeight = 1024,
}) {
  if (!layout) return null;
  const pageHeight = Math.max(1, Math.round(targetHeight));
  const pageWidth = Math.max(1, Math.round(pageHeight * (layout.pw / layout.ph)));
  const canvas = document.createElement("canvas");
  canvas.width = pageWidth;
  canvas.height = pageHeight;
  const ctx = get2dContext(canvas);
  ctx.fillStyle = display?.paperColor ?? "#ffffff";
  ctx.fillRect(0, 0, pageWidth, pageHeight);
  if (!page || !sourceBitmap) return canvas;

  const margins = computeMargins(layout, pageHeight / layout.ph);
  const geometry = getPageGeometry(margins, sideName, page, 0);
  const measurement = measurePageDraw(
    page,
    geometry.contentRect,
    geometry.contentMode,
    geometry.contentAlignX,
    geometry.contentAlignY,
    sourceBitmap,
  );
  if (!measurement) return canvas;

  if (measurement.clipRect) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      Math.round(measurement.clipRect.x),
      Math.round(measurement.clipRect.y),
      Math.round(measurement.clipRect.w),
      Math.round(measurement.clipRect.h),
    );
    ctx.clip();
  }

  const prevBlend = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = display?.contentBlendMode ?? "source-over";
  ctx.drawImage(
    sourceBitmap,
    0,
    0,
    sourceBitmap.width,
    sourceBitmap.height,
    Math.round(measurement.drawRect.x),
    Math.round(measurement.drawRect.y),
    Math.round(measurement.drawRect.w),
    Math.round(measurement.drawRect.h),
  );
  ctx.globalCompositeOperation = prevBlend;

  if (measurement.clipRect) ctx.restore();

  return canvas;
}

export { MAX_PAGE_SURFACE_EDGE };
