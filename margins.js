const canvas     = document.getElementById("canvas");
let ctx          = canvas.getContext("2d");
const wrap       = document.getElementById("canvas-wrap");
const canvasArea = document.getElementById("canvas-area");

const get = id => parseFloat(document.getElementById(id).value) || 0;
const fmt = v  => v.toFixed(3) + "″";

function get2dContext(targetCanvas, options) {
  return targetCanvas.getContext("2d", options);
}

// ── Mode state ────────────────────────────────────────────────────────────────

let appMode         = "layout";
let savedMarginState = null;
let lastVals        = null;   // last computed vals, used by drawContent()
let paperColor       = "#ffffff";
let contentBlendMode = "source-over";
const renderState   = {
  showMarginArrows: true,
  showLayoutContent:true,
  currentCursor:    "default",
  animationFrame:   0,
  animations:       [],  // { fromCanvas, toCanvas, direction, start, targetSpread }
  baseCanvas:       null,
};

// ── Content state ─────────────────────────────────────────────────────────────

const contentState = {
  pages:              [],  // [{ pageNum, aspectRatio, srcCanvas, loading, cropInitialized, crop, tolerance, cover, fitAxis, effects, renderCache, thumbnail }]
  pdfDoc:             null,
  spread:             0,
  editingPageIdx:     0,
  selectedPageIdxs:   new Set([0]),
  hoverHandle:        null,
};

let dragHandle  = null;  // { edge, startX, startY, startCrop, side }

function getSelectedPages() {
  const sel = contentState.selectedPageIdxs;
  if (!sel.size) return [contentState.pages[contentState.editingPageIdx]].filter(Boolean);
  return [...sel].map(i => contentState.pages[i]).filter(Boolean);
}

function makeDefaultPageEffects() {
  return {
    bwThreshold: 0,
    neutralizeColor: null,
    levelsBlack: 0,
    levelsGray: 128,
    levelsWhite: 255,
  };
}

function getPageEffectState(pg) {
  if (!pg.effects) pg.effects = makeDefaultPageEffects();
  return pg.effects;
}

function getPageEffectKey(pg) {
  const {
    bwThreshold = 0,
    neutralizeColor = null,
    levelsBlack = 0,
    levelsGray = 128,
    levelsWhite = 255,
  } = getPageEffectState(pg);
  const levels = normalizeLevels(levelsBlack, levelsGray, levelsWhite);
  return `neutralize:${neutralizeColor || "none"}|levels:${levels.black},${levels.gray.toFixed(2)},${levels.white}|bw:${bwThreshold}`;
}

function invalidatePageRenderCache(pg, { keepThumbnail = false } = {}) {
  if (!pg) return;
  pg.renderCache = { effectKey: "", canvas: null };
  if (!keepThumbnail) pg.thumbnail = null;
}

function refreshSelectedThumbnails() {
  for (const pg of getSelectedPages()) {
    if (pg?.srcCanvas) generateThumbnail(pg);
  }
  renderPageStrip();
}

let effectPreviewTimer = 0;

function scheduleEffectPreviewDraw() {
  if (effectPreviewTimer) clearTimeout(effectPreviewTimer);
  effectPreviewTimer = setTimeout(() => {
    effectPreviewTimer = 0;
    drawContent();
  }, 40);
}

function flushEffectPreviewDraw() {
  if (effectPreviewTimer) {
    clearTimeout(effectPreviewTimer);
    effectPreviewTimer = 0;
  }
  drawContent();
}

function normalizeHexColor(hex) {
  return typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : null;
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

function normalizeLevels(blackPoint, grayPoint, whitePoint) {
  const black = Math.max(0, Math.min(254, Math.round(Number.isFinite(blackPoint) ? blackPoint : 0)));
  const white = Math.max(1, Math.min(255, Math.round(Number.isFinite(whitePoint) ? whitePoint : 255)));
  const safeBlack = Math.min(black, 254);
  const safeWhite = Math.min(255, Math.max(safeBlack + 1, white));
  let gray = Number.isFinite(grayPoint) ? grayPoint : 128;

  if (gray >= 0.1 && gray <= 4) {
    const midRatio = Math.pow(0.5, 1 / Math.max(0.1, gray));
    gray = safeBlack + midRatio * (safeWhite - safeBlack);
  }

  gray = Math.round(gray);
  gray = Math.max(safeBlack + 1, Math.min(safeWhite - 1, gray));

  if (black < white) return { black, gray, white };
  return {
    black: Math.max(0, safeWhite - 1),
    gray,
    white: safeWhite,
  };
}

function applyLevelsChannel(value, blackPoint, grayPoint, whitePoint) {
  const normalized = Math.max(0, Math.min(1, (value - blackPoint) / (whitePoint - blackPoint)));
  const midpoint = Math.max(0.01, Math.min(0.99, (grayPoint - blackPoint) / (whitePoint - blackPoint)));
  const gamma = Math.log(0.5) / Math.log(midpoint);
  return Math.round(Math.pow(normalized, gamma) * 255);
}

// ── Listener registry ─────────────────────────────────────────────────────────

let _listeners = [];

function addListener(elOrId, type, fn) {
  const el = typeof elOrId === "string" ? document.getElementById(elOrId) : elOrId;
  if (!el) return;
  el.addEventListener(type, fn);
  _listeners.push({ el, type, fn });
}

function clearListeners() {
  for (const { el, type, fn } of _listeners) el.removeEventListener(type, fn);
  _listeners = [];
}

// ── Layout computation ────────────────────────────────────────────────────────

function applyPaperColor(color) {
  paperColor = color;
}

function syncInputs() {
  const ratioInput = document.getElementById("ratio");
  const sameAsPage = document.getElementById("ratio-same-as-page").checked;
  ratioInput.disabled = sameAsPage;
  if (sameAsPage) ratioInput.value = (get("pw") / get("ph")).toFixed(3);
}

function compute() {
  syncInputs();
  const pw = get("pw"), ph = get("ph"), r = get("ratio"), b = get("b-slider");
  const mi = get("m-inner"), mt = get("m-top"), mb = get("m-bottom");
  const inner  = mi * b;
  const top    = mt * b;
  const bottom = mb * b;
  const th     = ph - (mt + mb) * b;
  const tw     = r * th;
  const outer  = pw - inner - tw;
  return { pw, ph, r, b, inner, top, bottom, th, tw, outer };
}

function setC(id, val, warn) {
  const el  = document.getElementById(id);
  const row = el.closest(".computed-row");
  el.textContent = val;
  row.classList.toggle("warn", !!warn);
}

// ── Drawing primitives ────────────────────────────────────────────────────────

// Pixel-perfect strokeRect: snap corners (not x+w) so right/bottom edges
// don't drift 1px due to independent rounding.
function snappedStrokeRect(x, y, w, h) {
  const x0 = Math.round(x),     y0 = Math.round(y);
  const x1 = Math.round(x + w), y1 = Math.round(y + h);
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
}

function dottedLine(x1, y1, x2, y2, dash = [3, 3]) {
  ctx.save();
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
  ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
  ctx.stroke();
  ctx.restore();
}

function getSpreadMetrics(vals, scale) {
  return {
    pagePxW: vals.pw * scale,
    pagePxH: vals.ph * scale,
    twPx:    vals.tw * scale,
    thPx:    vals.th * scale,
    topPx:   vals.top * scale,
    innerPx: vals.inner * scale,
    outerPx: vals.outer * scale,
  };
}

function drawPageContent(pg, x, y, w, h, opts = {}) {
  if (!pg || !pg.srcCanvas) return null;
  const { mode = "fit", clipToRect = false } = opts;
  const srcCanvas = getProcessedCanvas(pg);
  const { crop } = pg;
  const sw = srcCanvas.width  - crop.left - crop.right;
  const sh = srcCanvas.height - crop.top  - crop.bottom;
  if (sw <= 0 || sh <= 0) return null;
  const s  = mode === "fill"
    ? Math.max(w / sw, h / sh)
    : mode === "fit-width"
      ? w / sw
      : mode === "fit-height"
        ? h / sh
        : Math.min(w / sw, h / sh);

  // Snap full image draw rect to integer pixels so drawImage never sub-pixel blurs.
  const rix = Math.round(x + (w - sw * s) / 2 - crop.left * s);
  const riy = Math.round(y + (h - sh * s) / 2 - crop.top  * s);
  const riw = Math.round(srcCanvas.width  * s);
  const rih = Math.round(srcCanvas.height * s);

  // Pixel-snapped clip/content boundaries derived from the rounded draw rect.
  const rcx  = Math.round(rix + crop.left  * riw / srcCanvas.width);
  const rcy  = Math.round(riy + crop.top   * rih / srcCanvas.height);
  const rcx2 = Math.round(rix + (srcCanvas.width  - crop.right)  * riw / srcCanvas.width);
  const rcy2 = Math.round(riy + (srcCanvas.height - crop.bottom) * rih / srcCanvas.height);

  // Pixel-snapped destination clip rect (for cover/fill mode).
  const rx0 = Math.round(x),      ry0 = Math.round(y);
  const rx1 = Math.round(x + w),  ry1 = Math.round(y + h);

  if (clipToRect) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx0, ry0, rx1 - rx0, ry1 - ry0);
    ctx.clip();
  }
  const prevBlend = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = contentBlendMode;
  ctx.drawImage(srcCanvas, rix, riy, riw, rih);
  ctx.globalCompositeOperation = prevBlend;
  if (clipToRect) ctx.restore();

  const visibleX      = clipToRect ? Math.max(rcx,  rx0) : rcx;
  const visibleY      = clipToRect ? Math.max(rcy,  ry0) : rcy;
  const visibleRight  = clipToRect ? Math.min(rcx2, rx1) : rcx2;
  const visibleBottom = clipToRect ? Math.min(rcy2, ry1) : rcy2;

  return {
    x: visibleX,
    y: visibleY,
    w: Math.max(0, visibleRight  - visibleX),
    h: Math.max(0, visibleBottom - visibleY),
    fitScale: s,
    sw: srcCanvas.width,
    sh: srcCanvas.height,
  };
}

function buildSpreadSide(side, metrics, pg, pageIndex, hasPlacedPages) {
  const isLeft = side === "left";
  const fitMode = pg?.fitAxis === "width" || pg?.fitAxis === "height" || pg?.fitAxis === "inside"
    ? pg.fitAxis
    : "inside";
  const pageRect = {
    x: isLeft ? 0 : metrics.pagePxW,
    y: 0,
    w: metrics.pagePxW,
    h: metrics.pagePxH,
  };
  const textblockRect = {
    x: isLeft ? metrics.outerPx : metrics.pagePxW + metrics.innerPx,
    y: metrics.topPx,
    w: metrics.twPx,
    h: metrics.thPx,
  };
  const isBlank = hasPlacedPages && !pg;
  const isCover = !!pg?.cover;

  return {
    side,
    page: pg,
    pageIndex,
    isBlank,
    isCover,
    overlayVisible: !isBlank && !isCover,
    pageRect,
    textblockRect,
    contentRect: isCover ? pageRect : textblockRect,
    contentMode: isCover ? "fill" : fitMode === "width" ? "fit-width" : fitMode === "height" ? "fit-height" : "fit",
    clipContent: isCover,
    drawnRect: null,
  };
}

function getSpreadRenderState(vals, scale, pageFills = null, spreadIndex = contentState.spread) {
  const metrics = getSpreadMetrics(vals, scale);
  const hasPlacedPages = Array.isArray(pageFills);
  const leftPageIdx = spreadIndex * 2 - 1;
  const rightPageIdx = spreadIndex * 2;
  const [leftPg, rightPg] = hasPlacedPages ? pageFills : [null, null];

  return {
    metrics,
    sides: {
      left:  buildSpreadSide("left", metrics, leftPg, leftPageIdx, hasPlacedPages),
      right: buildSpreadSide("right", metrics, rightPg, rightPageIdx, hasPlacedPages),
    },
  };
}

function drawTextblockRect(rect) {
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.setLineDash([1, 2]);
  snappedStrokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function drawMarginOverlay(side, vals, fs) {
  if (!side.overlayVisible) return;

  const { pageRect, textblockRect } = side;
  const midY = pageRect.y + pageRect.h / 2;
  const labelX = textblockRect.x + textblockRect.w / 2;

  drawTextblockRect(textblockRect);

  if (side.side === "left") {
    hArrowLabel(pageRect.x, textblockRect.x, midY, vals.outer.toFixed(2) + "″", fs);
    hArrowLabel(textblockRect.x + textblockRect.w, pageRect.x + pageRect.w, midY, vals.inner.toFixed(2) + "″", fs);
  } else {
    hArrowLabel(pageRect.x, textblockRect.x, midY, vals.inner.toFixed(2) + "″", fs);
    hArrowLabel(textblockRect.x + textblockRect.w, pageRect.x + pageRect.w, midY, vals.outer.toFixed(2) + "″", fs);
  }

  bracketLabel(labelX, pageRect.y, textblockRect.y, vals.top.toFixed(2) + "″", fs);
  bracketLabel(labelX, textblockRect.y + textblockRect.h, pageRect.y + pageRect.h, vals.bottom.toFixed(2) + "″", fs);
}

function paintSpread(targetCanvas, scale, vals, opts = {}) {
  const {
    pageFills = null,
    showPlaceholder = false,
    showMarginOverlay = true,
    showVdG = false,
    spreadIndex = contentState.spread,
  } = opts;
  const prevCtx = ctx;
  ctx = targetCanvas.getContext("2d");

  const { pw, ph, inner, top, bottom, th, tw, outer } = vals;
  const ok = outer > 0 && th > 0 && tw > 0;
  const s = scale;
  const { metrics, sides } = getSpreadRenderState(vals, scale, pageFills, spreadIndex);
  const { pagePxW, pagePxH } = metrics;

  ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
  ctx.save();

  ctx.fillStyle = paperColor;
  ctx.fillRect(0, 0, pagePxW * 2, pagePxH);

  if (ok) {
    for (const side of Object.values(sides)) {
      if (side.page) {
        side.drawnRect = drawPageContent(
          side.page,
          side.contentRect.x,
          side.contentRect.y,
          side.contentRect.w,
          side.contentRect.h,
          { mode: side.contentMode, clipToRect: side.clipContent }
        );
      } else if (showPlaceholder) {
        fillLorem(side.textblockRect.x, side.textblockRect.y, side.textblockRect.w, side.textblockRect.h);
      }
    }

    if (showVdG) drawVdG(pagePxW, pagePxH);

    if (showMarginOverlay) {
      const fs = Math.max(7, Math.round(s / 9));
      ctx.font = `${fs}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      drawMarginOverlay(sides.left, vals, fs);
      drawMarginOverlay(sides.right, vals, fs);
    }
  }

  drawPageBorder(pagePxW, pagePxH);

  ctx.restore();
  ctx = prevCtx;
  return { metrics, sides };
}

function renderSpread(targetCanvas, scale, vals, opts = {}) {
  const vdgEl = document.getElementById("vdg");
  const {
    pageFills = renderState.showLayoutContent ? getSpreadFills() : null,
    showPlaceholder = !contentState.pages.length,
    spreadIndex = contentState.spread,
  } = opts;
  return paintSpread(targetCanvas, scale, vals, {
    pageFills,
    showPlaceholder,
    showMarginOverlay: renderState.showMarginArrows,
    showVdG: !!(vdgEl && vdgEl.checked),
    spreadIndex,
  });
}

// ── Spread helpers ────────────────────────────────────────────────────────────
//
// Spread layout: page 1 always starts on the RIGHT of spread 0.
//   spread 0:  [blank]    | pages[0]
//   spread 1:  pages[1]   | pages[2]
//   spread 2:  pages[3]   | pages[4]  …
//
// left  page index = s*2 - 1  (-1 means blank for spread 0)
// right page index = s*2

function spreadPages(s) {
  const li = s * 2 - 1;
  const ri = s * 2;
  return {
    leftPg:       li >= 0 ? (contentState.pages[li] ?? null) : null,
    rightPg:      contentState.pages[ri] ?? null,
    leftPageIdx:  li,   // -1 = blank
    rightPageIdx: ri,
  };
}

function numSpreads() {
  return Math.max(1, Math.ceil((contentState.pages.length + 1) / 2));
}

function getEffectiveSpread() {
  const anims = renderState.animations;
  return anims.length ? anims[anims.length - 1].targetSpread : contentState.spread;
}

function updateSpreadNav() {
  const strip = document.getElementById("page-strip");
  if (!strip) return;
  const spread = getEffectiveSpread();
  const leftIdx  = spread * 2 - 1;
  const rightIdx = spread * 2;
  let activeEl = null;
  strip.querySelectorAll(".strip-thumb").forEach((el, i) => {
    const inSpread = i === leftIdx || i === rightIdx;
    const isActive = appMode === "content" && i === contentState.editingPageIdx;
    const isSelected = appMode === "content" && contentState.selectedPageIdxs.has(i);
    el.classList.toggle("in-spread", inSpread);
    el.classList.toggle("active", isActive);
    el.classList.toggle("selected", isSelected);
    if (isActive || (inSpread && appMode === "layout" && !activeEl)) activeEl = el;
  });
  activeEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ── Lazy page loading ─────────────────────────────────────────────────────────

function makePdfPageDescriptor(pageNum, aspectRatio) {
  return {
    pageNum, aspectRatio,
    srcCanvas: null, loading: false,
    crop: { top: 0, left: 0, right: 0, bottom: 0 },
    cropInitialized: false,
    tolerance: 15, cover: false, fitAxis: "inside",
    effects: makeDefaultPageEffects(),
    renderCache: { effectKey: "", canvas: null },
    thumbnail: null,
  };
}

function getProcessedCanvas(pg) {
  if (!pg?.srcCanvas) return null;

  const effectKey = getPageEffectKey(pg);
  if (pg.renderCache?.canvas && pg.renderCache.effectKey === effectKey) return pg.renderCache.canvas;

  const srcCanvas = pg.srcCanvas;
  const {
    bwThreshold = 0,
    neutralizeColor = null,
    levelsBlack = 0,
    levelsGray = 128,
    levelsWhite = 255,
  } = getPageEffectState(pg);
  const levels = normalizeLevels(levelsBlack, levelsGray, levelsWhite);
  const neutralizeRgb = hexToRgb(neutralizeColor);
  const hasNeutralizer = !!neutralizeRgb && (neutralizeRgb.r !== 255 || neutralizeRgb.g !== 255 || neutralizeRgb.b !== 255);
  const hasLevels = levels.black !== 0 || levels.gray !== 128 || levels.white !== 255;
  if (bwThreshold <= 0 && !hasNeutralizer && !hasLevels) {
    pg.renderCache = { effectKey, canvas: srcCanvas };
    return srcCanvas;
  }

  const out = document.createElement("canvas");
  out.width = srcCanvas.width;
  out.height = srcCanvas.height;

  const srcCtx = get2dContext(srcCanvas, { willReadFrequently: true });
  const outCtx = get2dContext(out, { willReadFrequently: true });
  const imageData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const { data } = imageData;
  const threshold = bwThreshold / 100;

  for (let i = 0; i < data.length; i += 4) {
    const sourceR = data[i];
    const sourceG = data[i + 1];
    const sourceB = data[i + 2];
    const max = Math.max(sourceR, sourceG, sourceB);
    const min = Math.min(sourceR, sourceG, sourceB);
    const delta = max - min;
    const saturation = max === 0 ? 0 : delta / max;

    let r = sourceR;
    let g = sourceG;
    let b = sourceB;

    if (hasNeutralizer) {
      r = Math.min(255, Math.round(r * 255 / Math.max(1, neutralizeRgb.r)));
      g = Math.min(255, Math.round(g * 255 / Math.max(1, neutralizeRgb.g)));
      b = Math.min(255, Math.round(b * 255 / Math.max(1, neutralizeRgb.b)));
    }

    if (hasLevels) {
      r = applyLevelsChannel(r, levels.black, levels.gray, levels.white);
      g = applyLevelsChannel(g, levels.black, levels.gray, levels.white);
      b = applyLevelsChannel(b, levels.black, levels.gray, levels.white);
    }

    if (saturation <= threshold) {
      const gray = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      r = gray;
      g = gray;
      b = gray;
    }

    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }

  outCtx.putImageData(imageData, 0, 0);
  pg.renderCache = { effectKey, canvas: out };
  return out;
}

function generateThumbnail(pg) {
  if (!pg.srcCanvas) return;
  const THUMB_H = 56;
  const tc = document.createElement("canvas");
  tc.height = THUMB_H;
  tc.width  = Math.round(THUMB_H * pg.aspectRatio);
  const tctx = tc.getContext("2d");
  tctx.fillStyle = paperColor;
  tctx.fillRect(0, 0, tc.width, tc.height);
  tctx.globalCompositeOperation = contentBlendMode;
  tctx.drawImage(getProcessedCanvas(pg), 0, 0, tc.width, tc.height);
  pg.thumbnail = tc;
}

function regenerateAllThumbnails() {
  for (const pg of contentState.pages) {
    pg.thumbnail = null;
    if (pg.srcCanvas) generateThumbnail(pg);
  }
  renderPageStrip();
}

async function renderPdfPage(pageIdx) {
  const pg = contentState.pages[pageIdx];
  if (!pg || pg.srcCanvas || pg.loading || !pg.pageNum || !contentState.pdfDoc) return;
  pg.loading = true;
  try {
    const page = await contentState.pdfDoc.getPage(pg.pageNum);
    const vp   = page.getViewport({ scale: 2 });
    const off  = document.createElement("canvas");
    off.width  = vp.width; off.height = vp.height;
    await page.render({
      canvasContext: get2dContext(off, { willReadFrequently: true }),
      viewport: vp,
    }).promise;
    pg.srcCanvas    = off;
    pg.aspectRatio  = off.width / off.height;
    pg.loading      = false;
    invalidatePageRenderCache(pg);
    if (!pg.cropInitialized) {
      pg.crop            = autoCrop(off, pg.tolerance);
      pg.cropInitialized = true;
    }
    generateThumbnail(pg);
    // Update strip thumb for this page without rebuilding the whole strip
    const strip = document.getElementById("page-strip");
    const thumb = strip?.querySelectorAll(".strip-thumb")[pageIdx];
    if (thumb && pg.thumbnail) {
      const oldCanvas = thumb.querySelector("canvas");
      if (oldCanvas) {
        const nc = document.createElement("canvas");
        nc.width  = pg.thumbnail.width;
        nc.height = pg.thumbnail.height;
        nc.getContext("2d").drawImage(pg.thumbnail, 0, 0);
        oldCanvas.replaceWith(nc);
      }
    }
    const spread = contentState.spread;
    const { leftPageIdx, rightPageIdx } = spreadPages(spread);
    if (pageIdx === leftPageIdx || pageIdx === rightPageIdx) {
      if (appMode === "content") drawContent();
      else draw();
    }
  } catch (e) {
    pg.loading = false;
    console.error(`Failed to render PDF page ${pg.pageNum}:`, e);
  }
}

function unloadPdfPage(pageIdx) {
  const pg = contentState.pages[pageIdx];
  if (!pg || !pg.srcCanvas || !pg.pageNum) return; // never unload image pages
  pg.srcCanvas = null;
  invalidatePageRenderCache(pg, { keepThumbnail: true });
}

let _lastEnsuredSpread = -1;

function ensureSpreadLoaded(spreadIdx) {
  _lastEnsuredSpread = spreadIdx;
  const n = numSpreads();
  for (let s = Math.max(0, spreadIdx - 1); s <= Math.min(n - 1, spreadIdx + 1); s++) {
    const { leftPageIdx, rightPageIdx } = spreadPages(s);
    if (leftPageIdx >= 0) renderPdfPage(leftPageIdx);
    if (rightPageIdx >= 0 && rightPageIdx < contentState.pages.length) renderPdfPage(rightPageIdx);
  }
  // Unload pages far from current spread
  const KEEP = 3;
  const keep = new Set();
  for (let s = Math.max(0, spreadIdx - KEEP); s <= Math.min(n - 1, spreadIdx + KEEP); s++) {
    const { leftPageIdx, rightPageIdx } = spreadPages(s);
    if (leftPageIdx >= 0) keep.add(leftPageIdx);
    if (rightPageIdx >= 0) keep.add(rightPageIdx);
  }
  contentState.pages.forEach((_, i) => { if (!keep.has(i)) unloadPdfPage(i); });
}

function renderPageStrip() {
  const strip = document.getElementById("page-strip");
  if (!strip) return;
  strip.innerHTML = "";
  if (!contentState.pages.length) {
    strip.style.display = "none";
    updateSpreadNav();
    return;
  }
  strip.style.display = "";
  const THUMB_H = 56;
  contentState.pages.forEach((pg, i) => {
    const thumb = document.createElement("div");
    thumb.className = "strip-thumb";
    const tc = document.createElement("canvas");
    tc.height = THUMB_H;
    tc.width  = Math.round(THUMB_H * pg.aspectRatio);
    const tctx = tc.getContext("2d");
    if (pg.thumbnail) {
      tctx.drawImage(pg.thumbnail, 0, 0, tc.width, tc.height);
    } else {
      tctx.fillStyle = paperColor;
      tctx.fillRect(0, 0, tc.width, tc.height);
    }
    const label = document.createElement("span");
    label.textContent = i + 1;
    thumb.append(tc, label);
    thumb.addEventListener("click", e => {
      const targetSpread = Math.floor((i + 1) / 2);
      if (appMode === "content") {
        if (e.metaKey || e.ctrlKey) {
          // Cmd+click: toggle this page in selection
          if (contentState.selectedPageIdxs.has(i)) {
            contentState.selectedPageIdxs.delete(i);
            if (contentState.editingPageIdx === i) {
              const last = [...contentState.selectedPageIdxs].pop();
              if (last !== undefined) contentState.editingPageIdx = last;
            }
          } else {
            contentState.selectedPageIdxs.add(i);
            contentState.editingPageIdx = i;
          }
        } else if (e.shiftKey) {
          // Shift+click: range from editing page to i
          const from = Math.min(contentState.editingPageIdx, i);
          const to   = Math.max(contentState.editingPageIdx, i);
          for (let j = from; j <= to; j++) contentState.selectedPageIdxs.add(j);
          contentState.editingPageIdx = i;
        } else {
          // Plain click: select only this page
          contentState.editingPageIdx = i;
          contentState.selectedPageIdxs = new Set([i]);
          animateToSpread(targetSpread);
        }
        syncPageUI();
        updateSpreadNav();
        drawContent();
        return;
      }
      animateToSpread(targetSpread);
    });
    strip.append(thumb);
  });
  updateSpreadNav();
}

// ── Layout draw ───────────────────────────────────────────────────────────────

function getSpreadFills(spreadIndex = contentState.spread) {
  if (!contentState.pages.length) return null;
  const { leftPg, rightPg } = spreadPages(spreadIndex);
  return [leftPg, rightPg];
}

function getCanvasScale(vals) {
  const ww = canvasArea.clientWidth - 64;
  const wh = canvasArea.clientHeight - 64;
  return Math.min(ww / (2 * vals.pw), wh / vals.ph);
}

function createSpreadSnapshot(vals, spreadIndex, mode = appMode) {
  const scale = getCanvasScale(vals);
  const offscreen = document.createElement("canvas");
  offscreen.width = Math.round(2 * vals.pw * scale);
  offscreen.height = Math.round(vals.ph * scale);

  if (mode === "layout") {
    renderSpread(offscreen, scale, vals, {
      pageFills: renderState.showLayoutContent ? getSpreadFills(spreadIndex) : null,
      showPlaceholder: !contentState.pages.length,
      spreadIndex,
    });
  } else {
    paintSpread(offscreen, scale, vals, {
      pageFills: getSpreadFills(spreadIndex),
      showMarginOverlay: false,
      spreadIndex,
    });
  }

  return offscreen;
}

function drawPageSlice(img, sx, sy, sw, sh, dx, dy, dw, dh, mirrored = false) {
  if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
  if (!mirrored) {
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    return;
  }

  ctx.save();
  ctx.translate(dx + dw, dy);
  ctx.scale(-1, 1);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
  ctx.restore();
}

function stopSpreadAnimation() {
  if (renderState.animationFrame) cancelAnimationFrame(renderState.animationFrame);
  renderState.animationFrame = 0;
  renderState.animations = [];
  renderState.baseCanvas = null;
}

function _tickAnimations(now) {
  const W = canvas.width, H = canvas.height, pageW = W / 2;
  ctx.clearRect(0, 0, W, H);
  if (renderState.baseCanvas) ctx.drawImage(renderState.baseCanvas, 0, 0);

  const remaining = [];
  const liftAnims = []; // { anim, liftW } — pages in the air
  const landAnims = []; // { anim, landW } — pages settling

  for (const anim of renderState.animations) {
    const progress = Math.min(1, (now - anim.start) / 420);
    const phaseP   = progress < 0.5 ? progress / 0.5 : (progress - 0.5) / 0.5;
    if (progress < 1) {
      remaining.push(anim);
      if (progress < 0.5)
        liftAnims.push({ anim, liftW: Math.max(0, pageW * (1 - phaseP)) });
      else
        landAnims.push({ anim, landW: Math.max(0, pageW * phaseP) });
    } else {
      contentState.spread = anim.targetSpread;
      renderState.baseCanvas = anim.toCanvas;
    }
  }

  // Layer 1 — land-phase pages (lowest Z, already crossed over)
  for (const { anim, landW } of landAnims) {
    if (anim.direction > 0) {
      drawPageSlice(anim.toCanvas, pageW, 0, pageW, H, pageW,         0, pageW, H);
      drawPageSlice(anim.toCanvas, 0,     0, pageW, H, pageW - landW, 0, landW, H);
    } else {
      drawPageSlice(anim.toCanvas, 0,     0, pageW, H, 0,    0, pageW, H);
      drawPageSlice(anim.toCanvas, pageW, 0, pageW, H, pageW, 0, landW, H);
    }
  }

  // Layer 2 — lift-phase destination backgrounds (oldest → newest)
  // Each "to" half stacks in front of the previous, revealing the final destination deepest
  for (const { anim } of liftAnims) {
    if (anim.direction > 0)
      drawPageSlice(anim.toCanvas, pageW, 0, pageW, H, pageW, 0, pageW, H);
    else
      drawPageSlice(anim.toCanvas, 0,     0, pageW, H, 0,     0, pageW, H);
  }

  // Layer 3 — lift-phase strips (newest → oldest, so oldest strip is on top)
  // Older page = further along its arc = physically higher = drawn last
  for (let i = liftAnims.length - 1; i >= 0; i--) {
    const { anim, liftW } = liftAnims[i];
    if (anim.direction > 0)
      drawPageSlice(anim.fromCanvas, pageW, 0, pageW, H, pageW,         0, liftW, H);
    else
      drawPageSlice(anim.fromCanvas, 0,     0, pageW, H, pageW - liftW, 0, liftW, H);
  }

  drawPageBorder(pageW);
  renderState.animations = remaining;

  if (remaining.length) {
    renderState.animationFrame = requestAnimationFrame(_tickAnimations);
  } else {
    renderState.animationFrame = 0;
    canvas._spreadRects = null;
    if (appMode === "layout") draw();
    else drawContent();
  }
}

function selectSpreadPage(spreadIdx) {
  if (appMode !== "content" || !contentState.pages.length) return;
  const { leftPageIdx, rightPageIdx } = spreadPages(spreadIdx);
  const pageIdx = leftPageIdx >= 0 ? leftPageIdx : rightPageIdx;
  if (pageIdx < 0 || pageIdx >= contentState.pages.length) return;
  contentState.editingPageIdx   = pageIdx;
  contentState.selectedPageIdxs = new Set([pageIdx]);
  syncPageUI();
  updateSpreadNav();
}

function animateToSpread(targetSpread) {
  if (targetSpread === getEffectiveSpread()) return;

  ensureSpreadLoaded(targetSpread);
  selectSpreadPage(targetSpread);

  if (!lastVals || !contentState.pages.length) {
    contentState.spread = targetSpread;
    stopSpreadAnimation();
    if (appMode === "layout") draw();
    else drawContent();
    return;
  }

  const fromSpread = getEffectiveSpread();
  const direction  = targetSpread > fromSpread ? 1 : -1;
  const fromCanvas = createSpreadSnapshot(lastVals, fromSpread);
  const toCanvas   = createSpreadSnapshot(lastVals, targetSpread);

  if (!renderState.animations.length) renderState.baseCanvas = fromCanvas;

  renderState.animations.push({ fromCanvas, toCanvas, direction, start: performance.now(), targetSpread });

  canvas._spreadRects = null;
  updateSpreadNav();

  if (!renderState.animationFrame) {
    renderState.animationFrame = requestAnimationFrame(_tickAnimations);
  }
}

function draw() {
  const vals = compute();
  lastVals = vals;
  const { pw, ph, b, inner, top, bottom, th, tw, outer } = vals;
  const ok = outer > 0 && th > 0 && tw > 0;

  document.getElementById("b-val").textContent = b.toFixed(2) + "″";
  setC("c-inner",  fmt(inner));
  setC("c-top",    fmt(top));
  setC("c-outer",  ok ? fmt(outer)  : "invalid", !ok);
  setC("c-bottom", fmt(bottom));
  setC("c-tw",     ok ? fmt(tw)     : "invalid", !ok);
  setC("c-th",     ok ? fmt(th)     : "invalid", !ok);

  const scale = getCanvasScale(vals);

  canvas.width  = Math.round(2 * pw * scale);
  canvas.height = Math.round(ph * scale);
  setCanvasCursor(renderState.currentCursor);

  contentState.spread = Math.min(contentState.spread, numSpreads() - 1);

  const { metrics, sides } = renderSpread(canvas, scale, vals, {
    pageFills: renderState.showLayoutContent ? getSpreadFills() : null,
    showPlaceholder: !contentState.pages.length,
  });
  canvas._spreadRects = renderState.showLayoutContent && contentState.pages.length
    ? {
        left: sides.left.drawnRect ? { ...sides.left.drawnRect, pageIndex: sides.left.pageIndex } : null,
        right: sides.right.drawnRect ? { ...sides.right.drawnRect, pageIndex: sides.right.pageIndex } : null,
        pagePxW: metrics.pagePxW,
      }
    : null;
  updateSpreadNav();
}

// ── Arrow / bracket label helpers ─────────────────────────────────────────────

function hArrowLabel(x1, x2, y, text, fs) {
  x1 = Math.round(x1); x2 = Math.round(x2); y = Math.round(y) + 0.5;
  const pad   = fs * 0.5;
  const midX  = Math.round((x1 + x2) / 2);
  const textW = ctx.measureText(text).width;
  const aw    = Math.round(fs * 0.6);
  const ah    = Math.round(fs * 0.35);

  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth   = 1;

  ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(midX - textW / 2 - pad, y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(midX + textW / 2 + pad, y); ctx.lineTo(x2, y); ctx.stroke();

  ctx.beginPath(); ctx.moveTo(x1 + aw, y - ah); ctx.lineTo(x1, y); ctx.lineTo(x1 + aw, y + ah); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x2 - aw, y - ah); ctx.lineTo(x2, y); ctx.lineTo(x2 - aw, y + ah); ctx.stroke();

  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, midX, y);
  ctx.restore();
}

function bracketLabel(x, y1, y2, text, fs) {
  x = Math.round(x) + 0.5; y1 = Math.round(y1); y2 = Math.round(y2);
  const pad   = fs * 0.5;
  const midY  = Math.round((y1 + y2) / 2);
  const textW = ctx.measureText(text).width;
  const aw    = Math.round(fs * 0.35);
  const ah    = Math.round(fs * 0.6);

  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth   = 1;

  ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, midY - fs / 2 - pad); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, midY + fs / 2 + pad); ctx.lineTo(x, y2); ctx.stroke();

  ctx.beginPath(); ctx.moveTo(x - aw, y1 + ah); ctx.lineTo(x, y1); ctx.lineTo(x + aw, y1 + ah); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - aw, y2 - ah); ctx.lineTo(x, y2); ctx.lineTo(x + aw, y2 - ah); ctx.stroke();

  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, midY);
  ctx.restore();
}

function drawVdG(W, H) {
  W = Math.round(W); H = Math.round(H);
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth   = 1;
  ctx.setLineDash([1, 2]);

  function line(x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
    ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
    ctx.stroke();
  }

  line(0, 0,   2*W, H);   line(0, H,   2*W, 0);
  line(0, H,   W,   0);   line(2*W, H, W,   0);

  const p1x = 2*W/3, p1y = H/3, p2x = 4*W/3, p2y = H/3;
  line(p1x, p1y, p1x, 0);  line(p2x, p2y, p2x, 0);
  line(p1x, 0,   p2x, p2y); line(p2x, 0,   p1x, p1y);

  snappedStrokeRect(2*W/9,   H/9, 2*W/3, 2*H/3);
  snappedStrokeRect(W+W/9,   H/9, 2*W/3, 2*H/3);
  ctx.restore();
}

const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt. Neque porro quisquam est qui dolorem ipsum quia dolor sit amet consectetur adipisci velit. ";

function tryHyphenate(word, availWidth, minBefore = 3, minAfter = 2) {
  if (word.length < minBefore + minAfter + 1) return null;
  for (let i = word.length - minAfter; i >= minBefore; i--) {
    const head = word.slice(0, i) + "-";
    if (ctx.measureText(head).width <= availWidth) return [head, word.slice(i)];
  }
  return null;
}

function renderJustified(words, x, lineY, w, isLast) {
  if (isLast || words.length <= 1) {
    ctx.textAlign = "left";
    ctx.fillText(words.join(" "), x, lineY);
    return;
  }
  const textW = words.reduce((sum, wd) => sum + ctx.measureText(wd).width, 0);
  const gap   = (w - textW) / (words.length - 1);
  let cx = x;
  for (const wd of words) {
    ctx.fillText(wd, cx, lineY);
    cx += ctx.measureText(wd).width + gap;
  }
}

function fillLorem(x, y, w, h) {
  const probe    = "abcdefghijklmnopqrstuvwxyz";
  ctx.font = `12px Georgia, serif`;
  const avgW12   = ctx.measureText(probe).width / probe.length;
  const fontSize = Math.max(5, Math.round(w / (60 * avgW12 / 12)));
  const leading  = fontSize * 1.45;

  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle    = "#000";
  ctx.font         = `${fontSize}px Georgia, serif`;
  ctx.textBaseline = "top";

  const src   = LOREM.repeat(6).split(" ").filter(Boolean);
  const lines = [];
  let row = [];

  for (const word of src) {
    if ((lines.length + 1) * leading > h + leading) break;
    const candidate = [...row, word].join(" ");
    if (row.length > 0 && ctx.measureText(candidate).width > w) {
      const avail = w - ctx.measureText(row.join(" ") + " ").width;
      const hyph  = tryHyphenate(word, avail);
      if (hyph) { lines.push([...row, hyph[0]]); row = [hyph[1]]; }
      else       { lines.push([...row]);           row = [word];   }
    } else {
      row.push(word);
    }
  }
  if (row.length) lines.push(row);

  lines.forEach((lineWords, i) => {
    const lineY = y + i * leading;
    if (lineY + fontSize > y + h) return;
    renderJustified(lineWords, x, lineY, w, i === lines.length - 1);
  });

  ctx.restore();
}

// ── Mode management ───────────────────────────────────────────────────────────

function saveMarginState() {
  savedMarginState = {};
  ["pw","ph","page-ratio","ratio","b-slider","m-inner","m-top","m-bottom"].forEach(id => {
    const el = document.getElementById(id);
    if (el) savedMarginState[id] = el.value;
  });
  ["preserve-ratio","ratio-same-as-page","vdg"].forEach(id => {
    const el = document.getElementById(id);
    if (el) savedMarginState[id] = el.checked;
  });
  const preset = document.getElementById("preset");
  if (preset) savedMarginState.preset = preset.value;
  savedMarginState["paper-color"]    = paperColor;
  savedMarginState["content-blend"]  = contentBlendMode;
}

function syncMarginArrowToggle() {
  const el = document.getElementById("show-margin-arrows");
  if (el) el.checked = renderState.showMarginArrows;
}

function syncLayoutContentToggle() {
  const el = document.getElementById("show-layout-content");
  if (el) el.checked = renderState.showLayoutContent;
}

function initDisplayControls(redrawFn, { includeLayoutContent = false } = {}) {
  syncMarginArrowToggle();
  syncLayoutContentToggle();
  addListener("show-margin-arrows", "change", function () {
    renderState.showMarginArrows = this.checked;
    redrawFn();
  });
  if (includeLayoutContent) {
    addListener("show-layout-content", "change", function () {
      renderState.showLayoutContent = this.checked;
      redrawFn();
    });
  }
}

function restoreMarginState() {
  if (!savedMarginState) return;
  ["pw","ph","page-ratio","ratio","b-slider","m-inner","m-top","m-bottom"].forEach(id => {
    const el = document.getElementById(id);
    if (el && savedMarginState[id] !== undefined) el.value = savedMarginState[id];
  });
  ["preserve-ratio","ratio-same-as-page","vdg"].forEach(id => {
    const el = document.getElementById(id);
    if (el && savedMarginState[id] !== undefined) el.checked = savedMarginState[id];
  });
  const preset = document.getElementById("preset");
  if (preset && savedMarginState.preset !== undefined) preset.value = savedMarginState.preset;
  if (savedMarginState["paper-color"]) {
    const el = document.getElementById("paper-color");
    if (el) el.value = savedMarginState["paper-color"];
    applyPaperColor(savedMarginState["paper-color"]);
  }
  if (savedMarginState["content-blend"]) {
    const el = document.getElementById("content-blend");
    if (el) el.value = savedMarginState["content-blend"];
    contentBlendMode = savedMarginState["content-blend"];
  }
}

function initLayoutListeners() {
  initDisplayControls(draw, { includeLayoutContent: true });

  addListener("paper-color", "input", function () {
    applyPaperColor(this.value);
    regenerateAllThumbnails();
    draw();
  });

  addListener("content-blend", "change", function () {
    contentBlendMode = this.value;
    regenerateAllThumbnails();
    draw();
  });

  addListener("preset", "change", function () {
    if (!this.value) return;
    const [w, h] = this.value.split(",").map(Number);
    document.getElementById("pw").value = w;
    document.getElementById("ph").value = h;
    document.getElementById("page-ratio").value = (w / h).toFixed(3);
    draw();
  });

  addListener("page-ratio", "change", function () {
    const r = parseFloat(this.value);
    if (!r || r <= 0) return;
    const pw = get("pw"), ph = get("ph");
    if (r < pw / ph) {
      document.getElementById("pw").value = (ph * r).toFixed(3);
    } else {
      document.getElementById("ph").value = (pw / r).toFixed(3);
    }
    draw();
  });

  addListener("pw", "input", function () {
    const pw = get("pw");
    if (document.getElementById("preserve-ratio").checked) {
      const r = parseFloat(document.getElementById("page-ratio").value);
      if (r) document.getElementById("ph").value = (pw / r).toFixed(3);
    } else {
      document.getElementById("page-ratio").value = (pw / get("ph")).toFixed(3);
    }
    draw();
  });

  addListener("ph", "input", function () {
    const ph = get("ph");
    if (document.getElementById("preserve-ratio").checked) {
      const r = parseFloat(document.getElementById("page-ratio").value);
      if (r) document.getElementById("pw").value = (ph * r).toFixed(3);
    } else {
      document.getElementById("page-ratio").value = (get("pw") / ph).toFixed(3);
    }
    draw();
  });

  ["ratio","m-inner","m-top","m-bottom"].forEach(id =>
    addListener(id, "input", draw)
  );
  addListener("b-slider", "input", draw);
  addListener("vdg", "change", draw);
  addListener("ratio-same-as-page", "change", draw);
  addListener("preserve-ratio", "change", draw);

  addListener("vdg-snap", "click", function () {
    const pw = get("pw"), ph = get("ph");
    const b  = pw / 9;
    document.getElementById("b-slider").value  = b.toFixed(3);
    document.getElementById("m-inner").value   = "1";
    document.getElementById("m-top").value     = (ph / pw).toFixed(3);
    document.getElementById("m-bottom").value  = (2 * ph / pw).toFixed(3);
    document.getElementById("ratio").value     = (pw / ph).toFixed(3);
    document.getElementById("ratio-same-as-page").checked = true;
    draw();
  });

  addListener("print-btn", "click", function () {
    const vals = compute();
    const { pw, ph } = vals;
    const DPI = 300;
    const printCanvas = document.createElement("canvas");
    printCanvas.width  = Math.round(2 * pw * DPI);
    printCanvas.height = Math.round(ph * DPI);
    renderSpread(printCanvas, DPI, vals, {
      pageFills: renderState.showLayoutContent ? getSpreadFills() : null,
      showPlaceholder: !contentState.pages.length,
    });

    const win = window.open("", "_blank");
    win.document.write(`<!DOCTYPE html><html><head><style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      @page { size: ${2 * pw}in ${ph}in; margin: 0; }
      body { width: ${2 * pw}in; height: ${ph}in; }
      img { width: ${2 * pw}in; height: ${ph}in; display: block; }
    </style></head><body>
      <img src="${printCanvas.toDataURL("image/png")}">
      <script>window.onload = function () { window.print(); window.close(); };<\/script>
    </body></html>`);
    win.document.close();
  });
}

function setTrimUI(tolerance) {
  const slider = document.getElementById("trim-slider");
  const valEl  = document.getElementById("trim-val");
  if (slider) slider.value    = tolerance;
  if (valEl)  valEl.textContent = tolerance;
}

function setBwUI(threshold) {
  const slider = document.getElementById("bw-slider");
  const valEl  = document.getElementById("bw-val");
  if (slider) slider.value = threshold;
  if (valEl) valEl.textContent = `${threshold}% sat`;
}

function setNeutralizeUI(color) {
  const normalized = normalizeHexColor(color);
  const colorEl = document.getElementById("neutralize-color");
  const valEl = document.getElementById("neutralize-val");
  if (colorEl) colorEl.value = normalized || "#ffffff";
  if (valEl) valEl.textContent = normalized || "none";
}

function setLevelsUI({ black = 0, gray = 128, white = 255 } = {}) {
  const levels = normalizeLevels(black, gray, white);
  const blackEl = document.getElementById("levels-black");
  const grayEl = document.getElementById("levels-gray");
  const whiteEl = document.getElementById("levels-white");
  const blackValEl = document.getElementById("levels-black-val");
  const grayValEl = document.getElementById("levels-gray-val");
  const whiteValEl = document.getElementById("levels-white-val");
  if (blackEl) blackEl.value = levels.black;
  if (grayEl) grayEl.value = levels.gray;
  if (whiteEl) whiteEl.value = levels.white;
  if (blackValEl) blackValEl.textContent = String(levels.black);
  if (grayValEl) grayValEl.textContent = String(levels.gray);
  if (whiteValEl) whiteValEl.textContent = String(levels.white);
}

function applyTrimToPage(pg) {
  if (!pg) return;
  const slider    = document.getElementById("trim-slider");
  const tolerance = slider ? parseInt(slider.value, 10) : 15;
  pg.tolerance = tolerance;
  if (pg.srcCanvas) {
    pg.crop            = autoCrop(pg.srcCanvas, tolerance);
    pg.cropInitialized = true;
  } else {
    pg.cropInitialized = false; // recompute on next load
  }
  const valEl = document.getElementById("trim-val");
  if (valEl) valEl.textContent = tolerance;
}

function applyBwToPage(pg) {
  if (!pg) return;
  const slider = document.getElementById("bw-slider");
  const threshold = slider ? parseInt(slider.value, 10) : 0;
  getPageEffectState(pg).bwThreshold = Math.max(0, Math.min(100, threshold || 0));
  invalidatePageRenderCache(pg, { keepThumbnail: true });
}

function applyNeutralizeColorToPage(pg, color) {
  if (!pg) return;
  getPageEffectState(pg).neutralizeColor = normalizeHexColor(color);
  invalidatePageRenderCache(pg, { keepThumbnail: true });
}

function applyLevelsToPage(pg, levels) {
  if (!pg) return;
  const effectState = getPageEffectState(pg);
  effectState.levelsBlack = levels.black;
  effectState.levelsGray = levels.gray;
  effectState.levelsWhite = levels.white;
  invalidatePageRenderCache(pg, { keepThumbnail: true });
}

// Sync all per-page sidebar controls to the currently editing page
function syncPageUI() {
  const section = document.getElementById("trim-section");
  if (section) section.style.display = "";
  const pg = contentState.pages[contentState.editingPageIdx];
  if (!pg) return;
  setTrimUI(pg.tolerance);
  const effects = getPageEffectState(pg);
  setBwUI(effects.bwThreshold);
  setNeutralizeUI(effects.neutralizeColor);
  setLevelsUI({
    black: effects.levelsBlack,
    gray: effects.levelsGray,
    white: effects.levelsWhite,
  });
  const coverEl = document.getElementById("cover-check");
  if (coverEl) coverEl.checked = pg.cover;
  const fitAxisEl = document.getElementById("fit-axis");
  if (fitAxisEl) {
    fitAxisEl.value = pg.fitAxis === "width" || pg.fitAxis === "height" || pg.fitAxis === "inside"
      ? pg.fitAxis
      : "inside";
    fitAxisEl.disabled = !!pg.cover;
  }
  const countEl = document.getElementById("selection-count");
  if (countEl) {
    const n = contentState.selectedPageIdxs.size;
    countEl.textContent = n > 1 ? `${n} pages` : "";
  }
}

function showTrimSection() { syncPageUI(); }

function initContentListeners() {
  initDisplayControls(drawContent);

  addListener("trim-slider", "input", () => {
    for (const pg of getSelectedPages()) applyTrimToPage(pg);
    drawContent();
  });

  addListener("bw-slider", "input", () => {
    for (const pg of getSelectedPages()) applyBwToPage(pg);
    scheduleEffectPreviewDraw();
  });
  addListener("bw-slider", "change", () => {
    refreshSelectedThumbnails();
    flushEffectPreviewDraw();
  });

  addListener("neutralize-clear", "click", () => {
    for (const pg of getSelectedPages()) applyNeutralizeColorToPage(pg, null);
    syncPageUI();
    refreshSelectedThumbnails();
    drawContent();
  });

  addListener("neutralize-color", "input", () => {
    const color = document.getElementById("neutralize-color").value;
    for (const pg of getSelectedPages()) applyNeutralizeColorToPage(pg, color);
    syncPageUI();
    scheduleEffectPreviewDraw();
  });
  addListener("neutralize-color", "change", () => {
    refreshSelectedThumbnails();
    flushEffectPreviewDraw();
  });

  function applyLevelsFromUI(changedId) {
    const blackInput = document.getElementById("levels-black");
    const grayInput = document.getElementById("levels-gray");
    const whiteInput = document.getElementById("levels-white");
    let black = blackInput ? parseInt(blackInput.value, 10) : 0;
    let gray = grayInput ? parseInt(grayInput.value, 10) : 128;
    let white = whiteInput ? parseInt(whiteInput.value, 10) : 255;

    if (black >= white) {
      if (changedId === "levels-white") black = Math.max(0, white - 1);
      else white = Math.min(255, black + 1);
    }

    if (gray <= black) gray = black + 1;
    if (gray >= white) gray = white - 1;

    const levels = normalizeLevels(black, gray, white);
    setLevelsUI(levels);
    for (const pg of getSelectedPages()) applyLevelsToPage(pg, levels);
    scheduleEffectPreviewDraw();
  }

  addListener("levels-black", "input", () => { applyLevelsFromUI("levels-black"); });
  addListener("levels-gray", "input", () => { applyLevelsFromUI("levels-gray"); });
  addListener("levels-white", "input", () => { applyLevelsFromUI("levels-white"); });
  addListener("levels-black", "change", () => {
    refreshSelectedThumbnails();
    flushEffectPreviewDraw();
  });
  addListener("levels-gray", "change", () => {
    refreshSelectedThumbnails();
    flushEffectPreviewDraw();
  });
  addListener("levels-white", "change", () => {
    refreshSelectedThumbnails();
    flushEffectPreviewDraw();
  });

  addListener("cover-check", "change", () => {
    const checked = document.getElementById("cover-check").checked;
    for (const pg of getSelectedPages()) pg.cover = checked;
    syncPageUI();
    drawContent();
  });

  addListener("fit-axis", "change", () => {
    const value = document.getElementById("fit-axis").value;
    const fitAxis = value === "width" || value === "height" ? value : "inside";
    for (const pg of getSelectedPages()) pg.fitAxis = fitAxis;
    drawContent();
  });
}

function switchMode(mode) {
  if (mode === appMode) return;

  stopSpreadAnimation();
  if (effectPreviewTimer) {
    clearTimeout(effectPreviewTimer);
    effectPreviewTimer = 0;
  }
  if (appMode === "layout") saveMarginState();
  clearListeners();
  appMode    = mode;

  document.querySelectorAll(".mode-tab").forEach(btn =>
    btn.classList.toggle("active", btn.dataset.mode === mode)
  );

  const tpl     = document.getElementById(`tpl-${mode}`);
  const toolbar = document.getElementById("toolbar");
  toolbar.innerHTML = "";
  toolbar.appendChild(tpl.content.cloneNode(true));
  htmx.process(toolbar);

  if (mode === "layout") {
    setCanvasCursor("default");
    restoreMarginState();
    initLayoutListeners();
    draw();
  } else {
    contentState.hoverHandle = null;
    setCanvasCursor("default");
    initContentListeners();
    if (contentState.pages.length) showTrimSection();
    drawContent();
  }
}

// ── Content mode: file loading ────────────────────────────────────────────────

function autoCrop(srcCanvas, tolerance = 15) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const data = get2dContext(srcCanvas, { willReadFrequently: true }).getImageData(0, 0, w, h).data;

  // A pixel is background if its average distance from white (255,255,255) ≤ tolerance.
  // tolerance=0 → only pure white is background; tolerance=255 → everything is background.
  function isBackground(i) {
    return ((255 - data[i]) + (255 - data[i+1]) + (255 - data[i+2])) / 3 <= tolerance;
  }

  function rowHasContent(row) {
    const base = row * w * 4;
    for (let x = 0; x < w; x++) {
      if (!isBackground(base + x * 4)) return true;
    }
    return false;
  }
  function colHasContent(col) {
    for (let y = 0; y < h; y++) {
      if (!isBackground((y * w + col) * 4)) return true;
    }
    return false;
  }

  let top = 0, bottom = h, left = 0, right = w;
  while (top < h      && !rowHasContent(top))      top++;
  while (bottom > top && !rowHasContent(bottom-1)) bottom--;
  while (left < w     && !colHasContent(left))     left++;
  while (right > left && !colHasContent(right-1))  right--;

  const pad = 8;
  return {
    top:    Math.max(0, top - pad),
    bottom: Math.max(0, h - Math.min(h, bottom + pad)),
    left:   Math.max(0, left - pad),
    right:  Math.max(0, w - Math.min(w, right + pad)),
  };
}

let pdfjsReady = null;

function ensurePdfjs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((resolve, reject) => {
    const readyKey = `__pdfjsReady${Math.random().toString(36).slice(2)}`;
    const errorKey = `__pdfjsError${Math.random().toString(36).slice(2)}`;
    globalThis[readyKey] = lib => {
      delete globalThis[readyKey];
      delete globalThis[errorKey];
      lib.GlobalWorkerOptions.workerSrc =
        "https://unpkg.com/pdfjs-dist@5.6.205/build/pdf.worker.mjs";
      resolve(lib);
    };
    globalThis[errorKey] = message => {
      delete globalThis[readyKey];
      delete globalThis[errorKey];
      reject(new Error(message));
    };
    const s = document.createElement("script");
    s.type = "module";
    s.textContent = `
      import("https://unpkg.com/pdfjs-dist@5.6.205/build/pdf.mjs")
        .then((lib) => globalThis["${readyKey}"](lib))
        .catch((error) => globalThis["${errorKey}"](error?.message || "Failed to load PDF.js"));
    `;
    s.onerror = () => reject(new Error("Failed to load PDF.js"));
    document.head.appendChild(s);
  });
  return pdfjsReady;
}



// ── Content mode: canvas rendering ───────────────────────────────────────────

function drawCropHandles(r, hoverEdge = null) {
  if (!r) return;
  const T = CROP_HANDLE_THICK, L = CROP_HANDLE_LEN;

  // Solid content-rect border
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth   = 1;
  snappedStrokeRect(r.x, r.y, r.w, r.h);

  // Snap corners once so all handle positions derive from the same integers
  const x = Math.round(r.x), y = Math.round(r.y);
  const x1 = Math.round(r.x + r.w), y1 = Math.round(r.y + r.h);
  const w = x1 - x, h = y1 - y;

  const handles = [
    { edge: "top",    hx: Math.round(x + w/2 - L/2), hy: Math.round(y - T/2),   hw: L, hh: T, axis: "h" },
    { edge: "bottom", hx: Math.round(x + w/2 - L/2), hy: Math.round(y1 - T/2),  hw: L, hh: T, axis: "h" },
    { edge: "left",   hx: Math.round(x - T/2),        hy: Math.round(y + h/2 - L/2), hw: T, hh: L, axis: "v" },
    { edge: "right",  hx: Math.round(x1 - T/2),       hy: Math.round(y + h/2 - L/2), hw: T, hh: L, axis: "v" },
  ];

  for (const { edge, hx, hy, hw, hh, axis } of handles) {
    const hovered = edge === hoverEdge;
    ctx.save();
    ctx.beginPath(); ctx.rect(hx, hy, hw, hh); ctx.clip();

    // White background
    ctx.fillStyle = "#fff";
    ctx.fillRect(hx, hy, hw, hh);
    // Every-other-pixel lengthwise stripes (hidden on hover)
    if (!hovered) {
      ctx.fillStyle = "#000";
      if (axis === "h") {
        for (let i = 0; i < hh; i += 2)
          ctx.fillRect(hx, hy + i, hw, 1);
      } else {
        for (let i = 0; i < hw; i += 2)
          ctx.fillRect(hx + i, hy, 1, hh);
      }
    }

    ctx.strokeStyle = "#000";
    ctx.lineWidth   = 1;
    ctx.strokeRect(hx + 0.5, hy + 0.5, hw - 1, hh - 1);
    ctx.restore();
  }

  ctx.restore();
}

function drawContent() {
  if (!lastVals) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    updateSpreadNav();
    return;
  }

  const vals = lastVals;
  const { pw, ph, inner, top, tw, th, outer } = vals;
  const ok = outer > 0 && th > 0 && tw > 0;

  const scale = getCanvasScale(vals);

  canvas.width  = Math.round(2 * pw * scale);
  canvas.height = Math.round(ph * scale);
  setCanvasCursor(renderState.currentCursor);

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!ok || !contentState.pages.length) {
    const { pagePxW, pagePxH } = getSpreadMetrics(vals, scale);
    drawPageBorder(pagePxW, pagePxH);
    canvas._spreadRects = null;
    updateSpreadNav();
    return;
  }

  contentState.spread = Math.min(contentState.spread, numSpreads() - 1);
  if (contentState.spread !== _lastEnsuredSpread) ensureSpreadLoaded(contentState.spread);
  const { metrics, sides } = paintSpread(canvas, scale, vals, {
    pageFills: getSpreadFills(contentState.spread),
    showMarginOverlay: false,
    spreadIndex: contentState.spread,
  });

  canvas._spreadRects = {
    left:  sides.left.drawnRect  ? { ...sides.left.drawnRect,  pageIndex: sides.left.pageIndex  } : null,
    right: sides.right.drawnRect ? { ...sides.right.drawnRect, pageIndex: sides.right.pageIndex } : null,
    pagePxW: metrics.pagePxW,
  };

  const hh = contentState.hoverHandle;
  const hoverEdge = hh?.edge ?? null;
  if (sides.left.pageIndex  === contentState.editingPageIdx && sides.left.drawnRect)
    drawCropHandles(sides.left.drawnRect,  hh?.side === "left"  ? hoverEdge : null);
  if (sides.right.pageIndex === contentState.editingPageIdx && sides.right.drawnRect)
    drawCropHandles(sides.right.drawnRect, hh?.side === "right" ? hoverEdge : null);

  updateSpreadNav();
}

function drawPageBorder(pagePxW, pagePxH) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const mid = Math.round(pagePxW);
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth   = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  ctx.setLineDash([1, 2]);
  ctx.beginPath(); ctx.moveTo(mid + 0.5, 0); ctx.lineTo(mid + 0.5, H); ctx.stroke();
  ctx.restore();
}

// ── Crop handle drag ──────────────────────────────────────────────────────────

function getCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width  / rect.width),
    y: (e.clientY - rect.top)  * (canvas.height / rect.height),
  };
}

const CROP_HANDLE_THICK = 9;   // handle short dimension (px)
const CROP_HANDLE_LEN   = 44;  // handle long dimension (px)
const CROP_HANDLE_PAD   = 5;   // hit-test padding around handle rect

function setCanvasCursor(cursor = "default") {
  renderState.currentCursor = cursor;
  const applied = cursor === "default" ? "" : cursor;
  document.documentElement.style.setProperty("cursor", applied, "important");
  document.body.style.setProperty("cursor", applied, "important");
  canvas.style.cursor = cursor;
  wrap.style.cursor = cursor;
}

function pointInRect(x, y, rect, pad = 0) {
  return !!rect &&
    x >= rect.x - pad &&
    x <= rect.x + rect.w + pad &&
    y >= rect.y - pad &&
    y <= rect.y + rect.h + pad;
}

function getSpreadHitTarget(x, y, pad = 0) {
  const rects = canvas._spreadRects;
  if (!rects) return null;
  if (pointInRect(x, y, rects.left, pad)) return { side: "left", rect: rects.left, rects };
  if (pointInRect(x, y, rects.right, pad)) return { side: "right", rect: rects.right, rects };
  return null;
}

function hitTestHandle(cx, cy, r) {
  if (!r) return null;
  const { x, y, w, h } = r;
  const T = CROP_HANDLE_THICK / 2 + CROP_HANDLE_PAD;
  const L = CROP_HANDLE_LEN  / 2 + CROP_HANDLE_PAD;
  const handles = [
    { edge: "top",    hx: x+w/2, hy: y,     dx: L, dy: T },
    { edge: "right",  hx: x+w,   hy: y+h/2, dx: T, dy: L },
    { edge: "bottom", hx: x+w/2, hy: y+h,   dx: L, dy: T },
    { edge: "left",   hx: x,     hy: y+h/2, dx: T, dy: L },
  ];
  return handles.find(h => Math.abs(cx - h.hx) <= h.dx && Math.abs(cy - h.hy) <= h.dy) || null;
}

function getHandleHitTarget(x, y) {
  const rects = canvas._spreadRects;
  if (!rects) return null;

  const matches = [];
  for (const side of ["left", "right"]) {
    const rect = rects[side];
    const handle = hitTestHandle(x, y, rect);
    if (!handle) continue;
    const dx = x - handle.hx;
    const dy = y - handle.hy;
    matches.push({ side, rect, handle, distanceSq: dx * dx + dy * dy });
  }

  if (!matches.length) return null;
  matches.sort((a, b) => a.distanceSq - b.distanceSq);
  return matches[0];
}

canvas.addEventListener("mousedown", e => {
  if (renderState.animations.length) return;
  const { x, y } = getCanvasCoords(e);

  if (appMode === "layout") {
    const hit = getSpreadHitTarget(x, y);
    if (hit?.rect) {
      if (hit.rect.pageIndex >= 0) contentState.editingPageIdx = hit.rect.pageIndex;
      switchMode("content");
    }
    return;
  }
  if (appMode !== "content") return;

  // Check handles first (they extend slightly beyond the image rect)
  const handleHit = getHandleHitTarget(x, y);
  const spreadHit = handleHit ?? getSpreadHitTarget(x, y);

  if (!spreadHit?.rect) {
    // Clicked outside all page images — switch back to layout mode
    switchMode("layout");
    return;
  }

  const { side, rect: sideRect } = spreadHit;
  const pageIdx = sideRect.pageIndex;

  if (contentState.editingPageIdx !== pageIdx || contentState.selectedPageIdxs.size > 1) {
    contentState.editingPageIdx   = pageIdx;
    contentState.selectedPageIdxs = new Set([pageIdx]);
    syncPageUI();
    updateSpreadNav();
    drawContent();
  }

  // Start drag if on a handle
  const handle = handleHit?.handle ?? hitTestHandle(x, y, sideRect);
  if (handle) {
    const pg = contentState.pages[pageIdx];
    dragHandle = { edge: handle.edge, startX: x, startY: y, startCrop: { ...pg.crop }, side };
    e.preventDefault();
  }
});

canvas.addEventListener("mousemove", e => {
  if (renderState.animations.length) return;
  if (appMode !== "content") return;
  const { x, y } = getCanvasCoords(e);

  if (dragHandle) {
    const rects    = canvas._spreadRects;
    const sideRect = rects?.[dragHandle.side];
    if (!sideRect) return;

    const pg = contentState.pages[sideRect.pageIndex];
    if (!pg) return;

    const { fitScale, sw, sh } = sideRect;
    const dx   = x - dragHandle.startX;
    const dy   = y - dragHandle.startY;
    const crop = { ...dragHandle.startCrop };

    if (dragHandle.edge === "top") {
      crop.top = Math.max(0, Math.min(sh - crop.bottom - 1,
        Math.round(dragHandle.startCrop.top + dy / fitScale)));
    } else if (dragHandle.edge === "bottom") {
      crop.bottom = Math.max(0, Math.min(sh - crop.top - 1,
        Math.round(dragHandle.startCrop.bottom - dy / fitScale)));
    } else if (dragHandle.edge === "left") {
      crop.left = Math.max(0, Math.min(sw - crop.right - 1,
        Math.round(dragHandle.startCrop.left + dx / fitScale)));
    } else {
      crop.right = Math.max(0, Math.min(sw - crop.left - 1,
        Math.round(dragHandle.startCrop.right - dx / fitScale)));
    }
    pg.crop = crop;
    drawContent();
    return;
  }

  // Update handle hover highlight
  const handleHit = getHandleHitTarget(x, y);
  const newHoverHandle = handleHit
    ? { side: handleHit.side, edge: handleHit.handle.edge }
    : null;
  const prev = contentState.hoverHandle;
  if (newHoverHandle?.side !== prev?.side || newHoverHandle?.edge !== prev?.edge) {
    contentState.hoverHandle = newHoverHandle;
    drawContent();
  }
});

canvas.addEventListener("mouseup", () => { dragHandle = null; });
canvas.addEventListener("mouseleave", () => {
  dragHandle = null;
  if (contentState.hoverHandle !== null) {
    contentState.hoverHandle = null;
    if (appMode === "content") drawContent();
  }
});

// ── Strip drag-and-drop (append pages) ───────────────────────────────────────

async function appendFiles(files) {
  const arr = Array.from(files);
  if (!arr.length) return;

  const isPDF = arr[0].type === "application/pdf" ||
                arr[0].name.toLowerCase().endsWith(".pdf");

  if (isPDF) {
    const lib = await ensurePdfjs();
    const buf = await arr[0].arrayBuffer();
    const pdf = await lib.getDocument({ data: buf }).promise;
    // Keep whichever pdfDoc was loaded most recently
    contentState.pdfDoc = pdf;
    const startIdx = contentState.pages.length;
    const dims = await Promise.all(
      Array.from({ length: pdf.numPages }, (_, i) =>
        pdf.getPage(i + 1).then(p => { const vp = p.getViewport({ scale: 1 }); return vp.width / vp.height; })
      )
    );
    for (let i = 0; i < pdf.numPages; i++)
      contentState.pages.push(makePdfPageDescriptor(i + 1, dims[i]));
    renderPageStrip();
    ensureSpreadLoaded(Math.floor((startIdx + 1) / 2));
  } else {
    for (const file of arr) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const off  = document.createElement("canvas");
      const offCtx = get2dContext(off, { willReadFrequently: true });
      off.width = img.naturalWidth; off.height = img.naturalHeight;
      offCtx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const pg = { pageNum: null, aspectRatio: off.width / off.height,
                   srcCanvas: off, loading: false,
                   crop: autoCrop(off, 15), cropInitialized: true,
                   tolerance: 15, cover: false, fitAxis: "inside",
                   effects: makeDefaultPageEffects(),
                   renderCache: { effectKey: "", canvas: null },
                   thumbnail: null };
      generateThumbnail(pg);
      contentState.pages.push(pg);
    }
  }

  contentState.spread           = 0;
  contentState.editingPageIdx   = 0;
  contentState.selectedPageIdxs = new Set([0]);
  renderPageStrip();
  showTrimSection();
  if (appMode === "layout") draw(); else drawContent();
  ensureSpreadLoaded(0);
  const strip = document.getElementById("page-strip");
  if (strip) { strip.scrollLeft = 0; }
  updateSpreadNav();
}

// ── Resize observer ───────────────────────────────────────────────────────────

const ro = new ResizeObserver(() => {
  if (renderState.animations.length) return;
  if (appMode === "layout") draw();
  else drawContent();
});
ro.observe(canvasArea);

// ── Global init ───────────────────────────────────────────────────────────────

// Window-level drop zone — replaces current document
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => {
  e.preventDefault();
  appendFiles(e.dataTransfer.files);
});

// Arrow key spread navigation + Cmd+A select-all
document.addEventListener("keydown", e => {
  if (e.target.matches("input, select, textarea")) return;
  const base = getEffectiveSpread();
  const max  = numSpreads() - 1;
  if (e.key === "ArrowLeft"  && base > 0)   animateToSpread(base - 1);
  if (e.key === "ArrowRight" && base < max) animateToSpread(base + 1);
  if ((e.metaKey || e.ctrlKey) && e.key === "a" && appMode === "content" && contentState.pages.length) {
    e.preventDefault();
    contentState.selectedPageIdxs = new Set(contentState.pages.map((_, i) => i));
    syncPageUI();
    updateSpreadNav();
  }
});

// Scroll wheel spread navigation
let _lastWheelFlip = 0;
canvasArea.addEventListener("wheel", e => {
  if (!contentState.pages.length) return;
  const now = performance.now();
  if (now - _lastWheelFlip < 400) return;
  _lastWheelFlip = now;
  const base = getEffectiveSpread();
  const max  = numSpreads() - 1;
  if (e.deltaY > 0 && base < max) animateToSpread(base + 1);
  if (e.deltaY < 0 && base > 0)  animateToSpread(base - 1);
}, { passive: true });

// Mode tabs
document.querySelectorAll(".mode-tab").forEach(btn =>
  btn.addEventListener("click", () => switchMode(btn.dataset.mode))
);

// Initialize layout defaults, then enter content mode on load
(function init() {
  const tpl     = document.getElementById("tpl-layout");
  const toolbar = document.getElementById("toolbar");
  toolbar.appendChild(tpl.content.cloneNode(true));
  htmx.process(toolbar);
  initLayoutListeners();
  draw();
  renderPageStrip();
  switchMode("content");
})();
