import { drawPageBorder, getPageChromeColor } from "./primitives.js";
import { getPaperTextureCanvasSync, loadPaperTextureCanvas } from "./paperTexture.js";
import { SpreadRenderer } from "./SpreadRenderer.js";
import { getPageGeometry } from "./layout.js";

const MAX_SHADOW_OCCLUDERS = 8;
const TURN_EASING_POWER = 3;
const TURN_DURATION_MS = 750;
const DEBUG_LOG_TURN_HINGE = false;
const BASE_PAGE_SURFACE_SCALE = 2;
const MAX_PAGE_SURFACE_EDGE = 8192;

function get2dContext(canvas, options) {
  return canvas.getContext("2d", options);
}

function setHighQualitySampling(ctx) {
  if (!ctx) return ctx;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return ctx;
}

function nextCanvasVersion(currentVersion) {
  return (currentVersion || 0) + 1;
}

function parseHexColor(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return [1, 1, 1, 1];
  }

  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
    1,
  ];
}

function getBlendModeIndex(mode) {
  switch (mode) {
    case "multiply":
      return 1;
    case "screen":
      return 2;
    case "overlay":
      return 3;
    default:
      return 0;
  }
}

function setBackendName(name) {
  globalThis.__rendererBackend = name;
  document.documentElement.dataset.rendererBackend = name;
}

function buildSideStates(margins, pages, hasPlacedPages) {
  const build = (sideName, entry) => {
    const page = entry?.page ?? null;
    const showThroughPage = entry?.showThroughPage ?? null;
    const geometry = getPageGeometry(
      margins,
      sideName,
      page,
      sideName === "left" ? 0 : margins.pagePxW
    );
    const isBlank = hasPlacedPages && !page;

    // Pin source-canvas references at scene-build time. The WebGPU renderer
    // caches scaled page-surface canvases keyed by source-canvas identity;
    // if a freshly-rendered high-res srcCanvas swaps in mid-animation, those
    // caches invalidate and the next animation frame triggers a fresh
    // main-thread paint of a large surface canvas. Pinning here keeps the
    // animation drawing from a stable source until the turn settles.
    return {
      side: sideName,
      page,
      pageIndex: entry?.pageIndex ?? -1,
      showThroughPage,
      showThroughEffectEntry: entry?.showThroughEffectEntry ?? { pipeline: [], key: "" },
      surfaceSource: page?.displayCanvas ?? null,
      translucencySource: page?.previewCanvas ?? page?.thumbnailSourceCanvas ?? null,
      // Show-through composition still happens in the renderer (it needs the
      // back-side placement of the neighboring page). Pin the raw source
      // bitmaps so the helperRenderer can apply its own placement math.
      showThroughSurfaceSource: showThroughPage?.rawPreviewCanvas ?? showThroughPage?.thumbnailSourceCanvas ?? null,
      backFaceSurfaceSource: showThroughPage?.rawDisplayCanvas ?? showThroughPage?.thumbnailSourceCanvas ?? null,
      isBlank,
      ...geometry,
      overlayVisible: !isBlank && geometry.overlayVisible,
      drawnRect: null,
    };
  };

  return {
    left: build("left", pages?.left),
    right: build("right", pages?.right),
  };
}

function measurePageDraw(page, rect, mode, alignX = "center", alignY = "center", sourceCanvas = page?.displayCanvas) {
  if (!sourceCanvas) return null;

  const crop = page.getCropFor(sourceCanvas);
  const sourceWidth = sourceCanvas.width - crop.left - crop.right;
  const sourceHeight = sourceCanvas.height - crop.top - crop.bottom;
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;

  const scale = mode === "fill"
    ? Math.max(rect.w / sourceWidth, rect.h / sourceHeight)
    : mode === "fit-width"
      ? rect.w / sourceWidth
      : mode === "fit-height"
        ? rect.h / sourceHeight
        : Math.min(rect.w / sourceWidth, rect.h / sourceHeight);
  const alignedX = alignX === "start"
    ? rect.x
    : alignX === "end"
      ? rect.x + rect.w - sourceWidth * scale
      : rect.x + (rect.w - sourceWidth * scale) / 2;
  const alignedY = alignY === "start"
    ? rect.y
    : alignY === "end"
      ? rect.y + rect.h - sourceHeight * scale
      : rect.y + (rect.h - sourceHeight * scale) / 2;

  const drawRect = {
    x: Math.round(alignedX - crop.left * scale),
    y: Math.round(alignedY - crop.top * scale),
    w: Math.max(1, Math.round(sourceCanvas.width * scale)),
    h: Math.max(1, Math.round(sourceCanvas.height * scale)),
  };

  const cropX = Math.round(drawRect.x + crop.left * drawRect.w / sourceCanvas.width);
  const cropY = Math.round(drawRect.y + crop.top * drawRect.h / sourceCanvas.height);
  const cropRight = Math.round(drawRect.x + (sourceCanvas.width - crop.right) * drawRect.w / sourceCanvas.width);
  const cropBottom = Math.round(drawRect.y + (sourceCanvas.height - crop.bottom) * drawRect.h / sourceCanvas.height);
  const clipX0 = Math.round(rect.x);
  const clipY0 = Math.round(rect.y);
  const clipX1 = Math.round(rect.x + rect.w);
  const clipY1 = Math.round(rect.y + rect.h);
  const clipRect = mode === "fill"
    ? { x: clipX0, y: clipY0, w: clipX1 - clipX0, h: clipY1 - clipY0 }
    : null;

  return {
    drawRect,
    clipRect,
    visibleRect: {
      x: clipRect ? Math.max(cropX, clipX0) : cropX,
      y: clipRect ? Math.max(cropY, clipY0) : cropY,
      w: Math.max(
        0,
        (clipRect ? Math.min(cropRight, clipX1) : cropRight) -
        (clipRect ? Math.max(cropX, clipX0) : cropX)
      ),
      h: Math.max(
        0,
        (clipRect ? Math.min(cropBottom, clipY1) : cropBottom) -
        (clipRect ? Math.max(cropY, clipY0) : cropY)
      ),
      fitScale: scale,
      sw: sourceCanvas.width,
      sh: sourceCanvas.height,
    },
  };
}

function deriveLayoutFromMargins(margins) {
  const b = Number(margins?.b) || 1;
  return {
    pw: Number(margins?.pw) || 0,
    ph: Number(margins?.ph) || 0,
    ratio: Number(margins?.ratio) || 0,
    b,
    mInner: (Number(margins?.inner) || 0) / b,
    mTop: (Number(margins?.top) || 0) / b,
    mBottom: (Number(margins?.bottom) || 0) / b,
  };
}

function buildSpreadRects(sideStates, margins) {
  return {
    left: sideStates.left.drawnRect
      ? { ...sideStates.left.drawnRect, pageIndex: sideStates.left.pageIndex }
      : null,
    right: sideStates.right.drawnRect
      ? { ...sideStates.right.drawnRect, pageIndex: sideStates.right.pageIndex }
      : null,
    pagePxW: margins.pagePxW,
  };
}

function getPageSurfaceScale(pageRect, measurement, previewZoom = 1) {
  if (!pageRect || !measurement) return BASE_PAGE_SURFACE_SCALE;
  const sourceWidthRatio = measurement.drawRect.w > 0
    ? measurement.visibleRect.sw / measurement.drawRect.w
    : BASE_PAGE_SURFACE_SCALE;
  const sourceHeightRatio = measurement.drawRect.h > 0
    ? measurement.visibleRect.sh / measurement.drawRect.h
    : BASE_PAGE_SURFACE_SCALE;
  const maxSourceScale = Math.max(1, Math.min(sourceWidthRatio, sourceHeightRatio));
  const zoomScale = BASE_PAGE_SURFACE_SCALE * Math.max(1, previewZoom || 1);
  const maxDimension = Math.max(1, Math.round(pageRect.w), Math.round(pageRect.h));
  const maxEdgeScale = MAX_PAGE_SURFACE_EDGE / maxDimension;
  return Math.max(1, Math.min(maxSourceScale, zoomScale, maxEdgeScale));
}

function buildQuadVertices({
  canvasWidth,
  canvasHeight,
  destRect,
  sourceRect,
  sourceWidth,
  sourceHeight,
  z = 0,
}) {
  const x0 = destRect.x;
  const y0 = destRect.y;
  const x1 = destRect.x + destRect.w;
  const y1 = destRect.y + destRect.h;
  const left = sourceRect.x / sourceWidth;
  const right = (sourceRect.x + sourceRect.w) / sourceWidth;
  const top = sourceRect.y / sourceHeight;
  const bottom = (sourceRect.y + sourceRect.h) / sourceHeight;

  return new Float32Array([
    2 * x0 / canvasWidth - 1, 1 - 2 * y0 / canvasHeight, z, 1, left, top,
    2 * x1 / canvasWidth - 1, 1 - 2 * y0 / canvasHeight, z, 1, right, top,
    2 * x0 / canvasWidth - 1, 1 - 2 * y1 / canvasHeight, z, 1, left, bottom,
    2 * x0 / canvasWidth - 1, 1 - 2 * y1 / canvasHeight, z, 1, left, bottom,
    2 * x1 / canvasWidth - 1, 1 - 2 * y0 / canvasHeight, z, 1, right, top,
    2 * x1 / canvasWidth - 1, 1 - 2 * y1 / canvasHeight, z, 1, right, bottom,
  ]);
}

function clipPolygon(points, isInside, intersect) {
  if (!points.length) return points;
  const output = [];
  let prev = points[points.length - 1];

  for (const point of points) {
    const prevInside = isInside(prev);
    const pointInside = isInside(point);

    if (pointInside) {
      if (!prevInside) output.push(intersect(prev, point));
      output.push(point);
    } else if (prevInside) {
      output.push(intersect(prev, point));
    }

    prev = point;
  }

  return output;
}

function clipPolygonToRect(points, rect) {
  const left = rect.x;
  const right = rect.x + rect.w;
  const top = rect.y;
  const bottom = rect.y + rect.h;

  let clipped = clipPolygon(
    points,
    point => point.x >= left,
    (a, b) => {
      const t = (left - a.x) / (b.x - a.x);
      return { x: left, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    }
  );
  clipped = clipPolygon(
    clipped,
    point => point.x <= right,
    (a, b) => {
      const t = (right - a.x) / (b.x - a.x);
      return { x: right, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    }
  );
  clipped = clipPolygon(
    clipped,
    point => point.y >= top,
    (a, b) => {
      const t = (top - a.y) / (b.y - a.y);
      return { x: a.x + (b.x - a.x) * t, y: top, z: a.z + (b.z - a.z) * t };
    }
  );
  clipped = clipPolygon(
    clipped,
    point => point.y <= bottom,
    (a, b) => {
      const t = (bottom - a.y) / (b.y - a.y);
      return { x: a.x + (b.x - a.x) * t, y: bottom, z: a.z + (b.z - a.z) * t };
    }
  );

  return clipped;
}

function buildShadowVertices({ canvasWidth, canvasHeight, points, color, z }) {
  if (points.length < 3) return null;

  const data = [];
  for (let i = 1; i < points.length - 1; i += 1) {
    const triangle = [points[0], points[i], points[i + 1]];
    for (const point of triangle) {
      data.push(
        2 * point.x / canvasWidth - 1,
        1 - 2 * point.y / canvasHeight,
        z,
        1,
        color[0],
        color[1],
        color[2],
        color[3]
      );
    }
  }

  return {
    data: new Float32Array(data),
    vertexCount: data.length / 8,
  };
}

function createPageModelMatrix(pageRect, z, angle = 0, hingeLocalX = 0) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const tx = pageRect.x + hingeLocalX - c * hingeLocalX;
  const ty = pageRect.y;
  const tz = z + s * hingeLocalX;

  return new Float32Array([
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    tx, ty, tz, 1,
  ]);
}

function easeTurnProgress(progress) {
  const t = Math.max(0, Math.min(1, progress));
  return 1 - Math.pow(1 - t, TURN_EASING_POWER);
}

function transformPoint(matrix, x, y, z = 0) {
  return {
    x: matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    y: matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    z: matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  };
}

function getPageWorldCorners(pageRect, modelMatrix) {
  return [
    transformPoint(modelMatrix, 0, 0, 0),
    transformPoint(modelMatrix, pageRect.w, 0, 0),
    transformPoint(modelMatrix, pageRect.w, pageRect.h, 0),
    transformPoint(modelMatrix, 0, pageRect.h, 0),
  ];
}

function projectPointToPlane(point, light, planeZ) {
  const denom = point.z - light.z;
  if (Math.abs(denom) < 1e-6) return null;
  const t = (planeZ - light.z) / denom;
  return {
    x: light.x + (point.x - light.x) * t,
    y: light.y + (point.y - light.y) * t,
    z: planeZ,
  };
}

export class WebGPUSpreadRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.helperRenderer = new SpreadRenderer(document.createElement("canvas"));
    this.backendName = "webgpu-pending";
    this.ready = false;
    this.textureCache = new WeakMap();
    this.pageSurfaceCache = new WeakMap();
    this.backFaceSurfaceCache = new WeakMap();
    this.translucencySurfaceCache = new WeakMap();
    this.showThroughSurfaceCache = new WeakMap();
    this.sceneByCanvas = new WeakMap();
    this.chromeCache = new Map();
    this.pageGeometryCache = new Map();
    this.canvasVersions = new WeakMap();
    this.pageIds = new WeakMap();
    this.nextPageId = 1;
    this.emptyShowThroughCanvas = document.createElement("canvas");
    this.emptyShowThroughCanvas.width = 1;
    this.emptyShowThroughCanvas.height = 1;
    // WebGPU's copyExternalImageToTexture rejects canvases without a
    // rendering context — make sure this empty fallback has one.
    this.emptyShowThroughCanvas.getContext("2d");
    this.paperTextureCanvas = getPaperTextureCanvasSync();
    this.fallbackRenderer = null;
    this.animationFrame = 0;
    this.animations = [];
    this.doneCallbacks = [];
    this.baseScene = null;
    this.lastScene = null;
    this.lastRenderArgs = null;
    this.clearColor = [1, 1, 1, 1];
    this.depthTexture = null;
    this.frameDisposables = [];
    setBackendName(this.backendName);

    if (!("gpu" in navigator)) {
      this.fallbackRenderer = new SpreadRenderer(canvas);
      this.backendName = this.fallbackRenderer.backendName;
      setBackendName(this.backendName);
      console.log(`[renderer] using ${this.backendName} (no navigator.gpu)`);
      return;
    }

    loadPaperTextureCanvas().then(canvas => {
      this.paperTextureCanvas = canvas;
      if (this.lastRenderArgs && !this.isAnimating) {
        this.render(...this.lastRenderArgs);
      }
    });

    this.initPromise = this.#init();
  }

  get isAnimating() {
    return this.fallbackRenderer
      ? this.fallbackRenderer.isAnimating
      : this.animations.length > 0 || this.animationFrame !== 0;
  }

  stopAnimation() {
    if (this.fallbackRenderer) {
      this.fallbackRenderer.stopAnimation();
      return;
    }

    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.animations = [];
    this.doneCallbacks = [];
    this.baseScene = this.lastScene;
    if (this.ready && this.baseScene) this.#drawStaticScene(this.baseScene);
  }

  render(pages, margins, effects, display, options = {}) {
    if (this.fallbackRenderer) {
      return this.fallbackRenderer.render(pages, margins, effects, display, options);
    }

    this.#resizeCanvas(Math.round(2 * margins.pagePxW), Math.round(margins.pagePxH));
    this.lastRenderArgs = [pages, margins, effects, display, options];
    this.clearColor = parseHexColor(display.paperColor);

    const scene = this.#buildScene(pages, margins, effects, display, options);
    this.lastScene = scene;
    if (!this.isAnimating) this.baseScene = scene;

    if (this.ready && !this.isAnimating) {
      this.#drawStaticScene(scene);
    }

    return {
      spreadRects: buildSpreadRects(scene.sideStates, margins),
      sideStates: scene.sideStates,
    };
  }

  snapshot(pages, margins, effects, display, options = {}) {
    if (this.fallbackRenderer) {
      return this.fallbackRenderer.snapshot(pages, margins, effects, display, options);
    }

    // On the WebGPU path, the animation samples scene data (texture refs +
    // geometry) — the returned canvas is only used as a WeakMap key to look
    // the scene back up. So we skip the expensive 2D helper paint entirely
    // and return a tiny sentinel canvas sized to the spread.
    const scene = this.#buildScene(pages, margins, effects, display, options);
    const keyCanvas = new OffscreenCanvas(
      Math.max(1, Math.round(2 * margins.pagePxW)),
      Math.max(1, Math.round(margins.pagePxH)),
    );
    // Ensure a rendering context exists so the sentinel is a valid
    // drawImage source and copyExternalImageToTexture input if anything
    // accidentally treats it as a real surface.
    keyCanvas.getContext("2d");
    this.sceneByCanvas.set(keyCanvas, scene);
    return { canvas: keyCanvas, sideStates: scene.sideStates, spreadRects: null };
  }

  getThumbnail(page, effectEntry, display, options = {}) {
    return this.helperRenderer.getThumbnail(page, effectEntry, display, options);
  }

  getPlacedPagePreview(page, effectEntry, display, options = {}) {
    return this.helperRenderer.getPlacedPagePreview(page, effectEntry, display, options);
  }

  rememberSnapshotScene(targetCanvas, sourceCanvas) {
    if (this.fallbackRenderer) return;
    const scene = this.sceneByCanvas.get(sourceCanvas);
    if (scene) this.sceneByCanvas.set(targetCanvas, scene);
  }

  /**
   * Re-points every active scene's pinned source-canvas refs for the given
   * page (and any side whose show-through neighbour is the given page) to
   * the page's current canvases. Use this when a fresh high-res bitmap
   * lands mid-animation so the in-flight turn picks it up on the next
   * frame instead of waiting for the post-animation redraw.
   *
   * The next #drawPageSurface call for an affected side will see a source
   * mismatch in the page-surface cache and rebuild that side's surface
   * canvas + texture once. Subsequent frames hit the new cache entry.
   */
  refreshPageSource(page) {
    if (this.fallbackRenderer || !page) return;
    const newSurfaceSource = page.displayCanvas ?? null;
    const newTranslucencySource = page.previewCanvas ?? page.thumbnailSourceCanvas ?? null;
    // Show-through composition uses the raw (un-composed) bitmaps so the
    // helperRenderer can apply the opposite-side placement.
    const newRawDisplay = page.rawDisplayCanvas ?? page.thumbnailSourceCanvas ?? null;
    const newRawPreview = page.rawPreviewCanvas ?? page.thumbnailSourceCanvas ?? null;

    const scenes = new Set();
    for (const animation of this.animations) {
      if (animation.fromScene) scenes.add(animation.fromScene);
      if (animation.toScene) scenes.add(animation.toScene);
    }
    if (this.baseScene) scenes.add(this.baseScene);
    if (this.lastScene) scenes.add(this.lastScene);

    for (const scene of scenes) {
      const sideStates = scene?.sideStates;
      if (!sideStates) continue;
      for (const sideName of ["left", "right"]) {
        const sideState = sideStates[sideName];
        if (!sideState) continue;
        if (sideState.page === page) {
          sideState.surfaceSource = newSurfaceSource;
          sideState.translucencySource = newTranslucencySource;
        }
        if (sideState.showThroughPage === page) {
          sideState.showThroughSurfaceSource = newRawPreview;
          sideState.backFaceSurfaceSource = newRawDisplay;
        }
      }
    }
  }

  animateTo(from, to, direction, onDone, options = {}) {
    if (this.fallbackRenderer) {
      this.fallbackRenderer.animateTo(from, to, direction, onDone, options);
      return;
    }

    const fromScene = this.sceneByCanvas.get(from) || this.baseScene || this.lastScene;
    const toScene = this.sceneByCanvas.get(to) || this.lastScene || fromScene;
    if (!this.animations.length) this.baseScene = fromScene;

    this.animations.push({
      direction,
      fromScene,
      toScene,
      start: performance.now(),
      durationMs: options.durationMs ?? TURN_DURATION_MS,
    });
    if (onDone) this.doneCallbacks.push(onDone);

    if (this.ready && !this.animationFrame) {
      this.animationFrame = requestAnimationFrame(now => this.#tick(now));
    }
  }

  async #init() {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error("No WebGPU adapter available");
      this.device = await adapter.requestDevice();
      this.context = this.canvas.getContext("webgpu");
      if (!this.context) throw new Error("Failed to acquire WebGPU canvas context");

      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: "premultiplied",
      });

      this.sampler = this.device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
      });

      this.quadPipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.device.createShaderModule({
            code: `
              struct VertexIn {
                @location(0) position: vec4<f32>,
                @location(1) uv: vec2<f32>,
              };

              struct VertexOut {
                @builtin(position) position: vec4<f32>,
                @location(0) uv: vec2<f32>,
              };

              @vertex
              fn main(input: VertexIn) -> VertexOut {
                var output: VertexOut;
                output.position = input.position;
                output.uv = input.uv;
                return output;
              }
            `,
          }),
          entryPoint: "main",
          buffers: [{
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" },
              { shaderLocation: 1, offset: 16, format: "float32x2" },
            ],
          }],
        },
        fragment: {
          module: this.device.createShaderModule({
            code: `
              @group(0) @binding(0) var texSampler: sampler;
              @group(0) @binding(1) var tex: texture_2d<f32>;

              @fragment
              fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
                return textureSample(tex, texSampler, uv);
              }
            `,
          }),
          entryPoint: "main",
          targets: [{
            format: this.format,
            blend: {
              color: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          }],
        },
        primitive: {
          topology: "triangle-list",
          cullMode: "none",
        },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: false,
          depthCompare: "always",
        },
      });

      const pageVertexModule = this.device.createShaderModule({
        code: `
              struct Uniforms {
                model: mat4x4<f32>,
                light: vec4<f32>,
                canvas: vec4<f32>,
                params: vec4<f32>,
                shadowInfo: vec4<f32>,
                paperColor: vec4<f32>,
                effectA: vec4<f32>,
                effectB: vec4<f32>,
                effectC: vec4<f32>,
                effectD: vec4<f32>,
                lightShadowColor: vec4<f32>,
                lightHighlightColor: vec4<f32>,
                shadowTintColor: vec4<f32>,
                occluders: array<vec4<f32>, 32>,
              };

              @group(0) @binding(0) var texSampler: sampler;
              @group(0) @binding(1) var tex: texture_2d<f32>;
              @group(0) @binding(2) var<uniform> uniforms: Uniforms;

              struct VertexIn {
                @location(0) position: vec3<f32>,
                @location(1) normal: vec3<f32>,
                @location(2) uv: vec2<f32>,
              };

              struct VertexOut {
                @builtin(position) position: vec4<f32>,
                @location(0) worldPos: vec3<f32>,
                @location(1) worldNormal: vec3<f32>,
                @location(2) uv: vec2<f32>,
                @location(3) pageUv: vec2<f32>,
              };

              @vertex
              fn main(input: VertexIn) -> VertexOut {
                var output: VertexOut;
                let world = uniforms.model * vec4<f32>(input.position, 1.0);
                let worldNormal = normalize((uniforms.model * vec4<f32>(input.normal * uniforms.params.z, 0.0)).xyz);
                let nearZ = uniforms.canvas.z;
                let farZ = uniforms.canvas.w;
                let clipZ = clamp((world.z - nearZ) / max(0.0001, farZ - nearZ), 0.0, 1.0);
                let baseUv = input.uv;
                let uv = select(baseUv, vec2<f32>(1.0 - baseUv.x, baseUv.y), uniforms.params.w > 0.5);

                output.position = vec4<f32>(
                  2.0 * world.x / uniforms.canvas.x - 1.0,
                  1.0 - 2.0 * world.y / uniforms.canvas.y,
                  clipZ,
                  1.0
                );
                output.worldPos = world.xyz;
                output.worldNormal = worldNormal;
                output.uv = uv;
                output.pageUv = baseUv;
                return output;
              }
            `,
      });

      const pageFragmentModule = this.device.createShaderModule({
        code: `
              struct Uniforms {
                model: mat4x4<f32>,
                light: vec4<f32>,
                canvas: vec4<f32>,
                params: vec4<f32>,
                shadowInfo: vec4<f32>,
                paperColor: vec4<f32>,
                effectA: vec4<f32>,
                effectB: vec4<f32>,
                effectC: vec4<f32>,
                effectD: vec4<f32>,
                lightShadowColor: vec4<f32>,
                lightHighlightColor: vec4<f32>,
                shadowTintColor: vec4<f32>,
                occluders: array<vec4<f32>, 32>,
              };

              @group(0) @binding(0) var texSampler: sampler;
              @group(0) @binding(1) var tex: texture_2d<f32>;
              @group(0) @binding(2) var<uniform> uniforms: Uniforms;
              @group(0) @binding(3) var showThroughTex: texture_2d<f32>;
              @group(0) @binding(4) var backFaceTex: texture_2d<f32>;
              @group(0) @binding(5) var translucencyTex: texture_2d<f32>;
              @group(0) @binding(6) var paperTex: texture_2d<f32>;

              fn pointInQuad(hit: vec3<f32>, p0: vec3<f32>, p1: vec3<f32>, p3: vec3<f32>) -> bool {
                let uAxis = p1 - p0;
                let vAxis = p3 - p0;
                let rel = hit - p0;
                let uLen2 = max(dot(uAxis, uAxis), 0.000001);
                let vLen2 = max(dot(vAxis, vAxis), 0.000001);
                let u = dot(rel, uAxis) / uLen2;
                let v = dot(rel, vAxis) / vLen2;
                return u >= 0.0 && u <= 1.0 && v >= 0.0 && v <= 1.0;
              }

              fn getOccluderPoint(index: u32, corner: u32) -> vec4<f32> {
                return uniforms.occluders[index * 4u + corner];
              }

              fn getSaturation(rgb: vec3<f32>) -> f32 {
                let maxC = max(max(rgb.x, rgb.y), rgb.z);
                let minC = min(min(rgb.x, rgb.y), rgb.z);
                if (maxC <= 0.00001) {
                  return 0.0;
                }
                return (maxC - minC) / maxC;
              }

              fn getHue(rgb: vec3<f32>) -> f32 {
                let maxC = max(max(rgb.x, rgb.y), rgb.z);
                let minC = min(min(rgb.x, rgb.y), rgb.z);
                let delta = maxC - minC;
                if (delta <= 0.00001) {
                  return 0.0;
                }
                var hue = 0.0;
                if (maxC == rgb.x) {
                  hue = ((rgb.y - rgb.z) / delta);
                } else if (maxC == rgb.y) {
                  hue = ((rgb.z - rgb.x) / delta) + 2.0;
                } else {
                  hue = ((rgb.x - rgb.y) / delta) + 4.0;
                }
                return fract(hue / 6.0);
              }

              fn hueMatches(hue: f32, low: f32, high: f32) -> bool {
                if (low <= high) {
                  return hue >= low && hue <= high;
                }
                return hue >= low || hue <= high;
              }

              fn matchesSelection(rgb: vec3<f32>) -> bool {
                let saturation = getSaturation(rgb);
                if (saturation < uniforms.effectB.x || saturation > uniforms.effectB.y) {
                  return false;
                }
                let hue = getHue(rgb);
                return hueMatches(hue, uniforms.effectB.z, uniforms.effectB.w);
              }

              fn applyNeutralize(rgb: vec3<f32>) -> vec3<f32> {
                if (uniforms.effectA.w < 0.5) {
                  return rgb;
                }
                let neutralize = max(uniforms.effectA.xyz, vec3<f32>(1.0 / 255.0));
                return clamp(rgb / neutralize, vec3<f32>(0.0), vec3<f32>(1.0));
              }

              fn applyBlackAndWhite(rgb: vec3<f32>, selected: bool) -> vec3<f32> {
                if (uniforms.effectC.w < 0.5) {
                  return rgb;
                }
                if (selected) {
                  let gray = dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
                  return vec3<f32>(gray, gray, gray);
                }
                return rgb;
              }

              fn applyLevelsChannel(value: f32, blackPoint: f32, grayPoint: f32, whitePoint: f32) -> f32 {
                let normalized = clamp((value - blackPoint) / max(0.0001, whitePoint - blackPoint), 0.0, 1.0);
                let midpoint = clamp((grayPoint - blackPoint) / max(0.0001, whitePoint - blackPoint), 0.01, 0.99);
                let gamma = log(0.5) / log(midpoint);
                return pow(normalized, gamma);
              }

              fn applyLevels(rgb: vec3<f32>, selected: bool) -> vec3<f32> {
                if (!selected) {
                  return rgb;
                }
                let blackPoint = uniforms.effectC.x;
                let grayPoint = uniforms.effectC.y;
                let whitePoint = uniforms.effectC.z;
                return clamp(vec3<f32>(
                  applyLevelsChannel(rgb.x, blackPoint, grayPoint, whitePoint),
                  applyLevelsChannel(rgb.y, blackPoint, grayPoint, whitePoint),
                  applyLevelsChannel(rgb.z, blackPoint, grayPoint, whitePoint)
                ), vec3<f32>(0.0), vec3<f32>(1.0));
              }

              fn blendOverlay(base: vec3<f32>, blend: vec3<f32>) -> vec3<f32> {
                let low = 2.0 * base * blend;
                let high = 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
                return vec3<f32>(
                  select(low.x, high.x, base.x >= 0.5),
                  select(low.y, high.y, base.y >= 0.5),
                  select(low.z, high.z, base.z >= 0.5)
                );
              }

              fn applyBlendMode(base: vec3<f32>, blend: vec3<f32>) -> vec3<f32> {
                let mode = i32(round(uniforms.effectD.x));
                if (mode == 1) {
                  return base * blend;
                }
                if (mode == 2) {
                  return 1.0 - (1.0 - base) * (1.0 - blend);
                }
                if (mode == 3) {
                  return blendOverlay(base, blend);
                }
                return blend;
              }

              fn unpremultiply(rgb: vec3<f32>, alpha: f32) -> vec3<f32> {
                if (alpha <= 0.00001) {
                  return vec3<f32>(0.0);
                }
                return clamp(rgb / alpha, vec3<f32>(0.0), vec3<f32>(1.0));
              }

              fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
                let lo = c / 12.92;
                let hi = pow(max(c + 0.055, vec3<f32>(0.0)) / 1.055, vec3<f32>(2.4));
                return select(hi, lo, c <= vec3<f32>(0.04045));
              }

              fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
                let clamped = max(c, vec3<f32>(0.0));
                let lo = clamped * 12.92;
                let hi = 1.055 * pow(clamped, vec3<f32>(1.0 / 2.4)) - 0.055;
                return select(hi, lo, clamped <= vec3<f32>(0.0031308));
              }

              fn computeShadow(worldPos: vec3<f32>) -> f32 {
                let lightPos = uniforms.light.xyz;
                let ray = lightPos - worldPos;
                var shadow = 0.0;

                for (var i: u32 = 0u; i < ${MAX_SHADOW_OCCLUDERS}u; i = i + 1u) {
                  if (f32(i) >= uniforms.shadowInfo.x) {
                    continue;
                  }
                  if (abs(f32(i) - uniforms.shadowInfo.y) < 0.5) {
                    continue;
                  }

                  let p0 = getOccluderPoint(i, 0u);
                  let p1 = getOccluderPoint(i, 1u);
                  let p3 = getOccluderPoint(i, 3u);
                  let normal = normalize(cross(p1.xyz - p0.xyz, p3.xyz - p0.xyz));
                  let denom = dot(ray, normal);
                  if (abs(denom) < 0.00001) {
                    continue;
                  }

                  let t = dot(p0.xyz - worldPos, normal) / denom;
                  if (t <= 0.001 || t >= 0.999) {
                    continue;
                  }

                  let hit = worldPos + ray * t;
                  if (pointInQuad(hit, p0.xyz, p1.xyz, p3.xyz)) {
                    shadow = 1.0 - (1.0 - shadow) * (1.0 - p0.w);
                  }
                }

                return shadow;
              }

              struct FragmentIn {
                @location(0) worldPos: vec3<f32>,
                @location(1) worldNormal: vec3<f32>,
                @location(2) uv: vec2<f32>,
                @location(3) pageUv: vec2<f32>,
              };

              @fragment
              fn main(input: FragmentIn) -> @location(0) vec4<f32> {
                let texel = textureSample(tex, texSampler, input.uv);
                let stUV = vec2<f32>(1.0 - input.pageUv.x, input.pageUv.y);
                let showThroughTexel = textureSample(showThroughTex, texSampler, stUV);
                let backFaceTexel = textureSample(backFaceTex, texSampler, stUV);
                let translucencyTexel = textureSample(translucencyTex, texSampler, input.uv);
                let paper = uniforms.paperColor.rgb;
                let normal = normalize(input.worldNormal);
                let frontVisible = normal.z >= 0.0;
                let visibleTexel = select(backFaceTexel, texel, frontVisible);
                let hiddenTexel = select(translucencyTexel, showThroughTexel, frontVisible);
                var content = unpremultiply(visibleTexel.rgb, visibleTexel.a);
                content = applyNeutralize(content);
                let selected = matchesSelection(content);
                content = applyBlackAndWhite(content, selected);
                content = applyLevels(content, selected);
                let turnFactor = clamp(1.0 - abs(normal.z), 0.0, 1.0);
                let composited = mix(paper, applyBlendMode(paper, content), visibleTexel.a);
                var lit = srgbToLinear(composited);
                let hingeOnRight = uniforms.params.y > 0.5;
                let shadingHingeOnRight = select(!hingeOnRight, hingeOnRight, frontVisible);
                let pageHingeDist = select(input.pageUv.x, 1.0 - input.pageUv.x, shadingHingeOnRight);
                let toOuter = select(1.0, -1.0, shadingHingeOnRight);
                let spineZone = 0.45;
                let spineNear = 1.0 - clamp(pageHingeDist / spineZone, 0.0, 1.0);
                let spineSlope = pow(spineNear, 1.7);
                let outerZone = 0.45;
                let outerNear = 1.0 - clamp((1.0 - pageHingeDist) / outerZone, 0.0, 1.0);
                let outerSlope = sin(outerNear * 1.5708) * 0.22;
                let curveTilt = toOuter * (spineSlope - outerSlope);
                let curvedLocal = normalize(vec3<f32>(
                  curveTilt,
                  0.0,
                  sqrt(max(0.0001, 1.0 - curveTilt * curveTilt))
                ));
                let curvedNormal = normalize((uniforms.model * vec4<f32>(curvedLocal * uniforms.params.z, 0.0)).xyz);
                let lightDir = vec3<f32>(0.0, 0.0, 1.0);
                let lightingNormal = curvedNormal * select(-1.0, 1.0, frontVisible);
                let diffuse = max(dot(lightingNormal, lightDir), 0.0);
                let lightTint = mix(
                  srgbToLinear(uniforms.lightShadowColor.rgb),
                  srgbToLinear(uniforms.lightHighlightColor.rgb),
                  diffuse
                );
                let shadow = computeShadow(input.worldPos);
                let shadowTint = mix(
                  vec3<f32>(1.0, 1.0, 1.0),
                  srgbToLinear(uniforms.shadowTintColor.rgb),
                  shadow
                );
                let lightOffset = uniforms.light.xyz - input.worldPos;
                let lightDist = length(lightOffset) / max(1.0, uniforms.canvas.x);
                let attenuation = 1.0 - clamp((lightDist - 1.25) * 0.5, 0.0, 0.42);
                let bounce = 1.0 + pow(clamp(diffuse, 0.0, 1.0), 1.6) * 0.14;
                let coolHighlight = pow(clamp(diffuse, 0.0, 1.0), 2.2) * 0.08;
                let highlightBalance = vec3<f32>(
                  1.0 - coolHighlight * 0.3,
                  1.0 - coolHighlight * 0.12,
                  1.0 + coolHighlight * 0.36
                );
                let paperLin = srgbToLinear(uniforms.paperColor.rgb);
                let yellowness = max(0.0, 0.5 * (paperLin.r + paperLin.g) - paperLin.b);
                let scatterTint = vec3<f32>(
                  paperLin.r,
                  paperLin.g * 0.97,
                  max(0.0, paperLin.b - yellowness * 1.6)
                );
                let scatterCurve = pow(1.0 - clamp(diffuse, 0.0, 1.0), 1.4);
                let paperThickness = clamp(uniforms.shadowInfo.z, 0.0, 1.0);
                let paperTextureStrength = clamp(uniforms.shadowInfo.w, 0.0, 1.0);
                let scatter = scatterTint * (scatterCurve * yellowness);
                var hiddenContent = unpremultiply(hiddenTexel.rgb, hiddenTexel.a);
                hiddenContent = applyNeutralize(hiddenContent);
                let hiddenSelected = matchesSelection(hiddenContent);
                hiddenContent = applyBlackAndWhite(hiddenContent, hiddenSelected);
                hiddenContent = applyLevels(hiddenContent, hiddenSelected);
                let hiddenTransmission = mix(
                  vec3<f32>(1.0, 1.0, 1.0),
                  min(vec3<f32>(1.0, 1.0, 1.0), hiddenContent),
                  hiddenTexel.a
                );
                let hiddenLin = srgbToLinear(hiddenTransmission);
                let transmittance = (1.0 - paperThickness) * (1.0 - paperThickness) * 0.45;
                let paperTexel = textureSample(paperTex, texSampler, input.pageUv).rgb;
                let paperLuma = dot(paperTexel, vec3<f32>(0.2126, 0.7152, 0.0722));
                let paperCentered = clamp((paperLuma - 0.965) * 3.4, -0.1, 0.075);
                let paperChroma = clamp(
                  paperTexel / max(vec3<f32>(paperLuma, paperLuma, paperLuma), vec3<f32>(0.0001, 0.0001, 0.0001)),
                  vec3<f32>(0.97, 0.97, 0.97),
                  vec3<f32>(1.03, 1.03, 1.03)
                );
                let paperMultiply = srgbToLinear(clamp(
                  mix(vec3<f32>(1.0, 1.0, 1.0), paperChroma * (1.0 + paperCentered * 0.8), paperTextureStrength * 0.34),
                  vec3<f32>(0.91, 0.91, 0.91),
                  vec3<f32>(1.05, 1.05, 1.05)
                ));
                let paperLighting = 1.0 + paperCentered * 0.13 * paperTextureStrength;
                let directShaded = lit * lightTint * shadowTint * attenuation * bounce * highlightBalance * paperLighting + scatter;
                let withShowThrough = directShaded * mix(vec3<f32>(1.0, 1.0, 1.0), hiddenLin, transmittance);
                var shadedLinear = withShowThrough;
                if (uniforms.params.x > 0.5) {
                  let outerReach = mix(0.014, 0.022, turnFactor);
                  let outerCrack = 1.0 - smoothstep(0.0, outerReach, pageHingeDist);
                  let outerMask = min(1.0, (0.24 + 0.08 * turnFactor) * pow(outerCrack, 1.2));
                  let outerTintLin = srgbToLinear(vec3<f32>(0.18, 0.13, 0.012));
                  let innerReach = mix(0.0052, 0.0078, turnFactor);
                  let innerCrack = 1.0 - smoothstep(0.0, innerReach, pageHingeDist);
                  let innerMask = min(1.0, (0.52 + 0.1 * turnFactor) * pow(innerCrack, 1.55));
                  let innerTintLin = srgbToLinear(vec3<f32>(0.09, 0.065, 0.01));
                  let coreReach = mix(0.0011, 0.0018, turnFactor);
                  let coreCrack = 1.0 - smoothstep(0.0, coreReach, pageHingeDist);
                  let coreMask = min(1.0, (0.78 + 0.04 * turnFactor) * pow(coreCrack, 1.05));
                  let coreTintLin = srgbToLinear(vec3<f32>(0.028, 0.02, 0.006));
                  shadedLinear = shadedLinear * mix(vec3<f32>(1.0, 1.0, 1.0), outerTintLin, outerMask);
                  shadedLinear = shadedLinear * mix(vec3<f32>(1.0, 1.0, 1.0), innerTintLin, innerMask);
                  shadedLinear = shadedLinear * mix(vec3<f32>(1.0, 1.0, 1.0), coreTintLin, coreMask);
                }
                shadedLinear = shadedLinear * paperMultiply;
                return vec4<f32>(linearToSrgb(shadedLinear), 1.0);
              }
            `,
      });

      const pageVertexState = {
        module: pageVertexModule,
        entryPoint: "main",
        buffers: [{
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
          ],
        }],
      };

      const pageFragmentState = {
        module: pageFragmentModule,
        entryPoint: "main",
        targets: [{
          format: this.format,
          blend: {
            color: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      };

      this.pagePipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: pageVertexState,
        fragment: pageFragmentState,
        primitive: {
          topology: "triangle-list",
          cullMode: "none",
        },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: true,
          depthCompare: "less-equal",
        },
      });

      this.shadowPipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.device.createShaderModule({
            code: `
              struct VertexIn {
                @location(0) position: vec4<f32>,
                @location(1) color: vec4<f32>,
              };

              struct VertexOut {
                @builtin(position) position: vec4<f32>,
                @location(0) color: vec4<f32>,
              };

              @vertex
              fn main(input: VertexIn) -> VertexOut {
                var output: VertexOut;
                output.position = input.position;
                output.color = input.color;
                return output;
              }
            `,
          }),
          entryPoint: "main",
          buffers: [{
            arrayStride: 32,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" },
              { shaderLocation: 1, offset: 16, format: "float32x4" },
            ],
          }],
        },
        fragment: {
          module: this.device.createShaderModule({
            code: `
              @fragment
              fn main(@builtin(position) position: vec4<f32>, @location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
                return vec4<f32>(color.rgb, 1.0);
              }
            `,
          }),
          entryPoint: "main",
          targets: [{
            format: this.format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          }],
        },
        primitive: {
          topology: "triangle-list",
          cullMode: "none",
        },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: false,
          depthCompare: "always",
        },
      });

      this.backendName = "webgpu";
      this.ready = true;
      setBackendName(this.backendName);
      console.log(`[renderer] using ${this.backendName}`);
      this.#ensureDepthTexture();

      if (this.lastScene && !this.isAnimating) {
        this.#drawStaticScene(this.lastScene);
      }
      if (this.animations.length && !this.animationFrame) {
        this.animationFrame = requestAnimationFrame(now => this.#tick(now));
      }
    } catch (error) {
      console.error("Falling back to CPU renderer:", error);
      this.fallbackRenderer = new SpreadRenderer(this.canvas);
      this.backendName = this.fallbackRenderer.backendName;
      setBackendName(this.backendName);
      console.log(`[renderer] using ${this.backendName} (webgpu init failed)`);
      if (this.lastRenderArgs) {
        this.fallbackRenderer.render(...this.lastRenderArgs);
      }
    }
  }

  #resizeCanvas(width, height) {
    const sizeChanged = this.canvas.width !== width || this.canvas.height !== height;
    if (sizeChanged) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    if (this.ready && this.context && sizeChanged) {
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: "premultiplied",
      });
      this.#ensureDepthTexture();
    }
  }

  #ensureDepthTexture() {
    if (!this.ready || !this.canvas.width || !this.canvas.height) return;

    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height, 1],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();
  }

  #buildScene(pages, margins, effects, display, options) {
    const showPlaceholder = !!options.showPlaceholder;
    const previewZoom = Math.max(1, options.previewZoom || 1);
    const showPageBorder = options.showPageBorder !== false;
    const hasPlacedPages = !!pages;
    const sideStates = buildSideStates(margins, pages, hasPlacedPages);

    for (const sideName of ["left", "right"]) {
      const sideState = sideStates[sideName];
      if (!sideState.page) continue;
      // The renderer no longer composes — but it still publishes
      // `drawnRect` so the app's crop-handle UI can convert canvas-space
      // drags back into source-pixel deltas. Measure against the raw
      // source bitmap (not the composed one) so visibleRect's fitScale +
      // sw/sh refer to the original content.
      const measurement = measurePageDraw(
        sideState.page,
        sideState.contentRect,
        sideState.contentMode,
        sideState.contentAlignX,
        sideState.contentAlignY,
        sideState.page.rawDisplayCanvas ?? sideState.surfaceSource
      );
      sideState.drawnRect = measurement?.visibleRect ?? null;
    }

    return {
      pages,
      margins,
      effects,
      display,
      showPlaceholder,
      showPageBorder,
      previewZoom,
      sideStates,
    };
  }

  #drawStaticScene(scene) {
    const light = this.#getLight(scene);
    this.#withFrame((encoder, targetView) => {
      const pass = this.#beginPass(encoder, targetView);
      this.#drawPageSurface(pass, scene, "left", createPageModelMatrix(scene.sideStates.left.pageRect, 0), light);
      this.#drawPageSurface(pass, scene, "right", createPageModelMatrix(scene.sideStates.right.pageRect, 0), light);
      this.#drawChrome(pass, scene);
      pass.end();
    });
  }

  #tick(now) {
    if (!this.ready) return;

    const active = [];
    const completed = [];

    for (const animation of this.animations) {
      const progress = Math.min(1, (now - animation.start) / (animation.durationMs || TURN_DURATION_MS));
      if (progress >= 1) {
        this.baseScene = animation.toScene;
        completed.push(animation);
      } else {
        active.push({ ...animation, progress });
      }
    }

    const currentScene = active.at(-1)?.toScene || this.baseScene || this.lastScene;
    const light = currentScene ? this.#getLight(currentScene) : null;
    const shadowOccluders = this.#buildShadowOccluders(active);

    this.#withFrame((encoder, targetView) => {
      if (!active.length) {
        const pass = this.#beginPass(encoder, targetView);
        if (this.baseScene && light) {
          this.#drawPageSurface(pass, this.baseScene, "left", createPageModelMatrix(this.baseScene.sideStates.left.pageRect, 0), light);
          this.#drawPageSurface(pass, this.baseScene, "right", createPageModelMatrix(this.baseScene.sideStates.right.pageRect, 0), light);
          this.#drawChrome(pass, this.baseScene);
        }
        pass.end();
        return;
      }

      const underlayPass = this.#beginPass(encoder, targetView);
      const underlaySides = this.#getUnderlaySides(active, this.baseScene || currentScene);
      if (underlaySides.left && light) {
        this.#drawPageSurface(underlayPass, underlaySides.left, "left", createPageModelMatrix(underlaySides.left.sideStates.left.pageRect, 0), light, {
          occluders: shadowOccluders,
        });
      }
      if (underlaySides.right && light) {
        this.#drawPageSurface(underlayPass, underlaySides.right, "right", createPageModelMatrix(underlaySides.right.sideStates.right.pageRect, 0), light, {
          occluders: shadowOccluders,
        });
      }
      underlayPass.end();

      const leafPass = this.#beginPass(encoder, targetView, { clearColor: false, clearDepth: true });
      for (const animation of active) {
        this.#drawAnimationFrame(leafPass, animation, light, shadowOccluders);
      }
      if (currentScene) this.#drawChrome(leafPass, currentScene);
      leafPass.end();
    });

    this.animations = active.map(({ progress, ...animation }) => animation);
    if (this.animations.length) {
      this.animationFrame = requestAnimationFrame(nextNow => this.#tick(nextNow));
    } else {
      this.animationFrame = 0;
      if (this.baseScene) this.#drawStaticScene(this.baseScene);
      const callbacks = [...this.doneCallbacks];
      this.doneCallbacks = [];
      for (const callback of callbacks) callback();
    }
  }

  #drawAnimationFrame(pass, animation, light, occluders) {
    if (!light) return;

    const sourceSide = animation.direction > 0 ? "right" : "left";
    const turningScene = animation.fromScene;

    const turningRect = turningScene.sideStates[sourceSide].pageRect;
    const hingeLocalX = sourceSide === "right" ? 0 : turningRect.w;
    const turnProgress = easeTurnProgress(animation.progress);
    const angle = animation.direction > 0 ? turnProgress * Math.PI : -turnProgress * Math.PI;
    const hingeOnRight = animation.direction > 0
      ? turnProgress >= 0.5
      : turnProgress < 0.5;
    if (DEBUG_LOG_TURN_HINGE) {
      console.log("turn-frame", {
        sourceSide,
        hingeOnRight,
        hingeLocalX,
        direction: animation.direction,
        progress: animation.progress,
        turnProgress,
        angle,
      });
    }
    const turningModel = createPageModelMatrix(turningRect, 0, angle, hingeLocalX);
    this.#drawPageSurface(pass, turningScene, sourceSide, turningModel, light, {
      hingeOnRight,
      normalSign: 1,
      flipX: false,
      occluders,
      ignoreOccluderId: animation.__shadowId,
    });
  }

  #getUnderlaySides(active, fallbackScene) {
    const initialScene = active[0]?.fromScene || fallbackScene || null;
    const sides = {
      left: initialScene,
      right: initialScene,
    };

    for (const animation of active) {
      const liftedSide = animation.direction > 0 ? "right" : "left";
      sides[liftedSide] = animation.toScene;
    }

    return sides;
  }

  #buildShadowOccluders(animations) {
    const occluders = [];
    for (const animation of animations) {
      if (occluders.length >= MAX_SHADOW_OCCLUDERS) break;
      const sourceSide = animation.direction > 0 ? "right" : "left";
      const turningRect = animation.fromScene.sideStates[sourceSide]?.pageRect;
      if (!turningRect) continue;

      const hingeLocalX = sourceSide === "right" ? 0 : turningRect.w;
      const turnProgress = easeTurnProgress(animation.progress);
      const angle = animation.direction > 0 ? turnProgress * Math.PI : -turnProgress * Math.PI;
      const turningModel = createPageModelMatrix(turningRect, 0, angle, hingeLocalX);
      const corners = getPageWorldCorners(turningRect, turningModel);
      const flatness = Math.abs(Math.cos(angle));
      const density = 0.05 + 0.3 * flatness * flatness * flatness;
      const id = occluders.length;
      animation.__shadowId = id;
      occluders.push({ corners, density, id });
    }
    return occluders;
  }

  #getLight(scene) {
    return {
      x: 0.35 * scene.margins.pagePxW,
      y: 0.3 * scene.margins.pagePxH,
      z: -1.4 * scene.margins.pagePxW,
    };
  }

  #drawChrome(pass, scene) {
    const chromeCanvas = this.#getChromeCanvas(scene);
    const rect = { x: 0, y: 0, w: chromeCanvas.width, h: chromeCanvas.height };
    this.#drawQuad(pass, chromeCanvas, rect, rect, 0.98);
  }

  #drawPageSurface(
    pass,
    scene,
    side,
    modelMatrix,
    light,
    { hingeOnRight = side === "left", normalSign = 1, flipX = false, occluders = [], ignoreOccluderId = -1 } = {}
  ) {
    if (!scene?.margins.ok) return;

    const sideState = scene.sideStates[side];
    if (!sideState?.page) return;

    const effectEntry = scene.effects[side];
    const pageSurface = this.#getPageSurfaceCanvas(scene, sideState, side);
    if (!pageSurface) return;

    const geometry = this.#getPageGeometry(sideState.pageRect.w, sideState.pageRect.h);
    const textureResource = this.#getTextureResource(pageSurface);
    const showThroughCanvas = this.#getShowThroughSurfaceCanvas(scene, sideState, side);
    const showThroughResource = this.#getTextureResource(showThroughCanvas);
    const backFaceCanvas = this.#getBackFaceSurfaceCanvas(scene, sideState, side);
    const backFaceResource = this.#getTextureResource(backFaceCanvas);
    const translucencyCanvas = this.#getTranslucencySurfaceCanvas(scene, sideState, side);
    const translucencyResource = this.#getTextureResource(translucencyCanvas);
    const paperTextureResource = this.#getTextureResource(this.paperTextureCanvas);
    const gpuEffects = effectEntry?.gpu?.fragment || {
      neutralizeColor: null,
      bwEnabled: false,
      selection: { satLow: 0, satHigh: 100, hueLow: 0, hueHigh: 360 },
      levels: { black: 0, gray: 128, white: 255 },
    };
    const neutralize = parseHexColor(gpuEffects.neutralizeColor || "#ffffff");
    const neutralizeEnabled = gpuEffects.neutralizeColor ? 1 : 0;
    const paperColor = parseHexColor(scene.display.paperColor);
    const lightShadowColor = parseHexColor(scene.display.lightShadowColor || scene.display.paperColor);
    const lightHighlightColor = parseHexColor(scene.display.lightHighlightColor || "#ffffff");
    const shadowTintColor = parseHexColor(scene.display.shadowTintColor || scene.display.paperColor);
    const uniformData = new Float32Array(192);
    uniformData.set(modelMatrix, 0);
    uniformData.set([light.x, light.y, light.z, 1], 16);
    uniformData.set([this.canvas.width, this.canvas.height, -this.canvas.width, this.canvas.width], 20);
    uniformData.set([1, hingeOnRight ? 1 : 0, normalSign, flipX ? 1 : 0], 24);
    const paperThickness = Math.max(0, Math.min(1, scene.display.paperThickness ?? 0.5));
    const paperTextureStrength = Math.max(0, Math.min(1, scene.display.paperTextureStrength ?? 0.2));
    uniformData.set([occluders.length, ignoreOccluderId, paperThickness, paperTextureStrength], 28);
    uniformData.set(paperColor, 32);
    uniformData.set([neutralize[0], neutralize[1], neutralize[2], neutralizeEnabled], 36);
    uniformData.set([
      (gpuEffects.selection?.satLow ?? 0) / 100,
      (gpuEffects.selection?.satHigh ?? 100) / 100,
      ((gpuEffects.selection?.hueLow ?? 0) % 360) / 360,
      ((gpuEffects.selection?.hueHigh ?? 360) === 360 ? 1 : ((gpuEffects.selection?.hueHigh ?? 360) % 360) / 360),
    ], 40);
    uniformData.set([
      (gpuEffects.levels?.black ?? 0) / 255,
      (gpuEffects.levels?.gray ?? 128) / 255,
      (gpuEffects.levels?.white ?? 255) / 255,
      gpuEffects.bwEnabled ? 1 : 0,
    ], 44);
    uniformData.set([getBlendModeIndex(scene.display.contentBlendMode), 0, 0, 0], 48);
    uniformData.set(lightShadowColor, 52);
    uniformData.set(lightHighlightColor, 56);
    uniformData.set(shadowTintColor, 60);
    let offset = 64;
    for (let i = 0; i < MAX_SHADOW_OCCLUDERS; i += 1) {
      const occluder = occluders[i];
      for (let corner = 0; corner < 4; corner += 1) {
        const point = occluder?.corners?.[corner];
        const density = occluder?.density ?? 0;
        uniformData.set(
          point ? [point.x, point.y, point.z, density] : [0, 0, 0, 0],
          offset
        );
        offset += 4;
      }
    }

    const uniformBuffer = this.device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true,
    });
    new Float32Array(uniformBuffer.getMappedRange()).set(uniformData);
    uniformBuffer.unmap();

    const bindGroup = this.device.createBindGroup({
      layout: this.pagePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: textureResource.view },
        { binding: 2, resource: { buffer: uniformBuffer } },
        { binding: 3, resource: showThroughResource.view },
        { binding: 4, resource: backFaceResource.view },
        { binding: 5, resource: translucencyResource.view },
        { binding: 6, resource: paperTextureResource.view },
      ],
    });

    pass.setPipeline(this.pagePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, geometry.vertexBuffer);
    pass.draw(geometry.vertexCount);
    this.frameDisposables.push(uniformBuffer);
  }

  #getPageSurfaceCanvas(scene, sideState, side) {
    return this.#getRenderedPageSurfaceCanvas(scene, sideState, sideState.surfaceSource, this.pageSurfaceCache);
  }

  #getTranslucencySurfaceCanvas(scene, sideState, side) {
    const sourceCanvas = sideState?.translucencySource ?? null;
    if (!sourceCanvas) return this.emptyShowThroughCanvas;
    return this.#getRenderedPageSurfaceCanvas(scene, sideState, sourceCanvas, this.translucencySurfaceCache);
  }

  // Page composition (content placement, crop, fit, align) lives in the
  // app's PageComposer now. The source canvas arrives here already at
  // page-rect proportions, so this is just a passthrough — the WebGPU
  // shader samples the bitmap directly onto the page geometry.
  #getRenderedPageSurfaceCanvas(_scene, sideState, sourceCanvas, _cacheStore) {
    if (!sideState?.page || !sourceCanvas) return null;
    return sourceCanvas;
  }

  #getShowThroughSurfaceCanvas(scene, sideState, side) {
    return this.#getReferencedPageSurfaceCanvas(
      scene,
      sideState,
      side,
      sideState.showThroughSurfaceSource,
      this.showThroughSurfaceCache
    );
  }

  #getBackFaceSurfaceCanvas(scene, sideState, side) {
    return this.#getReferencedPageSurfaceCanvas(
      scene,
      sideState,
      side,
      sideState.backFaceSurfaceSource,
      this.backFaceSurfaceCache
    );
  }

  #getReferencedPageSurfaceCanvas(scene, sideState, side, sourceCanvas, cacheStore) {
    const showThroughPage = sideState.showThroughPage ?? null;
    if (!showThroughPage || !sourceCanvas) return this.emptyShowThroughCanvas;

    const crop = showThroughPage.getCropFor(sourceCanvas);
    const hiddenSide = side === "left" ? "right" : "left";
    const pageHeight = Math.max(1, Math.round(sideState.pageRect.h));
    const effectKey = sideState.showThroughEffectEntry?.key || "";
    const drawKey = [
      hiddenSide,
      pageHeight,
      Math.round(scene.margins.pagePxW),
      Math.round(scene.margins.pagePxH),
      Math.round(scene.margins.innerPx),
      Math.round(scene.margins.outerPx),
      Math.round(scene.margins.topPx),
      Math.round(scene.margins.bottomPx),
      Math.round(scene.margins.twPx),
      Math.round(scene.margins.thPx),
      crop.left,
      crop.top,
      crop.right,
      crop.bottom,
      showThroughPage.cover ? "1" : "0",
      showThroughPage.spread ? "1" : "0",
      showThroughPage.fitAxis || "",
      showThroughPage.contentAlignX || "",
      showThroughPage.contentAlignY || "",
      effectKey,
    ].join("|");

    let pageCache = cacheStore.get(showThroughPage);
    if (!pageCache || pageCache.srcCanvas !== sourceCanvas) {
      pageCache = {
        srcCanvas: sourceCanvas,
        variants: new Map(),
      };
      cacheStore.set(showThroughPage, pageCache);
    }

    const cached = pageCache.variants.get(drawKey);
    if (cached) return cached;

    const surface = this.helperRenderer.getPlacedPagePreview(
      showThroughPage,
      sideState.showThroughEffectEntry,
      scene.display,
      {
        sourceCanvas,
        margins: scene.margins,
        side: hiddenSide,
        pageHeight,
        includePageColor: false,
      }
    );

    this.#markCanvasDirty(surface);
    pageCache.variants.set(drawKey, surface);
    if (pageCache.variants.size > 8) {
      const oldestKey = pageCache.variants.keys().next().value;
      pageCache.variants.delete(oldestKey);
    }
    return surface;
  }

  #getChromeCanvas(scene) {
    const chromeColor = getPageChromeColor(scene.display.paperColor);
    const key = [
      Math.round(scene.margins.pagePxW),
      Math.round(scene.margins.pagePxH),
      scene.display.paperColor,
      scene.display.shadowTintColor || "",
      chromeColor,
      scene.showPlaceholder ? "1" : "0",
      scene.sideStates.left.page ? "p" : "e",
      scene.sideStates.right.page ? "p" : "e",
    ].join("|");
    const cached = this.chromeCache.get(key);
    if (cached) return cached;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(2 * scene.margins.pagePxW);
    canvas.height = Math.round(scene.margins.pagePxH);
    const ctx = get2dContext(canvas);

    drawPageBorder(ctx, scene.margins.pagePxW, {
      showBorder: false,
      paperColor: scene.display.paperColor,
    });
    this.#markCanvasDirty(canvas);
    this.chromeCache.set(key, canvas);
    if (this.chromeCache.size > 16) {
      const oldestKey = this.chromeCache.keys().next().value;
      this.chromeCache.delete(oldestKey);
    }
    return canvas;
  }

  #drawQuad(pass, sourceCanvas, destRect, sourceRect, z) {
    const vertices = buildQuadVertices({
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      destRect,
      sourceRect,
      sourceWidth: sourceCanvas.width,
      sourceHeight: sourceCanvas.height,
      z,
    });

    const vertexBuffer = this.device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
    vertexBuffer.unmap();

    const bindGroup = this.#getQuadBindGroup(sourceCanvas);
    pass.setPipeline(this.quadPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.draw(6);
    this.frameDisposables.push(vertexBuffer);
  }

  #getQuadBindGroup(sourceCanvas) {
    const textureResource = this.#getTextureResource(sourceCanvas);
    if (textureResource.quadBindGroup) return textureResource.quadBindGroup;

    textureResource.quadBindGroup = this.device.createBindGroup({
      layout: this.quadPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: textureResource.view },
      ],
    });

    return textureResource.quadBindGroup;
  }

  #getTextureResource(sourceCanvas) {
    const sourceVersion = this.canvasVersions.get(sourceCanvas) || 0;
    const cached = this.textureCache.get(sourceCanvas);
    if (cached && cached.width === sourceCanvas.width && cached.height === sourceCanvas.height) {
      if (cached.sourceVersion !== sourceVersion) {
        this.#uploadCanvasToTexture(sourceCanvas, cached.texture);
        cached.sourceVersion = sourceVersion;
      }
      return cached;
    }

    if (cached) {
      cached.texture.destroy();
    }

    const texture = this.device.createTexture({
      size: [sourceCanvas.width, sourceCanvas.height, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.#uploadCanvasToTexture(sourceCanvas, texture);

    const resource = {
      texture,
      view: texture.createView(),
      width: sourceCanvas.width,
      height: sourceCanvas.height,
      sourceVersion,
      quadBindGroup: null,
    };
    this.textureCache.set(sourceCanvas, resource);
    return resource;
  }

  #uploadCanvasToTexture(sourceCanvas, texture) {
    this.device.queue.copyExternalImageToTexture(
      { source: sourceCanvas },
      { texture },
      [sourceCanvas.width, sourceCanvas.height]
    );
  }

  #getPageGeometry(pageWidth, pageHeight) {
    const key = `${Math.round(pageWidth)}x${Math.round(pageHeight)}`;
    const cached = this.pageGeometryCache.get(key);
    if (cached) return cached;

    const vertices = new Float32Array([
      0, 0, 0, 0, 0, 1, 0, 0,
      pageWidth, 0, 0, 0, 0, 1, 1, 0,
      0, pageHeight, 0, 0, 0, 1, 0, 1,
      0, pageHeight, 0, 0, 0, 1, 0, 1,
      pageWidth, 0, 0, 0, 0, 1, 1, 0,
      pageWidth, pageHeight, 0, 0, 0, 1, 1, 1,
    ]);

    const vertexBuffer = this.device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
    vertexBuffer.unmap();

    const geometry = {
      vertexBuffer,
      vertexCount: 6,
    };
    this.pageGeometryCache.set(key, geometry);
    return geometry;
  }

  #markCanvasDirty(canvas) {
    this.canvasVersions.set(canvas, nextCanvasVersion(this.canvasVersions.get(canvas)));
  }

  #withFrame(drawFn) {
    this.frameDisposables = [];
    const encoder = this.device.createCommandEncoder();
    const targetView = this.context.getCurrentTexture().createView();
    drawFn(encoder, targetView);
    this.device.queue.submit([encoder.finish()]);
    for (const resource of this.frameDisposables) resource.destroy();
    this.frameDisposables = [];
  }

  #beginPass(encoder, targetView, { clearColor = true, clearDepth = true } = {}) {
    return encoder.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        clearValue: {
          r: this.clearColor[0],
          g: this.clearColor[1],
          b: this.clearColor[2],
          a: this.clearColor[3],
        },
        loadOp: clearColor ? "clear" : "load",
        storeOp: "store",
      }],
      depthStencilAttachment: this.depthView
        ? {
            view: this.depthView,
            depthClearValue: 1,
            depthLoadOp: clearDepth ? "clear" : "load",
            depthStoreOp: "store",
          }
        : undefined,
    });
  }
}
