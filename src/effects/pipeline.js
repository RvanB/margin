import {
  getSelectionGate,
  neutralizeEffect,
  normalizeHexColor,
  normalizeLevels,
  selectionEffects,
} from "./cpu.js";

const LAYER_CACHE_LIMIT = 24;

export function effectKey(effects = {}) {
  const neutralizeColor = normalizeHexColor(effects.neutralizeColor);
  const levels = normalizeLevels(
    effects.levelsBlack,
    effects.levelsGray,
    effects.levelsWhite
  );
  const selection = getSelectionGate(effects, effects.bwThreshold);
  const bwEnabled = typeof effects.bwEnabled === "boolean"
    ? effects.bwEnabled
    : Math.max(0, Math.min(100, Math.round(effects.bwThreshold || 0))) > 0;

  return [
    `neutralize:${neutralizeColor || "none"}`,
    `selection:${selection.satLow},${selection.satHigh},${selection.hueLow},${selection.hueHigh}`,
    `bw:${bwEnabled ? 1 : 0}`,
    `levels:${levels.black},${levels.gray},${levels.white}`,
  ].join("|");
}

export function buildPipeline(effects = {}) {
  const selection = getSelectionGate(effects, effects.bwThreshold);
  const bwEnabled = typeof effects.bwEnabled === "boolean"
    ? effects.bwEnabled
    : Math.max(0, Math.min(100, Math.round(effects.bwThreshold || 0))) > 0;
  return [
    neutralizeEffect(effects.neutralizeColor),
    selectionEffects(selection, {
      bwEnabled,
      black: effects.levelsBlack,
      gray: effects.levelsGray,
      white: effects.levelsWhite,
    }),
  ].filter(Boolean);
}

export function buildPipelineStages(effects = {}) {
  const neutralizeColor = normalizeHexColor(effects.neutralizeColor);
  const levels = normalizeLevels(
    effects.levelsBlack,
    effects.levelsGray,
    effects.levelsWhite
  );
  const selection = getSelectionGate(effects, effects.bwThreshold);
  const bwEnabled = typeof effects.bwEnabled === "boolean"
    ? effects.bwEnabled
    : Math.max(0, Math.min(100, Math.round(effects.bwThreshold || 0))) > 0;

  return [
    {
      key: `neutralize:${neutralizeColor || "none"}`,
      effect: neutralizeEffect(effects.neutralizeColor),
    },
    {
      key: `selection:${selection.satLow},${selection.satHigh},${selection.hueLow},${selection.hueHigh}|bw:${bwEnabled ? 1 : 0}|levels:${levels.black},${levels.gray},${levels.white}`,
      effect: selectionEffects(selection, {
        bwEnabled,
        black: effects.levelsBlack,
        gray: effects.levelsGray,
        white: effects.levelsWhite,
      }),
    },
  ].filter(stage => stage.effect);
}

export function buildGpuEffectConfig(effects = {}) {
  const neutralizeColor = normalizeHexColor(effects.neutralizeColor);
  const levels = normalizeLevels(
    effects.levelsBlack,
    effects.levelsGray,
    effects.levelsWhite
  );
  const selection = getSelectionGate(effects, effects.bwThreshold);
  const bwEnabled = typeof effects.bwEnabled === "boolean"
    ? effects.bwEnabled
    : Math.max(0, Math.min(100, Math.round(effects.bwThreshold || 0))) > 0;

  return {
    key: effectKey(effects),
    computeStages: [],
    fragment: {
      neutralizeColor,
      bwEnabled,
      selection,
      levels,
    },
  };
}

function setCachedLayer(cache, key, canvas) {
  cache.set(key, canvas);
  if (cache.size > LAYER_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

export function applyEffectsToCanvas(canvas, effects = {}, layerCache = null, cacheKeyPrefix = "") {
  let out = canvas;
  let stageKey = cacheKeyPrefix;
  for (const stage of buildPipelineStages(effects)) {
    stageKey = stageKey ? `${stageKey}|${stage.key}` : stage.key;
    const cached = layerCache?.get(stageKey);
    if (cached) {
      out = cached;
      continue;
    }
    out = stage.effect(out);
    if (layerCache) setCachedLayer(layerCache, stageKey, out);
  }
  return out;
}
