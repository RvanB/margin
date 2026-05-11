export function computeLayoutValues(layout) {
  const pw = Number(layout.pw) || 0;
  const ph = Number(layout.ph) || 0;
  const ratio = Number(layout.ratio) || 0;
  const b = Number(layout.b) || 0;
  const inner = (Number(layout.mInner) || 0) * b;
  const top = (Number(layout.mTop) || 0) * b;
  const bottom = (Number(layout.mBottom) || 0) * b;
  const th = ph - ((Number(layout.mTop) || 0) + (Number(layout.mBottom) || 0)) * b;
  const tw = ratio * th;
  const outer = pw - inner - tw;

  return {
    pw,
    ph,
    ratio,
    b,
    inner,
    top,
    bottom,
    th,
    tw,
    outer,
    ok: outer > 0 && th > 0 && tw > 0,
  };
}

export function computeMargins(layout, scale) {
  const values = computeLayoutValues(layout);
  return {
    ...values,
    scale,
    pagePxW: values.pw * scale,
    pagePxH: values.ph * scale,
    innerPx: values.inner * scale,
    outerPx: values.outer * scale,
    topPx: values.top * scale,
    bottomPx: values.bottom * scale,
    twPx: values.tw * scale,
    thPx: values.th * scale,
  };
}

export function getPageGeometry(margins, sideName, page, pageRectX = 0) {
  const isLeft = sideName === "left";
  const fitMode = page?.fitAxis === "width" || page?.fitAxis === "height" || page?.fitAxis === "inside"
    ? page.fitAxis
    : "inside";
  const pageRect = {
    x: pageRectX,
    y: 0,
    w: margins.pagePxW,
    h: margins.pagePxH,
  };
  const textblockRect = {
    x: isLeft ? pageRect.x + margins.outerPx : pageRect.x + margins.innerPx,
    y: margins.topPx,
    w: margins.twPx,
    h: margins.thPx,
  };
  const isCover = !!page?.cover;
  const isSpread = !!page?.spread && !isCover;
  const effectiveAlignX = page?.contentAlignX
    || (isSpread ? (isLeft ? "right" : "left") : "center");
  const effectiveAlignY = page?.contentAlignY || "center";
  const overlayRect = isSpread
    ? {
        x: isLeft ? textblockRect.x : pageRect.x,
        y: textblockRect.y,
        w: isLeft
          ? pageRect.x + pageRect.w - textblockRect.x
          : textblockRect.x + textblockRect.w - pageRect.x,
        h: textblockRect.h,
      }
    : textblockRect;

  return {
    isCover,
    isSpread,
    pageRect,
    textblockRect,
    overlayRect,
    contentRect: isCover ? pageRect : overlayRect,
    contentAlignX: effectiveAlignX === "left" ? "start" : effectiveAlignX === "right" ? "end" : "center",
    contentAlignY: effectiveAlignY === "top" ? "start" : effectiveAlignY === "bottom" ? "end" : "center",
    contentMode: isCover
      ? "fill"
      : fitMode === "width"
        ? "fit-width"
        : fitMode === "height"
          ? "fit-height"
          : "fit",
    clipContent: isCover,
    overlayVisible: !isCover,
  };
}

export function computeScale(layout, containerW, containerH) {
  return Math.min((containerW - 64) / (2 * layout.pw), (containerH - 64) / layout.ph);
}

export function computeContentScale(layout, containerW, containerH) {
  return Math.min((containerW - 64) / layout.pw, (containerH - 64) / layout.ph);
}
