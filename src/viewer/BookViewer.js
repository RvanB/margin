import { LazyPageLoader } from "./loading/LazyPageLoader.js";
import { NavigationController } from "./controllers/NavigationController.js";
import { PageStrip } from "./controllers/PageStrip.js";
import { ZoomController } from "./controllers/ZoomController.js";
import { ViewerBook } from "./model/ViewerBook.js";

// Phase 4 of the viewer extraction: BookViewer is the renderer-facing
// entrypoint. Callers route render calls through it; it owns the latest
// spread geometry and broadcasts a "geometrychange" event so app-side
// overlay layers can react without reading renderer internals.
export class BookViewer {
  constructor({ spreadCanvas, stripContainer, rendererClass, app, source, pageStripCallbacks }) {
    this.app = app;
    this.source = source;
    this.book = new ViewerBook(source);
    this.spreadRenderer = new rendererClass(spreadCanvas);
    // The lazy loader still writes bitmap refs onto the app-side Page (which
    // is the `metadata.passthrough` for each ViewerPage). ViewerPage's
    // getters expose those bitmaps to the renderer without copying. Phase 3
    // separates them.
    this.lazyPageLoader = new LazyPageLoader(
      app.book,
      pageIndex => app.onPageReady(pageIndex),
    );
    this.pageStrip = new PageStrip(stripContainer, pageStripCallbacks);
    this.navigationController = new NavigationController(app);
    this.zoomController = new ZoomController(app);
    this.listeners = new Map();
    this.latestGeometry = null;
  }

  get backendName() {
    return this.spreadRenderer.backendName;
  }

  render(pages, margins, effects, display, options = {}) {
    const result = this.spreadRenderer.render(pages, margins, effects, display, options);
    this.latestGeometry = {
      spreadRects: result?.spreadRects ?? null,
      sideStates: result?.sideStates ?? null,
      margins,
    };
    this.#emit("geometrychange", this.latestGeometry);
    return result;
  }

  getSpreadGeometry() {
    return this.latestGeometry;
  }

  on(event, fn) {
    let arr = this.listeners.get(event);
    if (!arr) {
      arr = [];
      this.listeners.set(event, arr);
    }
    arr.push(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  }

  #emit(event, ...args) {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const fn of arr.slice()) fn(...args);
  }
}
