function get2dContext(canvas, options) {
  return canvas.getContext("2d", options);
}

let pdfjsReady = null;
const pdfDocActiveOps = new WeakMap();
const pdfDocCleanupPending = new WeakSet();
const pdfPageRasterInfoCache = new WeakMap();

function maybeCleanupPdfDocument(pdfDoc) {
  if (!pdfDocCleanupPending.has(pdfDoc)) return;
  if ((pdfDocActiveOps.get(pdfDoc) || 0) > 0) return;
  pdfDocCleanupPending.delete(pdfDoc);
  pdfDoc.cleanup?.();
}

export function ensurePdfjs() {
  if (pdfjsReady) return pdfjsReady;

  pdfjsReady = new Promise((resolve, reject) => {
    const readyKey = `__pdfjsReady${Math.random().toString(36).slice(2)}`;
    const errorKey = `__pdfjsError${Math.random().toString(36).slice(2)}`;

    globalThis[readyKey] = lib => {
      delete globalThis[readyKey];
      delete globalThis[errorKey];
      lib.GlobalWorkerOptions.workerSrc =
        "https://unpkg.com/pdfjs-dist@5.6.205/build/pdf.worker.mjs";
      resolve(lib);
    };

    globalThis[errorKey] = message => {
      delete globalThis[readyKey];
      delete globalThis[errorKey];
      reject(new Error(message));
    };

    const script = document.createElement("script");
    script.type = "module";
    script.textContent = `
      import("https://unpkg.com/pdfjs-dist@5.6.205/build/pdf.mjs")
        .then((lib) => globalThis["${readyKey}"](lib))
        .catch((error) => globalThis["${errorKey}"](error?.message || "Failed to load PDF.js"));
    `;
    script.onerror = () => reject(new Error("Failed to load PDF.js"));
    document.head.appendChild(script);
  });

  return pdfjsReady;
}

export async function loadPdfDocument(buffer) {
  const lib = await ensurePdfjs();
  return lib.getDocument({ data: buffer }).promise;
}

async function withPdfPage(pdfDoc, pageNum, work) {
  pdfDocActiveOps.set(pdfDoc, (pdfDocActiveOps.get(pdfDoc) || 0) + 1);
  const page = await pdfDoc.getPage(pageNum);
  try {
    return await work(page);
  } finally {
    page.cleanup?.();
    const remainingOps = Math.max(0, (pdfDocActiveOps.get(pdfDoc) || 1) - 1);
    if (remainingOps === 0) {
      pdfDocActiveOps.delete(pdfDoc);
    } else {
      pdfDocActiveOps.set(pdfDoc, remainingOps);
    }
    maybeCleanupPdfDocument(pdfDoc);
  }
}

export function requestPdfDocumentCleanup(pdfDoc) {
  if (!pdfDoc) return;
  pdfDocCleanupPending.add(pdfDoc);
  maybeCleanupPdfDocument(pdfDoc);
}

export async function getPdfPageAspectRatio(pdfDoc, pageNum) {
  return withPdfPage(pdfDoc, pageNum, page => {
    const viewport = page.getViewport({ scale: 1 });
    return viewport.width / viewport.height;
  });
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
  return {
    width: width * userUnit,
    height: height * userUnit,
  };
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
  return new Promise(resolve => {
    pool.get(objId, resolve);
  });
}

async function computePdfPageRasterSourceInfo(pdfDoc, pageNum) {
  const lib = await ensurePdfjs();
  return withPdfPage(pdfDoc, pageNum, async page => {
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

export async function getPdfPageRasterSourceInfo(pdfDoc, pageNum) {
  let pageCache = pdfPageRasterInfoCache.get(pdfDoc);
  if (!pageCache) {
    pageCache = new Map();
    pdfPageRasterInfoCache.set(pdfDoc, pageCache);
  }
  if (!pageCache.has(pageNum)) {
    pageCache.set(pageNum, computePdfPageRasterSourceInfo(pdfDoc, pageNum));
  }
  return pageCache.get(pageNum);
}

export async function renderPdfPage(pdfDoc, pageNum, scale) {
  return withPdfPage(pdfDoc, pageNum, async page => {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const renderTask = page.render({
      canvasContext: get2dContext(canvas, { willReadFrequently: true }),
      viewport,
    });
    renderTask.onContinue = continueCallback => {
      if (typeof globalThis.requestIdleCallback === "function") {
        globalThis.requestIdleCallback(() => continueCallback(), { timeout: 32 });
      } else {
        setTimeout(() => continueCallback(), 0);
      }
    };
    await renderTask.promise;
    return canvas;
  });
}
