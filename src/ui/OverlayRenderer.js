import { drawCropHandles, drawMarginOverlay, drawVdG } from "riffle";

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
