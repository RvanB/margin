const canvas = document.getElementById("canvas");
let ctx      = canvas.getContext("2d");
const wrap   = document.getElementById("canvas-wrap");

const get = id => parseFloat(document.getElementById(id).value) || 0;
const fmt = v  => v.toFixed(3) + "″";

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

function dottedRect(x, y, w, h, dash = [3, 3]) {
  ctx.save();
  ctx.setLineDash(dash);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function dottedLine(x1, y1, x2, y2, dash = [3, 3]) {
  ctx.save();
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function renderSpread(targetCanvas, scale, vals) {
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

    fillLorem(lx, ly, twPx, thPx);
    fillLorem(rx, ly, twPx, thPx);

    if (document.getElementById("vdg").checked) drawVdG(pagePxW, pagePxH);

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

function draw() {
  const vals = compute();
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

  renderSpread(canvas, scale, vals);
}

function hArrowLabel(x1, x2, y, text, fs) {
  const pad   = fs * 0.5;
  const midX  = (x1 + x2) / 2;
  const textW = ctx.measureText(text).width;
  const aw    = fs * 0.6;
  const ah    = fs * 0.35;

  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth   = 0.75;

  // Line — two halves with gap for text
  ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(midX - textW / 2 - pad, y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(midX + textW / 2 + pad, y); ctx.lineTo(x2, y); ctx.stroke();

  // Open chevron pointing left (toward x1)
  ctx.beginPath();
  ctx.moveTo(x1 + aw, y - ah);
  ctx.lineTo(x1, y);
  ctx.lineTo(x1 + aw, y + ah);
  ctx.stroke();

  // Open chevron pointing right (toward x2)
  ctx.beginPath();
  ctx.moveTo(x2 - aw, y - ah);
  ctx.lineTo(x2, y);
  ctx.lineTo(x2 - aw, y + ah);
  ctx.stroke();

  // White background + text
  ctx.fillStyle = "#fff";
  ctx.fillRect(midX - textW / 2 - pad, y - fs / 2 - pad / 2, textW + pad * 2, fs + pad);
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, midX, y);

  ctx.restore();
}

function bracketLabel(x, y1, y2, text, fs) {
  const pad    = fs * 0.5;
  const midY   = (y1 + y2) / 2;
  const textW  = ctx.measureText(text).width;
  const aw = fs * 0.35;  // arrowhead half-width
  const ah = fs * 0.6;   // arrowhead height

  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth   = 0.75;

  // Dimension line — two halves with a gap for text, connecting to chevron tips
  ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, midY - fs / 2 - pad); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, midY + fs / 2 + pad); ctx.lineTo(x, y2); ctx.stroke();

  // Open arrowhead pointing up (toward y1)
  ctx.beginPath();
  ctx.moveTo(x - aw, y1 + ah);
  ctx.lineTo(x, y1);
  ctx.lineTo(x + aw, y1 + ah);
  ctx.stroke();

  // Open arrowhead pointing down (toward y2)
  ctx.beginPath();
  ctx.moveTo(x - aw, y2 - ah);
  ctx.lineTo(x, y2);
  ctx.lineTo(x + aw, y2 - ah);
  ctx.stroke();

  // White background behind text
  ctx.fillStyle = "#fff";
  ctx.fillRect(x - textW / 2 - pad, midY - fs / 2 - pad / 2, textW + pad * 2, fs + pad);

  // Text
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
  ctx.globalAlpha = 1;
  ctx.setLineDash([1, 2]);

  function line(x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Spread diagonals
  line(0, 0,   2*W, H);
  line(0, H,   2*W, 0);

  // Page diagonals: bottom-outside to inside-top
  line(0,   H, W, 0);   // left page
  line(2*W, H, W, 0);   // right page

  // Intersections (derived geometrically):
  //   left:  spread diag (0,0)→(2W,H) ∩ page diag (0,H)→(W,0)  = (2W/3, H/3)
  //   right: spread diag (0,H)→(2W,0) ∩ page diag (2W,H)→(W,0) = (4W/3, H/3)
  const p1x = 2*W/3, p1y = H/3;
  const p2x = 4*W/3, p2y = H/3;

  // Verticals up from intersections to top of page
  line(p1x, p1y, p1x, 0);
  line(p2x, p2y, p2x, 0);

  // Diagonals: vertical's top → opposite intersection
  line(p1x, 0, p2x, p2y);
  line(p2x, 0, p1x, p1y);

  // Text block outlines: outer=2W/9, top=H/9, width=2W/3, height=2H/3
  const tbX = 2*W/9, tbY = H/9, tbW = 2*W/3, tbH = 2*H/3;
  ctx.strokeRect(tbX, tbY, tbW, tbH);               // left page
  ctx.strokeRect(W + W/9, tbY, tbW, tbH);           // right page

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
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.fillStyle    = "#000";
  ctx.font         = `${fontSize}px Georgia, serif`;
  ctx.textBaseline = "top";

  const src  = LOREM.repeat(6).split(" ").filter(Boolean);
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

document.getElementById("preset").addEventListener("change", function () {
  if (!this.value) return;
  const [w, h] = this.value.split(",").map(Number);
  document.getElementById("pw").value = w;
  document.getElementById("ph").value = h;
  document.getElementById("page-ratio").value = (w / h).toFixed(3);
  draw();
});

// Page ratio input: shrink whichever dimension needs to shrink
document.getElementById("page-ratio").addEventListener("change", function () {
  const r = parseFloat(this.value);
  if (!r || r <= 0) return;
  const pw = get("pw"), ph = get("ph");
  const cur = pw / ph;
  if (r < cur) {
    // more portrait — shrink width
    document.getElementById("pw").value = (ph * r).toFixed(3);
  } else {
    // more landscape — shrink height
    document.getElementById("ph").value = (pw / r).toFixed(3);
  }
  draw();
});

// Width/height: update page-ratio display, and lock the other if preserve-ratio
document.getElementById("pw").addEventListener("input", function () {
  const pw = get("pw"), ph = get("ph");
  if (document.getElementById("preserve-ratio").checked) {
    const r = parseFloat(document.getElementById("page-ratio").value);
    if (r) document.getElementById("ph").value = (pw / r).toFixed(3);
  } else {
    document.getElementById("page-ratio").value = (pw / get("ph")).toFixed(3);
  }
  draw();
});

document.getElementById("ph").addEventListener("input", function () {
  const ph = get("ph");
  if (document.getElementById("preserve-ratio").checked) {
    const r = parseFloat(document.getElementById("page-ratio").value);
    if (r) document.getElementById("pw").value = (ph * r).toFixed(3);
  } else {
    document.getElementById("page-ratio").value = (get("pw") / ph).toFixed(3);
  }
  draw();
});

["ratio", "m-inner", "m-top", "m-bottom"].forEach(id =>
  document.getElementById(id).addEventListener("input", draw)
);
document.getElementById("b-slider").addEventListener("input", draw);
document.getElementById("vdg").addEventListener("change", draw);
document.getElementById("ratio-same-as-page").addEventListener("change", draw);
document.getElementById("preserve-ratio").addEventListener("change", draw);

document.getElementById("vdg-snap").addEventListener("click", function () {
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

document.getElementById("print-btn").addEventListener("click", function () {
  const vals = compute();
  const { pw, ph } = vals;
  const DPI = 300;
  const printCanvas = document.createElement("canvas");
  printCanvas.width  = Math.round(2 * pw * DPI);
  printCanvas.height = Math.round(ph * DPI);
  renderSpread(printCanvas, DPI, vals);

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

const ro = new ResizeObserver(draw);
ro.observe(wrap);

draw();
