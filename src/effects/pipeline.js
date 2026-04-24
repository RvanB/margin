import {
  bwEffect,
  levelsEffect,
  neutralizeEffect,
  normalizeHexColor,
  normalizeLevels,
} from "./cpu.js";

export function effectKey(effects = {}) {
  const threshold = Math.max(0, Math.min(100, Math.round(effects.bwThreshold || 0)));
  const neutralizeColor = normalizeHexColor(effects.neutralizeColor);
  const levels = normalizeLevels(
    effects.levelsBlack,
    effects.levelsGray,
    effects.levelsWhite
  );

  return `neutralize:${neutralizeColor || "none"}|levels:${levels.black},${levels.gray},${levels.white}|bw:${threshold}`;
}

export function buildPipeline(effects = {}) {
  return [
    neutralizeEffect(effects.neutralizeColor),
    levelsEffect(effects.levelsBlack, effects.levelsGray, effects.levelsWhite),
    bwEffect(effects.bwThreshold),
  ].filter(Boolean);
}
