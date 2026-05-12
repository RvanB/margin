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

export function drawDirectionalLightFalloff(
  ctx,
  spreadRect,
  { paperColor = null, shadowTintColor = null, lightBias = 0.32 } = {}
) {
  if (!spreadRect || spreadRect.w <= 0 || spreadRect.h <= 0) return;

  const paper = hexToRgb(paperColor || "#ffffff", [1, 1, 1]);
  const shadowTint = hexToRgb(shadowTintColor || paperColor || "#000000", [0, 0, 0]);
  const darkness = Math.max(0, relativeLuminance(paper) - relativeLuminance(shadowTint));
  const warmShade = mixRgb(shadowTint, [0.45, 0.32, 0.18], 0.55);
  const peak = 0.16 + darkness * 0.1;
  const lightCenter = Math.max(0, Math.min(1, lightBias));

  const gradient = ctx.createLinearGradient(
    spreadRect.x,
    0,
    spreadRect.x + spreadRect.w,
    0
  );
  gradient.addColorStop(0, rgbToCss(warmShade, peak * 0.4 * lightCenter));
  gradient.addColorStop(lightCenter, rgbToCss(warmShade, 0));
  gradient.addColorStop(1, rgbToCss(warmShade, peak));

  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = gradient;
  ctx.fillRect(
    Math.round(spreadRect.x),
    Math.round(spreadRect.y),
    Math.round(spreadRect.w),
    Math.round(spreadRect.h)
  );
  ctx.restore();
}

export function drawPageCurvatureLighting(
  ctx,
  pageRect,
  side,
  { paperColor = null, shadowTintColor = null } = {}
) {
  if (!pageRect || pageRect.w <= 0 || pageRect.h <= 0) return;

  const paper = hexToRgb(paperColor || "#ffffff", [1, 1, 1]);
  const shadowTint = hexToRgb(shadowTintColor || paperColor || "#000000", [0, 0, 0]);
  const darkness = Math.max(0, relativeLuminance(paper) - relativeLuminance(shadowTint));
  const warmShade = mixRgb(shadowTint, [0.55, 0.4, 0.22], 0.5);
  const crackWarmShade = mixRgb(shadowTint, [0.88, 0.72, 0.08], 0.34);
  const crackInnerShade = mixRgb(crackWarmShade, [0, 0, 0], 0.55);
  const crackShade = mixRgb([0, 0, 0], [0.12, 0.08, 0.04], 0.22);

  const isLeftPage = side === "left";
  const hingeX = isLeftPage ? Math.round(pageRect.x + pageRect.w) : Math.round(pageRect.x);
  const outerX = isLeftPage ? Math.round(pageRect.x) : Math.round(pageRect.x + pageRect.w);
  const px = Math.round(pageRect.x);
  const py = Math.round(pageRect.y);
  const pw = Math.round(pageRect.w);
  const ph = Math.round(pageRect.h);

  const spineCrack = 0.72 + darkness * 0.22;
  const spineSoft = 0.22 + darkness * 0.12;
  const midShade = 0.02;
  const outerPeak = 0.06 + darkness * 0.05;

  const shadowGradient = ctx.createLinearGradient(hingeX, 0, outerX, 0);
  shadowGradient.addColorStop(0.0, rgbToCss(warmShade, spineCrack));
  shadowGradient.addColorStop(0.008, rgbToCss(warmShade, spineCrack * 0.74));
  shadowGradient.addColorStop(0.032, rgbToCss(warmShade, spineSoft));
  shadowGradient.addColorStop(0.15, rgbToCss(warmShade, spineSoft * 0.5));
  shadowGradient.addColorStop(0.32, rgbToCss(warmShade, spineSoft * 0.2));
  shadowGradient.addColorStop(0.5, rgbToCss(warmShade, midShade));
  shadowGradient.addColorStop(0.75, rgbToCss(warmShade, midShade * 0.6));
  shadowGradient.addColorStop(0.93, rgbToCss(warmShade, outerPeak * 0.75));
  shadowGradient.addColorStop(1.0, rgbToCss(warmShade, outerPeak));

  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = shadowGradient;
  ctx.fillRect(px, py, pw, ph);
  const crackReach = Math.max(6, Math.round(pageRect.w * 0.018));
  const crackOuterX = isLeftPage ? hingeX - crackReach : hingeX + crackReach;
  const crackGradient = ctx.createLinearGradient(hingeX, 0, crackOuterX, 0);
  crackGradient.addColorStop(0, rgbToCss(crackShade, Math.min(0.96, spineCrack + 0.12)));
  crackGradient.addColorStop(0.08, rgbToCss(crackInnerShade, Math.min(0.9, spineCrack * 0.82)));
  crackGradient.addColorStop(0.24, rgbToCss(crackWarmShade, Math.min(0.72, spineCrack * 0.56)));
  crackGradient.addColorStop(0.55, rgbToCss(crackWarmShade, Math.min(0.34, spineSoft * 0.9)));
  crackGradient.addColorStop(1, rgbToCss(crackWarmShade, 0));
  ctx.fillStyle = crackGradient;
  ctx.fillRect(
    Math.min(hingeX, crackOuterX),
    py,
    Math.abs(crackOuterX - hingeX),
    ph
  );
  ctx.restore();

  const bouncePeak = 0.13;
  const bounceColor = [0.988, 0.994, 1];
  const bounceGradient = ctx.createLinearGradient(hingeX, 0, outerX, 0);
  bounceGradient.addColorStop(0.0, rgbToCss(bounceColor, 0));
  bounceGradient.addColorStop(0.3, rgbToCss(bounceColor, bouncePeak * 0.4));
  bounceGradient.addColorStop(0.6, rgbToCss(bounceColor, bouncePeak));
  bounceGradient.addColorStop(0.88, rgbToCss(bounceColor, bouncePeak * 0.45));
  bounceGradient.addColorStop(1.0, rgbToCss(bounceColor, 0));

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = bounceGradient;
  ctx.fillRect(px, py, pw, ph);
  ctx.restore();

  const yellowness = Math.max(0, 0.5 * (paper[0] + paper[1]) - paper[2]);
  if (yellowness > 0.001) {
    const scatterTint = [
      Math.min(1, paper[0]),
      Math.min(1, paper[1] * 0.97),
      Math.max(0, paper[2] - yellowness * 1.6),
    ];
    const scatterPeak = Math.min(0.55, yellowness * 1.6);
    const scatterGrad = ctx.createLinearGradient(hingeX, 0, outerX, 0);
    scatterGrad.addColorStop(0.0, rgbToCss(scatterTint, scatterPeak));
    scatterGrad.addColorStop(0.04, rgbToCss(scatterTint, scatterPeak * 0.7));
    scatterGrad.addColorStop(0.12, rgbToCss(scatterTint, scatterPeak * 0.32));
    scatterGrad.addColorStop(0.25, rgbToCss(scatterTint, scatterPeak * 0.08));
    scatterGrad.addColorStop(0.4, rgbToCss(scatterTint, 0));
    scatterGrad.addColorStop(1.0, rgbToCss(scatterTint, 0));

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = scatterGrad;
    ctx.fillRect(px, py, pw, ph);
    ctx.restore();
  }
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
  const warmTint = mixRgb(shadowTint, [0.97, 0.84, 0.46], 0.52);
  const crackWarmTint = mixRgb(shadowTint, [0.88, 0.72, 0.08], 0.34 + edgeFactor * 0.08);
  const crackInnerTint = mixRgb(crackWarmTint, [0, 0, 0], 0.52);
  const warmOuter = mixRgb(warmTint, [0, 0, 0], 0.22);
  const warmCenter = mixRgb(warmTint, [0, 0, 0], 0.64 + edgeFactor * 0.14);
  const outerPeak = 0.08 + darkness * 0.08 + edgeFactor * 0.08;
  const centerPeak = 0.38 + darkness * 0.14 + edgeFactor * 0.18;
  const hingeX = side === "left" ? Math.round(pageRect.x + pageRect.w) : Math.round(pageRect.x);
  const outerX = side === "left" ? hingeX - reach : hingeX + reach;
  const gradient = ctx.createLinearGradient(hingeX, 0, outerX, 0);

  gradient.addColorStop(0, rgbToCss(crackInnerTint, centerPeak));
  gradient.addColorStop(0.05, rgbToCss(warmCenter, centerPeak * 0.82));
  gradient.addColorStop(0.14, rgbToCss(crackWarmTint, centerPeak * 0.46));
  gradient.addColorStop(0.28, rgbToCss(warmOuter, outerPeak * 0.9));
  gradient.addColorStop(0.5, rgbToCss(warmOuter, outerPeak * 0.5));
  gradient.addColorStop(0.72, rgbToCss(warmOuter, outerPeak * 0.2));
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
  ctx.fillStyle = rgbToCss(crackWarmTint, Math.min(0.92, centerPeak * 0.72));
  ctx.fillRect(hingeX + (side === "left" ? -2 : 0), Math.round(pageRect.y), 2, Math.round(pageRect.h));
  ctx.fillStyle = rgbToCss([0, 0, 0], Math.min(0.98, centerPeak + 0.16));
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
