let worker = null;
let nextRequestId = 1;
const pending = new Map();

// Main-thread dispatch queue. We send at most one request to the worker at a
// time so that newly-arriving high-priority requests (e.g. high-res renders
// for a destination spread the user just navigated to) can jump ahead of a
// long FIFO of low-priority preview renders.
const highPriorityQueue = [];
const lowPriorityQueue = [];
let inFlight = 0;
const MAX_IN_FLIGHT = 1;

function getWorker() {
  if (worker) return worker;
  // Cache-bust the worker URL per page load — Firefox in particular caches
  // module workers aggressively and a hard-reload doesn't always invalidate
  // them. Remove the query string when shipping if you want to leverage HTTP
  // caching for the worker file.
  const workerUrl = new URL("./pdfWorker.js", import.meta.url);
  workerUrl.searchParams.set("v", String(Date.now()));
  worker = new Worker(workerUrl, { type: "module" });
  worker.addEventListener("message", event => {
    const { id, ok, result, error } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    inFlight = Math.max(0, inFlight - 1);
    if (ok) entry.resolve(result);
    else entry.reject(new Error(error));
    dispatch();
  });
  worker.addEventListener("error", event => {
    console.error("PDF worker error:", event.message || event);
  });
  return worker;
}

function dispatch() {
  while (inFlight < MAX_IN_FLIGHT) {
    const entry = highPriorityQueue.shift() || lowPriorityQueue.shift();
    if (!entry) return;
    inFlight += 1;
    const id = nextRequestId++;
    pending.set(id, { resolve: entry.resolve, reject: entry.reject });
    getWorker().postMessage({ id, type: entry.type, payload: entry.payload }, entry.transfer);
  }
}

function call(type, payload, { transfer = [], priority = false } = {}) {
  return new Promise((resolve, reject) => {
    const entry = { type, payload, transfer, resolve, reject };
    if (priority) highPriorityQueue.push(entry);
    else lowPriorityQueue.push(entry);
    dispatch();
  });
}

export async function loadPdfDocument(buffer) {
  const transferable = buffer instanceof ArrayBuffer ? [buffer] : [];
  return call("loadDocument", { buffer }, { transfer: transferable });
}

export async function getPdfPageAspectRatio(pdfDoc, pageNum) {
  return call("getAspectRatio", { docId: pdfDoc.docId, pageNum });
}

export async function getPdfPageRasterSourceInfo(pdfDoc, pageNum) {
  return call("getRasterInfo", { docId: pdfDoc.docId, pageNum });
}

/**
 * Renders a PDF page at the given scale, returning an ImageBitmap.
 *
 * Options:
 *   - downscaleTo: if set, the worker downscales the page to that max-edge
 *     before transferring the bitmap.
 *   - priority: if true, this request jumps ahead of queued low-priority
 *     renders. Use for renders the user is actively waiting on (e.g.
 *     high-res renders for a destination spread).
 */
export async function renderPdfPage(pdfDoc, pageNum, scale, { downscaleTo = 0, priority = false } = {}) {
  return call(
    "renderPage",
    { docId: pdfDoc.docId, pageNum, scale, downscaleTo },
    { priority },
  );
}

export function requestPdfDocumentCleanup(pdfDoc) {
  if (!pdfDoc?.docId) return;
  call("requestCleanup", { docId: pdfDoc.docId }).catch(() => {});
}
