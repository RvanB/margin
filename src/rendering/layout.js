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

export function computeScale(layout, containerW, containerH) {
  return Math.min((containerW - 64) / (2 * layout.pw), (containerH - 64) / layout.ph);
}
