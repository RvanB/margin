import { drawCropHandles, drawMarginOverlay, drawVdG } from "riffle";

export function measureOverlayDraw(page, sideState, sourceCanvas) {
  const rect = sideState?.contentRect;
  if (!rect || !sourceCanvas) return null;
  const crop = page.getCropFor(sourceCanvas);
  const sourceWidth = sourceCanvas.width - crop.left - crop.right;
  const sourceHeight = sourceCanvas.height - crop.top - crop.bottom;
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;

  const mode = sideState.contentMode;
  const scale = mode === "fill"
    ? Math.max(rect.w / sourceWidth, rect.h / sourceHeight)
    : mode === "fit-width"
      ? rect.w / sourceWidth
      : mode === "fit-height"
        ? rect.h / sourceHeight
        : Math.min(rect.w / sourceWidth, rect.h / sourceHeight);
  const alignedX = sideState.contentAlignX === "start"
    ? rect.x
    : sideState.contentAlignX === "end"
      ? rect.x + rect.w - sourceWidth * scale
      : rect.x + (rect.w - sourceWidth * scale) / 2;
  const alignedY = sideState.contentAlignY === "start"
    ? rect.y
    : sideState.contentAlignY === "end"
      ? rect.y + rect.h - sourceHeight * scale
      : rect.y + (rect.h - sourceHeight * scale) / 2;
  const drawX = Math.round(alignedX - crop.left * scale);
  const drawY = Math.round(alignedY - crop.top * scale);
  const drawW = Math.max(1, Math.round(sourceCanvas.width * scale));
  const drawH = Math.max(1, Math.round(sourceCanvas.height * scale));
  const cropX = Math.round(drawX + crop.left * drawW / sourceCanvas.width);
  const cropY = Math.round(drawY + crop.top * drawH / sourceCanvas.height);
  const cropRight = Math.round(drawX + (sourceCanvas.width - crop.right) * drawW / sourceCanvas.width);
  const cropBottom = Math.round(drawY + (sourceCanvas.height - crop.bottom) * drawH / sourceCanvas.height);
  const clipX0 = Math.round(rect.x);
  const clipY0 = Math.round(rect.y);
  const clipX1 = Math.round(rect.x + rect.w);
  const clipY1 = Math.round(rect.y + rect.h);
  const visibleX = mode === "fill" ? Math.max(cropX, clipX0) : cropX;
  const visibleY = mode === "fill" ? Math.max(cropY, clipY0) : cropY;
  const visibleRight = mode === "fill" ? Math.min(cropRight, clipX1) : cropRight;
  const visibleBottom = mode === "fill" ? Math.min(cropBottom, clipY1) : cropBottom;

  return {
    crop,
    drawRect: {
      x: drawX,
      y: drawY,
      w: drawW,
      h: drawH,
    },
    clipRect: mode === "fill"
      ? {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.x + rect.w) - Math.round(rect.x),
        h: Math.round(rect.y + rect.h) - Math.round(rect.y),
      }
      : null,
    visibleRect: {
      x: visibleX,
      y: visibleY,
      w: Math.max(0, visibleRight - visibleX),
      h: Math.max(0, visibleBottom - visibleY),
      fitScale: scale,
      sw: sourceCanvas.width,
      sh: sourceCanvas.height,
    },
  };
}

export function renderContentEditOverlay(book, uiState, {
  spreadSideStates = null,
} = {}) {
  if (uiState.appMode !== "content" || !spreadSideStates) return null;

  const page = book.pages[uiState.editingPageIdx] ?? null;
  const sideState = ["left", "right"]
    .map(side => spreadSideStates[side])
    .find(state => state?.pageIndex === uiState.editingPageIdx);
  const sourceCanvas = page?.displayCanvas;
  const measurement = page && measureOverlayDraw(page, sideState, sourceCanvas);
  if (!measurement) return null;
  return {
    side: sideState.side,
    sourceCanvas,
    measurement,
    rect: {
      ...measurement.visibleRect,
      pageIndex: uiState.editingPageIdx,
    },
  };
}

export function renderOverlay(ctx, margins, uiState, {
  paperColor = null,
  spreadRects = null,
  spreadSideStates = null,
} = {}) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  if (uiState.appMode === "layout") {
    if (uiState.showVdG) drawVdG(ctx, margins.pagePxW, margins.pagePxH, { paperColor });

    if (uiState.showMarginArrows && spreadSideStates) {
      const fontSize = Math.max(7, Math.round(margins.scale / 9));
      ctx.save();
      ctx.font = `${fontSize}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      drawMarginOverlay(ctx, spreadSideStates.left, margins, fontSize, { paperColor });
      drawMarginOverlay(ctx, spreadSideStates.right, margins, fontSize, { paperColor });
      ctx.restore();
    }
  }

  if (uiState.appMode === "content" && spreadRects) {
    const hoverHandle = uiState.hoverHandle;
    if (spreadRects.left?.pageIndex === uiState.editingPageIdx) {
      drawCropHandles(
        ctx,
        spreadRects.left,
        hoverHandle?.side === "left" ? hoverHandle.edge : null,
        { paperColor }
      );
    }
    if (spreadRects.right?.pageIndex === uiState.editingPageIdx) {
      drawCropHandles(
        ctx,
        spreadRects.right,
        hoverHandle?.side === "right" ? hoverHandle.edge : null,
        { paperColor }
      );
    }
  }
}
