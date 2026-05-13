function computeTargetSize(sourceWidth, sourceHeight, maxEdge) {
  const safeMaxEdge = Math.max(1, Math.round(maxEdge || 1));
  const sourceMaxEdge = Math.max(sourceWidth, sourceHeight);
  if (sourceMaxEdge <= safeMaxEdge) {
    return {
      width: Math.max(1, Math.round(sourceWidth)),
      height: Math.max(1, Math.round(sourceHeight)),
    };
  }
  const scale = safeMaxEdge / sourceMaxEdge;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

/**
 * Synchronous main-thread downscale, used by the interactive preview path
 * during pan/zoom interactions where we need a smaller copy immediately and
 * cannot await a worker round-trip. Accepts any CanvasImageSource (canvas,
 * OffscreenCanvas, ImageBitmap) and returns a regular HTMLCanvasElement.
 */
export function downscaleCanvasToMaxEdgeSync(source, maxEdge) {
  if (!source?.width || !source?.height) return null;

  const { width: targetWidth, height: targetHeight } = computeTargetSize(
    source.width,
    source.height,
    maxEdge
  );
  if (targetWidth === source.width && targetHeight === source.height) {
    return source;
  }

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
  return canvas;
}
