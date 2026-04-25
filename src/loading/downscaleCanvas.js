function get2dContext(canvas, options) {
  return canvas.getContext("2d", options);
}

const DOWNSCALE_WORKGROUP_SIZE = 8;
let webgpuDownscalerReady = null;

function computeTargetSize(sourceWidth, sourceHeight, maxEdge) {
  const safeMaxEdge = Math.max(1, Math.round(maxEdge || 1));
  const sourceMaxEdge = Math.max(sourceWidth, sourceHeight);
  if (sourceMaxEdge <= safeMaxEdge) {
    return {
      width: Math.max(1, Math.round(sourceWidth)),
      height: Math.max(1, Math.round(sourceHeight)),
    };
  }
  const scale = safeMaxEdge / sourceMaxEdge;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

async function getWebgpuDownscaler() {
  if (!globalThis.navigator?.gpu) return null;
  if (webgpuDownscalerReady) return webgpuDownscalerReady;

  webgpuDownscalerReady = (async () => {
    const adapter = await globalThis.navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const shaderModule = device.createShaderModule({
      code: `
        struct Params {
          srcWidth: u32,
          srcHeight: u32,
          dstWidth: u32,
          dstHeight: u32,
        };

        @group(0) @binding(0) var sourceTex: texture_2d<f32>;
        @group(0) @binding(1) var destTex: texture_storage_2d<rgba8unorm, write>;
        @group(0) @binding(2) var<uniform> params: Params;

        fn ceilDiv(value: u32, divisor: u32) -> u32 {
          return (value + divisor - 1u) / divisor;
        }

        @compute @workgroup_size(${DOWNSCALE_WORKGROUP_SIZE}, ${DOWNSCALE_WORKGROUP_SIZE})
        fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
          if (gid.x >= params.dstWidth || gid.y >= params.dstHeight) {
            return;
          }

          let srcX0 = gid.x * params.srcWidth / params.dstWidth;
          let srcY0 = gid.y * params.srcHeight / params.dstHeight;
          let srcX1 = max(srcX0 + 1u, ceilDiv((gid.x + 1u) * params.srcWidth, params.dstWidth));
          let srcY1 = max(srcY0 + 1u, ceilDiv((gid.y + 1u) * params.srcHeight, params.dstHeight));

          var accum = vec4<f32>(0.0);
          var count = 0u;
          for (var sy = srcY0; sy < srcY1; sy = sy + 1u) {
            for (var sx = srcX0; sx < srcX1; sx = sx + 1u) {
              accum = accum + textureLoad(sourceTex, vec2<i32>(i32(sx), i32(sy)), 0);
              count = count + 1u;
            }
          }

          textureStore(destTex, vec2<i32>(i32(gid.x), i32(gid.y)), accum / f32(max(count, 1u)));
        }
      `,
    });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: {
        module: shaderModule,
        entryPoint: "main",
      },
    });

    device.lost.then(() => {
      webgpuDownscalerReady = null;
    });

    return { device, pipeline };
  })().catch(error => {
    console.error("Failed to initialize WebGPU downscaler:", error);
    webgpuDownscalerReady = null;
    return null;
  });

  return webgpuDownscalerReady;
}

function downscaleCanvas2d(sourceCanvas, targetWidth, targetHeight) {
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = get2dContext(canvas, { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
  return canvas;
}

export function downscaleCanvasToMaxEdgeSync(sourceCanvas, maxEdge) {
  if (!sourceCanvas?.width || !sourceCanvas?.height) return null;

  const { width: targetWidth, height: targetHeight } = computeTargetSize(
    sourceCanvas.width,
    sourceCanvas.height,
    maxEdge
  );
  if (targetWidth === sourceCanvas.width && targetHeight === sourceCanvas.height) {
    return sourceCanvas;
  }

  return downscaleCanvas2d(sourceCanvas, targetWidth, targetHeight);
}

async function downscaleCanvasWebgpu(sourceCanvas, targetWidth, targetHeight) {
  const downscaler = await getWebgpuDownscaler();
  if (!downscaler) return null;

  const { device, pipeline } = downscaler;
  const sourceWidth = Math.max(1, Math.round(sourceCanvas.width));
  const sourceHeight = Math.max(1, Math.round(sourceCanvas.height));
  const paddedBytesPerRow = Math.ceil((targetWidth * 4) / 256) * 256;

  const sourceTexture = device.createTexture({
    size: [sourceWidth, sourceHeight, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const destTexture = device.createTexture({
    size: [targetWidth, targetHeight, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  const paramsBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const readbackBuffer = device.createBuffer({
    size: paddedBytesPerRow * targetHeight,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  try {
    device.queue.copyExternalImageToTexture(
      { source: sourceCanvas },
      { texture: sourceTexture },
      [sourceWidth, sourceHeight]
    );
    device.queue.writeBuffer(
      paramsBuffer,
      0,
      new Uint32Array([sourceWidth, sourceHeight, targetWidth, targetHeight])
    );

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sourceTexture.createView() },
        { binding: 1, resource: destTexture.createView() },
        { binding: 2, resource: { buffer: paramsBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(targetWidth / DOWNSCALE_WORKGROUP_SIZE),
      Math.ceil(targetHeight / DOWNSCALE_WORKGROUP_SIZE)
    );
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: destTexture },
      {
        buffer: readbackBuffer,
        bytesPerRow: paddedBytesPerRow,
        rowsPerImage: targetHeight,
      },
      [targetWidth, targetHeight, 1]
    );
    device.queue.submit([encoder.finish()]);

    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const mapped = readbackBuffer.getMappedRange();
    const srcBytes = new Uint8Array(mapped);
    const destBytes = new Uint8ClampedArray(targetWidth * targetHeight * 4);
    for (let row = 0; row < targetHeight; row += 1) {
      const srcOffset = row * paddedBytesPerRow;
      const destOffset = row * targetWidth * 4;
      destBytes.set(srcBytes.subarray(srcOffset, srcOffset + targetWidth * 4), destOffset);
    }
    readbackBuffer.unmap();

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    get2dContext(canvas, { willReadFrequently: true }).putImageData(
      new ImageData(destBytes, targetWidth, targetHeight),
      0,
      0
    );
    return canvas;
  } finally {
    sourceTexture.destroy();
    destTexture.destroy();
    paramsBuffer.destroy();
    readbackBuffer.destroy();
  }
}

export async function downscaleCanvasToMaxEdge(sourceCanvas, maxEdge) {
  if (!sourceCanvas?.width || !sourceCanvas?.height) return null;

  const { width: targetWidth, height: targetHeight } = computeTargetSize(
    sourceCanvas.width,
    sourceCanvas.height,
    maxEdge
  );
  if (targetWidth === sourceCanvas.width && targetHeight === sourceCanvas.height) {
    return sourceCanvas;
  }

  return (
    await downscaleCanvasWebgpu(sourceCanvas, targetWidth, targetHeight)
  ) || downscaleCanvasToMaxEdgeSync(sourceCanvas, maxEdge);
}
