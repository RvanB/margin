const canvas = document.getElementById("canvas");
let ctx      = canvas.getContext("2d");
const wrap   = document.getElementById("canvas-wrap");

const get = id => parseFloat(document.getElementById(id).value) || 0;
const fmt = v  => v.toFixed(3) + "″";

// ── Mode state ────────────────────────────────────────────────────────────────

let appMode         = "layout";
let savedMarginState = null;
let lastVals        = null;   // last computed vals, used by drawContent()

// ── Content state ─────────────────────────────────────────────────────────────

const contentState = {
  pages:          [],  // [{ srcCanvas, crop: {top,left,right,bottom} }]
  spread:         0,
  editingPageIdx: 0,
};

let activeSide  = null;  // 'left' | 'right' | null — hovered side in content mode
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
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

// Draw a page fitted into a rect, using crop to define which region of the image
// maps to the destination — the full image is drawn (no pixels hidden).
function drawPageContent(pg, x, y, w, h) {
  if (!pg) return null;
  const { srcCanvas, crop } = pg;
  const sw = srcCanvas.width  - crop.left - crop.right;
  const sh = srcCanvas.height - crop.top  - crop.bottom;
  if (sw <= 0 || sh <= 0) return null;
  const s  = Math.min(w / sw, h / sh);
  const fw = sw * s, fh = sh * s;
  // Top-left of the content region in destination space
  const cx = x + (w - fw) / 2;
  const cy = y + (h - fh) / 2;
  // Full image origin (content is inset by crop amounts at scale s)
  const ix = cx - crop.left * s;
  const iy = cy - crop.top  * s;
  ctx.drawImage(srcCanvas, ix, iy, srcCanvas.width * s, srcCanvas.height * s);
  return { x: cx, y: cy, w: fw, h: fh, fitScale: s,
           sw: srcCanvas.width, sh: srcCanvas.height };
}

function renderSpread(targetCanvas, scale, vals, pageFills = null) {
  const prevCtx = ctx;
  ctx = targetCanvas.getContext("2d");

  const { pw, ph, inner, top, bottom, th, tw, outer } = vals;
  const ok = outer > 0 && th > 0 && tw > 0;
  const s = scale;
  const pagePxW = pw * s;
  const pagePxH = ph * s;

  ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
  ctx.save();

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, pagePxW * 2, pagePxH);

  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, pagePxW * 2 - 1, pagePxH - 1);
  dottedLine(pagePxW, 0, pagePxW, pagePxH, [1, 2]);

  if (ok) {
    const twPx    = tw * s;
    const thPx    = th * s;
    const innerPx = inner * s;
    const outerPx = outer * s;
    const topPx   = top * s;
    const botPx   = bottom * s;
    const lx = outerPx, ly = topPx, rx = pagePxW + innerPx;

    if (pageFills) {
      const [lp, rp] = pageFills;
      if (lp) drawPageContent(lp, lp.cover ? 0        : lx, lp.cover ? 0 : ly,
                                   lp.cover ? pagePxW  : twPx, lp.cover ? pagePxH : thPx);
      if (rp) drawPageContent(rp, rp.cover ? pagePxW  : rx, rp.cover ? 0 : ly,
                                   rp.cover ? pagePxW  : twPx, rp.cover ? pagePxH : thPx);
    } else {
      fillLorem(lx, ly, twPx, thPx);
      fillLorem(rx, ly, twPx, thPx);
    }

    const vdgEl = document.getElementById("vdg");
    if (vdgEl && vdgEl.checked) drawVdG(pagePxW, pagePxH);

    const fs = Math.max(7, Math.round(s / 9));
    ctx.font = `${fs}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    const mid = pagePxH / 2;
    hArrowLabel(0,                     outerPx,           mid, outer.toFixed(2) + "″", fs);
    hArrowLabel(pagePxW - innerPx,     pagePxW,           mid, inner.toFixed(2) + "″", fs);
    hArrowLabel(pagePxW,               pagePxW + innerPx, mid, inner.toFixed(2) + "″", fs);
    hArrowLabel(pagePxW * 2 - outerPx, pagePxW * 2,       mid, outer.toFixed(2) + "″", fs);

    const lCx = lx + twPx / 2, rCx = rx + twPx / 2;
    bracketLabel(lCx, 0,               topPx,   top.toFixed(2)    + "″", fs);
    bracketLabel(rCx, 0,               topPx,   top.toFixed(2)    + "″", fs);
    bracketLabel(lCx, pagePxH - botPx, pagePxH, bottom.toFixed(2) + "″", fs);
    bracketLabel(rCx, pagePxH - botPx, pagePxH, bottom.toFixed(2) + "″", fs);
  }

  ctx.restore();
  ctx = prevCtx;
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

function updateSpreadNav() {
  const total = numSpreads();
  const show  = contentState.pages.length > 0 && total > 1;
  const prev  = document.getElementById("spread-prev");
  const next  = document.getElementById("spread-next");
  const label = document.getElementById("spread-label");
  if (prev) {
    prev.style.visibility = show ? "visible" : "hidden";
    prev.disabled = contentState.spread === 0;
  }
  if (next) {
    next.style.visibility = show ? "visible" : "hidden";
    next.disabled = contentState.spread >= total - 1;
  }
  if (label) {
    label.textContent = show ? `${contentState.spread + 1} / ${total}` : "";
  }
}

// ── Layout draw ───────────────────────────────────────────────────────────────

function getSpreadFills() {
  if (!contentState.pages.length) return null;
  const { leftPg, rightPg } = spreadPages(contentState.spread);
  return [leftPg, rightPg];
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

  const ww    = wrap.clientWidth  - 64;
  const wh    = wrap.clientHeight - 64;
  const scale = Math.min(ww / (2 * pw), wh / ph);

  canvas.width  = Math.round(2 * pw * scale);
  canvas.height = Math.round(ph * scale);

  contentState.spread = Math.min(contentState.spread, numSpreads() - 1);

  renderSpread(canvas, scale, vals, getSpreadFills());
  updateSpreadNav();
}

// ── Arrow / bracket label helpers ─────────────────────────────────────────────

function hArrowLabel(x1, x2, y, text, fs) {
  const pad   = fs * 0.5;
  const midX  = (x1 + x2) / 2;
  const textW = ctx.measureText(text).width;
  const aw    = fs * 0.6;
  const ah    = fs * 0.35;

  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth   = 0.75;

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
  const pad   = fs * 0.5;
  const midY  = (y1 + y2) / 2;
  const textW = ctx.measureText(text).width;
  const aw    = fs * 0.35;
  const ah    = fs * 0.6;

  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth   = 0.75;

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
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth   = 0.75;
  ctx.setLineDash([1, 2]);

  function line(x1, y1, x2, y2) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  line(0, 0,   2*W, H);   line(0, H,   2*W, 0);
  line(0, H,   W,   0);   line(2*W, H, W,   0);

  const p1x = 2*W/3, p1y = H/3, p2x = 4*W/3, p2y = H/3;
  line(p1x, p1y, p1x, 0);  line(p2x, p2y, p2x, 0);
  line(p1x, 0,   p2x, p2y); line(p2x, 0,   p1x, p1y);

  ctx.strokeRect(2*W/9, H/9, 2*W/3, 2*H/3);
  ctx.strokeRect(W + W/9, H/9, 2*W/3, 2*H/3);
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
    renderSpread(printCanvas, DPI, vals, getSpreadFills());

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
}

function showTrimSection() { syncPageUI(); }

function initContentListeners() {
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
      drawContent();
    }
  });
}

function switchMode(mode) {
  if (mode === appMode) return;

  if (appMode === "layout") saveMarginState();
  clearListeners();
  appMode    = mode;
  activeSide = null;

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
  const data = srcCanvas.getContext("2d").getImageData(0, 0, w, h).data;

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
    off.width  = vp.width;
    off.height = vp.height;
    await page.render({ canvasContext: off.getContext("2d"), viewport: vp }).promise;
    contentState.pages.push({ srcCanvas: off, crop: autoCrop(off, 15), tolerance: 15, cover: false });
  }
  contentState.spread         = 0;
  contentState.editingPageIdx = 0;
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
    off.width  = img.naturalWidth;
    off.height = img.naturalHeight;
    off.getContext("2d").drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    contentState.pages.push({ srcCanvas: off, crop: autoCrop(off, 15), tolerance: 15, cover: false });
  }
  contentState.spread         = 0;
  contentState.editingPageIdx = 0;
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
      activeSide = (i + 1) % 2 === 1 ? "right" : "left";
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

function drawCropHandles(r) {
  if (!r) return;
  const { x, y, w, h } = r;
  const hs = 5;

  ctx.save();
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 3]);

  ctx.beginPath(); ctx.moveTo(x,   y);   ctx.lineTo(x+w, y);   ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x+w, y);   ctx.lineTo(x+w, y+h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x+w, y+h); ctx.lineTo(x,   y+h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x,   y+h); ctx.lineTo(x,   y);   ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = "#2563eb";
  [
    [x + w/2, y    ],
    [x + w,   y+h/2],
    [x + w/2, y+h  ],
    [x,       y+h/2],
  ].forEach(([hx, hy]) => ctx.fillRect(hx - hs, hy - hs, hs*2, hs*2));

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

  const ww    = wrap.clientWidth  - 64;
  const wh    = wrap.clientHeight - 64;
  const scale = Math.min(ww / (2 * pw), wh / ph);

  canvas.width  = Math.round(2 * pw * scale);
  canvas.height = Math.round(ph * scale);

  const pagePxW = pw * scale;
  const pagePxH = ph * scale;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!ok || !contentState.pages.length) {
    drawPageBorder(pagePxW, pagePxH);
    canvas._spreadRects = null;
    updateSpreadNav();
    return;
  }

  const twPx    = tw    * scale;
  const thPx    = th    * scale;
  const topPx   = top   * scale;
  const innerPx = inner * scale;
  const outerPx = outer * scale;

  contentState.spread = Math.min(contentState.spread, numSpreads() - 1);

  const { leftPg, rightPg, leftPageIdx, rightPageIdx } = spreadPages(contentState.spread);

  // Helper: pick rendering rect based on cover flag
  function pageRect(pg, tbX) {
    return pg?.cover
      ? { rx: tbX === outerPx ? 0 : pagePxW, ry: 0,     rw: pagePxW, rh: pagePxH }
      : { rx: tbX,                            ry: topPx, rw: twPx,    rh: thPx    };
  }

  const lr = pageRect(leftPg,  outerPx);
  const rr = pageRect(rightPg, pagePxW + innerPx);

  const leftRect  = drawPageContent(leftPg,  lr.rx, lr.ry, lr.rw, lr.rh);
  const rightRect = drawPageContent(rightPg, rr.rx, rr.ry, rr.rw, rr.rh);

  // Page border drawn on top so it's always visible over cover images
  drawPageBorder(pagePxW, pagePxH);

  canvas._spreadRects = {
    left:  leftRect  ? { ...leftRect,  pageIndex: leftPageIdx  } : null,
    right: rightRect ? { ...rightRect, pageIndex: rightPageIdx } : null,
    pagePxW,
  };

  // Draw crop handles for the editing page (always visible in content mode)
  if (leftPageIdx  === contentState.editingPageIdx && leftRect)  drawCropHandles(leftRect);
  if (rightPageIdx === contentState.editingPageIdx && rightRect) drawCropHandles(rightRect);

  updateSpreadNav();
}

function drawPageBorder(pagePxW, pagePxH) {
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth   = 1;
  ctx.strokeRect(0.5, 0.5, pagePxW * 2 - 1, pagePxH - 1);
  ctx.setLineDash([1, 2]);
  ctx.beginPath(); ctx.moveTo(pagePxW, 0); ctx.lineTo(pagePxW, pagePxH); ctx.stroke();
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

function hitTestHandle(cx, cy, r) {
  if (!r) return null;
  const { x, y, w, h } = r;
  const hs = 8;
  const handles = [
    { edge: "top",    hx: x+w/2, hy: y     },
    { edge: "right",  hx: x+w,   hy: y+h/2 },
    { edge: "bottom", hx: x+w/2, hy: y+h   },
    { edge: "left",   hx: x,     hy: y+h/2 },
  ];
  return handles.find(h => Math.abs(cx - h.hx) <= hs && Math.abs(cy - h.hy) <= hs) || null;
}

canvas.addEventListener("mousedown", e => {
  if (appMode !== "content") return;
  const { x, y } = getCanvasCoords(e);
  const rects = canvas._spreadRects;
  if (!rects) return;

  const side    = x < rects.pagePxW ? "left" : "right";
  const sideRect = rects[side];
  if (!sideRect) return;

  // Select this page for editing
  const pageIdx = sideRect.pageIndex;
  if (contentState.editingPageIdx !== pageIdx) {
    contentState.editingPageIdx = pageIdx;
    activeSide = side;
    syncPageUI();
    document.querySelectorAll(".page-thumb").forEach((el, j) =>
      el.classList.toggle("active", j === pageIdx)
    );
    drawContent();
  }

  // Start drag if on a handle
  const handle = hitTestHandle(x, y, sideRect);
  if (handle) {
    const pg = contentState.pages[pageIdx];
    dragHandle = { edge: handle.edge, startX: x, startY: y, startCrop: { ...pg.crop }, side };
    canvas.style.cursor = (handle.edge === "top" || handle.edge === "bottom")
      ? "ns-resize" : "ew-resize";
    e.preventDefault();
  }
});

canvas.addEventListener("mousemove", e => {
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

  // Hover: update active side and cursor
  const rects   = canvas._spreadRects;
  const newSide = rects ? (x < rects.pagePxW ? "left" : "right") : null;
  const sideRect = newSide ? rects[newSide] : null;
  const handle  = hitTestHandle(x, y, sideRect);

  canvas.style.cursor = handle
    ? (handle.edge === "top" || handle.edge === "bottom" ? "ns-resize" : "ew-resize")
    : "default";

  if (newSide !== activeSide) {
    activeSide = newSide;
    drawContent();
  }
});

canvas.addEventListener("mouseup",    () => { dragHandle = null; canvas.style.cursor = "default"; });
canvas.addEventListener("mouseleave", () => {
  dragHandle = null;
  canvas.style.cursor = "default";
  if (appMode !== "content" && activeSide !== null) { activeSide = null; drawContent(); }
});

// ── Resize observer ───────────────────────────────────────────────────────────

const ro = new ResizeObserver(() => {
  if (appMode === "layout") draw();
  else drawContent();
});
ro.observe(wrap);

// ── Global init ───────────────────────────────────────────────────────────────

// Spread buttons live in the canvas-wrap (always present)
document.getElementById("spread-prev").addEventListener("click", () => {
  if (contentState.spread > 0) {
    contentState.spread--;
    if (appMode === "layout") draw();
    else drawContent();
  }
});
document.getElementById("spread-next").addEventListener("click", () => {
  const max = numSpreads() - 1;
  if (contentState.spread < max) {
    contentState.spread++;
    if (appMode === "layout") draw();
    else drawContent();
  }
});

// Mode tabs
document.querySelectorAll(".mode-tab").forEach(btn =>
  btn.addEventListener("click", () => switchMode(btn.dataset.mode))
);

// Enter layout mode on load
(function init() {
  const tpl     = document.getElementById("tpl-layout");
  const toolbar = document.getElementById("toolbar");
  toolbar.appendChild(tpl.content.cloneNode(true));
  htmx.process(toolbar);
  initLayoutListeners();
  draw();
})();
