let worker = null;
let nextRequestId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./pdfWorker.js", import.meta.url), { type: "module" });
  worker.addEventListener("message", event => {
    const { id, ok, result, error } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(result);
    else entry.reject(new Error(error));
  });
  worker.addEventListener("error", event => {
    console.error("PDF worker error:", event.message || event);
  });
  return worker;
}

function call(type, payload, transfer = []) {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, type, payload }, transfer);
  });
}

export async function loadPdfDocument(buffer) {
  const transferable = buffer instanceof ArrayBuffer ? [buffer] : [];
  return call("loadDocument", { buffer }, transferable);
}

export async function getPdfPageAspectRatio(pdfDoc, pageNum) {
  return call("getAspectRatio", { docId: pdfDoc.docId, pageNum });
}

export async function getPdfPageRasterSourceInfo(pdfDoc, pageNum) {
  return call("getRasterInfo", { docId: pdfDoc.docId, pageNum });
}

/**
 * Renders a PDF page at the given scale, returning an ImageBitmap.
 * If `downscaleTo` is provided, the worker downscales the rasterized page
 * to that max-edge size before transferring the bitmap.
 */
export async function renderPdfPage(pdfDoc, pageNum, scale, { downscaleTo = 0 } = {}) {
  return call("renderPage", { docId: pdfDoc.docId, pageNum, scale, downscaleTo });
}

export function requestPdfDocumentCleanup(pdfDoc) {
  if (!pdfDoc?.docId) return;
  call("requestCleanup", { docId: pdfDoc.docId }).catch(() => {});
}
