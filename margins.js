const canvas = document.getElementById("canvas");
let ctx      = canvas.getContext("2d");
const wrap   = document.getElementById("canvas-wrap");

const get = id => parseFloat(document.getElementById(id).value) || 0;
const fmt = v  => v.toFixed(3) + "″";

function get2dContext(targetCanvas, options) {
  return targetCanvas.getContext("2d", options);
}

// ── Mode state ────────────────────────────────────────────────────────────────

let appMode         = "layout";
let savedMarginState = null;
let lastVals        = null;   // last computed vals, used by drawContent()
const renderState   = {
  showMarginArrows: true,
  showLayoutContent:true,
  currentCursor:    "default",
  animationFrame:   0,
  animating:        false,
  animationTarget:  null,
  queuedSpread:     null,
};

// ── Content state ─────────────────────────────────────────────────────────────

const contentState = {
  pages:          [],  // [{ srcCanvas, crop: {top,left,right,bottom} }]
  spread:         0,
  editingPageIdx: 0,
  hoverHandle:    null,  // { side, edge } of handle being hovered
};

let dragHandle  = null;  // { edge, startX, startY, startCrop, side }

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

function dottedLine(x1, y1, x2, y2, dash = [3, 3]) {
  ctx.save();
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(Math.round(x1), Math.round(y1));
  ctx.lineTo(Math.round(x2), Math.round(y2));
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
  if (!pg) return null;
  const { mode = "fit", clipToRect = false } = opts;
  const { srcCanvas, crop } = pg;
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
  const fw = sw * s, fh = sh * s;
  const cx = x + (w - fw) / 2;
  const cy = y + (h - fh) / 2;
  const ix = cx - crop.left * s;
  const iy = cy - crop.top  * s;

  if (clipToRect) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
  }

  ctx.drawImage(srcCanvas, ix, iy, srcCanvas.width * s, srcCanvas.height * s);

  if (clipToRect) ctx.restore();

  const visibleX = clipToRect ? Math.max(cx, x) : cx;
  const visibleY = clipToRect ? Math.max(cy, y) : cy;
  const visibleRight = clipToRect ? Math.min(cx + fw, x + w) : cx + fw;
  const visibleBottom = clipToRect ? Math.min(cy + fh, y + h) : cy + fh;

  return {
    x: visibleX,
    y: visibleY,
    w: Math.max(0, visibleRight - visibleX),
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
  const x = Math.round(rect.x), y = Math.round(rect.y);
  const w = Math.round(rect.w), h = Math.round(rect.h);
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.setLineDash([1, 2]);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
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

  ctx.fillStyle = "#fff";
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
  if (renderState.queuedSpread !== null) return renderState.queuedSpread;
  if (renderState.animationTarget !== null) return renderState.animationTarget;
  return contentState.spread;
}

function updateSpreadNav() {
  const total = numSpreads();
  const show  = contentState.pages.length > 0 && total > 1;
  const effectiveSpread = getEffectiveSpread();
  const prev  = document.getElementById("spread-prev");
  const next  = document.getElementById("spread-next");
  const label = document.getElementById("spread-label");
  if (prev) {
    prev.style.visibility = show ? "visible" : "hidden";
    prev.disabled = effectiveSpread === 0;
  }
  if (next) {
    next.style.visibility = show ? "visible" : "hidden";
    next.disabled = effectiveSpread >= total - 1;
  }
  if (label) {
    label.textContent = show ? `${effectiveSpread + 1} / ${total}` : "";
  }
}

// ── Layout draw ───────────────────────────────────────────────────────────────

function getSpreadFills(spreadIndex = contentState.spread) {
  if (!contentState.pages.length) return null;
  const { leftPg, rightPg } = spreadPages(spreadIndex);
  return [leftPg, rightPg];
}

function getCanvasScale(vals) {
  const ww = wrap.clientWidth - 64;
  const wh = wrap.clientHeight - 64;
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

function drawFlipFrame(fromCanvas, toCanvas, direction, progress) {
  const width = fromCanvas.width;
  const height = fromCanvas.height;
  const pageW = width / 2;
  const phase = progress < 0.5 ? "lift" : "land";
  const phaseProgress = progress < 0.5 ? progress / 0.5 : (progress - 0.5) / 0.5;
  const liftW = Math.max(0, pageW * (1 - phaseProgress));
  const landW = Math.max(0, pageW * phaseProgress);
  const leftX = 0;
  const rightX = pageW;

  ctx.clearRect(0, 0, width, height);

  if (direction > 0) {
    if (phase === "lift") {
      drawPageSlice(fromCanvas, 0, 0, pageW, height, leftX, 0, pageW, height);
      drawPageSlice(toCanvas, pageW, 0, pageW, height, rightX, 0, pageW, height);
      drawPageSlice(fromCanvas, pageW, 0, pageW, height, rightX, 0, liftW, height);
    } else {
      drawPageSlice(fromCanvas, 0, 0, pageW, height, leftX, 0, pageW, height);
      drawPageSlice(toCanvas, pageW, 0, pageW, height, rightX, 0, pageW, height);
      drawPageSlice(toCanvas, 0, 0, pageW, height, pageW - landW, 0, landW, height);
    }
  } else {
    if (phase === "lift") {
      drawPageSlice(toCanvas, 0, 0, pageW, height, leftX, 0, pageW, height);
      drawPageSlice(fromCanvas, pageW, 0, pageW, height, rightX, 0, pageW, height);
      drawPageSlice(fromCanvas, 0, 0, pageW, height, pageW - liftW, 0, liftW, height);
    } else {
      drawPageSlice(toCanvas, 0, 0, pageW, height, leftX, 0, pageW, height);
      drawPageSlice(fromCanvas, pageW, 0, pageW, height, rightX, 0, pageW, height);
      drawPageSlice(toCanvas, pageW, 0, pageW, height, rightX, 0, landW, height);
    }
  }

  drawPageBorder(pageW, height);
}

function stopSpreadAnimation() {
  if (renderState.animationFrame) cancelAnimationFrame(renderState.animationFrame);
  renderState.animationFrame = 0;
  renderState.animating = false;
  renderState.animationTarget = null;
  renderState.queuedSpread = null;
}

function animateToSpread(targetSpread) {
  if (renderState.animating) {
    renderState.queuedSpread = targetSpread;
    updateSpreadNav();
    return;
  }
  if (targetSpread === contentState.spread) return;
  if (!lastVals || !contentState.pages.length) {
    contentState.spread = targetSpread;
    if (appMode === "layout") draw();
    else drawContent();
    return;
  }

  const currentSpread = contentState.spread;
  const direction = targetSpread > currentSpread ? 1 : -1;
  const fromCanvas = createSpreadSnapshot(lastVals, currentSpread);
  const toCanvas = createSpreadSnapshot(lastVals, targetSpread);
  const duration = 420;
  const start = performance.now();

  stopSpreadAnimation();
  renderState.animating = true;
  renderState.animationTarget = targetSpread;
  canvas._spreadRects = null;
  updateSpreadNav();

  function frame(now) {
    const progress = Math.min(1, (now - start) / duration);
    drawFlipFrame(fromCanvas, toCanvas, direction, progress);

    if (progress < 1) {
      renderState.animationFrame = requestAnimationFrame(frame);
      return;
    }

    contentState.spread = targetSpread;
    const queuedSpread = renderState.queuedSpread;
    renderState.queuedSpread = null;
    stopSpreadAnimation();
    if (queuedSpread !== null && queuedSpread !== contentState.spread) {
      animateToSpread(queuedSpread);
      return;
    }
    if (appMode === "layout") draw();
    else drawContent();
  }

  renderState.animationFrame = requestAnimationFrame(frame);
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

  ctx.fillStyle = "#fff";
  ctx.fillRect(midX - textW / 2 - pad, y - fs / 2 - pad / 2, textW + pad * 2, fs + pad);
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

  ctx.fillStyle = "#fff";
  ctx.fillRect(x - textW / 2 - pad, midY - fs / 2 - pad / 2, textW + pad * 2, fs + pad);
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
    ctx.moveTo(Math.round(x1), Math.round(y1));
    ctx.lineTo(Math.round(x2), Math.round(y2));
    ctx.stroke();
  }

  line(0, 0,   2*W, H);   line(0, H,   2*W, 0);
  line(0, H,   W,   0);   line(2*W, H, W,   0);

  const p1x = 2*W/3, p1y = H/3, p2x = 4*W/3, p2y = H/3;
  line(p1x, p1y, p1x, 0);  line(p2x, p2y, p2x, 0);
  line(p1x, 0,   p2x, p2y); line(p2x, 0,   p1x, p1y);

  const r = (v) => Math.round(v);
  ctx.strokeRect(r(2*W/9)+0.5, r(H/9)+0.5, r(2*W/3)-1, r(2*H/3)-1);
  ctx.strokeRect(r(W+W/9)+0.5, r(H/9)+0.5, r(2*W/3)-1, r(2*H/3)-1);
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
}

function initLayoutListeners() {
  initDisplayControls(draw, { includeLayoutContent: true });

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

function applyTrimToPage(pg) {
  if (!pg) return;
  const slider    = document.getElementById("trim-slider");
  const tolerance = slider ? parseInt(slider.value, 10) : 15;
  pg.tolerance = tolerance;
  pg.crop      = autoCrop(pg.srcCanvas, tolerance);
  const valEl = document.getElementById("trim-val");
  if (valEl) valEl.textContent = tolerance;
}

// Sync all per-page sidebar controls to the currently editing page
function syncPageUI() {
  const section = document.getElementById("trim-section");
  if (section) section.style.display = "";
  const pg = contentState.pages[contentState.editingPageIdx];
  if (!pg) return;
  setTrimUI(pg.tolerance);
  const coverEl = document.getElementById("cover-check");
  if (coverEl) coverEl.checked = pg.cover;
  const fitAxisEl = document.getElementById("fit-axis");
  if (fitAxisEl) {
    fitAxisEl.value = pg.fitAxis === "width" || pg.fitAxis === "height" || pg.fitAxis === "inside"
      ? pg.fitAxis
      : "inside";
    fitAxisEl.disabled = !!pg.cover;
  }
}

function showTrimSection() { syncPageUI(); }

function initContentListeners() {
  initDisplayControls(drawContent);

  const dropTarget = document.getElementById("drop-target");
  const filePick   = document.getElementById("file-pick");

  addListener(dropTarget, "click", () => filePick.click());
  addListener(dropTarget, "dragover", e => {
    e.preventDefault();
    dropTarget.classList.add("drag-over");
  });
  addListener(dropTarget, "dragleave", () => dropTarget.classList.remove("drag-over"));
  addListener(dropTarget, "drop", e => {
    e.preventDefault();
    dropTarget.classList.remove("drag-over");
    handleFiles(e.dataTransfer.files);
  });
  addListener(filePick, "change", () => handleFiles(filePick.files));

  addListener("trim-slider", "input", () => {
    const pg = contentState.pages[contentState.editingPageIdx];
    applyTrimToPage(pg);
    drawContent();
  });

  addListener("cover-check", "change", () => {
    const pg = contentState.pages[contentState.editingPageIdx];
    if (pg) {
      pg.cover = document.getElementById("cover-check").checked;
      syncPageUI();
      drawContent();
    }
  });

  addListener("fit-axis", "change", () => {
    const pg = contentState.pages[contentState.editingPageIdx];
    if (pg) {
      const value = document.getElementById("fit-axis").value;
      pg.fitAxis = value === "width" || value === "height" ? value : "inside";
      drawContent();
    }
  });
}

function switchMode(mode) {
  if (mode === appMode) return;

  stopSpreadAnimation();
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
    restoreMarginState();
    initLayoutListeners();
    draw();
  } else {
    contentState.hoverHandle = null;
    initContentListeners();
    if (contentState.pages.length) {
      renderPageList();
      showTrimSection();
    }
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
    const s = document.createElement("script");
    s.src = "https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js";
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error("Failed to load PDF.js"));
    document.head.appendChild(s);
  });
  return pdfjsReady;
}

async function loadPDF(file) {
  const lib = await ensurePdfjs();
  const buf = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: buf }).promise;
  contentState.pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp   = page.getViewport({ scale: 2 });
    const off  = document.createElement("canvas");
    const offCtx = get2dContext(off, { willReadFrequently: true });
    off.width  = vp.width;
    off.height = vp.height;
    await page.render({ canvasContext: offCtx, viewport: vp }).promise;
    contentState.pages.push({ srcCanvas: off, crop: autoCrop(off, 15), tolerance: 15, cover: false, fitAxis: "inside" });
  }
  contentState.spread         = 0;
  contentState.editingPageIdx = 0;
  contentState.hoverHandle    = null;
  renderPageList();
  showTrimSection();
  drawContent();
}

async function loadImages(files) {
  contentState.pages = [];
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const off  = document.createElement("canvas");
    const offCtx = get2dContext(off, { willReadFrequently: true });
    off.width  = img.naturalWidth;
    off.height = img.naturalHeight;
    offCtx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    contentState.pages.push({ srcCanvas: off, crop: autoCrop(off, 15), tolerance: 15, cover: false, fitAxis: "inside" });
  }
  contentState.spread         = 0;
  contentState.editingPageIdx = 0;
  contentState.hoverHandle    = null;
  renderPageList();
  showTrimSection();
  drawContent();
}

async function handleFiles(files) {
  const arr = Array.from(files);
  if (!arr.length) return;
  const isPDF = arr[0].type === "application/pdf" ||
                arr[0].name.toLowerCase().endsWith(".pdf");
  if (isPDF) await loadPDF(arr[0]);
  else       await loadImages(arr);
}

function renderPageList() {
  const list    = document.getElementById("page-list");
  const section = document.getElementById("pages-section");
  if (!list || !section) return;

  section.style.display = contentState.pages.length ? "" : "none";
  list.innerHTML = "";

  contentState.pages.forEach((pg, i) => {
    const thumb = document.createElement("div");
    thumb.className = "page-thumb" + (i === contentState.editingPageIdx ? " active" : "");

    const tc     = document.createElement("canvas");
    const aspect = pg.srcCanvas.height / pg.srcCanvas.width;
    tc.width  = 40;
    tc.height = Math.round(40 * aspect);
    tc.getContext("2d").drawImage(pg.srcCanvas, 0, 0, tc.width, tc.height);

    const label = document.createElement("span");
    label.textContent = `Page ${i + 1}`;

    thumb.append(tc, label);
    thumb.addEventListener("click", () => {
      contentState.spread         = Math.floor((i + 1) / 2);
      contentState.editingPageIdx = i;
      document.querySelectorAll(".page-thumb").forEach((el, j) =>
        el.classList.toggle("active", j === i)
      );
      syncPageUI();
      updateSpreadNav();
      drawContent();
    });
    list.append(thumb);
  });
}

// ── Content mode: canvas rendering ───────────────────────────────────────────

function drawCropHandles(r, hoverEdge = null) {
  if (!r) return;
  const x = Math.round(r.x), y = Math.round(r.y);
  const w = Math.round(r.w), h = Math.round(r.h);
  const T = CROP_HANDLE_THICK, L = CROP_HANDLE_LEN;

  // Solid content-rect border
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth   = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  const handles = [
    { edge: "top",    hx: Math.round(x + w/2 - L/2), hy: Math.round(y - T/2),     hw: L, hh: T, axis: "h" },
    { edge: "bottom", hx: Math.round(x + w/2 - L/2), hy: Math.round(y+h - T/2),   hw: L, hh: T, axis: "h" },
    { edge: "left",   hx: Math.round(x - T/2),        hy: Math.round(y + h/2-L/2), hw: T, hh: L, axis: "v" },
    { edge: "right",  hx: Math.round(x+w - T/2),      hy: Math.round(y + h/2-L/2), hw: T, hh: L, axis: "v" },
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
  if (renderState.animating) return;
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

  if (contentState.editingPageIdx !== pageIdx) {
    contentState.editingPageIdx = pageIdx;
    syncPageUI();
    document.querySelectorAll(".page-thumb").forEach((el, j) =>
      el.classList.toggle("active", j === pageIdx)
    );
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
  if (renderState.animating) return;
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

// ── Resize observer ───────────────────────────────────────────────────────────

const ro = new ResizeObserver(() => {
  if (renderState.animating) return;
  if (appMode === "layout") draw();
  else drawContent();
});
ro.observe(wrap);

// ── Global init ───────────────────────────────────────────────────────────────

// Spread buttons live in the canvas-wrap (always present)
document.getElementById("spread-prev").addEventListener("click", () => {
  const base = getEffectiveSpread();
  if (base > 0) {
    animateToSpread(base - 1);
  }
});
document.getElementById("spread-next").addEventListener("click", () => {
  const max = numSpreads() - 1;
  const base = getEffectiveSpread();
  if (base < max) {
    animateToSpread(base + 1);
  }
});

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
  switchMode("content");
})();
