export const CROP_HANDLE_THICK = 9;
export const CROP_HANDLE_LEN = 44;
export const CROP_HANDLE_PAD = 5;

export function snappedStrokeRect(ctx, x, y, w, h) {
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const x1 = Math.round(x + w);
  const y1 = Math.round(y + h);
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
}

function getInterfaceForeground() {
  const value = globalThis.getComputedStyle?.(document.documentElement)
    ?.getPropertyValue("--ui-foreground")
    ?.trim();
  return value || "#000000";
}

function getInterfaceBackground() {
  const value = globalThis.getComputedStyle?.(document.documentElement)
    ?.getPropertyValue("--ui-background")
    ?.trim();
  return value || "#ffffff";
}

function hexToRgb(hex, fallback = [0, 0, 0]) {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback;
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

function mixRgb(a, b, t) {
  const weight = Math.max(0, Math.min(1, t));
  return [
    a[0] + (b[0] - a[0]) * weight,
    a[1] + (b[1] - a[1]) * weight,
    a[2] + (b[2] - a[2]) * weight,
  ];
}

function rgbToCss(rgb, alpha = 1) {
  return `rgba(${rgb.map(channel => Math.round(Math.max(0, Math.min(1, channel)) * 255)).join(", ")}, ${alpha})`;
}

function relativeLuminance([r, g, b]) {
  const convert = channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const [lr, lg, lb] = [convert(r), convert(g), convert(b)];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrastRatio(a, b) {
  const l1 = relativeLuminance(hexToRgb(a));
  const l2 = relativeLuminance(hexToRgb(b));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function getPageChromeColor(paperColor) {
  const foreground = getInterfaceForeground();
  const background = getInterfaceBackground();
  const paper = typeof paperColor === "string" && /^#[0-9a-fA-F]{6}$/.test(paperColor)
    ? paperColor
    : "#ffffff";
  return contrastRatio(foreground, paper) >= contrastRatio(background, paper) ? foreground : background;
}

function getPageChromeFillColor(paperColor) {
  const foreground = getInterfaceForeground();
  const background = getInterfaceBackground();
  const chrome = getPageChromeColor(paperColor);
  return chrome === foreground ? background : foreground;
}

export function drawInsideEdgeShadow(
  ctx,
  pageRect,
  side,
  { paperColor = null, shadowTintColor = null, turnFactor = 0 } = {}
) {
  if (!pageRect || pageRect.w <= 0 || pageRect.h <= 0) return;

  const paper = hexToRgb(paperColor || "#ffffff", [1, 1, 1]);
  const shadowTint = hexToRgb(shadowTintColor || paperColor || "#000000", [0, 0, 0]);
  const darkness = Math.max(0, relativeLuminance(paper) - relativeLuminance(shadowTint));
  const edgeFactor = Math.max(0, Math.min(1, turnFactor));
  const reach = Math.max(14, Math.min(72, Math.round(pageRect.w * (0.065 + edgeFactor * 0.09))));
  const warmOuter = mixRgb(shadowTint, [0, 0, 0], 0.18);
  const warmCenter = mixRgb(shadowTint, [0, 0, 0], 0.52 + edgeFactor * 0.14);
  const outerPeak = 0.08 + darkness * 0.08 + edgeFactor * 0.08;
  const centerPeak = 0.28 + darkness * 0.12 + edgeFactor * 0.18;
  const hingeX = side === "left" ? Math.round(pageRect.x + pageRect.w) : Math.round(pageRect.x);
  const outerX = side === "left" ? hingeX - reach : hingeX + reach;
  const gradient = ctx.createLinearGradient(hingeX, 0, outerX, 0);

  gradient.addColorStop(0, rgbToCss(warmCenter, centerPeak));
  gradient.addColorStop(0.018, rgbToCss(warmCenter, centerPeak * 0.98));
  gradient.addColorStop(0.045, rgbToCss(warmCenter, centerPeak * 0.46));
  gradient.addColorStop(0.12, rgbToCss(warmOuter, outerPeak * 0.9));
  gradient.addColorStop(0.28, rgbToCss(warmOuter, outerPeak * 0.56));
  gradient.addColorStop(0.55, rgbToCss(warmOuter, outerPeak * 0.24));
  gradient.addColorStop(1, rgbToCss(paper, 0));

  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = gradient;
  ctx.fillRect(
    Math.min(hingeX, outerX),
    Math.round(pageRect.y),
    Math.abs(outerX - hingeX),
    Math.round(pageRect.h)
  );
  ctx.fillStyle = rgbToCss(warmCenter, Math.min(0.9, centerPeak + 0.08));
  ctx.fillRect(hingeX + (side === "left" ? -1 : 0), Math.round(pageRect.y), 1, Math.round(pageRect.h));
  ctx.restore();
}

export function drawPageBorder(
  ctx,
  pagePxW,
  { showBorder = true, paperColor = null } = {}
) {
  const chromeColor = getPageChromeColor(paperColor);
  const canvasWidth = ctx.canvas.width;
  const canvasHeight = ctx.canvas.height;
  ctx.save();
  ctx.strokeStyle = chromeColor;
  ctx.lineWidth = 1;
  if (showBorder) {
    ctx.strokeRect(0.5, 0.5, canvasWidth - 1, canvasHeight - 1);
  }
  ctx.restore();
}

function hArrowLabel(ctx, x1, x2, y, text, fontSize, color) {
  const pad = fontSize * 0.5;
  const midX = Math.round((x1 + x2) / 2);
  const textWidth = ctx.measureText(text).width;
  const arrowW = Math.round(fontSize * 0.6);
  const arrowH = Math.round(fontSize * 0.35);
  const snappedY = Math.round(y) + 0.5;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x1), snappedY);
  ctx.lineTo(midX - textWidth / 2 - pad, snappedY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(midX + textWidth / 2 + pad, snappedY);
  ctx.lineTo(Math.round(x2), snappedY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(Math.round(x1) + arrowW, snappedY - arrowH);
  ctx.lineTo(Math.round(x1), snappedY);
  ctx.lineTo(Math.round(x1) + arrowW, snappedY + arrowH);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(Math.round(x2) - arrowW, snappedY - arrowH);
  ctx.lineTo(Math.round(x2), snappedY);
  ctx.lineTo(Math.round(x2) - arrowW, snappedY + arrowH);
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, midX, snappedY);
  ctx.restore();
}

function bracketLabel(ctx, x, y1, y2, text, fontSize, color) {
  const snappedX = Math.round(x) + 0.5;
  const topY = Math.round(y1);
  const bottomY = Math.round(y2);
  const pad = fontSize * 0.5;
  const midY = Math.round((topY + bottomY) / 2);
  const arrowW = Math.round(fontSize * 0.35);
  const arrowH = Math.round(fontSize * 0.6);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(snappedX, topY);
  ctx.lineTo(snappedX, midY - fontSize / 2 - pad);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(snappedX, midY + fontSize / 2 + pad);
  ctx.lineTo(snappedX, bottomY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(snappedX - arrowW, topY + arrowH);
  ctx.lineTo(snappedX, topY);
  ctx.lineTo(snappedX + arrowW, topY + arrowH);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(snappedX - arrowW, bottomY - arrowH);
  ctx.lineTo(snappedX, bottomY);
  ctx.lineTo(snappedX + arrowW, bottomY - arrowH);
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, snappedX, midY);
  ctx.restore();
}

export function drawVdG(ctx, pagePxW, pagePxH, { paperColor = null } = {}) {
  const chromeColor = getPageChromeColor(paperColor);
  const w = Math.round(pagePxW);
  const h = Math.round(pagePxH);

  function line(x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
    ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
    ctx.stroke();
  }

  ctx.save();
  ctx.strokeStyle = chromeColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([1, 2]);
  line(0, 0, 2 * w, h);
  line(0, h, 2 * w, 0);
  line(0, h, w, 0);
  line(2 * w, h, w, 0);

  const p1x = 2 * w / 3;
  const p1y = h / 3;
  const p2x = 4 * w / 3;
  const p2y = h / 3;
  line(p1x, p1y, p1x, 0);
  line(p2x, p2y, p2x, 0);
  line(p1x, 0, p2x, p2y);
  line(p2x, 0, p1x, p1y);

  snappedStrokeRect(ctx, 2 * w / 9, h / 9, 2 * w / 3, 2 * h / 3);
  snappedStrokeRect(ctx, w + w / 9, h / 9, 2 * w / 3, 2 * h / 3);
  ctx.restore();
}

export function drawMarginOverlay(ctx, side, margins, fontSize, { paperColor = null } = {}) {
  if (!side?.overlayVisible) return;
  const chromeColor = getPageChromeColor(paperColor);

  const { pageRect } = side;
  const overlayRect = side.overlayRect || side.textblockRect || side.contentRect;
  if (!overlayRect) return;
  const scale = margins.scale || 1;
  const midY = pageRect.y + pageRect.h / 2;
  const labelX = overlayRect.x + overlayRect.w / 2;
  const top = (overlayRect.y - pageRect.y) / scale;
  const bottom = (pageRect.y + pageRect.h - (overlayRect.y + overlayRect.h)) / scale;
  const leftGap = (overlayRect.x - pageRect.x) / scale;
  const rightGap = (pageRect.x + pageRect.w - (overlayRect.x + overlayRect.w)) / scale;
  const outer = side.side === "left" ? leftGap : rightGap;
  const inner = side.side === "left" ? rightGap : leftGap;

  ctx.save();
  ctx.strokeStyle = chromeColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([1, 2]);
  snappedStrokeRect(ctx, overlayRect.x, overlayRect.y, overlayRect.w, overlayRect.h);
  ctx.restore();

  if (side.side === "left") {
    hArrowLabel(ctx, pageRect.x, overlayRect.x, midY, `${outer.toFixed(2)}″`, fontSize, chromeColor);
    hArrowLabel(
      ctx,
      overlayRect.x + overlayRect.w,
      pageRect.x + pageRect.w,
      midY,
      `${inner.toFixed(2)}″`,
      fontSize,
      chromeColor
    );
  } else {
    hArrowLabel(ctx, pageRect.x, overlayRect.x, midY, `${inner.toFixed(2)}″`, fontSize, chromeColor);
    hArrowLabel(
      ctx,
      overlayRect.x + overlayRect.w,
      pageRect.x + pageRect.w,
      midY,
      `${outer.toFixed(2)}″`,
      fontSize,
      chromeColor
    );
  }

  bracketLabel(ctx, labelX, pageRect.y, overlayRect.y, `${top.toFixed(2)}″`, fontSize, chromeColor);
  bracketLabel(
    ctx,
    labelX,
    overlayRect.y + overlayRect.h,
    pageRect.y + pageRect.h,
    `${bottom.toFixed(2)}″`,
    fontSize,
    chromeColor
  );
}

export function drawCropHandles(ctx, rect, hoverEdge = null, { paperColor = null } = {}) {
  if (!rect) return;
  const chromeColor = getPageChromeColor(paperColor);
  const fillColor = getPageChromeFillColor(paperColor);

  const thickness = CROP_HANDLE_THICK;
  const length = CROP_HANDLE_LEN;

  ctx.save();
  ctx.strokeStyle = chromeColor;
  ctx.lineWidth = 1;
  snappedStrokeRect(ctx, rect.x, rect.y, rect.w, rect.h);

  const x0 = Math.round(rect.x);
  const y0 = Math.round(rect.y);
  const x1 = Math.round(rect.x + rect.w);
  const y1 = Math.round(rect.y + rect.h);
  const width = x1 - x0;
  const height = y1 - y0;

  const handles = [
    { edge: "top", x: Math.round(x0 + width / 2 - length / 2), y: Math.round(y0 - thickness / 2), w: length, h: thickness, axis: "h" },
    { edge: "bottom", x: Math.round(x0 + width / 2 - length / 2), y: Math.round(y1 - thickness / 2), w: length, h: thickness, axis: "h" },
    { edge: "left", x: Math.round(x0 - thickness / 2), y: Math.round(y0 + height / 2 - length / 2), w: thickness, h: length, axis: "v" },
    { edge: "right", x: Math.round(x1 - thickness / 2), y: Math.round(y0 + height / 2 - length / 2), w: thickness, h: length, axis: "v" },
  ];

  for (const handle of handles) {
    const hovered = handle.edge === hoverEdge;
    ctx.save();
    ctx.beginPath();
    ctx.rect(handle.x, handle.y, handle.w, handle.h);
    ctx.clip();

    ctx.fillStyle = fillColor;
    ctx.fillRect(handle.x, handle.y, handle.w, handle.h);

    if (!hovered) {
      ctx.fillStyle = chromeColor;
      if (handle.axis === "h") {
        for (let i = 0; i < handle.h; i += 2) {
          ctx.fillRect(handle.x, handle.y + i, handle.w, 1);
        }
      } else {
        for (let i = 0; i < handle.w; i += 2) {
          ctx.fillRect(handle.x + i, handle.y, 1, handle.h);
        }
      }
    }

    ctx.strokeStyle = chromeColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(handle.x + 0.5, handle.y + 0.5, handle.w - 1, handle.h - 1);
    ctx.restore();
  }

  ctx.restore();
}
