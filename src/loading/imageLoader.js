import { downscaleCanvasToMaxEdge } from "./downscaleCanvas.js";

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

function drawImageToCanvas(image, width = image.naturalWidth, height = image.naturalHeight) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0, width, height);
  return canvas;
}

async function withLoadedImage(file, work) {
  const url = URL.createObjectURL(file);

  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(`Could not load image file: ${file?.name || "unknown"}`));
      image.src = url;
    });
    return await work(image);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function loadImageFile(file) {
  return withLoadedImage(file, async image => {
    return drawImageToCanvas(image);
  });
}

export async function loadImagePreview(file, maxEdge) {
  return withLoadedImage(file, async image => {
    const sourceCanvas = drawImageToCanvas(image);
    const { width, height } = computeTargetSize(image.naturalWidth, image.naturalHeight, maxEdge);
    let canvas = sourceCanvas;
    if (width !== sourceCanvas.width || height !== sourceCanvas.height) {
      canvas = await downscaleCanvasToMaxEdge(sourceCanvas, maxEdge) || sourceCanvas;
      if (canvas !== sourceCanvas) {
        sourceCanvas.width = 0;
        sourceCanvas.height = 0;
      }
    }
    return {
      canvas,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  });
}
