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

export function drawPageBorder(ctx, pagePxW) {
  const canvasWidth = ctx.canvas.width;
  const canvasHeight = ctx.canvas.height;
  const mid = Math.round(pagePxW);
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, canvasWidth - 1, canvasHeight - 1);
  ctx.setLineDash([1, 2]);
  ctx.beginPath();
  ctx.moveTo(mid + 0.5, 0);
  ctx.lineTo(mid + 0.5, canvasHeight);
  ctx.stroke();
  ctx.restore();
}

function hArrowLabel(ctx, x1, x2, y, text, fontSize) {
  const pad = fontSize * 0.5;
  const midX = Math.round((x1 + x2) / 2);
  const textWidth = ctx.measureText(text).width;
  const arrowW = Math.round(fontSize * 0.6);
  const arrowH = Math.round(fontSize * 0.35);
  const snappedY = Math.round(y) + 0.5;

  ctx.save();
  ctx.strokeStyle = "#000";
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

  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, midX, snappedY);
  ctx.restore();
}

function bracketLabel(ctx, x, y1, y2, text, fontSize) {
  const snappedX = Math.round(x) + 0.5;
  const topY = Math.round(y1);
  const bottomY = Math.round(y2);
  const pad = fontSize * 0.5;
  const midY = Math.round((topY + bottomY) / 2);
  const arrowW = Math.round(fontSize * 0.35);
  const arrowH = Math.round(fontSize * 0.6);

  ctx.save();
  ctx.strokeStyle = "#000";
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

  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, snappedX, midY);
  ctx.restore();
}

export function drawVdG(ctx, pagePxW, pagePxH) {
  const w = Math.round(pagePxW);
  const h = Math.round(pagePxH);

  function line(x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
    ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
    ctx.stroke();
  }

  ctx.save();
  ctx.strokeStyle = "#000";
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

export function drawMarginOverlay(ctx, side, margins, fontSize) {
  if (!side?.overlayVisible) return;

  const { pageRect, textblockRect } = side;
  const midY = pageRect.y + pageRect.h / 2;
  const labelX = textblockRect.x + textblockRect.w / 2;

  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.setLineDash([1, 2]);
  snappedStrokeRect(ctx, textblockRect.x, textblockRect.y, textblockRect.w, textblockRect.h);
  ctx.restore();

  if (side.side === "left") {
    hArrowLabel(ctx, pageRect.x, textblockRect.x, midY, `${margins.outer.toFixed(2)}″`, fontSize);
    hArrowLabel(
      ctx,
      textblockRect.x + textblockRect.w,
      pageRect.x + pageRect.w,
      midY,
      `${margins.inner.toFixed(2)}″`,
      fontSize
    );
  } else {
    hArrowLabel(ctx, pageRect.x, textblockRect.x, midY, `${margins.inner.toFixed(2)}″`, fontSize);
    hArrowLabel(
      ctx,
      textblockRect.x + textblockRect.w,
      pageRect.x + pageRect.w,
      midY,
      `${margins.outer.toFixed(2)}″`,
      fontSize
    );
  }

  bracketLabel(ctx, labelX, pageRect.y, textblockRect.y, `${margins.top.toFixed(2)}″`, fontSize);
  bracketLabel(
    ctx,
    labelX,
    textblockRect.y + textblockRect.h,
    pageRect.y + pageRect.h,
    `${margins.bottom.toFixed(2)}″`,
    fontSize
  );
}

export function drawCropHandles(ctx, rect, hoverEdge = null) {
  if (!rect) return;

  const thickness = CROP_HANDLE_THICK;
  const length = CROP_HANDLE_LEN;

  ctx.save();
  ctx.strokeStyle = "#000";
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

    ctx.fillStyle = "#fff";
    ctx.fillRect(handle.x, handle.y, handle.w, handle.h);

    if (!hovered) {
      ctx.fillStyle = "#000";
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

    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.strokeRect(handle.x + 0.5, handle.y + 0.5, handle.w - 1, handle.h - 1);
    ctx.restore();
  }

  ctx.restore();
}
