import { CROP_HANDLE_LEN, CROP_HANDLE_PAD, CROP_HANDLE_THICK } from "riffle";

function getCanvasCoords(spreadCanvas, event) {
  const rect = spreadCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (spreadCanvas.width / rect.width),
    y: (event.clientY - rect.top) * (spreadCanvas.height / rect.height),
  };
}

function pointInRect(x, y, rect, pad = 0) {
  return !!rect &&
    x >= rect.x - pad &&
    x <= rect.x + rect.w + pad &&
    y >= rect.y - pad &&
    y <= rect.y + rect.h + pad;
}

function getSpreadHitTarget(spreadRects, x, y, pad = 0) {
  if (!spreadRects) return null;
  if (pointInRect(x, y, spreadRects.left, pad)) return { side: "left", rect: spreadRects.left };
  if (pointInRect(x, y, spreadRects.right, pad)) return { side: "right", rect: spreadRects.right };
  return null;
}

function hitTestHandle(x, y, rect) {
  if (!rect) return null;
  const handles = [
    { edge: "top", hx: rect.x + rect.w / 2, hy: rect.y, dx: CROP_HANDLE_LEN / 2 + CROP_HANDLE_PAD, dy: CROP_HANDLE_THICK / 2 + CROP_HANDLE_PAD },
    { edge: "right", hx: rect.x + rect.w, hy: rect.y + rect.h / 2, dx: CROP_HANDLE_THICK / 2 + CROP_HANDLE_PAD, dy: CROP_HANDLE_LEN / 2 + CROP_HANDLE_PAD },
    { edge: "bottom", hx: rect.x + rect.w / 2, hy: rect.y + rect.h, dx: CROP_HANDLE_LEN / 2 + CROP_HANDLE_PAD, dy: CROP_HANDLE_THICK / 2 + CROP_HANDLE_PAD },
    { edge: "left", hx: rect.x, hy: rect.y + rect.h / 2, dx: CROP_HANDLE_THICK / 2 + CROP_HANDLE_PAD, dy: CROP_HANDLE_LEN / 2 + CROP_HANDLE_PAD },
  ];
  return handles.find(handle => Math.abs(x - handle.hx) <= handle.dx && Math.abs(y - handle.hy) <= handle.dy) || null;
}

function getHandleHitTarget(spreadRects, x, y) {
  if (!spreadRects) return null;
  const matches = [];
  for (const side of ["left", "right"]) {
    const rect = spreadRects[side];
    const handle = hitTestHandle(x, y, rect);
    if (!handle) continue;
    const dx = x - handle.hx;
    const dy = y - handle.hy;
    matches.push({ side, rect, handle, distanceSq: dx * dx + dy * dy });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => a.distanceSq - b.distanceSq);
  return matches[0];
}

function cursorForEdge(edge) {
  return edge === "left" || edge === "right" ? "ew-resize" : "ns-resize";
}

export class CanvasInteraction {
  constructor(app) {
    this.app = app;
    this.dragHandle = null;
    this.panOrigin = null;
    this.isPanning = false;
    this.pendingCanvasClick = null;
  }

  bindListeners() {
    const { spreadCanvas } = this.app;
    spreadCanvas.addEventListener("mousedown", event => this.#onMouseDown(event));
    spreadCanvas.addEventListener("mousemove", event => this.#onMouseMove(event));
    spreadCanvas.addEventListener("mouseup", () => this.#onMouseUp());
    spreadCanvas.addEventListener("mouseleave", () => this.#onMouseLeave());
  }

  setCursor(cursor = "default") {
    const { spreadCanvas, canvasWrap } = this.app;
    const applied = cursor === "default" ? "" : cursor;
    document.documentElement.style.setProperty("cursor", applied, "important");
    document.body.style.setProperty("cursor", applied, "important");
    spreadCanvas.style.cursor = cursor;
    canvasWrap.style.cursor = cursor;
  }

  refreshDragCursor() {
    this.setCursor(this.dragHandle ? cursorForEdge(this.dragHandle.edge) : "default");
  }

  handleKeyDown(event) {
    const app = this.app;
    if (app.busyIndicator.isExporting) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (app.modalManager.isOpen()) return;
    if (event.target.matches("input, select, textarea")) return;
    const key = typeof event.key === "string" ? event.key.toLowerCase() : event.key;
    const base = app.navigationController.getEffectiveSpread();
    const max = app.viewerBook.numSpreads() - 1;

    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      if (key === "+" || key === "=") {
        event.preventDefault();
        event.stopPropagation();
        app.zoomController.adjustContentZoom(1);
        return;
      }
      if (key === "-" || key === "_") {
        event.preventDefault();
        event.stopPropagation();
        app.zoomController.adjustContentZoom(-1);
        return;
      }
      if (key === "0") {
        event.preventDefault();
        event.stopPropagation();
        app.zoomController.resetContentZoom();
        return;
      }
    }

    if (key === "arrowleft" && base > 0) app.navigationController.navigateTo(base - 1);
    if (key === "arrowright" && base < max) app.navigationController.navigateTo(base + 1);

    if ((event.metaKey || event.ctrlKey) && key === "a" && app.book.pages.length) {
      event.preventDefault();
      event.stopPropagation();
      app.uiState.selectedPageIdxs = new Set(app.book.pages.map((_, index) => index));
      if (app.uiState.appMode === "layout") app.switchMode("content");
      else {
        app.toolbarController.syncPageUI();
        app.redraw();
      }
      return;
    }

    if (!event.metaKey && !event.ctrlKey && !event.altKey && app.uiState.appMode === "layout") {
      const toggleId = key === "m"
        ? "show-margin-arrows"
        : key === "c"
          ? "show-layout-content"
          : key === "v"
            ? "vdg"
            : null;
      if (toggleId) {
        event.preventDefault();
        document.getElementById(toggleId)?.click();
      }
    }
  }

  #onMouseDown(event) {
    const app = this.app;
    if (app.busyIndicator.isExporting) return;
    if (app.spreadRenderer.isAnimating) return;
    app.placedPreviewManager.endInteractive({ redraw: false });
    const { x, y } = getCanvasCoords(app.spreadCanvas, event);

    this.panOrigin = {
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: app.canvasArea.scrollLeft,
      scrollTop: app.canvasArea.scrollTop,
    };
    this.isPanning = false;
    this.pendingCanvasClick = null;

    if (app.uiState.appMode === "layout") {
      const hit = getSpreadHitTarget(app.getInteractionSpreadRects(), x, y);
      if (hit?.rect?.pageIndex >= 0) {
        this.pendingCanvasClick = { type: "layout-to-content", pageIndex: hit.rect.pageIndex };
      }
      return;
    }

    if (app.uiState.appMode !== "content") return;

    const handleHit = getHandleHitTarget(app.getInteractionSpreadRects(), x, y);
    const spreadHit = handleHit ?? getSpreadHitTarget(app.getInteractionSpreadRects(), x, y);
    if (!spreadHit?.rect) {
      this.pendingCanvasClick = { type: "content-to-layout" };
      return;
    }

    const pageIndex = spreadHit.rect.pageIndex;
    if (app.uiState.editingPageIdx !== pageIndex || app.uiState.selectedPageIdxs.size > 1) {
      app.placedPreviewManager.flushDirty();
      app.uiState.editingPageIdx = pageIndex;
      app.uiState.selectedPageIdxs = new Set([pageIndex]);
      app.toolbarController.syncPageUI();
      app.redraw();
    }

    const handle = handleHit?.handle ?? hitTestHandle(x, y, spreadHit.rect);
    if (handle) {
      const page = app.book.pages[pageIndex];
      this.dragHandle = {
        edge: handle.edge,
        startX: x,
        startY: y,
        startCrop: page.getCropFor(page.displayCanvas),
        side: spreadHit.side,
      };
      this.setCursor(cursorForEdge(handle.edge));
      event.preventDefault();
    }
  }

  #onMouseMove(event) {
    const app = this.app;
    if (app.busyIndicator.isExporting) return;
    if (this.panOrigin && !this.dragHandle) {
      const dx = event.clientX - this.panOrigin.clientX;
      const dy = event.clientY - this.panOrigin.clientY;
      if (!this.isPanning && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        this.isPanning = true;
        this.pendingCanvasClick = null;
        this.setCursor("grabbing");
      }
      if (this.isPanning) {
        app.canvasArea.scrollLeft = this.panOrigin.scrollLeft - dx;
        app.canvasArea.scrollTop = this.panOrigin.scrollTop - dy;
        return;
      }
    }

    if (app.spreadRenderer.isAnimating || app.uiState.appMode !== "content") return;
    const { x, y } = getCanvasCoords(app.spreadCanvas, event);

    if (this.dragHandle) {
      const sideRect = app.getInteractionSpreadRects()?.[this.dragHandle.side];
      if (!sideRect) return;
      const page = app.book.pages[sideRect.pageIndex];
      if (!page) return;
      const dx = x - this.dragHandle.startX;
      const dy = y - this.dragHandle.startY;
      const crop = { ...this.dragHandle.startCrop };
      if (this.dragHandle.edge === "top") {
        crop.top = Math.max(0, Math.min(sideRect.sh - crop.bottom - 1, Math.round(this.dragHandle.startCrop.top + dy / sideRect.fitScale)));
      } else if (this.dragHandle.edge === "bottom") {
        crop.bottom = Math.max(0, Math.min(sideRect.sh - crop.top - 1, Math.round(this.dragHandle.startCrop.bottom - dy / sideRect.fitScale)));
      } else if (this.dragHandle.edge === "left") {
        crop.left = Math.max(0, Math.min(sideRect.sw - crop.right - 1, Math.round(this.dragHandle.startCrop.left + dx / sideRect.fitScale)));
      } else {
        crop.right = Math.max(0, Math.min(sideRect.sw - crop.left - 1, Math.round(this.dragHandle.startCrop.right - dx / sideRect.fitScale)));
      }
      page.setCropFor(page.displayCanvas, crop);
      app.redraw();
      return;
    }

    const handleHit = getHandleHitTarget(app.getInteractionSpreadRects(), x, y);
    const nextHover = handleHit
      ? { side: handleHit.side, edge: handleHit.handle.edge }
      : null;
    const prevHover = app.uiState.hoverHandle;
    if (nextHover?.side !== prevHover?.side || nextHover?.edge !== prevHover?.edge) {
      app.uiState.hoverHandle = nextHover;
      this.setCursor(nextHover ? cursorForEdge(nextHover.edge) : "default");
      app.redraw();
    }
  }

  #onMouseUp() {
    const app = this.app;
    if (app.busyIndicator.isExporting) return;
    const wasPanning = this.isPanning;
    this.isPanning = false;
    this.panOrigin = null;

    if (this.dragHandle) {
      const sideRect = app.getInteractionSpreadRects()?.[this.dragHandle.side];
      if (sideRect?.pageIndex >= 0) app.placedPreviewManager.refresh(sideRect.pageIndex);
      this.dragHandle = null;
      if (!app.uiState.hoverHandle) this.setCursor("default");
      return;
    }

    if (!wasPanning) {
      const pending = this.pendingCanvasClick;
      this.pendingCanvasClick = null;
      if (pending?.type === "layout-to-content") {
        app.uiState.editingPageIdx = pending.pageIndex;
        app.uiState.selectedPageIdxs = new Set([pending.pageIndex]);
        app.switchMode("content");
      } else if (pending?.type === "content-to-layout") {
        app.placedPreviewManager.flushDirty();
        app.switchMode("layout");
      }
    }

    this.pendingCanvasClick = null;
    if (!app.uiState.hoverHandle) this.setCursor("default");
  }

  #onMouseLeave() {
    const app = this.app;
    if (app.busyIndicator.isExporting) return;
    if (!this.isPanning) {
      this.panOrigin = null;
      this.pendingCanvasClick = null;
    }
    this.dragHandle = null;
    if (app.uiState.hoverHandle) {
      app.uiState.hoverHandle = null;
      this.setCursor("default");
      app.redraw();
    }
  }
}
