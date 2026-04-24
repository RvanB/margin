export function makeDefaultPageEffects() {
  return {
    bwThreshold: 0,
    neutralizeColor: null,
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
    aspectRatio = 1,
    crop = null,
    cropInitialized = false,
    tolerance = 128,
    cover = false,
    fitAxis = "inside",
    effects = null,
  } = {}) {
    this.source = source;
    this.srcCanvas = srcCanvas;
    this.loading = false;
    this.aspectRatio = aspectRatio;
    this.crop = crop ? { ...makeDefaultCrop(), ...crop } : makeDefaultCrop();
    this.cropInitialized = cropInitialized;
    this.tolerance = tolerance;
    this.cover = cover;
    this.fitAxis = normalizeFitAxis(fitAxis);
    this.effects = effects ? { ...makeDefaultPageEffects(), ...effects } : makeDefaultPageEffects();
  }
}
