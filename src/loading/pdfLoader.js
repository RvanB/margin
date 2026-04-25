function get2dContext(canvas, options) {
  return canvas.getContext("2d", options);
}

let pdfjsReady = null;

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
  const page = await pdfDoc.getPage(pageNum);
  try {
    return await work(page);
  } finally {
    page.cleanup?.();
    pdfDoc.cleanup?.();
  }
}

export async function getPdfPageAspectRatio(pdfDoc, pageNum) {
  return withPdfPage(pdfDoc, pageNum, page => {
    const viewport = page.getViewport({ scale: 1 });
    return viewport.width / viewport.height;
  });
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
