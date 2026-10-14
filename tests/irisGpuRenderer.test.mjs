import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

await build({ entryPoints: ["src/utils/irisGpuRenderer.ts"], outfile: ".tmp/iris-gpu-tests/runtime.js",
  bundle: true, packages: "external", format: "esm", platform: "browser", logLevel: "silent" });
const { irisCoverCropUv, irisQuadClipVertices, irisBoundedRasterSize, irisMediaImageSize, createIrisGpuRenderer } = await import("../.tmp/iris-gpu-tests/runtime.js");

function near(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test("center crop retains aspect ratio and the original texel boundary without a second square raster", () => {
  for (const [sw, sh, tw, th] of [[640, 360, 70, 70], [360, 640, 280, 280], [123, 321, 280, 70],
    [800, 450, 1600, 900], [384, 384, 70, 70]]) {
    const uv = irisCoverCropUv(sw, sh, tw, th);
    const sampledWidth = (uv[1].u - uv[0].u) * sw;
    const sampledHeight = (uv[3].v - uv[0].v) * sh;
    near(sampledWidth / sampledHeight, tw / th);
    near((uv[0].u + uv[2].u) / 2, .5);
    near((uv[0].v + uv[2].v) / 2, .5);
    assert.ok(uv.every(point => point.u >= 0 && point.u <= 1 && point.v >= 0 && point.v <= 1));
    assert.ok(uv[0].u === 0 || uv[0].v === 0, "the uncropped axis keeps its original texture edge");
  }
  assert.deepEqual(irisCoverCropUv(384, 384), [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }, { u: 0, v: 1 }]);
  for (const invalid of [0, -1, NaN, Infinity]) assert.throws(() => irisCoverCropUv(invalid, 384), RangeError);
});

test("quad upload preserves homogeneous screen positions and independent old/new crop coordinates", () => {
  const points = [{ x: -40, y: 20, w: .8 }, { x: 460, y: 60, w: 1.25 },
    { x: 450, y: 430, w: 1.25 }, { x: -60, y: 440, w: .8 }];
  const uv = irisCoverCropUv(640, 360), previousUv = irisCoverCropUv(360, 640);
  const data = irisQuadClipVertices(points, 500, 450, uv, previousUv);
  assert.equal(data.length, 28);
  for (let index = 0; index < 4; index++) {
    const [cx, cy, w, u, v, oldU, oldV] = data.subarray(index * 7, index * 7 + 7);
    near((cx / w + 1) * 250, points[index].x, 2e-5);
    near((1 - cy / w) * 225, points[index].y, 2e-5);
    near(w, points[index].w);
    near(u, uv[index].u); near(v, uv[index].v);
    near(oldU, previousUv[index].u); near(oldV, previousUv[index].v);
  }
  for (const w of [0, -1, NaN, Infinity, 1e-100]) {
    assert.throws(() => irisQuadClipVertices([{ ...points[0], w }, ...points.slice(1)], 500, 450), RangeError);
  }
  assert.throws(() => irisQuadClipVertices([{ ...points[0], x: 1e100 }, ...points.slice(1)], 500, 450), RangeError);
});

function barycentric(point, vertices) {
  const [a, b, c] = vertices;
  const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  const first = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / denominator;
  const second = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / denominator;
  return [first, second, 1 - first - second];
}

test("two triangle interpolation reconstructs rotated plane UV while affine screen UV is measurably wrong", () => {
  // Independent pinhole geometry, rather than the production projection helper.
  const angle = 1.15, width = 280, height = 210, distance = 400;
  const project = (u, v) => {
    const dx = (u - .5) * width, dy = (v - .5) * height;
    const w = (distance - dx * Math.sin(angle)) / distance;
    return { x: 240 + dx * Math.cos(angle) / w, y: 220 + dy / w, w };
  };
  const sourceUv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const points = sourceUv.map(([u, v]) => project(u, v));
  const data = irisQuadClipVertices(points, 480, 440);
  const uploaded = points.map((_, index) => {
    const [x, y, w] = data.subarray(index * 7, index * 7 + 3);
    return { x: (x / w + 1) * 240, y: (1 - y / w) * 220, w };
  });
  for (const [u, v, indices] of [[.73, .2, [0, 1, 2]], [.2, .71, [0, 2, 3]]]) {
    const weights = barycentric(project(u, v), indices.map(index => uploaded[index]));
    assert.ok(weights.every(weight => weight >= 0 && weight <= 1));
    const denominator = weights.reduce((sum, weight, index) => sum + weight / uploaded[indices[index]].w, 0);
    const reconstructed = [0, 1].map(channel => weights.reduce((sum, weight, index) =>
      sum + weight * sourceUv[indices[index]][channel] / uploaded[indices[index]].w, 0) / denominator);
    near(reconstructed[0], u); near(reconstructed[1], v);
    const affineU = weights.reduce((sum, weight, index) => sum + weight * sourceUv[indices[index]][0], 0);
    assert.ok(Math.abs(affineU - u) > .05, "using w=1 would lose the intended perspective mapping");
  }
});

test("raster bounds honor the 2x cap, the actual device edge and a fixed pixel budget", () => {
  assert.deepEqual(irisBoundedRasterSize(1180, 760, 3), { width: 2360, height: 1520, rasterScale: 2 });
  assert.deepEqual(irisBoundedRasterSize(920, 620, 1.25), { width: 1150, height: 775, rasterScale: 1.25 });
  for (const [width, height, scale, edge] of [[7680, 4320, 3, 16384], [10000, 10000, 2, 8192],
    [1, 10000, 2, 4096], [9999, 3, 2, 1024], [.1, .2, 1, 2048]]) {
    const raster = irisBoundedRasterSize(width, height, scale, edge);
    assert.ok(raster.width >= 1 && raster.height >= 1 && raster.width <= edge && raster.height <= edge);
    assert.ok(raster.width * raster.height <= 16_777_216);
    assert.ok(raster.rasterScale > 0 && raster.rasterScale <= 2 && raster.rasterScale <= scale);
    if (width > 1 && height > 1) {
      near(raster.width / width, raster.height / height, 1 / Math.min(width, height));
    }
  }
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => irisBoundedRasterSize(value, 760, 2), RangeError);
});

test("an unavailable or rejected browser context returns null for the existing Canvas fallback", () => {
  const requests = [];
  assert.equal(createIrisGpuRenderer({ createElement() { return { getContext(type) { requests.push(type); return null; } }; } }), null);
  assert.deepEqual(requests, ["webgl2", "webgl"]);
  assert.equal(createIrisGpuRenderer({ createElement() { return { getContext() { throw new Error("GPU policy disabled"); } }; } }), null);
});

test("decoded image dimensions are independent of its display size and Canvas keeps its raster size", () => {
  assert.deepEqual(irisMediaImageSize({ naturalWidth: 384, naturalHeight: 192, width: 1, height: 1 }), { width: 384, height: 192 });
  assert.deepEqual(irisMediaImageSize({ width: 1600, height: 900 }), { width: 1600, height: 900 });
});

test("both GL versions upload the exact decoded image or Canvas once with straight alpha flags", () => {
  for (const webgl2 of [true, false]) {
    const env = recordingGpu(webgl2);
    const renderer = createIrisGpuRenderer(env.document);
    assert.ok(renderer);
    const image = { naturalWidth: 8, naturalHeight: 2, width: 1, height: 1, src: "local-controlled.png" };
    const canvas = { width: 8, height: 2 };
    const vertices = [{x:0,y:0,w:1},{x:64,y:0,w:1},{x:64,y:64,w:1},{x:0,y:64,w:1}];
    const palette = [{r:50,g:40,b:30},{r:30,g:60,b:40},{r:60,g:40,b:30}];
    try {
      for (let frame = 0; frame < 3; frame++) {
        assert.equal(renderer.begin({width:64,height:64,rasterScale:1,dpiScale:2}), true);
        assert.equal(renderer.cover({image,previous:canvas,mix:.5,vertices,opacity:89/255}), true);
        const vertexData = env.calls.findLast(call => call.name === "bufferData"
          && call.args[1] instanceof Float32Array && call.args[1].length === 28).args[1];
        for (const [index, [u, v]] of [[.375,0],[.625,0],[.625,1],[.375,1]].entries()) {
          assert.deepEqual([...vertexData.subarray(index * 7 + 3, index * 7 + 7)], [u, v, u, v],
            "default image and previous Canvas UVs use their decoded 8x2 dimensions");
        }
        assert.equal(renderer.finishWall({palette,timeSeconds:frame,opacity:1}), renderer.canvas);
        assert.equal(renderer.begin({width:64,height:64,rasterScale:1,dpiScale:2,transparent:true}), true);
        assert.equal(renderer.photo({image,vertices,palette,timeSeconds:frame,opacity:1}), true);
        assert.equal(renderer.finishPhoto(), renderer.canvas);
      }
      const uploads = env.calls.filter(call => call.name === "texImage2D" && call.args.length === 6);
      assert.equal(uploads.length, 2, "source textures are immutable and cached across frames and material paths");
      assert.deepEqual(uploads.map(call => call.args[5]), [image, canvas]);
      for (const upload of uploads) {
        const before = env.calls.slice(0, env.calls.indexOf(upload));
        const premul = before.findLast(call => call.name === "pixelStorei" && call.args[0] === env.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
        const colorSpace = before.findLast(call => call.name === "pixelStorei" && call.args[0] === env.gl.UNPACK_COLORSPACE_CONVERSION_WEBGL);
        assert.equal(premul.args[1], false);
        assert.equal(colorSpace.args[1], env.gl.NONE);
      }
      const oversized = { naturalWidth: 5000, naturalHeight: 2, width: 1, height: 1, src: "too-large" };
      renderer.begin({width:64,height:64,rasterScale:1,dpiScale:1});
      assert.equal(renderer.photo({image:oversized,vertices,palette,timeSeconds:0,opacity:1}), false,
        "device bounds use decoded dimensions even when CSS width is small");
      assert.equal(env.calls.filter(call => call.name === "texImage2D" && call.args.length === 6).length, 2);
      assert.equal(image.src, "local-controlled.png", "renderer ownership never clears a source retained by a scene");
    } finally { renderer.dispose(); }
    assert.equal(renderer.available, false);
    assert.equal(env.listeners.size, 0);
  }
});

test("GPU receives native RGBA without gain and the selected clip path", () => {
  const env = recordingGpu(true);
  const renderer = createIrisGpuRenderer(env.document);
  try {
    const palette = [{r:112,g:163,b:200,a:.25},{r:248,g:237,b:68,a:.5},{r:204,g:255,b:204,a:.75}];
    const vertices = [{x:0,y:0,w:1},{x:1180,y:0,w:1},{x:1180,y:760,w:1},{x:0,y:760,w:1}];
    renderer.begin({width:1180,height:760,rasterScale:2,dpiScale:3,transparent:true});
    assert.equal(renderer.photo({image:{width:8,height:8},vertices,palette,timeSeconds:0,pathIndex:2,opacity:1}), true);
    for (const [index,name] of ["uPrimary","uHighlight1","uHighlight2"].entries()) {
      const call = env.calls.findLast(call => call.name === "uniform4f" && call.args[0].name === name);
      const color = palette[index];
      assert.deepEqual(call.args.slice(1), [color.r/255,color.g/255,color.b/255,color.a]);
    }
    assert.deepEqual(env.calls.findLast(call => call.name === "uniform2f" && call.args[0].name === "uLight1").args.slice(1), [3540,456]);
    assert.deepEqual(env.calls.findLast(call => call.name === "uniform2f" && call.args[0].name === "uLight2").args.slice(1), [0,1140]);
  } finally { renderer.dispose(); }
});

function recordingGpu(webgl2) {
  const calls = [], listeners = new Map();
  let nextConstant = 1, nextHandle = 0;
  const functions = {
    NO_ERROR: 0,
    getShaderPrecisionFormat() { return {precision:23}; },
    getParameter() { return 4096; },
    getShaderParameter() { return true; },
    getProgramParameter() { return true; },
    getAttribLocation(_program,name) { return {aPosition:0,aUv:1,aPreviousUv:2}[name]; },
    getUniformLocation(_program,name) { return {name}; },
    isContextLost() { return false; },
    getError() { return 0; },
    checkFramebufferStatus() { return gl.FRAMEBUFFER_COMPLETE; },
  };
  const gl = new Proxy(functions, { get(target,name) {
    if (name in target) return target[name];
    if (/^[A-Z_0-9]+$/.test(name)) return target[name] = nextConstant++;
    return target[name] = (...args) => {
      calls.push({name,args});
      if (String(name).startsWith("create")) return {handle:++nextHandle};
    };
  } });
  const canvas = { width:0,height:0, getContext(type) { return type === "webgl2" && !webgl2 ? null : gl; },
    addEventListener(type,listener) { listeners.set(type,listener); }, removeEventListener(type) { listeners.delete(type); } };
  return {gl,calls,listeners,document:{createElement() { return canvas; }}};
}
