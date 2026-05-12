const PAPER_TEXTURE_URL = new URL("../../229-plain-white-paper.webp", import.meta.url).href;

let neutralCanvas = null;
let loadedTextureCanvas = null;
let loadPromise = null;

function get2dContext(canvas, options) {
  return canvas.getContext("2d", options);
}

function getNeutralCanvas() {
  if (neutralCanvas) return neutralCanvas;
  neutralCanvas = document.createElement("canvas");
  neutralCanvas.width = 1;
  neutralCanvas.height = 1;
  const ctx = get2dContext(neutralCanvas);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 1, 1);
  return neutralCanvas;
}

function imageToCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = get2dContext(canvas, { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function getPaperTextureCanvasSync() {
  return loadedTextureCanvas || getNeutralCanvas();
}

export async function loadPaperTextureCanvas() {
  if (loadedTextureCanvas) return loadedTextureCanvas;
  if (!loadPromise) {
    loadPromise = new Promise(resolve => {
      const image = new Image();
      image.onload = () => {
        loadedTextureCanvas = imageToCanvas(image);
        resolve(loadedTextureCanvas);
      };
      image.onerror = error => {
        console.error("Failed to load paper texture:", error);
        loadedTextureCanvas = getNeutralCanvas();
        resolve(loadedTextureCanvas);
      };
      image.src = PAPER_TEXTURE_URL;
    });
  }
  return loadPromise;
}

export function drawPaperTextureOverlay(ctx, rect, textureCanvas = getPaperTextureCanvasSync(), { strength = 0.2 } = {}) {
  if (!ctx || !rect || rect.w <= 0 || rect.h <= 0 || !textureCanvas) return;
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = strength;
  ctx.drawImage(
    textureCanvas,
    Math.round(rect.x),
    Math.round(rect.y),
    Math.round(rect.w),
    Math.round(rect.h)
  );
  ctx.restore();
}
