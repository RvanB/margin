import { loadImageFile } from "../loading/imageLoader.js";
import { getPdfPageRasterSourceInfo, renderPdfPage } from "../loading/pdfLoader.js";
import { computeMargins, getPageGeometry } from "../rendering/layout.js";
import { SpreadRenderer } from "../rendering/SpreadRenderer.js";
import { canvasToBlob, getPageSide, parseNumber } from "../util/helpers.js";

export class ExportController {
  constructor({ book, spreadRenderer, modalManager, busyIndicator, getEffectEntry }) {
    this.book = book;
    this.spreadRenderer = spreadRenderer;
    this.modalManager = modalManager;
    this.busyIndicator = busyIndicator;
    this.getEffectEntry = getEffectEntry;
    this.settings = {
      resolutionMode: "source",
      dpi: 300,
      includePageColor: true,
    };
  }

  #getNativeExportScale(page, sourceCanvas, side) {
    const margins = computeMargins(this.book.layout, 1);
    const geometry = getPageGeometry(margins, side, page, 0);
    const rect = geometry.contentRect;
    const crop = page.getCropFor(sourceCanvas);
    const sourceWidth = sourceCanvas.width - crop.left - crop.right;
    const sourceHeight = sourceCanvas.height - crop.top - crop.bottom;
    if (!rect?.w || !rect?.h || sourceWidth <= 0 || sourceHeight <= 0) return 1;
    const minScale = 1 / Math.max(rect.w, rect.h, sourceWidth, sourceHeight, 1);

    if (geometry.contentMode === "fill") {
      return Math.max(minScale, Math.min(sourceWidth / rect.w, sourceHeight / rect.h));
    }
    if (geometry.contentMode === "fit-width") {
      return Math.max(minScale, sourceWidth / rect.w);
    }
    if (geometry.contentMode === "fit-height") {
      return Math.max(minScale, sourceHeight / rect.h);
    }
    return Math.max(minScale, sourceWidth / rect.w, sourceHeight / rect.h);
  }

  #getExportScale(page, sourceCanvas, side, settings) {
    if (settings?.resolutionMode === "custom") {
      return Math.max(1, parseNumber(settings.dpi, 0));
    }
    return this.#getNativeExportScale(page, sourceCanvas, side);
  }

  async #getNativeExportSourceCanvas(page) {
    if (page?.source?.type === "image" && page.source.file) {
      return { canvas: await loadImageFile(page.source.file), temporary: true };
    }
    if (page?.source?.type === "pdf" && page.source.pdfDoc && page.source.pageNum) {
      const rasterInfo = await getPdfPageRasterSourceInfo(page.source.pdfDoc, page.source.pageNum);
      return {
        canvas: await renderPdfPage(page.source.pdfDoc, page.source.pageNum, rasterInfo.renderScale),
        temporary: true,
      };
    }
    return { canvas: page?.srcCanvas || page?.previewCanvas || null, temporary: false };
  }

  async #getPageEffectiveDpiInfo(pageIndex, signal = null) {
    const page = this.book.pages[pageIndex];
    if (!page) return null;
    if (page?.source?.type === "pdf" && page.source.pdfDoc && page.source.pageNum) {
      const rasterInfo = await getPdfPageRasterSourceInfo(page.source.pdfDoc, page.source.pageNum);
      if (signal?.aborted) return null;
      if (!rasterInfo.hasRasterImage) {
        return { pageIndex, kind: "pdf-vector" };
      }
    }
    const side = getPageSide(pageIndex);
    const { canvas: sourceCanvas, temporary } = await this.#getNativeExportSourceCanvas(page);
    if (!sourceCanvas || signal?.aborted) {
      if (temporary && sourceCanvas) {
        sourceCanvas.close?.();
      }
      return null;
    }

    try {
      return {
        pageIndex,
        kind: "raster",
        dpi: this.#getNativeExportScale(page, sourceCanvas, side),
      };
    } finally {
      if (temporary) {
        sourceCanvas.close?.();
      }
    }
  }

  #formatEffectiveDpiLabel(info) {
    if (!info) return "—";
    if (info.kind === "pdf-vector") return `Page ${info.pageIndex + 1} — vector PDF`;
    const dpi = Number(info.dpi.toFixed(info.dpi >= 100 ? 1 : 2));
    return `Page ${info.pageIndex + 1} — ${dpi} DPI`;
  }

  async #getEffectiveDpiStats(signal = null) {
    const infos = [];
    for (let pageIndex = 0; pageIndex < this.book.pages.length; pageIndex += 1) {
      if (signal?.aborted) return null;
      const info = await this.#getPageEffectiveDpiInfo(pageIndex, signal);
      if (info?.kind === "raster" && info.dpi > 0) infos.push(info);
    }
    if (!infos.length) return { lowest: null, highest: null };
    return {
      lowest: infos.reduce((lowest, current) => (current.dpi < lowest.dpi ? current : lowest)),
      highest: infos.reduce((highest, current) => (current.dpi > highest.dpi ? current : highest)),
    };
  }

  async openModal() {
    if (this.busyIndicator.isExporting) return;
    if (!this.book.pages.length) {
      window.alert("Load pages before exporting.");
      return;
    }

    this.modalManager.show({
      title: "Export pages",
      templateId: "tpl-export-modal",
      onOpen: ({ content, dialog, signal }) => {
        const form = content.querySelector("#export-modal-form");
        const sourceRadio = form?.querySelector('input[name="export-resolution-mode"][value="source"]');
        const customRadio = form?.querySelector('input[name="export-resolution-mode"][value="custom"]');
        const dpiInput = form?.querySelector("#export-dpi");
        const includePageColor = form?.querySelector("#export-include-page-color");
        const lowestDpi = form?.querySelector("#export-lowest-effective-dpi");
        const highestDpi = form?.querySelector("#export-highest-effective-dpi");
        if (!form || !sourceRadio || !customRadio || !dpiInput || !includePageColor) return;

        sourceRadio.checked = this.settings.resolutionMode !== "custom";
        customRadio.checked = this.settings.resolutionMode === "custom";
        dpiInput.value = String(this.settings.dpi);
        includePageColor.checked = this.settings.includePageColor !== false;

        const syncResolutionInputs = () => {
          dpiInput.disabled = !customRadio.checked;
        };

        sourceRadio.addEventListener("change", syncResolutionInputs, { signal });
        customRadio.addEventListener("change", syncResolutionInputs, { signal });
        syncResolutionInputs();

        form.addEventListener("submit", async event => {
          event.preventDefault();
          const resolutionMode = customRadio.checked ? "custom" : "source";
          const dpi = Math.round(parseNumber(dpiInput.value, 0));
          if (resolutionMode === "custom" && dpi <= 0) {
            window.alert("Enter a DPI greater than 0.");
            dpiInput.focus();
            return;
          }

          this.settings = {
            resolutionMode,
            dpi: resolutionMode === "custom" ? dpi : this.settings.dpi,
            includePageColor: includePageColor.checked,
          };
          dialog.close();
          await this.exportAll();
        }, { signal });

        this.#getEffectiveDpiStats(signal).then(stats => {
          if (signal.aborted || !stats) return;
          if (lowestDpi) lowestDpi.textContent = this.#formatEffectiveDpiLabel(stats.lowest);
          if (highestDpi) highestDpi.textContent = this.#formatEffectiveDpiLabel(stats.highest);
        });
      },
    });
  }

  async #renderPage(pageIndex, settings) {
    const page = this.book.pages[pageIndex];
    if (!page) return null;
    const side = getPageSide(pageIndex);
    const { canvas: sourceCanvas, temporary } = await this.#getNativeExportSourceCanvas(page);
    if (!sourceCanvas) return null;

    try {
      const exportScale = this.#getExportScale(page, sourceCanvas, side, settings);
      const margins = computeMargins(this.book.layout, exportScale);
      const previewRenderer = typeof this.spreadRenderer.getPlacedPagePreview === "function"
        ? this.spreadRenderer
        : new SpreadRenderer(document.createElement("canvas"));
      return previewRenderer.getPlacedPagePreview(
        page,
        this.getEffectEntry(page),
        this.book.display,
        {
          sourceCanvas,
          layout: this.book.layout,
          side,
          pageHeight: margins.pagePxH,
          includePageColor: settings?.includePageColor !== false,
        }
      );
    } finally {
      if (temporary) {
        sourceCanvas.close?.();
      }
    }
  }

  async #writeBlob(handle, name, blob) {
    const fileHandle = await handle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  #downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async exportAll(settings = this.settings) {
    if (this.busyIndicator.isExporting) return;
    if (!this.book.pages.length) {
      window.alert("Load pages before exporting.");
      return;
    }

    this.modalManager.close();
    this.busyIndicator.setExporting(true);
    this.busyIndicator.setExportProgress("Preparing export", 0, this.book.pages.length);
    try {
      let directoryHandle = null;
      const zip = typeof globalThis.JSZip === "function" ? new globalThis.JSZip() : null;
      if (typeof globalThis.showDirectoryPicker === "function") {
        try {
          this.busyIndicator.setExportProgress("Choose export folder", 0, this.book.pages.length);
          directoryHandle = await globalThis.showDirectoryPicker({ mode: "readwrite" });
        } catch (error) {
          if (error?.name === "AbortError") return;
          console.error("Directory picker failed:", error);
        }
      }

      for (let pageIndex = 0; pageIndex < this.book.pages.length; pageIndex += 1) {
        this.busyIndicator.setExportProgress("Rendering page", pageIndex, this.book.pages.length);
        const exportCanvas = await this.#renderPage(pageIndex, settings);
        if (!exportCanvas) continue;
        try {
          const blob = await canvasToBlob(exportCanvas);
          const fileName = `page-${String(pageIndex + 1).padStart(4, "0")}.png`;
          if (directoryHandle) {
            this.busyIndicator.setExportProgress("Writing page", pageIndex + 1, this.book.pages.length);
            await this.#writeBlob(directoryHandle, fileName, blob);
          } else {
            if (!zip) throw new Error("JSZip unavailable");
            zip.file(fileName, blob);
            this.busyIndicator.setExportProgress("Adding to ZIP", pageIndex + 1, this.book.pages.length);
          }
        } finally {
          exportCanvas.width = 0;
          exportCanvas.height = 0;
        }
      }

      if (!directoryHandle && zip) {
        this.busyIndicator.setExportProgress("Building ZIP", this.book.pages.length, this.book.pages.length);
        const zipBlob = await zip.generateAsync({ type: "blob" });
        this.busyIndicator.setExportProgress("Downloading ZIP", this.book.pages.length, this.book.pages.length);
        this.#downloadBlob("pages.zip", zipBlob);
      }
    } catch (error) {
      console.error("Failed to export pages:", error);
      window.alert("Could not export pages.");
    } finally {
      this.busyIndicator.setExporting(false);
    }
  }
}
