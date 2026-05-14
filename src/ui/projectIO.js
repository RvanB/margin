import { loadImagePreview } from "../loading/imageLoader.js";
import { getPdfPageAspectRatio, loadPdfDocument } from "riffle";
import { Page, normalizeContentAlignX, normalizeContentAlignY, normalizeFitAxis } from "../model/Page.js";
import { applyPaperPreset, getPaperPresetIdForColor, normalizePaperPreset } from "../model/paper.js";
import { SHARED_PREVIEW_SIZE } from "../previewSizing.js";
import {
  finiteNumber,
  getZipEntryFileName,
  inferMimeTypeFromName,
  isZipFile,
  normalizeCrop,
  parseNumber,
  shouldImportZipEntry,
} from "../util/helpers.js";

export function isPdfFile(file) {
  return file?.type === "application/pdf" || file?.name?.toLowerCase().endsWith(".pdf");
}

export function serializeProject(book, { layoutControlsState }) {
  return {
    version: 4,
    layout: { ...book.layout },
    display: {
      paperPreset: book.display.paperPreset,
      contentBlendMode: book.display.contentBlendMode,
      paperThickness: book.display.paperThickness,
      paperTextureStrength: book.display.paperTextureStrength,
    },
    layoutControls: { ...layoutControlsState },
    pageCount: book.pages.length,
    pages: book.pages.map(page => ({
      crop: { ...page.crop },
      cropSourceWidth: page.cropSourceWidth,
      cropSourceHeight: page.cropSourceHeight,
      cover: !!page.cover,
      spread: !!page.spread,
      fitAxis: normalizeFitAxis(page.fitAxis),
      contentAlignX: normalizeContentAlignX(page.contentAlignX),
      contentAlignY: normalizeContentAlignY(page.contentAlignY),
    })),
  };
}

function applyPageState(page, pageState) {
  if (!page || !pageState || typeof pageState !== "object") return;
  page.crop = normalizeCrop(pageState.crop);
  page.cropSourceWidth = Math.max(0, Math.round(parseNumber(pageState.cropSourceWidth)));
  page.cropSourceHeight = Math.max(0, Math.round(parseNumber(pageState.cropSourceHeight)));
  page.cover = !!pageState.cover;
  page.spread = !!pageState.spread;
  page.fitAxis = normalizeFitAxis(pageState.fitAxis);
  page.contentAlignX = normalizeContentAlignX(pageState.contentAlignX);
  page.contentAlignY = normalizeContentAlignY(pageState.contentAlignY);
}

export function applyProjectDataToBook(book, project, { layoutControlsState, onPageApplied = null } = {}) {
  if (!project || typeof project !== "object") {
    throw new Error("Invalid project data");
  }

  const layout = project.layout && typeof project.layout === "object" ? project.layout : {};
  book.layout.pw = finiteNumber(parseNumber(layout.pw, book.layout.pw), book.layout.pw);
  book.layout.ph = finiteNumber(parseNumber(layout.ph, book.layout.ph), book.layout.ph);
  book.layout.ratio = finiteNumber(parseNumber(layout.ratio, book.layout.ratio), book.layout.ratio);
  book.layout.b = finiteNumber(parseNumber(layout.b, book.layout.b), book.layout.b);
  book.layout.mInner = finiteNumber(parseNumber(layout.mInner, book.layout.mInner), book.layout.mInner);
  book.layout.mTop = finiteNumber(parseNumber(layout.mTop, book.layout.mTop), book.layout.mTop);
  book.layout.mBottom = finiteNumber(parseNumber(layout.mBottom, book.layout.mBottom), book.layout.mBottom);

  const layoutControls = project.layoutControls && typeof project.layoutControls === "object"
    ? project.layoutControls
    : {};
  const nextLayoutControlsState = {
    preserveRatio: !!layoutControls.preserveRatio,
    ratioSameAsPage: "ratioSameAsPage" in layoutControls
      ? !!layoutControls.ratioSameAsPage
      : layoutControlsState.ratioSameAsPage,
  };

  const display = project.display && typeof project.display === "object" ? project.display : {};
  if (typeof display.contentBlendMode === "string" && display.contentBlendMode) {
    book.display.contentBlendMode = display.contentBlendMode;
  }
  if ("paperPreset" in display || "paperColor" in display) {
    const presetId = "paperPreset" in display
      ? normalizePaperPreset(display.paperPreset)
      : getPaperPresetIdForColor(display.paperColor);
    applyPaperPreset(book.display, presetId);
  }
  if (typeof display.paperThickness === "number") {
    book.display.paperThickness = Math.max(0, Math.min(1, display.paperThickness));
  }
  if (typeof display.paperTextureStrength === "number") {
    book.display.paperTextureStrength = Math.max(0, Math.min(1, display.paperTextureStrength));
  }

  const pageStates = Array.isArray(project.pages) ? project.pages : [];
  const appliedPageCount = Math.min(book.pages.length, pageStates.length);
  for (let pageIndex = 0; pageIndex < appliedPageCount; pageIndex += 1) {
    const page = book.pages[pageIndex];
    applyPageState(page, pageStates[pageIndex]);
    onPageApplied?.(page, pageIndex);
  }

  return { layoutControlsState: nextLayoutControlsState, appliedPageCount };
}

export async function readProjectJsonFile(file) {
  return JSON.parse(await file.text());
}

export function downloadProjectJson(project, fileName = "margins-project.json") {
  const blob = new Blob([`${JSON.stringify(project, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function expandImportFiles(files) {
  const expanded = [];

  for (const file of Array.from(files)) {
    if (!isZipFile(file)) {
      expanded.push(file);
      continue;
    }

    if (typeof globalThis.JSZip !== "function") {
      console.error("JSZip unavailable for ZIP import");
      window.alert(`Could not read "${file.name}".`);
      continue;
    }

    try {
      const zip = await globalThis.JSZip.loadAsync(await file.arrayBuffer());
      const entries = [];
      zip.forEach((_, entry) => {
        if (!entry.dir && shouldImportZipEntry(entry.name)) entries.push(entry);
      });

      for (const entry of entries) {
        const blob = await entry.async("blob");
        const fileName = getZipEntryFileName(entry.name);
        expanded.push(new File(
          [blob],
          fileName,
          { type: blob.type || inferMimeTypeFromName(fileName) }
        ));
      }
    } catch (error) {
      console.error("Failed to read ZIP file:", error);
      window.alert(`Could not read "${file.name}".`);
    }
  }

  return expanded;
}

export async function readPdfPagesFromFile(file) {
  const pdfDoc = await loadPdfDocument(await file.arrayBuffer());
  const aspectRatios = await Promise.all(
    Array.from({ length: pdfDoc.numPages }, (_, index) =>
      getPdfPageAspectRatio(pdfDoc, index + 1)
    )
  );
  return aspectRatios.map((aspectRatio, index) => new Page({
    source: { type: "pdf", pdfDoc, pageNum: index + 1 },
    aspectRatio,
  }));
}

export async function readImagePageFromFile(file) {
  const { canvas: thumbnailSourceCanvas, width, height } = await loadImagePreview(file, SHARED_PREVIEW_SIZE);
  return new Page({
    source: { type: "image", file },
    previewCanvas: thumbnailSourceCanvas,
    thumbnailSourceCanvas,
    aspectRatio: width / height,
  });
}
