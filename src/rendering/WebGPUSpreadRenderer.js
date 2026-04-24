import { fillLorem } from "./text.js";
import { drawPageBorder } from "./primitives.js";
import { SpreadRenderer } from "./SpreadRenderer.js";

const MAX_SHADOW_OCCLUDERS = 8;

function get2dContext(canvas, options) {
  return canvas.getContext("2d", options);
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

function setBackendName(name) {
  globalThis.__rendererBackend = name;
  document.documentElement.dataset.rendererBackend = name;
}

function buildSideStates(margins, pages, hasPlacedPages) {
  const build = (sideName, entry) => {
    const isLeft = sideName === "left";
    const page = entry?.page ?? null;
    const fitMode = page?.fitAxis === "width" || page?.fitAxis === "height" || page?.fitAxis === "inside"
      ? page.fitAxis
      : "inside";
    const pageRect = {
      x: isLeft ? 0 : margins.pagePxW,
      y: 0,
      w: margins.pagePxW,
      h: margins.pagePxH,
    };
    const textblockRect = {
      x: isLeft ? margins.outerPx : margins.pagePxW + margins.innerPx,
      y: margins.topPx,
      w: margins.twPx,
      h: margins.thPx,
    };
    const isBlank = hasPlacedPages && !page;
    const isCover = !!page?.cover;

    return {
      side: sideName,
      page,
      pageIndex: entry?.pageIndex ?? -1,
      isBlank,
      isCover,
      overlayVisible: !isBlank && !isCover,
      pageRect,
      textblockRect,
      contentRect: isCover ? pageRect : textblockRect,
      contentMode: isCover
        ? "fill"
        : fitMode === "width"
          ? "fit-width"
          : fitMode === "height"
            ? "fit-height"
            : "fit",
      clipContent: isCover,
      drawnRect: null,
    };
  };

  return {
    left: build("left", pages?.left),
    right: build("right", pages?.right),
  };
}

function measurePageDraw(page, rect, mode) {
  const sourceCanvas = page?.srcCanvas;
  if (!sourceCanvas) return null;

  const { crop } = page;
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

  const drawRect = {
    x: Math.round(rect.x + (rect.w - sourceWidth * scale) / 2 - crop.left * scale),
    y: Math.round(rect.y + (rect.h - sourceHeight * scale) / 2 - crop.top * scale),
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
    this.effectCache = new WeakMap();
    this.pageSurfaceCache = new WeakMap();
    this.sceneByCanvas = new WeakMap();
    this.chromeCache = new Map();
    this.pageGeometryCache = new Map();
    this.fallbackRenderer = null;
    this.animationFrame = 0;
    this.animations = [];
    this.baseScene = null;
    this.lastScene = null;
    this.lastRenderArgs = null;
    this.clearColor = [1, 1, 1, 1];
    this.depthTexture = null;
    setBackendName(this.backendName);

    if (!("gpu" in navigator)) {
      this.fallbackRenderer = new SpreadRenderer(canvas);
      this.backendName = this.fallbackRenderer.backendName;
      setBackendName(this.backendName);
      return;
    }

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

    const scene = this.#buildScene(pages, margins, effects, display, options);
    const result = this.helperRenderer.snapshot(pages, margins, effects, display, options);
    this.sceneByCanvas.set(result.canvas, scene);
    return result;
  }

  getThumbnail(page, effectEntry, display) {
    return this.helperRenderer.getThumbnail(page, effectEntry, display);
  }

  rememberSnapshotScene(targetCanvas, sourceCanvas) {
    if (this.fallbackRenderer) return;
    const scene = this.sceneByCanvas.get(sourceCanvas);
    if (scene) this.sceneByCanvas.set(targetCanvas, scene);
  }

  animateTo(from, to, direction, onDone) {
    if (this.fallbackRenderer) {
      this.fallbackRenderer.animateTo(from, to, direction, onDone);
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
      onDone,
    });

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

      this.pagePipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.device.createShaderModule({
            code: `
              struct Uniforms {
                model: mat4x4<f32>,
                light: vec4<f32>,
                canvas: vec4<f32>,
                params: vec4<f32>,
                shadowInfo: vec4<f32>,
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
                return output;
              }
            `,
          }),
          entryPoint: "main",
          buffers: [{
            arrayStride: 32,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32x2" },
            ],
          }],
        },
        fragment: {
          module: this.device.createShaderModule({
            code: `
              struct Uniforms {
                model: mat4x4<f32>,
                light: vec4<f32>,
                canvas: vec4<f32>,
                params: vec4<f32>,
                shadowInfo: vec4<f32>,
                occluders: array<vec4<f32>, 32>,
              };

              @group(0) @binding(0) var texSampler: sampler;
              @group(0) @binding(1) var tex: texture_2d<f32>;
              @group(0) @binding(2) var<uniform> uniforms: Uniforms;

              fn bayer4(index: u32) -> f32 {
                let values = array<f32, 16>(
                  0.0, 8.0, 2.0, 10.0,
                  12.0, 4.0, 14.0, 6.0,
                  3.0, 11.0, 1.0, 9.0,
                  15.0, 7.0, 13.0, 5.0
                );
                return values[index];
              }

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
                    shadow = max(shadow, p0.w);
                  }
                }

                return shadow;
              }

              struct FragmentIn {
                @location(0) worldPos: vec3<f32>,
                @location(1) worldNormal: vec3<f32>,
                @location(2) uv: vec2<f32>,
              };

              @fragment
              fn main(input: FragmentIn, @builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
                let texel = textureSample(tex, texSampler, input.uv);
                let normal = normalize(input.worldNormal);
                let lightDir = vec3<f32>(0.0, 0.0, -1.0);
                let diffuse = abs(dot(normal, lightDir));
                let shade = 0.82 + 0.18 * diffuse;
                let shadow = computeShadow(input.worldPos);
                let x = u32(position.x) & 3u;
                let y = u32(position.y) & 3u;
                let threshold = (bayer4(y * 4u + x) + 0.5) / 16.0;
                let shadowBit = select(0.0, 1.0, shadow > threshold);
                let shadowShade = select(1.0, 0.42, shadowBit > 0.5);
                return vec4<f32>(texel.rgb * shade * shadowShade, texel.a);
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
          depthWriteEnabled: true,
          depthCompare: "less",
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
              fn bayer4(index: u32) -> f32 {
                let values = array<f32, 16>(
                  0.0, 8.0, 2.0, 10.0,
                  12.0, 4.0, 14.0, 6.0,
                  3.0, 11.0, 1.0, 9.0,
                  15.0, 7.0, 13.0, 5.0
                );
                return values[index];
              }

              @fragment
              fn main(@builtin(position) position: vec4<f32>, @location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
                let x = u32(position.x) & 3u;
                let y = u32(position.y) & 3u;
                let threshold = (bayer4(y * 4u + x) + 0.5) / 16.0;
                if (color.a <= threshold) {
                  discard;
                }
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
    const hasPlacedPages = !!pages;
    const sideStates = buildSideStates(margins, pages, hasPlacedPages);

    for (const sideName of ["left", "right"]) {
      const sideState = sideStates[sideName];
      if (!sideState.page) continue;
      const measurement = measurePageDraw(sideState.page, sideState.contentRect, sideState.contentMode);
      sideState.drawnRect = measurement?.visibleRect ?? null;
    }

    return {
      pages,
      margins,
      effects,
      display,
      showPlaceholder,
      sideStates,
    };
  }

  #drawStaticScene(scene) {
    const light = this.#getLight(scene);
    this.#withPass(pass => {
      this.#drawPageSurface(pass, scene, "left", createPageModelMatrix(scene.sideStates.left.pageRect, 0), light);
      this.#drawPageSurface(pass, scene, "right", createPageModelMatrix(scene.sideStates.right.pageRect, 0), light);
      this.#drawChrome(pass, scene);
    });
  }

  #tick(now) {
    if (!this.ready) return;

    const active = [];
    const completed = [];

    for (const animation of this.animations) {
      const progress = Math.min(1, (now - animation.start) / 420);
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

    this.#withPass(pass => {
      if (!active.length) {
        if (this.baseScene && light) {
          this.#drawPageSurface(pass, this.baseScene, "left", createPageModelMatrix(this.baseScene.sideStates.left.pageRect, 0), light);
          this.#drawPageSurface(pass, this.baseScene, "right", createPageModelMatrix(this.baseScene.sideStates.right.pageRect, 0), light);
          this.#drawChrome(pass, this.baseScene);
        }
        return;
      }

      for (const animation of active) {
        this.#drawAnimationFrame(pass, animation, light, shadowOccluders);
      }

      if (currentScene) this.#drawChrome(pass, currentScene);
    });

    for (const animation of completed) {
      animation.onDone?.();
    }

    this.animations = active.map(({ progress, ...animation }) => animation);
    if (this.animations.length) {
      this.animationFrame = requestAnimationFrame(nextNow => this.#tick(nextNow));
    } else {
      this.animationFrame = 0;
      if (this.baseScene) this.#drawStaticScene(this.baseScene);
    }
  }

  #drawAnimationFrame(pass, animation, light, occluders) {
    if (!light) return;

    const sourceSide = animation.direction > 0 ? "right" : "left";
    const backSide = animation.direction > 0 ? "left" : "right";
    const leftStaticScene = animation.direction < 0 ? animation.toScene : animation.fromScene;
    const rightStaticScene = animation.direction > 0 ? animation.toScene : animation.fromScene;
    const turningScene = animation.fromScene;
    const backScene = animation.toScene;

    this.#drawPageSurface(
      pass,
      leftStaticScene,
      "left",
      createPageModelMatrix(leftStaticScene.sideStates.left.pageRect, 0),
      light,
      { occluders }
    );
    this.#drawPageSurface(
      pass,
      rightStaticScene,
      "right",
      createPageModelMatrix(rightStaticScene.sideStates.right.pageRect, 0),
      light,
      { occluders }
    );

    const turningRect = turningScene.sideStates[sourceSide].pageRect;
    const hingeLocalX = sourceSide === "right" ? 0 : turningRect.w;
    const angle = animation.direction > 0 ? animation.progress * Math.PI : -animation.progress * Math.PI;
    const turningModel = createPageModelMatrix(turningRect, 0, angle, hingeLocalX);
    if (Math.cos(angle) >= 0) {
      this.#drawPageSurface(pass, turningScene, sourceSide, turningModel, light, {
        normalSign: 1,
        flipX: false,
        occluders,
        ignoreOccluderId: animation.__shadowId,
      });
    } else {
      this.#drawPageSurface(pass, backScene, backSide, turningModel, light, {
        normalSign: -1,
        flipX: true,
        occluders,
        ignoreOccluderId: animation.__shadowId,
      });
    }
  }

  #buildShadowOccluders(animations) {
    const occluders = [];
    for (const animation of animations) {
      if (occluders.length >= MAX_SHADOW_OCCLUDERS) break;
      const sourceSide = animation.direction > 0 ? "right" : "left";
      const turningRect = animation.fromScene.sideStates[sourceSide]?.pageRect;
      if (!turningRect) continue;

      const hingeLocalX = sourceSide === "right" ? 0 : turningRect.w;
      const angle = animation.direction > 0 ? animation.progress * Math.PI : -animation.progress * Math.PI;
      const turningModel = createPageModelMatrix(turningRect, 0, angle, hingeLocalX);
      const corners = getPageWorldCorners(turningRect, turningModel);
      const flatness = Math.abs(Math.cos(angle));
      const density = 0.04 + 0.28 * flatness * flatness * flatness;
      const id = occluders.length;
      animation.__shadowId = id;
      occluders.push({ corners, density, id });
    }
    return occluders;
  }

  #getLight(scene) {
    return {
      x: scene.margins.pagePxW,
      y: 0.5 * scene.margins.pagePxH,
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
    { normalSign = 1, flipX = false, occluders = [], ignoreOccluderId = -1 } = {}
  ) {
    if (!scene?.margins.ok) return;

    const sideState = scene.sideStates[side];
    if (!sideState?.page) return;

    const pageSurface = this.#getPageSurfaceCanvas(scene, sideState, side);
    if (!pageSurface) return;

    const geometry = this.#getPageGeometry(sideState.pageRect.w, sideState.pageRect.h);
    const textureResource = this.#getTextureResource(pageSurface);
    const uniformData = new Float32Array(160);
    uniformData.set(modelMatrix, 0);
    uniformData.set([light.x, light.y, light.z, 1], 16);
    uniformData.set([this.canvas.width, this.canvas.height, -this.canvas.width, this.canvas.width], 20);
    uniformData.set([0.8, 0.25, normalSign, flipX ? 1 : 0], 24);
    uniformData.set([occluders.length, ignoreOccluderId, 0, 0], 28);
    let offset = 32;
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
      ],
    });

    pass.setPipeline(this.pagePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, geometry.vertexBuffer);
    pass.draw(geometry.vertexCount);
  }

  #getPageSurfaceCanvas(scene, sideState, side) {
    if (!sideState?.page) return null;

    const effectEntry = scene.effects[side];
    const measurement = measurePageDraw(sideState.page, sideState.contentRect, sideState.contentMode);
    const drawKey = measurement
      ? [
          effectEntry.key,
          Math.round(sideState.pageRect.w),
          Math.round(sideState.pageRect.h),
          Math.round(sideState.contentRect.x - sideState.pageRect.x),
          Math.round(sideState.contentRect.y - sideState.pageRect.y),
          Math.round(sideState.contentRect.w),
          Math.round(sideState.contentRect.h),
          sideState.contentMode,
          scene.display.paperColor,
          scene.display.contentBlendMode,
        ].join("|")
      : null;

    let pageCache = this.pageSurfaceCache.get(sideState.page);
    if (!pageCache || pageCache.srcCanvas !== sideState.page.srcCanvas) {
      pageCache = {
        srcCanvas: sideState.page.srcCanvas,
        variants: new Map(),
      };
      this.pageSurfaceCache.set(sideState.page, pageCache);
    }

    const cached = drawKey ? pageCache.variants.get(drawKey) : null;
    if (cached) return cached;

    const pageWidth = Math.max(1, Math.round(sideState.pageRect.w));
    const pageHeight = Math.max(1, Math.round(sideState.pageRect.h));
    const surface = document.createElement("canvas");
    surface.width = pageWidth;
    surface.height = pageHeight;
    const ctx = get2dContext(surface, { willReadFrequently: true });
    ctx.fillStyle = scene.display.paperColor;
    ctx.fillRect(0, 0, pageWidth, pageHeight);

    if (measurement) {
      const processedCanvas = this.#getProcessedCanvas(
        sideState.page,
        measurement.drawRect.w,
        measurement.drawRect.h,
        effectEntry
      );

      if (processedCanvas) {
        if (measurement.clipRect) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(
            Math.round(measurement.clipRect.x - sideState.pageRect.x),
            Math.round(measurement.clipRect.y - sideState.pageRect.y),
            Math.round(measurement.clipRect.w),
            Math.round(measurement.clipRect.h)
          );
          ctx.clip();
        }

        const prevBlend = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = scene.display.contentBlendMode;
        ctx.drawImage(
          processedCanvas,
          Math.round(measurement.drawRect.x - sideState.pageRect.x),
          Math.round(measurement.drawRect.y - sideState.pageRect.y),
          Math.round(measurement.drawRect.w),
          Math.round(measurement.drawRect.h)
        );
        ctx.globalCompositeOperation = prevBlend;

        if (measurement.clipRect) ctx.restore();
      }
    }

    if (drawKey) {
      pageCache.variants.set(drawKey, surface);
      if (pageCache.variants.size > 8) {
        const oldestKey = pageCache.variants.keys().next().value;
        pageCache.variants.delete(oldestKey);
      }
    }

    return surface;
  }

  #getChromeCanvas(scene) {
    const key = [
      Math.round(scene.margins.pagePxW),
      Math.round(scene.margins.pagePxH),
      scene.display.paperColor,
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

    if (scene.showPlaceholder) {
      for (const sideName of ["left", "right"]) {
        const sideState = scene.sideStates[sideName];
        if (sideState.page) continue;
        fillLorem(
          ctx,
          sideState.textblockRect.x,
          sideState.textblockRect.y,
          sideState.textblockRect.w,
          sideState.textblockRect.h
        );
      }
    }

    drawPageBorder(ctx, scene.margins.pagePxW);
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
    const cached = this.textureCache.get(sourceCanvas);
    if (cached && cached.width === sourceCanvas.width && cached.height === sourceCanvas.height) {
      return cached;
    }

    const texture = this.device.createTexture({
      size: [sourceCanvas.width, sourceCanvas.height, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.device.queue.copyExternalImageToTexture(
      { source: sourceCanvas },
      { texture },
      [sourceCanvas.width, sourceCanvas.height]
    );

    const resource = {
      texture,
      view: texture.createView(),
      width: sourceCanvas.width,
      height: sourceCanvas.height,
      quadBindGroup: null,
    };
    this.textureCache.set(sourceCanvas, resource);
    return resource;
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

  #getProcessedCanvas(page, targetWidth, targetHeight, effectEntry) {
    if (!page?.srcCanvas) return null;

    const previewWidth = Math.max(1, Math.min(page.srcCanvas.width, Math.round(targetWidth || page.srcCanvas.width)));
    const previewHeight = Math.max(1, Math.min(page.srcCanvas.height, Math.round(targetHeight || page.srcCanvas.height)));
    const cacheKey = `${effectEntry.key}|${previewWidth}x${previewHeight}`;

    let pageCache = this.effectCache.get(page);
    if (!pageCache || pageCache.srcCanvas !== page.srcCanvas) {
      pageCache = {
        srcCanvas: page.srcCanvas,
        variants: new Map(),
      };
      this.effectCache.set(page, pageCache);
    }

    const cached = pageCache.variants.get(cacheKey);
    if (cached) return cached;

    const base = document.createElement("canvas");
    base.width = previewWidth;
    base.height = previewHeight;
    get2dContext(base, { willReadFrequently: true }).drawImage(page.srcCanvas, 0, 0, previewWidth, previewHeight);

    let out = base;
    for (const effect of effectEntry.pipeline) out = effect(out);

    pageCache.variants.set(cacheKey, out);
    if (pageCache.variants.size > 8) {
      const oldestKey = pageCache.variants.keys().next().value;
      pageCache.variants.delete(oldestKey);
    }

    return out;
  }

  #withPass(drawFn) {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: {
          r: this.clearColor[0],
          g: this.clearColor[1],
          b: this.clearColor[2],
          a: this.clearColor[3],
        },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: this.depthView
        ? {
            view: this.depthView,
            depthClearValue: 1,
            depthLoadOp: "clear",
            depthStoreOp: "store",
          }
        : undefined,
    });

    drawFn(pass);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
