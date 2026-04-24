import {
  bwEffect,
  levelsEffect,
  neutralizeEffect,
  normalizeHexColor,
  normalizeLevels,
} from "./cpu.js";

const LAYER_CACHE_LIMIT = 24;

export function effectKey(effects = {}) {
  const threshold = Math.max(0, Math.min(100, Math.round(effects.bwThreshold || 0)));
  const neutralizeColor = normalizeHexColor(effects.neutralizeColor);
  const levels = normalizeLevels(
    effects.levelsBlack,
    effects.levelsGray,
    effects.levelsWhite
  );

  return `neutralize:${neutralizeColor || "none"}|bw:${threshold}|levels:${levels.black},${levels.gray},${levels.white}`;
}

export function buildPipeline(effects = {}) {
  return [
    neutralizeEffect(effects.neutralizeColor),
    bwEffect(effects.bwThreshold),
    levelsEffect(effects.levelsBlack, effects.levelsGray, effects.levelsWhite, effects.bwThreshold),
  ].filter(Boolean);
}

export function buildPipelineStages(effects = {}) {
  const threshold = Math.max(0, Math.min(100, Math.round(effects.bwThreshold || 0)));
  const neutralizeColor = normalizeHexColor(effects.neutralizeColor);
  const levels = normalizeLevels(
    effects.levelsBlack,
    effects.levelsGray,
    effects.levelsWhite
  );

  return [
    {
      key: `neutralize:${neutralizeColor || "none"}`,
      effect: neutralizeEffect(effects.neutralizeColor),
    },
    {
      key: `bw:${threshold}`,
      effect: bwEffect(effects.bwThreshold),
    },
    {
      key: `levels:${levels.black},${levels.gray},${levels.white}|sat:${threshold}`,
      effect: levelsEffect(effects.levelsBlack, effects.levelsGray, effects.levelsWhite, effects.bwThreshold),
    },
  ].filter(stage => stage.effect);
}

export function buildGpuEffectConfig(effects = {}) {
  const threshold = Math.max(0, Math.min(100, Math.round(effects.bwThreshold || 0)));
  const neutralizeColor = normalizeHexColor(effects.neutralizeColor);
  const levels = normalizeLevels(
    effects.levelsBlack,
    effects.levelsGray,
    effects.levelsWhite
  );

  return {
    key: effectKey(effects),
    computeStages: [],
    fragment: {
      neutralizeColor,
      bwThreshold: threshold / 100,
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
