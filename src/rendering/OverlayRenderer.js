import {
  drawCropHandles,
  drawMarginOverlay,
  drawVdG,
} from "./primitives.js";

export function renderOverlay(ctx, margins, uiState) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  if (uiState.appMode === "layout") {
    if (uiState.showVdG) drawVdG(ctx, margins.pagePxW, margins.pagePxH);

    if (uiState.showMarginArrows && uiState.spreadSideStates) {
      const fontSize = Math.max(7, Math.round(margins.scale / 9));
      ctx.save();
      ctx.font = `${fontSize}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      drawMarginOverlay(ctx, uiState.spreadSideStates.left, margins, fontSize);
      drawMarginOverlay(ctx, uiState.spreadSideStates.right, margins, fontSize);
      ctx.restore();
    }
  }

  if (uiState.appMode === "content" && uiState.spreadRects) {
    const hoverHandle = uiState.hoverHandle;
    if (uiState.spreadRects.left?.pageIndex === uiState.editingPageIdx) {
      drawCropHandles(
        ctx,
        uiState.spreadRects.left,
        hoverHandle?.side === "left" ? hoverHandle.edge : null
      );
    }
    if (uiState.spreadRects.right?.pageIndex === uiState.editingPageIdx) {
      drawCropHandles(
        ctx,
        uiState.spreadRects.right,
        hoverHandle?.side === "right" ? hoverHandle.edge : null
      );
    }
  }
}
