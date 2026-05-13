import { cloneSet } from "../util/helpers.js";

const BASE_TURN_DURATION_MS = 750;
const BASE_MULTI_SPREAD_TURN_INTERVAL_MS = 40;
const MAX_QUEUE_DURATION_MS = 2000;

export class NavigationController {
  constructor(app) {
    this.app = app;
    this.queuedSpreadTurnTimer = 0;
    this.queuedSpreadTurnToken = 0;
    this.pendingTurnStartToken = 0;
    this.animationDirection = 0;
    this.animationCompletionScheduled = false;
  }

  getEffectiveSpread() {
    const app = this.app;
    return app.spreadRenderer.isAnimating ? app.uiState.effectiveSpread : app.uiState.currentSpread;
  }

  resetAnimationState() {
    this.animationCompletionScheduled = false;
    this.animationDirection = 0;
  }

  #kickoffHighResForSpread(spreadIndex) {
    const app = this.app;
    if (spreadIndex < 0 || spreadIndex >= app.book.numSpreads()) return;
    const { left, right } = app.book.spreadPageEntries(spreadIndex);
    for (const pageIndex of [left.pageIndex, right.pageIndex]) {
      if (pageIndex < 0) continue;
      if (app.lazyPageLoader.isPageHighResReady(pageIndex, app.contentZoom)) continue;
      app.lazyPageLoader.ensurePageHighRes(pageIndex, app.contentZoom);
    }
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
    // Kick off high-res loading for the FINAL destination spread now,
    // while the queued turns animate through intermediate low-res spreads.
    // By the time the user arrives, high-res is already in flight or
    // resolved.
    this.#kickoffHighResForSpread(clampedTarget);

    // Cap total queued-turn time at MAX_QUEUE_DURATION_MS. For long jumps
    // we compress both per-turn duration and the inter-turn delay
    // proportionally so the visual cadence stays consistent.
    const nominalTotal = BASE_TURN_DURATION_MS + (distance - 1) * BASE_MULTI_SPREAD_TURN_INTERVAL_MS;
    const scale = Math.min(1, MAX_QUEUE_DURATION_MS / nominalTotal);
    const stepDurationMs = BASE_TURN_DURATION_MS * scale;
    const stepIntervalMs = BASE_MULTI_SPREAD_TURN_INTERVAL_MS * scale;

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
        selectPage: isFinalStep,
        durationMs: stepDurationMs,
      });
      if (!isFinalStep) {
        this.queuedSpreadTurnTimer = setTimeout(advance, stepIntervalMs);
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

    app.placedPreviewManager.endInteractive({ redraw: false });
    app.lazyPageLoader.ensureSpreadLoaded(clampedTarget, 1, { allowHighRes: false });
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

      // Defer LRU evictions while the animation runs — the renderer holds
      // pinned bitmap refs in its scenes that mustn't be closed mid-flight.
      app.lazyPageLoader.setEvictionsDeferred(true);

      const onDone = this.animationCompletionScheduled
        ? null
        : () => {
            this.animationCompletionScheduled = false;
            this.animationDirection = 0;
            app.uiState.currentSpread = app.uiState.effectiveSpread;
            app.overlayCanvas.style.visibility = "";
            // Pages whose bitmaps arrived during the animation had their
            // placed-preview rebuilds deferred — flush them now that the
            // turn has settled.
            app.placedPreviewManager.flushDirty();
            app.redraw();
            // Old scenes/textures are no longer referenced after the redraw
            // builds a fresh scene — safe to evict over-capacity LRU entries.
            app.lazyPageLoader.flushEvictions();
            app.schedulePreviewRedraw();
          };

      this.animationCompletionScheduled = true;
      app.spreadRenderer.animateTo(fromCanvas, toCanvas, direction, onDone, {
        durationMs: options.durationMs,
      });
      app.schedulePreviewRedraw();
      app.pageStrip.update(app.book, {
        ...app.uiState,
        selectedPageIdxs: cloneSet(app.uiState.selectedPageIdxs),
        effectiveSpread: app.uiState.effectiveSpread,
      });
    };

    // High-res preloading: for single-step nav, kick off the destination
    // spread (both pages) now so it's ready on arrival. For queued jumps,
    // the queue starter already kicked off the final destination — skip
    // intermediates so they stay low-res.
    if (!options.fromQueuedJump) {
      this.#kickoffHighResForSpread(clampedTarget);
    }

    startTurn();
  }
}
