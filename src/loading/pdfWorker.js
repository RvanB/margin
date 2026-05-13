const PDFJS_URL = "https://unpkg.com/pdfjs-dist@5.6.205/build/pdf.mjs";
const PDF_WORKER_URL = "https://unpkg.com/pdfjs-dist@5.6.205/build/pdf.worker.mjs";

// pdf.js reaches for `globalThis.document.createElement("canvas")` in a few
// places that bypass its CanvasFactory. Inside a worker we install a minimal
// shim that hands back OffscreenCanvas-shaped objects for those code paths.
if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    createElement(name) {
      if (name === "canvas") return new OffscreenCanvas(1, 1);
      throw new Error(`Unsupported element in pdf worker shim: ${name}`);
    },
    createElementNS(_ns, name) {
      return this.createElement(name);
    },
  };
}

// pdf.js's default DOMCanvasFactory uses `document.createElement`, which
// doesn't exist in a worker context. This worker-side factory creates
// OffscreenCanvas instances instead.
class OffscreenCanvasFactory {
  create(width, height) {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }
  reset(canvasAndContext, width, height) {
    if (!canvasAndContext.canvas) throw new Error("Canvas is not specified");
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    if (!canvasAndContext.canvas) throw new Error("Canvas is not specified");
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

let pdfjsPromise = null;
function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL).then(lib => {
      lib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
      return lib;
    });
  }
  return pdfjsPromise;
}

const docs = new Map();
const activeOps = new Map();
const cleanupPending = new Set();
const rasterInfoCache = new Map();
let nextDocId = 1;

function bumpOps(docId) {
  activeOps.set(docId, (activeOps.get(docId) || 0) + 1);
}

function dropOps(docId) {
  const remaining = Math.max(0, (activeOps.get(docId) || 1) - 1);
  if (remaining === 0) activeOps.delete(docId);
  else activeOps.set(docId, remaining);
  maybeCleanup(docId);
}

function maybeCleanup(docId) {
  if (!cleanupPending.has(docId)) return;
  if ((activeOps.get(docId) || 0) > 0) return;
  cleanupPending.delete(docId);
  docs.get(docId)?.cleanup?.();
}

async function withPdfPage(docId, pageNum, work) {
  const doc = docs.get(docId);
  if (!doc) throw new Error(`Unknown pdf docId: ${docId}`);
  bumpOps(docId);
  const page = await doc.getPage(pageNum);
  try {
    return await work(page);
  } finally {
    page.cleanup?.();
    dropOps(docId);
  }
}

function multiplyTransform(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function getTransformAxisLengths(transform) {
  return {
    width: Math.hypot(transform[0], transform[1]),
    height: Math.hypot(transform[2], transform[3]),
  };
}

function getPlacedImageSize(transform, userUnit = 1) {
  const { width, height } = getTransformAxisLengths(transform);
  return { width: width * userUnit, height: height * userUnit };
}

function getImageDpiFromTransform(imageWidth, imageHeight, transform, userUnit = 1) {
  const { width, height } = getTransformAxisLengths(transform);
  if (width <= 0 || height <= 0 || imageWidth <= 0 || imageHeight <= 0) return 0;
  return Math.max(
    (imageWidth * 72) / (width * userUnit),
    (imageHeight * 72) / (height * userUnit)
  );
}

function getResolvedPdfObject(page, objId) {
  const pool = objId.startsWith("g_") ? page.commonObjs : page.objs;
  if (pool.has(objId)) return Promise.resolve(pool.get(objId));
  return new Promise(resolve => pool.get(objId, resolve));
}

async function computeRasterInfo(docId, pageNum) {
  const lib = await getPdfjs();
  return withPdfPage(docId, pageNum, async page => {
    const operatorList = await page.getOperatorList();
    const fnArray = operatorList.fnArray || [];
    const argsArray = operatorList.argsArray || [];
    const stack = [];
    let transform = [1, 0, 0, 1, 0, 0];
    let bestDpi = 72;
    let hasRasterImage = false;
    let imageCount = 0;
    let primaryImage = null;

    const registerImage = (imageLike, imageTransform = transform) => {
      const imageWidth = imageLike?.width || 0;
      const imageHeight = imageLike?.height || 0;
      if (imageWidth <= 0 || imageHeight <= 0) return;
      imageCount += 1;
      const placedSize = getPlacedImageSize(imageTransform, page.userUnit || 1);
      const dpi = getImageDpiFromTransform(imageWidth, imageHeight, imageTransform, page.userUnit || 1);
      if (dpi > 0) {
        hasRasterImage = true;
        if (dpi > bestDpi) bestDpi = dpi;
      }
      const placedArea = placedSize.width * placedSize.height;
      if (!primaryImage || placedArea > primaryImage.placedArea) {
        primaryImage = {
          width: imageWidth,
          height: imageHeight,
          dpi,
          placedWidth: placedSize.width,
          placedHeight: placedSize.height,
          placedArea,
        };
      }
    };

    for (let i = 0; i < fnArray.length; i += 1) {
      const fnId = fnArray[i];
      const args = argsArray[i] || [];

      if (fnId === lib.OPS.save) {
        stack.push(transform.slice());
        continue;
      }
      if (fnId === lib.OPS.restore) {
        transform = stack.pop() || [1, 0, 0, 1, 0, 0];
        continue;
      }
      if (fnId === lib.OPS.transform) {
        transform = multiplyTransform(transform, args);
        continue;
      }
      if (fnId === lib.OPS.paintInlineImageXObject) {
        registerImage(args[0]);
        continue;
      }
      if (fnId === lib.OPS.paintImageXObject) {
        registerImage(await getResolvedPdfObject(page, args[0]));
        continue;
      }
      if (fnId === lib.OPS.paintImageXObjectRepeat) {
        const image = await getResolvedPdfObject(page, args[0]);
        const scaleX = args[1];
        const scaleY = args[2];
        const positions = args[3] || [];
        for (let j = 0; j < positions.length; j += 2) {
          registerImage(image, multiplyTransform(transform, [scaleX, 0, 0, scaleY, positions[j], positions[j + 1]]));
        }
        continue;
      }
      if (fnId === lib.OPS.paintInlineImageXObjectGroup) {
        const image = args[0];
        const map = args[1] || [];
        for (const entry of map) {
          registerImage(image, multiplyTransform(transform, entry.transform));
        }
      }
    }

    return {
      dpi: bestDpi,
      renderScale: Math.max(1 / 72, bestDpi / 72),
      hasRasterImage,
      imageCount,
      imageWidth: primaryImage?.width || 0,
      imageHeight: primaryImage?.height || 0,
      placedWidth: primaryImage?.placedWidth || 0,
      placedHeight: primaryImage?.placedHeight || 0,
      primaryImageDpi: primaryImage?.dpi || 0,
    };
  });
}

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

const handlers = {
  async loadDocument({ buffer }) {
    const lib = await getPdfjs();
    const doc = await lib.getDocument({
      data: buffer,
      CanvasFactory: OffscreenCanvasFactory,
    }).promise;
    const docId = nextDocId++;
    docs.set(docId, doc);
    return { docId, numPages: doc.numPages };
  },

  async getAspectRatio({ docId, pageNum }) {
    return withPdfPage(docId, pageNum, page => {
      const viewport = page.getViewport({ scale: 1 });
      return viewport.width / viewport.height;
    });
  },

  async getRasterInfo({ docId, pageNum }) {
    let docCache = rasterInfoCache.get(docId);
    if (!docCache) {
      docCache = new Map();
      rasterInfoCache.set(docId, docCache);
    }
    if (!docCache.has(pageNum)) {
      docCache.set(pageNum, computeRasterInfo(docId, pageNum));
    }
    return docCache.get(pageNum);
  },

  async renderPage({ docId, pageNum, scale, downscaleTo = 0 }) {
    return withPdfPage(docId, pageNum, async page => {
      const viewport = page.getViewport({ scale });
      const renderWidth = Math.max(1, Math.round(viewport.width));
      const renderHeight = Math.max(1, Math.round(viewport.height));
      const renderCanvas = new OffscreenCanvas(renderWidth, renderHeight);
      const renderCtx = renderCanvas.getContext("2d");
      await page.render({ canvasContext: renderCtx, viewport }).promise;

      if (downscaleTo > 0) {
        const { width, height } = computeTargetSize(renderWidth, renderHeight, downscaleTo);
        if (width !== renderWidth || height !== renderHeight) {
          const downscaled = new OffscreenCanvas(width, height);
          const downCtx = downscaled.getContext("2d");
          downCtx.imageSmoothingEnabled = true;
          downCtx.imageSmoothingQuality = "high";
          downCtx.drawImage(renderCanvas, 0, 0, width, height);
          return downscaled.transferToImageBitmap();
        }
      }

      return renderCanvas.transferToImageBitmap();
    });
  },

  releaseDocument({ docId }) {
    if (!docs.has(docId)) return null;
    cleanupPending.add(docId);
    maybeCleanup(docId);
    return null;
  },

  requestCleanup({ docId }) {
    if (!docs.has(docId)) return null;
    cleanupPending.add(docId);
    maybeCleanup(docId);
    return null;
  },

  async decodeImageFile({ blob, downscaleTo = 0 }) {
    const bitmap = await createImageBitmap(blob);
    if (downscaleTo > 0) {
      const { width, height } = computeTargetSize(bitmap.width, bitmap.height, downscaleTo);
      if (width !== bitmap.width || height !== bitmap.height) {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, width, height);
        const originalWidth = bitmap.width;
        const originalHeight = bitmap.height;
        bitmap.close();
        return {
          bitmap: canvas.transferToImageBitmap(),
          width: originalWidth,
          height: originalHeight,
        };
      }
    }
    return { bitmap, width: bitmap.width, height: bitmap.height };
  },
};

self.addEventListener("message", async event => {
  const { id, type, payload } = event.data;
  const handler = handlers[type];
  if (!handler) {
    self.postMessage({ id, ok: false, error: `Unknown message type: ${type}` });
    return;
  }

  try {
    const result = await handler(payload || {});
    const transfer = [];
    if (result instanceof ImageBitmap) transfer.push(result);
    else if (result && typeof result === "object" && result.bitmap instanceof ImageBitmap) transfer.push(result.bitmap);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
});
