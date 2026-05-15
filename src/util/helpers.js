export function cloneSet(set) {
  return new Set([...set]);
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeHexColor(value, fallback) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (/^#[0-9a-f]{6}$/.test(normalized)) return normalized;
  if (/^#[0-9a-f]{3}$/.test(normalized)) {
    return `#${normalized.slice(1).split("").map(char => char + char).join("")}`;
  }
  return fallback;
}

export function isProjectJsonFile(file) {
  return !!file && (
    file.type === "application/json"
    || file.name.toLowerCase().endsWith(".json")
  );
}

export function isZipFile(file) {
  return !!file && (
    file.type === "application/zip"
    || file.type === "application/x-zip-compressed"
    || file.name.toLowerCase().endsWith(".zip")
  );
}

export function inferMimeTypeFromName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  return "";
}

export function shouldImportZipEntry(name) {
  const normalized = String(name || "").replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length) return false;
  if (segments.some(segment => segment.startsWith(".") || segment.startsWith("_"))) return false;
  return true;
}

export function getZipEntryFileName(name) {
  const normalized = String(name || "").replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] || normalized;
}

export function normalizeCrop(crop) {
  return {
    top: Math.max(0, Math.round(parseNumber(crop?.top))),
    left: Math.max(0, Math.round(parseNumber(crop?.left))),
    right: Math.max(0, Math.round(parseNumber(crop?.right))),
    bottom: Math.max(0, Math.round(parseNumber(crop?.bottom))),
  };
}

export function getPageSide(pageIndex) {
  return pageIndex % 2 === 1 ? "left" : "right";
}

export function getEditingPage(book, uiState) {
  return book.pages[uiState.editingPageIdx] ?? null;
}

export function getSelectedPages(book, uiState) {
  if (!uiState.selectedPageIdxs.size) {
    return [book.pages[uiState.editingPageIdx]].filter(Boolean);
  }
  return [...uiState.selectedPageIdxs]
    .map(index => book.pages[index])
    .filter(Boolean);
}

export function getEffectiveContentAlignX(book, page) {
  if (!page) return "center";
  if (page.contentAlignX) return page.contentAlignX;
  const pageIndex = book.pages.indexOf(page);
  const side = getPageSide(pageIndex);
  return page.spread && !page.cover
    ? (side === "left" ? "right" : "left")
    : "center";
}

export function getEffectiveContentAlignY(page) {
  return page?.contentAlignY || "top";
}

export function canvasToBlob(canvas, type = "image/png") {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("Failed to create image blob"));
    }, type);
  });
}
