import { LazyPageLoader } from "./loading/LazyPageLoader.js";
import { NavigationController } from "./controllers/NavigationController.js";
import { PageStrip } from "./controllers/PageStrip.js";
import { ZoomController } from "./controllers/ZoomController.js";
import { ViewerBook } from "./model/ViewerBook.js";

// Phase 2 of the viewer extraction: the viewer owns a ViewerBook populated
// by a PageSource. App still reaches into BookViewer's properties directly
// (and the controllers still receive an `app` reference) — Phase 3+ narrows
// this further.
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
  }

  get backendName() {
    return this.spreadRenderer.backendName;
  }
}
