export function makeDefaultPageEffects() {
  return {
    bwThreshold: 0,
    bwEnabled: false,
    neutralizeColor: null,
    selectionSatLow: 0,
    selectionSatHigh: 100,
    selectionHueLow: 0,
    selectionHueHigh: 360,
    levelsBlack: 0,
    levelsGray: 128,
    levelsWhite: 255,
  };
}

function makeDefaultCrop() {
  return { top: 0, left: 0, right: 0, bottom: 0 };
}

export function normalizeFitAxis(value) {
  return value === "width" || value === "height" || value === "inside"
    ? value
    : "inside";
}

export class Page {
  constructor({
    source = null,
    srcCanvas = null,
    previewCanvas = null,
    placedPreviewCanvas = null,
    thumbnailSourceCanvas = null,
    aspectRatio = 1,
    crop = null,
    cropSourceWidth = 0,
    cropSourceHeight = 0,
    cropInitialized = false,
    tolerance = 128,
    cover = false,
    fitAxis = "inside",
    effects = null,
  } = {}) {
    this.source = source;
    this.srcCanvas = srcCanvas;
    this.previewCanvas = previewCanvas;
    this.placedPreviewCanvas = placedPreviewCanvas;
    this.thumbnailSourceCanvas = thumbnailSourceCanvas;
    this.loading = false;
    this.aspectRatio = aspectRatio;
    this.crop = crop ? { ...makeDefaultCrop(), ...crop } : makeDefaultCrop();
    this.cropSourceWidth = cropSourceWidth;
    this.cropSourceHeight = cropSourceHeight;
    this.cropInitialized = cropInitialized;
    this.tolerance = tolerance;
    this.cover = cover;
    this.fitAxis = normalizeFitAxis(fitAxis);
    this.effects = effects ? { ...makeDefaultPageEffects(), ...effects } : makeDefaultPageEffects();
  }

  get displayCanvas() {
    return this.srcCanvas || this.previewCanvas || null;
  }

  get thumbnailCanvas() {
    return this.placedPreviewCanvas || this.thumbnailSourceCanvas || this.previewCanvas || this.srcCanvas || null;
  }

  getCropFor(sourceCanvas) {
    const base = { ...makeDefaultCrop(), ...this.crop };
    if (!sourceCanvas) return base;
    const basisWidth = this.cropSourceWidth || sourceCanvas.width;
    const basisHeight = this.cropSourceHeight || sourceCanvas.height;
    if (!basisWidth || !basisHeight) return base;
    if (basisWidth === sourceCanvas.width && basisHeight === sourceCanvas.height) return base;
    const scaleX = sourceCanvas.width / basisWidth;
    const scaleY = sourceCanvas.height / basisHeight;
    return {
      top: Math.round(base.top * scaleY),
      left: Math.round(base.left * scaleX),
      right: Math.round(base.right * scaleX),
      bottom: Math.round(base.bottom * scaleY),
    };
  }

  setCropFor(sourceCanvas, crop) {
    this.crop = { ...makeDefaultCrop(), ...crop };
    this.cropSourceWidth = sourceCanvas?.width || 0;
    this.cropSourceHeight = sourceCanvas?.height || 0;
  }
}
