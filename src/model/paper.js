const PAPER_PRESETS = [
  {
    id: "bright-white",
    label: "Bright White",
    paperColor: "#ffffff",
    scatterColor: "#f2e7c8",
  },
  {
    id: "natural",
    label: "Natural",
    paperColor: "#f7f5ef",
    scatterColor: "#edd7a1",
  },
  {
    id: "ivory",
    label: "Ivory",
    paperColor: "#f4efe2",
    scatterColor: "#e4c470",
  },
];

export const DEFAULT_PAPER_PRESET_ID = "natural";

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function hexToRgb(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return [1, 1, 1];
  }

  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

function rgbToHex(rgb) {
  return `#${rgb
    .map(channel => Math.round(clamp01(channel) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixRgb(a, b, t) {
  const weight = clamp01(t);
  return [
    a[0] + (b[0] - a[0]) * weight,
    a[1] + (b[1] - a[1]) * weight,
    a[2] + (b[2] - a[2]) * weight,
  ];
}

function lighten(rgb, amount) {
  return mixRgb(rgb, [1, 1, 1], amount);
}

function darken(rgb, amount) {
  return mixRgb(rgb, [0, 0, 0], amount);
}

function buildPaperAppearance(preset) {
  if (preset.id === "bright-white") {
    return {
      paperColor: preset.paperColor,
      lightShadowColor: "#ebebeb",
      lightHighlightColor: "#ffffff",
      shadowTintColor: "#f2f2f2",
    };
  }

  const paperRgb = hexToRgb(preset.paperColor);
  const scatterRgb = mixRgb(paperRgb, hexToRgb(preset.scatterColor), 0.68);
  const lightShadowRgb = darken(mixRgb(paperRgb, scatterRgb, 0.45), 0.08);
  const lightHighlightRgb = lighten(mixRgb(paperRgb, [1, 0.985, 0.94], 0.38), 0.03);
  const shadowTintRgb = darken(mixRgb(scatterRgb, [0.97, 0.84, 0.46], 0.5), 0.14);

  return {
    paperColor: preset.paperColor,
    lightShadowColor: rgbToHex(lightShadowRgb),
    lightHighlightColor: rgbToHex(lightHighlightRgb),
    shadowTintColor: rgbToHex(shadowTintRgb),
  };
}

export function getPaperPresetOptions() {
  return PAPER_PRESETS.map(({ id, label }) => ({ id, label }));
}

export function normalizePaperPreset(presetId) {
  return PAPER_PRESETS.some(preset => preset.id === presetId)
    ? presetId
    : DEFAULT_PAPER_PRESET_ID;
}

export function getPaperPresetIdForColor(paperColor) {
  const normalized = typeof paperColor === "string" ? paperColor.toLowerCase() : "";
  return PAPER_PRESETS.find(preset => preset.paperColor.toLowerCase() === normalized)?.id || DEFAULT_PAPER_PRESET_ID;
}

export function applyPaperPreset(display, presetId) {
  const normalizedPresetId = normalizePaperPreset(presetId);
  const preset = PAPER_PRESETS.find(entry => entry.id === normalizedPresetId);
  Object.assign(display, {
    paperPreset: normalizedPresetId,
    ...buildPaperAppearance(preset),
  });
  return display;
}
