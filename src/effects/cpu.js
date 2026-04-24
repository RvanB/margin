function get2dContext(canvas, options) {
  return canvas.getContext("2d", options);
}

function cloneCanvas(canvas) {
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  get2dContext(out, { willReadFrequently: true }).drawImage(canvas, 0, 0);
  return out;
}

export function normalizeHexColor(hex) {
  return typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : null;
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

export function normalizeLevels(blackPoint, grayPoint, whitePoint) {
  const black = Math.max(0, Math.min(254, Math.round(Number.isFinite(blackPoint) ? blackPoint : 0)));
  const white = Math.max(1, Math.min(255, Math.round(Number.isFinite(whitePoint) ? whitePoint : 255)));
  const safeBlack = Math.min(black, 254);
  const safeWhite = Math.min(255, Math.max(safeBlack + 1, white));
  let gray = Number.isFinite(grayPoint) ? grayPoint : 128;

  if (gray >= 0.1 && gray <= 4) {
    const midRatio = Math.pow(0.5, 1 / Math.max(0.1, gray));
    gray = safeBlack + midRatio * (safeWhite - safeBlack);
  }

  gray = Math.round(gray);
  gray = Math.max(safeBlack + 1, Math.min(safeWhite - 1, gray));

  if (black < white) return { black, gray, white };
  return {
    black: Math.max(0, safeWhite - 1),
    gray,
    white: safeWhite,
  };
}

function applyLevelsChannel(value, blackPoint, grayPoint, whitePoint) {
  const normalized = Math.max(0, Math.min(1, (value - blackPoint) / (whitePoint - blackPoint)));
  const midpoint = Math.max(0.01, Math.min(0.99, (grayPoint - blackPoint) / (whitePoint - blackPoint)));
  const gamma = Math.log(0.5) / Math.log(midpoint);
  return Math.round(Math.pow(normalized, gamma) * 255);
}

function getSaturation(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

export function bwEffect(threshold) {
  const safeThreshold = Math.max(0, Math.min(100, Math.round(Number.isFinite(threshold) ? threshold : 0)));
  if (safeThreshold <= 0) return null;

  return canvas => {
    const out = cloneCanvas(canvas);
    const outCtx = get2dContext(out, { willReadFrequently: true });
    const imageData = outCtx.getImageData(0, 0, out.width, out.height);
    const { data } = imageData;
    const saturationThreshold = safeThreshold / 100;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const saturation = getSaturation(r, g, b);

      if (saturation <= saturationThreshold) {
        const gray = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
        data[i] = gray;
        data[i + 1] = gray;
        data[i + 2] = gray;
      }
    }

    outCtx.putImageData(imageData, 0, 0);
    return out;
  };
}

export function levelsEffect(blackPoint, grayPoint, whitePoint, threshold = 100) {
  const levels = normalizeLevels(blackPoint, grayPoint, whitePoint);
  const safeThreshold = Math.max(0, Math.min(100, Math.round(Number.isFinite(threshold) ? threshold : 100)));
  if (levels.black === 0 && levels.gray === 128 && levels.white === 255) return null;
  const saturationThreshold = safeThreshold / 100;

  return canvas => {
    const out = cloneCanvas(canvas);
    const outCtx = get2dContext(out, { willReadFrequently: true });
    const imageData = outCtx.getImageData(0, 0, out.width, out.height);
    const { data } = imageData;

    for (let i = 0; i < data.length; i += 4) {
      const saturation = getSaturation(data[i], data[i + 1], data[i + 2]);
      if (saturation > saturationThreshold) continue;
      data[i] = applyLevelsChannel(data[i], levels.black, levels.gray, levels.white);
      data[i + 1] = applyLevelsChannel(data[i + 1], levels.black, levels.gray, levels.white);
      data[i + 2] = applyLevelsChannel(data[i + 2], levels.black, levels.gray, levels.white);
    }

    outCtx.putImageData(imageData, 0, 0);
    return out;
  };
}

export function neutralizeEffect(hexColor) {
  const neutralizeRgb = hexToRgb(hexColor);
  if (
    !neutralizeRgb ||
    (neutralizeRgb.r === 255 && neutralizeRgb.g === 255 && neutralizeRgb.b === 255)
  ) {
    return null;
  }

  return canvas => {
    const out = cloneCanvas(canvas);
    const outCtx = get2dContext(out, { willReadFrequently: true });
    const imageData = outCtx.getImageData(0, 0, out.width, out.height);
    const { data } = imageData;

    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.min(255, Math.round(data[i] * 255 / Math.max(1, neutralizeRgb.r)));
      data[i + 1] = Math.min(255, Math.round(data[i + 1] * 255 / Math.max(1, neutralizeRgb.g)));
      data[i + 2] = Math.min(255, Math.round(data[i + 2] * 255 / Math.max(1, neutralizeRgb.b)));
    }

    outCtx.putImageData(imageData, 0, 0);
    return out;
  };
}

export function autoCrop(srcCanvas, tolerance = 128) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const data = get2dContext(srcCanvas, { willReadFrequently: true }).getImageData(0, 0, w, h).data;

  function isBackground(i) {
    return ((255 - data[i]) + (255 - data[i + 1]) + (255 - data[i + 2])) / 3 <= tolerance;
  }

  function rowHasContent(row) {
    const base = row * w * 4;
    for (let x = 0; x < w; x += 1) {
      if (!isBackground(base + x * 4)) return true;
    }
    return false;
  }

  function colHasContent(col) {
    for (let y = 0; y < h; y += 1) {
      if (!isBackground((y * w + col) * 4)) return true;
    }
    return false;
  }

  let top = 0;
  let bottom = h;
  let left = 0;
  let right = w;
  while (top < h && !rowHasContent(top)) top += 1;
  while (bottom > top && !rowHasContent(bottom - 1)) bottom -= 1;
  while (left < w && !colHasContent(left)) left += 1;
  while (right > left && !colHasContent(right - 1)) right -= 1;

  const pad = 8;
  return {
    top: Math.max(0, top - pad),
    bottom: Math.max(0, h - Math.min(h, bottom + pad)),
    left: Math.max(0, left - pad),
    right: Math.max(0, w - Math.min(w, right + pad)),
  };
}
