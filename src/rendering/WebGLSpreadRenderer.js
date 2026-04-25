import { fillLorem } from "./text.js";
import { drawPageBorder } from "./primitives.js";
import { SpreadRenderer } from "./SpreadRenderer.js";

const GL_CONTEXT_OPTIONS = {
  alpha: true,
  antialias: false,
  preserveDrawingBuffer: true,
  premultipliedAlpha: true,
};

function get2dContext(canvas, options) {
  return canvas.getContext("2d", options);
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(message || "Failed to compile WebGL shader");
  }
  return shader;
}

function createProgram(gl) {
  const vertexShader = createShader(
    gl,
    gl.VERTEX_SHADER,
    `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      uniform vec2 u_resolution;
      varying vec2 v_texCoord;

      void main() {
        vec2 zeroToOne = a_position / u_resolution;
        vec2 zeroToTwo = zeroToOne * 2.0;
        vec2 clipSpace = zeroToTwo - 1.0;
        gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `
  );

  const fragmentShader = createShader(
    gl,
    gl.FRAGMENT_SHADER,
    `
      precision mediump float;
      varying vec2 v_texCoord;
      uniform sampler2D u_image;
      uniform int u_blendMode;
      uniform vec3 u_backdropColor;

      vec3 overlayBlend(vec3 base, vec3 blend) {
        vec3 low = 2.0 * base * blend;
        vec3 high = 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
        return mix(low, high, step(0.5, base));
      }

      void main() {
        vec4 src = texture2D(u_image, v_texCoord);
        vec3 rgb = src.rgb;

        if (u_blendMode == 1) {
          rgb = u_backdropColor * src.rgb;
        } else if (u_blendMode == 2) {
          rgb = 1.0 - (1.0 - u_backdropColor) * (1.0 - src.rgb);
        } else if (u_blendMode == 3) {
          rgb = overlayBlend(u_backdropColor, src.rgb);
        }

        gl_FragColor = vec4(rgb, src.a);
      }
    `
  );

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(message || "Failed to link WebGL program");
  }

  return program;
}

function parseHexColor(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return [1, 1, 1];
  }

  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

function blendModeCode(mode) {
  return mode === "multiply"
    ? 1
    : mode === "screen"
      ? 2
      : mode === "overlay"
        ? 3
        : 0;
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
  const sourceCanvas = page?.displayCanvas;
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

  return {
    drawRect,
    clipRect: mode === "fill"
      ? { x: clipX0, y: clipY0, w: clipX1 - clipX0, h: clipY1 - clipY0 }
      : null,
    visibleRect: {
      x: mode === "fill" ? Math.max(cropX, clipX0) : cropX,
      y: mode === "fill" ? Math.max(cropY, clipY0) : cropY,
      w: Math.max(
        0,
        (mode === "fill" ? Math.min(cropRight, clipX1) : cropRight) -
        (mode === "fill" ? Math.max(cropX, clipX0) : cropX)
      ),
      h: Math.max(
        0,
        (mode === "fill" ? Math.min(cropBottom, clipY1) : cropBottom) -
        (mode === "fill" ? Math.max(cropY, clipY0) : cropY)
      ),
      fitScale: scale,
      sw: sourceCanvas.width,
      sh: sourceCanvas.height,
    },
  };
}

export class WebGLSpreadRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.backendName = "2d";
    this.effectCache = new WeakMap();
    this.thumbnailRenderer = new SpreadRenderer(document.createElement("canvas"));
    this.animationFrame = 0;
    this.animations = [];
    this.baseCanvas = null;
    this.doneCallbacks = [];
    this.shadowCanvas = document.createElement("canvas");

    this.mainTarget = this.#createRenderTarget(canvas);
    if (!this.mainTarget) {
      this.fallbackRenderer = new SpreadRenderer(canvas);
      this.backendName = this.fallbackRenderer.backendName;
      return;
    }

    this.fallbackRenderer = null;
    this.backendName = "webgl";
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
    this.baseCanvas = null;
    this.doneCallbacks = [];
  }

  render(pages, margins, effects, display, options = {}) {
    if (this.fallbackRenderer) {
      return this.fallbackRenderer.render(pages, margins, effects, display, options);
    }

    this.#resizeTarget(this.mainTarget, Math.round(2 * margins.pagePxW), Math.round(margins.pagePxH));
    return this.#paint(this.mainTarget, pages, margins, effects, display, options);
  }

  snapshot(pages, margins, effects, display, options = {}) {
    if (this.fallbackRenderer) {
      return this.fallbackRenderer.snapshot(pages, margins, effects, display, options);
    }

    const offscreen = document.createElement("canvas");
    const target = this.#createRenderTarget(offscreen);
    if (!target) {
      return new SpreadRenderer(offscreen).snapshot(pages, margins, effects, display, options);
    }

    this.#resizeTarget(target, Math.round(2 * margins.pagePxW), Math.round(margins.pagePxH));
    const result = this.#paint(target, pages, margins, effects, display, options);
    return { canvas: offscreen, ...result };
  }

  getThumbnail(page, effectEntry, display, options = {}) {
    return this.thumbnailRenderer.getThumbnail(page, effectEntry, display, options);
  }

  getPlacedPagePreview(page, effectEntry, display, options = {}) {
    return this.thumbnailRenderer.getPlacedPagePreview(page, effectEntry, display, options);
  }

  animateTo(from, to, direction, onDone) {
    if (this.fallbackRenderer) {
      this.fallbackRenderer.animateTo(from, to, direction, onDone);
      return;
    }

    if (!this.animations.length) this.baseCanvas = from;
    this.animations.push({ fromCanvas: from, toCanvas: to, direction, start: performance.now(), targetSpread: 0 });
    if (onDone) this.doneCallbacks.push(onDone);

    if (!this.animationFrame) {
      this.animationFrame = requestAnimationFrame(now => this.#tick(now));
    }
  }

  #createRenderTarget(canvas) {
    const gl = canvas.getContext("webgl", GL_CONTEXT_OPTIONS);
    if (!gl) return null;

    const program = createProgram(gl);
    return {
      canvas,
      gl,
      program,
      positionLocation: gl.getAttribLocation(program, "a_position"),
      texCoordLocation: gl.getAttribLocation(program, "a_texCoord"),
      resolutionLocation: gl.getUniformLocation(program, "u_resolution"),
      imageLocation: gl.getUniformLocation(program, "u_image"),
      blendModeLocation: gl.getUniformLocation(program, "u_blendMode"),
      backdropColorLocation: gl.getUniformLocation(program, "u_backdropColor"),
      positionBuffer: gl.createBuffer(),
      texCoordBuffer: gl.createBuffer(),
      textureCache: new WeakMap(),
      stageCanvas: document.createElement("canvas"),
      stageCtx: get2dContext(document.createElement("canvas")),
    };
  }

  #resizeTarget(target, width, height) {
    target.canvas.width = width;
    target.canvas.height = height;
    target.stageCanvas.width = width;
    target.stageCanvas.height = height;
    target.stageCtx = get2dContext(target.stageCanvas);
    target.gl.viewport(0, 0, width, height);
  }

  #paint(target, pages, margins, effects, display, options) {
    const showPlaceholder = !!options.showPlaceholder;
    const hasPlacedPages = !!pages;
    const sideStates = buildSideStates(margins, pages, hasPlacedPages);
    const stageCtx = target.stageCtx;

    stageCtx.clearRect(0, 0, target.canvas.width, target.canvas.height);
    if (margins.ok) {
      for (const sideState of Object.values(sideStates)) {
        if (!sideState.page && showPlaceholder) {
          fillLorem(
            stageCtx,
            sideState.textblockRect.x,
            sideState.textblockRect.y,
            sideState.textblockRect.w,
            sideState.textblockRect.h
          );
        }
      }
    }
    drawPageBorder(stageCtx, margins.pagePxW);

    this.#clearTarget(target, display.paperColor);

    if (margins.ok) {
      for (const [sideName, sideState] of Object.entries(sideStates)) {
        if (!sideState.page?.displayCanvas && !sideState.page?.placedPreviewCanvas) continue;
        const effectEntry = effects[sideName];
        const measurement = measurePageDraw(sideState.page, sideState.contentRect, sideState.contentMode);
        if (!sideState.page.srcCanvas && sideState.page.placedPreviewCanvas) {
          sideState.drawnRect = measurement?.visibleRect ?? {
            x: sideState.pageRect.x,
            y: sideState.pageRect.y,
            w: sideState.pageRect.w,
            h: sideState.pageRect.h,
            fitScale: 1,
            sw: sideState.page.placedPreviewCanvas.width,
            sh: sideState.page.placedPreviewCanvas.height,
          };
          this.#drawCanvasRegion(
            target,
            sideState.page.placedPreviewCanvas,
            sideState.pageRect,
            null,
            null,
            "source-over",
            display.paperColor,
            true
          );
          continue;
        }
        if (!measurement) continue;
        sideState.drawnRect = measurement.visibleRect;
        const processedCanvas = this.#getProcessedCanvas(
          sideState.page,
          measurement.drawRect.w,
          measurement.drawRect.h,
          effectEntry
        );
        if (!processedCanvas) continue;

        this.#drawCanvasRegion(
          target,
          processedCanvas,
          {
            x: measurement.drawRect.x,
            y: measurement.drawRect.y,
            w: measurement.drawRect.w,
            h: measurement.drawRect.h,
          },
          null,
          measurement.clipRect,
          display.contentBlendMode,
          display.paperColor,
          true
        );
      }
    }

    this.#drawCanvasRegion(
      target,
      target.stageCanvas,
      { x: 0, y: 0, w: target.canvas.width, h: target.canvas.height },
      null,
      null,
      "source-over",
      display.paperColor,
      false
    );

    return {
      spreadRects: {
        left: sideStates.left.drawnRect
          ? { ...sideStates.left.drawnRect, pageIndex: sideStates.left.pageIndex }
          : null,
        right: sideStates.right.drawnRect
          ? { ...sideStates.right.drawnRect, pageIndex: sideStates.right.pageIndex }
          : null,
        pagePxW: margins.pagePxW,
      },
      sideStates,
    };
  }

  #clearTarget(target, paperColor) {
    const [r, g, b] = parseHexColor(paperColor);
    target.gl.disable(target.gl.SCISSOR_TEST);
    target.gl.clearColor(r, g, b, 1);
    target.gl.clear(target.gl.COLOR_BUFFER_BIT);
  }

  #drawCanvasRegion(target, sourceCanvas, destRect, sourceRect = null, clipRect = null, blendMode = "source-over", paperColor = "#ffffff", cacheTexture = true) {
    const gl = target.gl;
    const drawW = Math.round(destRect.w);
    const drawH = Math.round(destRect.h);
    if (drawW <= 0 || drawH <= 0) return;

    const texture = this.#getTexture(target, sourceCanvas, cacheTexture);
    gl.useProgram(target.program);
    gl.uniform2f(target.resolutionLocation, target.canvas.width, target.canvas.height);
    gl.uniform1i(target.imageLocation, 0);
    gl.uniform1i(target.blendModeLocation, blendModeCode(blendMode));
    gl.uniform3fv(target.backdropColorLocation, parseHexColor(paperColor));

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);

    const x0 = destRect.x;
    const y0 = destRect.y;
    const x1 = destRect.x + destRect.w;
    const y1 = destRect.y + destRect.h;
    const positions = new Float32Array([
      x0, y0,
      x1, y0,
      x0, y1,
      x0, y1,
      x1, y0,
      x1, y1,
    ]);

    const src = sourceRect ?? { x: 0, y: 0, w: sourceCanvas.width, h: sourceCanvas.height };
    const left = src.x / sourceCanvas.width;
    const right = (src.x + src.w) / sourceCanvas.width;
    const top = src.y / sourceCanvas.height;
    const bottom = (src.y + src.h) / sourceCanvas.height;
    const texCoords = new Float32Array([
      left, top,
      right, top,
      left, bottom,
      left, bottom,
      right, top,
      right, bottom,
    ]);

    gl.bindBuffer(gl.ARRAY_BUFFER, target.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(target.positionLocation);
    gl.vertexAttribPointer(target.positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, target.texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(target.texCoordLocation);
    gl.vertexAttribPointer(target.texCoordLocation, 2, gl.FLOAT, false, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (clipRect) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(
        Math.round(clipRect.x),
        Math.round(target.canvas.height - clipRect.y - clipRect.h),
        Math.round(clipRect.w),
        Math.round(clipRect.h)
      );
    } else {
      gl.disable(gl.SCISSOR_TEST);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.SCISSOR_TEST);

    if (!cacheTexture) gl.deleteTexture(texture);
  }

  #getTexture(target, sourceCanvas, cacheTexture) {
    const gl = target.gl;
    const cached = cacheTexture ? target.textureCache.get(sourceCanvas) : null;

    if (cached &&
        cached.width === sourceCanvas.width &&
        cached.height === sourceCanvas.height) {
      return cached.texture;
    }

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);

    if (cacheTexture) {
      if (cached?.texture) gl.deleteTexture(cached.texture);
      target.textureCache.set(sourceCanvas, {
        texture,
        width: sourceCanvas.width,
        height: sourceCanvas.height,
      });
    }

    return texture;
  }

  #getProcessedCanvas(page, targetWidth, targetHeight, effectEntry) {
    const sourceCanvas = page?.displayCanvas;
    if (!sourceCanvas) return null;

    const previewWidth = Math.max(1, Math.min(sourceCanvas.width, Math.round(targetWidth || sourceCanvas.width)));
    const previewHeight = Math.max(1, Math.min(sourceCanvas.height, Math.round(targetHeight || sourceCanvas.height)));
    const cacheKey = `${effectEntry.key}|${previewWidth}x${previewHeight}`;

    let pageCache = this.effectCache.get(page);
    if (!pageCache || pageCache.srcCanvas !== sourceCanvas) {
      pageCache = {
        srcCanvas: sourceCanvas,
        variants: new Map(),
      };
      this.effectCache.set(page, pageCache);
    }

    const cached = pageCache.variants.get(cacheKey);
    if (cached) return cached;

    const base = document.createElement("canvas");
    base.width = previewWidth;
    base.height = previewHeight;
    get2dContext(base, { willReadFrequently: true }).drawImage(sourceCanvas, 0, 0, previewWidth, previewHeight);

    let out = base;
    for (const effect of effectEntry.pipeline) out = effect(out);

    pageCache.variants.set(cacheKey, out);
    if (pageCache.variants.size > 8) {
      const oldestKey = pageCache.variants.keys().next().value;
      pageCache.variants.delete(oldestKey);
    }

    return out;
  }

  #drawPageShadow(target, pageWidth, pageHeight, strength, side) {
    const shadowStrength = Math.max(0, Math.min(1, strength));
    if (shadowStrength <= 0) return;

    const shadowWidth = pageWidth;
    const shadowCanvas = this.shadowCanvas;
    shadowCanvas.width = shadowWidth;
    shadowCanvas.height = pageHeight;

    const shadowCtx = get2dContext(shadowCanvas);
    const imageData = shadowCtx.createImageData(shadowWidth, pageHeight);
    const { data } = imageData;
    const bayer4 = [
      0, 8, 2, 10,
      12, 4, 14, 6,
      3, 11, 1, 9,
      15, 7, 13, 5,
    ];
    const maxDensity = 0.5 * shadowStrength;

    for (let y = 0; y < pageHeight; y += 1) {
      for (let x = 0; x < shadowWidth; x += 1) {
        const tx = x / Math.max(1, shadowWidth - 1);
        const t = side === "left" ? tx : 1 - tx;
        const density = maxDensity * (0.2 + 0.8 * t);
        const threshold = (bayer4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
        if (density <= threshold) continue;

        const idx = (y * shadowWidth + x) * 4;
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
        data[idx + 3] = 255;
      }
    }

    shadowCtx.putImageData(imageData, 0, 0);
    const destX = side === "right" ? pageWidth : 0;
    this.#drawCanvasRegion(
      target,
      shadowCanvas,
      { x: destX, y: 0, w: shadowWidth, h: pageHeight },
      null,
      null,
      "source-over",
      "#ffffff",
      false
    );
  }

  #tick(now) {
    const width = this.canvas.width;
    const height = this.canvas.height;
    const pageWidth = width / 2;
    const target = this.mainTarget;
    let landLeftShadowStrength = 0;
    let landRightShadowStrength = 0;
    let liftLeftShadowStrength = 0;
    let liftRightShadowStrength = 0;

    if (this.baseCanvas) {
      this.#clearTarget(target, "#ffffff");
      this.#drawCanvasRegion(
        target,
        this.baseCanvas,
        { x: 0, y: 0, w: width, h: height },
        { x: 0, y: 0, w: this.baseCanvas.width, h: this.baseCanvas.height }
      );
    } else {
      this.#clearTarget(target, "#ffffff");
    }

    const remaining = [];
    const liftAnimations = [];
    const landAnimations = [];

    for (const animation of this.animations) {
      const progress = Math.min(1, (now - animation.start) / 420);
      const phaseProgress = progress < 0.5 ? progress / 0.5 : (progress - 0.5) / 0.5;
      if (animation.direction > 0) {
        if (progress < 0.5) {
          liftRightShadowStrength = Math.max(liftRightShadowStrength, 1 - phaseProgress);
        } else {
          landLeftShadowStrength = Math.max(landLeftShadowStrength, phaseProgress);
        }
      } else if (progress < 0.5) {
        liftLeftShadowStrength = Math.max(liftLeftShadowStrength, 1 - phaseProgress);
      } else {
        landRightShadowStrength = Math.max(landRightShadowStrength, phaseProgress);
      }

      if (progress < 1) {
        remaining.push(animation);
        if (progress < 0.5) {
          liftAnimations.push({ animation, liftW: Math.max(0, pageWidth * (1 - phaseProgress)) });
        } else {
          landAnimations.push({ animation, landW: Math.max(0, pageWidth * phaseProgress) });
        }
      } else {
        this.baseCanvas = animation.toCanvas;
      }
    }

    for (const { animation, landW } of landAnimations) {
      if (animation.direction > 0) {
        this.#drawCanvasRegion(target, animation.toCanvas, { x: pageWidth, y: 0, w: pageWidth, h: height }, { x: pageWidth, y: 0, w: pageWidth, h: height });
      } else {
        this.#drawCanvasRegion(target, animation.toCanvas, { x: 0, y: 0, w: pageWidth, h: height }, { x: 0, y: 0, w: pageWidth, h: height });
      }
    }

    if (landLeftShadowStrength > 0) {
      this.#drawPageShadow(target, pageWidth, height, landLeftShadowStrength, "left");
    }

    if (landRightShadowStrength > 0) {
      this.#drawPageShadow(target, pageWidth, height, landRightShadowStrength, "right");
    }

    for (const { animation, landW } of landAnimations) {
      if (animation.direction > 0) {
        this.#drawCanvasRegion(target, animation.toCanvas, { x: pageWidth - landW, y: 0, w: landW, h: height }, { x: 0, y: 0, w: pageWidth, h: height });
      } else {
        this.#drawCanvasRegion(target, animation.toCanvas, { x: pageWidth, y: 0, w: landW, h: height }, { x: pageWidth, y: 0, w: pageWidth, h: height });
      }
    }

    for (const { animation } of liftAnimations) {
      if (animation.direction > 0) {
        this.#drawCanvasRegion(target, animation.toCanvas, { x: pageWidth, y: 0, w: pageWidth, h: height }, { x: pageWidth, y: 0, w: pageWidth, h: height });
      } else {
        this.#drawCanvasRegion(target, animation.toCanvas, { x: 0, y: 0, w: pageWidth, h: height }, { x: 0, y: 0, w: pageWidth, h: height });
      }
    }

    if (liftLeftShadowStrength > 0) {
      this.#drawPageShadow(target, pageWidth, height, liftLeftShadowStrength, "left");
    }

    if (liftRightShadowStrength > 0) {
      this.#drawPageShadow(target, pageWidth, height, liftRightShadowStrength, "right");
    }

    for (let index = liftAnimations.length - 1; index >= 0; index -= 1) {
      const { animation, liftW } = liftAnimations[index];
      if (animation.direction > 0) {
        this.#drawCanvasRegion(target, animation.fromCanvas, { x: pageWidth, y: 0, w: liftW, h: height }, { x: pageWidth, y: 0, w: pageWidth, h: height });
      } else {
        this.#drawCanvasRegion(target, animation.fromCanvas, { x: pageWidth - liftW, y: 0, w: liftW, h: height }, { x: 0, y: 0, w: pageWidth, h: height });
      }
    }

    this.animations = remaining;

    if (remaining.length) {
      this.animationFrame = requestAnimationFrame(nextNow => this.#tick(nextNow));
      return;
    }

    this.animationFrame = 0;
    const callbacks = [...this.doneCallbacks];
    this.doneCallbacks = [];
    for (const callback of callbacks) callback();
  }
}
