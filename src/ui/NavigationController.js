import { cloneSet } from "../util/helpers.js";

const MULTI_SPREAD_TURN_INTERVAL_MS = 40;

export class NavigationController {
  constructor(app) {
    this.app = app;
    this.queuedSpreadTurnTimer = 0;
    this.queuedSpreadTurnToken = 0;
    this.pendingTurnStartToken = 0;
    this.activeAnimationKeepSpreadIndexes = [];
    this.pendingSettledKeepSpreadIndexes = [];
    this.animationDirection = 0;
    this.animationCompletionScheduled = false;
  }

  getEffectiveSpread() {
    const app = this.app;
    return app.spreadRenderer.isAnimating ? app.uiState.effectiveSpread : app.uiState.currentSpread;
  }

  getLoaderKeepSpreadIndexes(targetSpread = this.getEffectiveSpread()) {
    const app = this.app;
    const keep = new Set([
      ...this.pendingSettledKeepSpreadIndexes,
      ...this.activeAnimationKeepSpreadIndexes,
    ]);
    if (targetSpread >= 0) keep.add(targetSpread);
    if (app.uiState.currentSpread >= 0) keep.add(app.uiState.currentSpread);
    if (app.spreadRenderer.isAnimating && app.uiState.effectiveSpread >= 0) {
      keep.add(app.uiState.effectiveSpread);
    }
    return [...keep];
  }

  resetAnimationState() {
    this.animationCompletionScheduled = false;
    this.animationDirection = 0;
  }

  clearSettledKeepSpreadIndexes() {
    this.pendingSettledKeepSpreadIndexes = [];
  }

  cancelQueuedSpreadTurns() {
    this.queuedSpreadTurnToken += 1;
    if (this.queuedSpreadTurnTimer) {
      clearTimeout(this.queuedSpreadTurnTimer);
      this.queuedSpreadTurnTimer = 0;
    }
  }

  queueSpreadTurnsTo(targetSpread, preferredPageIndex = null) {
    const app = this.app;
    const clampedTarget = Math.max(0, Math.min(targetSpread, app.book.numSpreads() - 1));
    const fromSpread = this.getEffectiveSpread();
    const distance = Math.abs(clampedTarget - fromSpread);
    if (distance <= 1 || !app.lastMargins || !app.book.pages.length) {
      this.navigateTo(clampedTarget, preferredPageIndex);
      return;
    }

    const direction = clampedTarget > fromSpread ? 1 : -1;
    if (app.spreadRenderer.isAnimating && this.animationDirection && direction !== this.animationDirection) return;

    this.cancelQueuedSpreadTurns();
    const token = this.queuedSpreadTurnToken;
    const queuedKeepSpreadIndexes = [];
    const pathStart = Math.min(fromSpread, clampedTarget);
    const pathEnd = Math.max(fromSpread, clampedTarget);
    for (let spread = pathStart; spread <= pathEnd; spread += 1) {
      queuedKeepSpreadIndexes.push(spread);
    }
    const advance = () => {
      if (token !== this.queuedSpreadTurnToken) return;
      const currentSpread = this.getEffectiveSpread();
      if (currentSpread === clampedTarget) {
        this.queuedSpreadTurnTimer = 0;
        return;
      }
      const nextSpread = currentSpread + direction;
      const isFinalStep = nextSpread === clampedTarget;
      this.navigateTo(nextSpread, isFinalStep ? preferredPageIndex : null, {
        fromQueuedJump: true,
        isFinalQueuedStep: isFinalStep,
        queuedKeepSpreadIndexes,
        selectPage: isFinalStep,
      });
      if (!isFinalStep) {
        this.queuedSpreadTurnTimer = setTimeout(advance, MULTI_SPREAD_TURN_INTERVAL_MS);
      } else {
        this.queuedSpreadTurnTimer = 0;
      }
    };

    advance();
  }

  selectSpreadPage(spreadIndex, preferredPageIndex = null) {
    const app = this.app;
    if (app.uiState.appMode !== "content" || !app.book.pages.length) return;
    const { left, right } = app.book.spreadPageEntries(spreadIndex);
    const spreadPageIndexes = [left.pageIndex, right.pageIndex].filter(index => index >= 0);
    const pageIndex = spreadPageIndexes.includes(preferredPageIndex)
      ? preferredPageIndex
      : (left.pageIndex >= 0 ? left.pageIndex : right.pageIndex);
    if (pageIndex < 0 || pageIndex >= app.book.pages.length) return;
    app.placedPreviewManager.endInteractive({ redraw: false });
    app.placedPreviewManager.flushDirty();
    app.uiState.editingPageIdx = pageIndex;
    app.uiState.selectedPageIdxs = new Set([pageIndex]);
    app.toolbarController.syncPageUI();
  }

  navigateTo(targetSpread, preferredPageIndex = null, options = {}) {
    const app = this.app;
    const clampedTarget = Math.max(0, Math.min(targetSpread, app.book.numSpreads() - 1));
    if (clampedTarget === this.getEffectiveSpread()) return;
    if (!options.fromQueuedJump) this.cancelQueuedSpreadTurns();
    const fromSpread = this.getEffectiveSpread();
    const direction = clampedTarget > fromSpread ? 1 : -1;
    const targetPages = app.book.spreadPageEntries(clampedTarget);
    const destinationTurningPageIndex = direction > 0
      ? targetPages.left.pageIndex
      : targetPages.right.pageIndex;
    const queuedKeepSpreadIndexes = Array.isArray(options.queuedKeepSpreadIndexes)
      ? options.queuedKeepSpreadIndexes
      : [];
    const extraKeepSpreadIndexes = [
      ...(fromSpread >= 0 ? [fromSpread] : []),
      ...queuedKeepSpreadIndexes,
    ];
    this.activeAnimationKeepSpreadIndexes = [...new Set(extraKeepSpreadIndexes)];

    app.placedPreviewManager.endInteractive({ redraw: false });
    app.lazyPageLoader.ensureSpreadLoaded(clampedTarget, 1, {
      allowHighRes: false,
      extraKeepSpreadIndexes,
    });
    if (options.selectPage !== false) this.selectSpreadPage(clampedTarget, preferredPageIndex);

    if (!app.lastMargins || !app.book.pages.length) {
      app.uiState.currentSpread = clampedTarget;
      app.uiState.effectiveSpread = clampedTarget;
      this.animationDirection = 0;
      app.spreadRenderer.stopAnimation();
      this.animationCompletionScheduled = false;
      app.overlayCanvas.style.visibility = "";
      app.redraw();
      return;
    }

    if (app.spreadRenderer.isAnimating && this.animationDirection && direction !== this.animationDirection) return;
    const turnStartToken = ++this.pendingTurnStartToken;
    const startTurn = () => {
      if (this.pendingTurnStartToken !== turnStartToken) return;

      app.uiState.effectiveSpread = clampedTarget;
      this.animationDirection = direction;
      const fromCanvas = app.spreadComposer.createSpreadSnapshot(fromSpread);
      const toCanvas = app.spreadComposer.createSpreadSnapshot(clampedTarget);
      app.overlayCanvas.style.visibility = "hidden";

      const onDone = this.animationCompletionScheduled
        ? null
        : () => {
            this.animationCompletionScheduled = false;
            this.animationDirection = 0;
            app.uiState.currentSpread = app.uiState.effectiveSpread;
            this.activeAnimationKeepSpreadIndexes = [];
            this.pendingSettledKeepSpreadIndexes = [...extraKeepSpreadIndexes];
            app.overlayCanvas.style.visibility = "";
            app.redraw();
            app.schedulePreviewRedraw();
          };

      this.animationCompletionScheduled = true;
      app.spreadRenderer.animateTo(fromCanvas, toCanvas, direction, onDone);
      app.schedulePreviewRedraw();
      app.pageStrip.update(app.book, {
        ...app.uiState,
        selectedPageIdxs: cloneSet(app.uiState.selectedPageIdxs),
        effectiveSpread: app.uiState.effectiveSpread,
      }, app.spreadRenderer);
    };

    if (
      destinationTurningPageIndex >= 0
      && !app.lazyPageLoader.isPageHighResReady(destinationTurningPageIndex, app.contentZoom)
    ) {
      app.lazyPageLoader.ensurePageHighRes(destinationTurningPageIndex, app.contentZoom);
    }

    startTurn();
  }
}
