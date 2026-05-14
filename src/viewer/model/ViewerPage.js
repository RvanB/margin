const DEFAULT_CROP = { top: 0, left: 0, right: 0, bottom: 0 };

// A page as seen by the viewer. In Phase 2 the bitmap and placement fields
// are passthroughs to `metadata` (which the source populates — for the margin
// app this is the corresponding app-side Page instance). Phase 3 will narrow
// this to bitmaps-only by moving content placement into an app-side composer.
export class ViewerPage {
  constructor({ aspectRatio = 1, metadata = null } = {}) {
    this.aspectRatio = aspectRatio;
    this.metadata = metadata;
  }

  get srcCanvas() { return this.metadata?.srcCanvas ?? null; }
  get previewCanvas() { return this.metadata?.previewCanvas ?? null; }
  get thumbnailSourceCanvas() { return this.metadata?.thumbnailSourceCanvas ?? null; }
  get placedPreviewCanvas() { return this.metadata?.placedPreviewCanvas ?? null; }
  get displayCanvasOverride() { return this.metadata?.displayCanvasOverride ?? null; }
  get displayCanvas() { return this.metadata?.displayCanvas ?? null; }
  get thumbnailCanvas() { return this.metadata?.thumbnailCanvas ?? null; }
  get contentAlignX() { return this.metadata?.contentAlignX ?? null; }
  get contentAlignY() { return this.metadata?.contentAlignY ?? null; }
  get cover() { return this.metadata?.cover ?? false; }
  get spread() { return this.metadata?.spread ?? false; }
  get fitAxis() { return this.metadata?.fitAxis ?? "inside"; }
  get crop() { return this.metadata?.crop ?? null; }

  getCropFor(sourceCanvas) {
    return this.metadata?.getCropFor?.(sourceCanvas) ?? { ...DEFAULT_CROP };
  }
}
