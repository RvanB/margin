import { buildGpuEffectConfig, buildPipeline, effectKey } from "../effects/pipeline.js";
import { computeMargins } from "../viewer/rendering/layout.js";
import { renderOverlay } from "./OverlayRenderer.js";

export class SpreadComposer {
  constructor(app) {
    this.app = app;
    this.contentEffectCaches = new WeakMap();
  }

  reset() {
    this.contentEffectCaches = new WeakMap();
  }

  #getContentEffectLayerCache(page) {
    const sourceCanvas = page?.displayCanvas;
    let cached = this.contentEffectCaches.get(page);
    if (!cached || cached.srcCanvas !== sourceCanvas) {
      cached = {
        srcCanvas: sourceCanvas,
        variants: new Map(),
      };
      this.contentEffectCaches.set(page, cached);
    }
    return cached.variants;
  }

  getEffectEntry(page) {
    if (!page) return { pipeline: [], key: "" };
    return {
      pipeline: buildPipeline(),
      key: effectKey(),
      gpu: buildGpuEffectConfig(),
      layerCache: this.app.uiState.appMode === "content" ? this.#getContentEffectLayerCache(page) : null,
    };
  }

  shouldExposeSpreadRects() {
    const { viewerBook, uiState } = this.app;
    if (!viewerBook.pages.length) return false;
    if (uiState.appMode === "content") return true;
    return uiState.showLayoutContent;
  }

  shouldShowPlaceholder() {
    const { viewerBook, uiState } = this.app;
    return uiState.appMode === "layout" && !viewerBook.pages.length && uiState.showLayoutContent;
  }

  getRenderableSpreadPages(spreadIndex) {
    const { viewerBook, uiState } = this.app;
    if (uiState.appMode === "layout" && (!uiState.showLayoutContent || !viewerBook.pages.length)) {
      return null;
    }
    const pages = viewerBook.spreadPageEntries(spreadIndex);
    return {
      left: {
        ...pages.left,
        showThroughEffectEntry: pages.left.showThroughPage
          ? this.getEffectEntry(pages.left.showThroughPage)
          : { pipeline: [], key: "" },
      },
      right: {
        ...pages.right,
        showThroughEffectEntry: pages.right.showThroughPage
          ? this.getEffectEntry(pages.right.showThroughPage)
          : { pipeline: [], key: "" },
      },
    };
  }

  createSpreadSnapshot(spreadIndex, scaleOverride = null) {
    const app = this.app;
    const margins = scaleOverride
      ? computeMargins(app.book.layout, scaleOverride)
      : computeMargins(app.book.layout, app.zoomController.getRenderScale());
    const pages = this.getRenderableSpreadPages(spreadIndex);
    const effectEntries = {
      left: pages?.left?.page ? this.getEffectEntry(pages.left.page) : { pipeline: [], key: "" },
      right: pages?.right?.page ? this.getEffectEntry(pages.right.page) : { pipeline: [], key: "" },
    };
    const { canvas: snapshot, sideStates } = app.spreadRenderer.snapshot(
      pages,
      margins,
      effectEntries,
      app.book.display,
      {
        showPlaceholder: this.shouldShowPlaceholder(),
        previewZoom: app.renderZoom,
        showPageBorder: app.uiState.showPageBorder,
      }
    );

    if (app.uiState.appMode === "layout") {
      const overlayCanvas = document.createElement("canvas");
      overlayCanvas.width = snapshot.width;
      overlayCanvas.height = snapshot.height;
      const overlayCtx = overlayCanvas.getContext("2d");
      renderOverlay(overlayCtx, margins, {
        ...app.uiState,
        spreadRects: null,
        spreadSideStates: sideStates,
      }, {
        paperColor: app.book.display.paperColor,
      });
      const composite = document.createElement("canvas");
      composite.width = snapshot.width;
      composite.height = snapshot.height;
      const compositeCtx = composite.getContext("2d");
      compositeCtx.drawImage(snapshot, 0, 0);
      compositeCtx.drawImage(overlayCanvas, 0, 0);
      app.spreadRenderer.rememberSnapshotScene?.(composite, snapshot);
      return composite;
    }

    return snapshot;
  }
}
