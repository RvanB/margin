import { LazyPageLoader } from "./loading/LazyPageLoader.js";
import { NavigationController } from "./controllers/NavigationController.js";
import { PageStrip } from "./controllers/PageStrip.js";
import { ZoomController } from "./controllers/ZoomController.js";

// Phase 1 of the viewer extraction: a thin wrapper that bundles construction
// of the viewer-side pieces. App still reaches into BookViewer's properties
// directly (and the controllers still receive an `app` reference) — Phase 2
// narrows this to a proper PageSource-driven API.
export class BookViewer {
  constructor({ spreadCanvas, stripContainer, rendererClass, app, pageStripCallbacks }) {
    this.app = app;
    this.spreadRenderer = new rendererClass(spreadCanvas);
    this.lazyPageLoader = new LazyPageLoader(
      app.book,
      pageIndex => app.onPageReady(pageIndex),
    );
    this.pageStrip = new PageStrip(stripContainer, pageStripCallbacks);
    this.navigationController = new NavigationController(app);
    this.zoomController = new ZoomController(app);
  }

  get backendName() {
    return this.spreadRenderer.backendName;
  }
}
