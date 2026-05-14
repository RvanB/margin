import { PageSource } from "./PageSource.js";

// Callback-driven source for callers (like the margin app) that maintain
// their own page model and want to feed the viewer with bitmaps they've
// composed externally.
//
// Pass an options object with `getPageCount` and `getPageMetadata`. The
// metadata return value is opaque to the viewer beyond `{ aspectRatio,
// passthrough }`; the `passthrough` field becomes `viewerPage.metadata` for
// the renderer to read app-specific placement fields (crop, fitAxis, etc.)
// while Phase 3 is still pending.
//
// `getPagePreview` and `getPageHighRes` are optional for now — when the
// margin app's LazyPageLoader still drives bitmap loading directly into the
// passthrough page, the source isn't asked to materialize bitmaps. They
// become required once Phase 3 makes the viewer pull bitmaps through the
// source.
export class ImagePageSource extends PageSource {
  constructor({
    getPageCount,
    getPageMetadata,
    getPagePreview = null,
    getPageHighRes = null,
  }) {
    super();
    this._getPageCount = getPageCount;
    this._getPageMetadata = getPageMetadata;
    this._getPagePreview = getPagePreview;
    this._getPageHighRes = getPageHighRes;
  }

  getPageCount() { return this._getPageCount(); }
  getPageMetadata(index) { return this._getPageMetadata(index); }
  async getPagePreview(index) {
    return this._getPagePreview ? this._getPagePreview(index) : null;
  }
  async getPageHighRes(index, targetEdgePx) {
    return this._getPageHighRes ? this._getPageHighRes(index, targetEdgePx) : null;
  }
}
