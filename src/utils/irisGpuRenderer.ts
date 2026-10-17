import { createMosaicColorFieldMotion } from "./mosaicLighting.js";
import type { RgbColor } from "./nowPlayingCanvas.js";

export type IrisProjectedVertex = { x: number; y: number; w: number };
export type IrisTextureCoordinate = { u: number; v: number };
/** Clockwise order: top-left, top-right, bottom-right, bottom-left. */
export type IrisQuad<T> = readonly [T, T, T, T];
export type IrisMediaImage = HTMLImageElement | HTMLCanvasElement;
/** Decoded dimensions must not depend on an image's optional CSS size. */
export function irisMediaImageSize(image: IrisMediaImage) {
  return "naturalWidth" in image
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: image.width, height: image.height };
}
export type IrisPalette = readonly [RgbColor & { a?: number }, RgbColor & { a?: number }, RgbColor & { a?: number }, ...RgbColor[]];
export type IrisRasterSize = { width: number; height: number; rasterScale: number };
export type IrisFrame = {
  width: number; height: number; rasterScale: number; dpiScale: number; transparent?: boolean;
};
export type IrisCover = {
  image: IrisMediaImage;
  previous?: IrisMediaImage | null;
  mix?: number;
  vertices: IrisQuad<IrisProjectedVertex>;
  uv?: IrisQuad<IrisTextureCoordinate>;
  previousUv?: IrisQuad<IrisTextureCoordinate>;
  /** Final normalized D3DCOLOR alpha; the caller owns material/keyframe quantization. */
  opacity: number;
  backingOpacity?: number;
};
export type IrisPhoto = {
  image: IrisMediaImage;
  vertices: IrisQuad<IrisProjectedVertex>;
  uv?: IrisQuad<IrisTextureCoordinate>;
  palette: IrisPalette;
  timeSeconds: number;
  pathIndex?: number;
  opacity: number;
};
export type IrisTextGlyph = { vertices: IrisQuad<IrisProjectedVertex>; uv: IrisQuad<IrisTextureCoordinate>; opacity: number };
export type IrisTypography = { atlas: HTMLCanvasElement; glyphs: readonly IrisTextGlyph[] };
export type IrisGpuRenderer = {
  readonly available: boolean;
  readonly canvas: HTMLCanvasElement;
  readonly rasterSize: IrisRasterSize;
  begin(frame: IrisFrame): boolean;
  cover(cover: IrisCover): boolean;
  finishWall(options: { palette: IrisPalette; timeSeconds: number; pathIndex?: number; opacity: number }): HTMLCanvasElement | null;
  photo(photo: IrisPhoto): boolean;
  finishPhoto(typography?: readonly IrisTypography[]): HTMLCanvasElement | null;
  dispose(): void;
};

const MAX_TEXTURES = 96;
const MAX_RASTER_PIXELS = 16_777_216;
const DEFAULT_UV: IrisQuad<IrisTextureCoordinate> = [
  { u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }, { u: 0, v: 1 },
];
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

/** Center-crop coordinates preserve the source aspect ratio without another raster. */
export function irisCoverCropUv(sourceWidth: number, sourceHeight: number, targetWidth = 1, targetHeight = 1): IrisQuad<IrisTextureCoordinate> {
  const sourceRatio = positive(sourceWidth) / positive(sourceHeight);
  const targetRatio = positive(targetWidth) / positive(targetHeight);
  const cropWidth = sourceRatio > targetRatio ? targetRatio / sourceRatio : 1;
  const cropHeight = sourceRatio > targetRatio ? 1 : sourceRatio / targetRatio;
  const left = (1 - cropWidth) / 2, top = (1 - cropHeight) / 2;
  return [{ u: left, v: top }, { u: left + cropWidth, v: top },
    { u: left + cropWidth, v: top + cropHeight }, { u: left, v: top + cropHeight }];
}

/** Store homogeneous clip XY rather than affine screen coordinates. */
export function irisQuadClipVertices(
  vertices: IrisQuad<IrisProjectedVertex>, width: number, height: number,
  uv: IrisQuad<IrisTextureCoordinate> = DEFAULT_UV,
  previousUv: IrisQuad<IrisTextureCoordinate> = uv,
): Float32Array {
  const values = new Float32Array(28);
  const logicalWidth = positive(width), logicalHeight = positive(height);
  for (let index = 0; index < 4; index += 1) {
    const point = vertices[index], coordinate = uv[index], previous = previousUv[index];
    if (![point.x, point.y, point.w, coordinate.u, coordinate.v, previous.u, previous.v].every(Number.isFinite) || point.w <= 0) {
      throw new RangeError("Iris vertices must contain finite coordinates and positive clip w");
    }
    const offset = index * 7;
    values[offset] = (2 * point.x / logicalWidth - 1) * point.w;
    values[offset + 1] = (1 - 2 * point.y / logicalHeight) * point.w;
    values[offset + 2] = point.w;
    values[offset + 3] = coordinate.u;
    values[offset + 4] = coordinate.v;
    values[offset + 5] = previous.u;
    values[offset + 6] = previous.v;
    if (![...values.subarray(offset, offset + 7)].every(Number.isFinite) || values[offset + 2] <= 0) {
      throw new RangeError("Iris clip coordinates exceed float32 range");
    }
  }
  return values;
}

/** Keep allocation proportional to the viewport and below both device limits. */
export function irisBoundedRasterSize(width: number, height: number, rasterScale: number, maximumEdge = 16_384): IrisRasterSize {
  const logicalWidth = positive(width), logicalHeight = positive(height);
  const scale = Math.min(2, positive(rasterScale), positive(maximumEdge) / Math.max(logicalWidth, logicalHeight),
    Math.sqrt(MAX_RASTER_PIXELS / logicalWidth / logicalHeight));
  if (scale <= 0 || !Number.isFinite(scale)) throw new RangeError("Iris raster scale is not representable");
  return { width: Math.max(1, Math.floor(logicalWidth * scale)),
    height: Math.max(1, Math.floor(logicalHeight * scale)), rasterScale: scale };
}

function positive(value: number) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError("Iris dimensions must be finite and positive");
  return value;
}

function unit(value: number) { return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0; }

type Gl = WebGLRenderingContext | WebGL2RenderingContext;
type Program = { program: WebGLProgram; position: number; uv: number; previousUv: number; uniforms: Map<string, WebGLUniformLocation | null> };

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec2 aUv;
attribute vec2 aPreviousUv;
varying vec2 vUv;
varying vec2 vPreviousUv;
void main() {
  gl_Position = vec4(aPosition.xy, 0.0, aPosition.z);
  vUv = aUv;
  vPreviousUv = aPreviousUv;
}`;

const COVER_SHADER = `
precision highp float;
varying vec2 vUv;
varying vec2 vPreviousUv;
uniform sampler2D uPrevious;
uniform sampler2D uImage;
uniform float uMix;
uniform float uOpacity;
uniform float uBacking;
void main() {
  if (uBacking > 0.5) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, uOpacity);
  } else {
    vec4 previous = texture2D(uPrevious, vPreviousUv);
    vec4 image = texture2D(uImage, vUv);
    float oldMaterial = (dot(previous.rgb, vec3(0.15, 0.55, 0.30)) - 0.5) * 0.85 + 0.5;
    float material = (dot(image.rgb, vec3(0.15, 0.55, 0.30)) - 0.5) * 0.85 + 0.5;
    float alpha = mix(previous.a, image.a, uMix);
    float mixed = mix(oldMaterial * previous.a, material * image.a, uMix);
    gl_FragColor = vec4(vec3(alpha > 0.0 ? mixed / alpha : 0.0), alpha * uOpacity);
  }
}`;

const LIGHTING_FUNCTIONS = `
uniform vec2 uLogicalSize;
uniform vec2 uRasterSize;
uniform float uDpi;
uniform vec4 uPrimary;
uniform vec4 uHighlight1;
uniform vec4 uHighlight2;
uniform vec2 uLight1;
uniform vec2 uLight2;
vec3 overlayColor(vec3 base, vec3 source) {
  return mix(2.0 * base * source, 1.0 - 2.0 * (1.0 - base) * (1.0 - source), step(vec3(0.5), base));
}
vec4 lightField(vec4 image) {
  vec2 pixel = vec2(gl_FragCoord.x / uRasterSize.x, 1.0 - gl_FragCoord.y / uRasterSize.y) * uLogicalSize * uDpi;
  vec2 d1 = pixel - uLight1;
  vec2 d2 = pixel - uLight2;
  float first = clamp(500.0 / (700.0 + dot(d1, d1) * 0.005), 0.0, 1.0);
  float second = clamp(500.0 / (700.0 + dot(d2, d2) * 0.005), 0.0, 1.0);
  vec3 field = overlayColor(vec3(800.0 / 1050.0), uHighlight1.rgb * first);
  field = overlayColor(field, uHighlight2.rgb * second);
  field = overlayColor(field, image.rgb * uPrimary.rgb);
  return vec4(field, 800.0 / 1050.0 + uHighlight1.a * first + uHighlight2.a * second + uPrimary.a);
}`;

const WALL_SHADER = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uImage;
uniform float uOpacity;
${LIGHTING_FUNCTIONS}
void main() {
  vec4 destination = texture2D(uImage, vUv);
  vec4 field = lightField(vec4(1.0));
  vec3 lit = overlayColor(destination.rgb, field.rgb);
  gl_FragColor = vec4(mix(destination.rgb, lit, clamp(field.a * uOpacity, 0.0, 1.0)), destination.a);
}`;

const PHOTO_SHADER = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uImage;
uniform float uOpacity;
${LIGHTING_FUNCTIONS}
void main() {
  vec4 image = texture2D(uImage, vUv);
  float gray = dot(image.rgb, vec3(0.15, 0.55, 0.30));
  image.rgb = (mix(image.rgb, vec3(gray), 0.9) - 0.5) * 0.95 + 0.5;
  // BackgroundLighting's Multiply selects Primary alpha, independent of Image.
  image.a = uPrimary.a;
  vec4 field = lightField(image);
  gl_FragColor = vec4(field.rgb, clamp(field.a * uOpacity, 0.0, 1.0));
}`;

const COPY_SHADER = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uImage;
void main() { gl_FragColor = texture2D(uImage, vUv); }
`;

const TEXT_SHADER = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uImage;
uniform sampler2D uBackground;
uniform vec2 uRasterSize;
uniform float uOpacity;
void main() {
  vec4 glyph = texture2D(uImage, vUv);
  vec3 base = texture2D(uBackground, gl_FragCoord.xy / uRasterSize).rgb;
  // The immutable atlas is a white mask; transparent padding must not tint
  // antialiased edges when a straight-alpha texture is linearly sampled.
  vec3 color = min(2.0 * base, vec3(1.0));
  // BlendedLabel uses Overlay color and Source2 (glyph) alpha.
  gl_FragColor = vec4(color, glyph.a * uOpacity);
}`;

/** A bounded media renderer; it has no clock and performs no GPU readback. */
export function createIrisGpuRenderer(ownerDocument: Document): IrisGpuRenderer | null {
  const canvas = ownerDocument.createElement("canvas");
  let gl: Gl | null = null;
  let version2 = false;
  try {
    const attributes: WebGLContextAttributes = {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false,
    };
    gl = canvas.getContext("webgl2", attributes);
    version2 = Boolean(gl);
    if (!gl) gl = canvas.getContext("webgl", attributes);
  } catch { return null; }
  if (!gl || typeof gl.getShaderPrecisionFormat !== "function") return null;
  const context = gl;
  const highp = context.getShaderPrecisionFormat(context.FRAGMENT_SHADER, context.HIGH_FLOAT);
  if (!highp || highp.precision === 0) return null;
  let disposed = false, lost = false, started = false;
  let frame: IrisFrame = { width: 1, height: 1, rasterScale: 1, dpiScale: 1 };
  let raster: IrisRasterSize = { width: 1, height: 1, rasterScale: 1 };
  let targetAllocated = false;
  const maximumEdge = Math.min(context.getParameter(context.MAX_TEXTURE_SIZE) as number,
    context.getParameter(context.MAX_RENDERBUFFER_SIZE) as number);
  const textures = new Map<IrisMediaImage, WebGLTexture>();
  const textTextures = new Map<IrisMediaImage, WebGLTexture>();
  const failedTextures = new WeakSet<IrisMediaImage>();
  const programs: Program[] = [];
  const vertexBuffer = context.createBuffer(), indexBuffer = context.createBuffer();
  const targetTexture = context.createTexture(), framebuffer = context.createFramebuffer();
  if (!vertexBuffer || !indexBuffer || !targetTexture || !framebuffer) {
    context.deleteBuffer(vertexBuffer); context.deleteBuffer(indexBuffer);
    context.deleteTexture(targetTexture); context.deleteFramebuffer(framebuffer);
    return null;
  }
  context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, indexBuffer);
  context.bufferData(context.ELEMENT_ARRAY_BUFFER, QUAD_INDICES, context.STATIC_DRAW);

  function compileProgram(fragmentSource: string): Program | null {
    const program = context.createProgram();
    if (!program) return null;
    const shaders: WebGLShader[] = [];
    for (const [type, source] of [[context.VERTEX_SHADER, VERTEX_SHADER], [context.FRAGMENT_SHADER, fragmentSource]] as const) {
      const shader = context.createShader(type);
      if (!shader) { context.deleteProgram(program); shaders.forEach(value => context.deleteShader(value)); return null; }
      let compiledSource = source;
      if (version2) {
        compiledSource = "#version 300 es\n" + source.replace(/attribute /g, "in ")
          .replace(/varying /g, type === context.VERTEX_SHADER ? "out " : "in ")
          .replace(/texture2D\(/g, "texture(").replace(/gl_FragColor/g, "irisFragmentColor");
        if (type === context.FRAGMENT_SHADER) compiledSource = compiledSource.replace("precision highp float;", "precision highp float;\nout vec4 irisFragmentColor;");
      }
      context.shaderSource(shader, compiledSource);
      context.compileShader(shader);
      if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
        context.deleteShader(shader); context.deleteProgram(program); shaders.forEach(value => context.deleteShader(value)); return null;
      }
      shaders.push(shader); context.attachShader(program, shader);
    }
    context.linkProgram(program);
    shaders.forEach(shader => context.deleteShader(shader));
    if (!context.getProgramParameter(program, context.LINK_STATUS)) { context.deleteProgram(program); return null; }
    const result = { program, position: context.getAttribLocation(program, "aPosition"), uv: context.getAttribLocation(program, "aUv"),
      previousUv: context.getAttribLocation(program, "aPreviousUv"),
      uniforms: new Map<string, WebGLUniformLocation | null>() };
    programs.push(result);
    return result;
  }

  const coverProgram = compileProgram(COVER_SHADER), wallProgram = compileProgram(WALL_SHADER);
  const photoProgram = compileProgram(PHOTO_SHADER), copyProgram = compileProgram(COPY_SHADER);
  const textProgram = compileProgram(TEXT_SHADER);
  if (!coverProgram || !wallProgram || !photoProgram || !copyProgram || !textProgram) {
    programs.forEach(value => context.deleteProgram(value.program));
    context.deleteBuffer(vertexBuffer); context.deleteBuffer(indexBuffer);
    context.deleteTexture(targetTexture); context.deleteFramebuffer(framebuffer);
    return null;
  }

  const contextLost = (event: Event) => { event.preventDefault(); lost = true; started = false; };
  // Restored contexts have lost every resource; the caller recreates this renderer.
  canvas.addEventListener("webglcontextlost", contextLost);
  context.disable(context.DEPTH_TEST); context.disable(context.CULL_FACE); context.disable(context.DITHER);

  function available() { return !disposed && !lost && !context.isContextLost(); }
  function location(program: Program, name: string) {
    if (!program.uniforms.has(name)) program.uniforms.set(name, context.getUniformLocation(program.program, name));
    return program.uniforms.get(name) ?? null;
  }
  function one(program: Program, name: string, value: number) { context.uniform1f(location(program, name), value); }
  function two(program: Program, name: string, x: number, y: number) { context.uniform2f(location(program, name), x, y); }
  function bindTexture(program: Program, name: string, texture: WebGLTexture, unitIndex: number) {
    context.activeTexture(context.TEXTURE0 + unitIndex); context.bindTexture(context.TEXTURE_2D, texture);
    context.uniform1i(location(program, name), unitIndex);
  }
  function geometry(program: Program, data: Float32Array) {
    context.useProgram(program.program);
    context.bindBuffer(context.ARRAY_BUFFER, vertexBuffer);
    context.bufferData(context.ARRAY_BUFFER, data, context.DYNAMIC_DRAW);
    context.enableVertexAttribArray(program.position);
    context.vertexAttribPointer(program.position, 3, context.FLOAT, false, 28, 0);
    if (program.uv >= 0) {
      context.enableVertexAttribArray(program.uv);
      context.vertexAttribPointer(program.uv, 2, context.FLOAT, false, 28, 12);
    }
    if (program.previousUv >= 0) {
      context.enableVertexAttribArray(program.previousUv);
      context.vertexAttribPointer(program.previousUv, 2, context.FLOAT, false, 28, 20);
    }
    context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, indexBuffer);
  }
  function drawQuad() { context.drawElements(context.TRIANGLES, 6, context.UNSIGNED_SHORT, 0); }
  function blend() {
    context.enable(context.BLEND);
    context.blendEquationSeparate(context.FUNC_ADD, context.FUNC_ADD);
    context.blendFuncSeparate(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA, context.ONE, context.ONE);
  }
  function sourceTexture(source: IrisMediaImage, cache = textures, maximum = MAX_TEXTURES): WebGLTexture | null {
    const cached = cache.get(source);
    if (cached) { cache.delete(source); cache.set(source, cached); return cached; }
    const { width, height } = irisMediaImageSize(source);
    if (failedTextures.has(source) || width < 1 || height < 1 || Math.max(width, height) > maximumEdge) return null;
    const texture = context.createTexture();
    if (!texture) return null;
    try {
      context.activeTexture(context.TEXTURE0); context.bindTexture(context.TEXTURE_2D, texture);
      setTextureParameters(context);
      // Source UVs start at the top-left. Keeping DOM row order also avoids a
      // second Y inversion; framebuffer copies use the opposite UV ordering.
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, false);
      context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
      context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, context.RGBA, context.UNSIGNED_BYTE, source);
      if (context.getError() !== context.NO_ERROR) throw new Error("Iris texture upload failed");
    } catch { context.deleteTexture(texture); failedTextures.add(source); return null; }
    cache.set(source, texture);
    if (cache.size > maximum) {
      const oldest = cache.keys().next().value;
      if (oldest) { context.deleteTexture(cache.get(oldest)!); cache.delete(oldest); }
    }
    return texture;
  }
  function lighting(program: Program, palette: IrisPalette, timeSeconds: number, pathIndex = 0) {
    const positions = createMosaicColorFieldMotion(timeSeconds, pathIndex);
    const dpi = Math.max(1, frame.dpiScale);
    two(program, "uLogicalSize", frame.width, frame.height); two(program, "uRasterSize", raster.width, raster.height);
    one(program, "uDpi", dpi);
    for (const [name, color] of [["uPrimary", palette[0]], ["uHighlight1", palette[1]], ["uHighlight2", palette[2]]] as const) {
      context.uniform4f(location(program, name), unit(color.r / 255), unit(color.g / 255), unit(color.b / 255), unit(color.a ?? 1));
    }
    two(program, "uLight1", positions.highlight1[0] * frame.width * dpi, positions.highlight1[1] * frame.height * dpi);
    two(program, "uLight2", positions.highlight2[0] * frame.width * dpi, positions.highlight2[1] * frame.height * dpi);
  }
  function outputGeometry(program: Program) {
    // FBO texture coordinates use GL's lower-left origin.
    geometry(program, new Float32Array([-1, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1,
      1, -1, 1, 1, 0, 1, 0, -1, -1, 1, 0, 0, 0, 0]));
    context.bindFramebuffer(context.FRAMEBUFFER, null); context.viewport(0, 0, raster.width, raster.height);
    context.disable(context.BLEND);
    bindTexture(program, "uImage", targetTexture!, 0);
  }

  return {
    get available() { return available(); }, canvas,
    get rasterSize() { return { ...raster }; },
    begin(nextFrame) {
      started = false;
      if (!available()) return false;
      try {
        positive(nextFrame.dpiScale);
        const nextRaster = irisBoundedRasterSize(nextFrame.width, nextFrame.height, nextFrame.rasterScale, maximumEdge);
        frame = { ...nextFrame };
        if (canvas.width !== nextRaster.width || canvas.height !== nextRaster.height) {
          canvas.width = nextRaster.width; canvas.height = nextRaster.height;
        }
        // Allocate on the first frame or a genuine size change, never per draw.
        if (raster.width !== nextRaster.width || raster.height !== nextRaster.height || !targetAllocated) {
          context.bindTexture(context.TEXTURE_2D, targetTexture); setTextureParameters(context);
          context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, nextRaster.width, nextRaster.height, 0,
            context.RGBA, context.UNSIGNED_BYTE, null);
          targetAllocated = true;
        }
        raster = nextRaster;
        context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
        context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, targetTexture, 0);
        if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) return false;
        context.viewport(0, 0, raster.width, raster.height); context.disable(context.BLEND);
        if (nextFrame.transparent) context.clearColor(0, 0, 0, 0);
        else context.clearColor(3 / 255, 3 / 255, 3 / 255, 1);
        context.clear(context.COLOR_BUFFER_BIT);
        started = true;
        return true;
      } catch { return false; }
    },
    cover(options) {
      if (!started || !available()) return false;
      const image = sourceTexture(options.image), previous = sourceTexture(options.previous ?? options.image);
      if (!image || !previous) return false;
      try {
        let uv = options.uv, previousUv = options.previousUv;
        if (!uv) {
          const size = irisMediaImageSize(options.image);
          uv = irisCoverCropUv(size.width, size.height);
        }
        if (!previousUv) {
          const size = irisMediaImageSize(options.previous ?? options.image);
          previousUv = irisCoverCropUv(size.width, size.height);
        }
        context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
        geometry(coverProgram, irisQuadClipVertices(options.vertices, frame.width, frame.height,
          uv, previousUv));
        bindTexture(coverProgram, "uImage", image, 0); bindTexture(coverProgram, "uPrevious", previous, 1);
        blend();
        const backingOpacity = unit(options.backingOpacity ?? 1);
        if (backingOpacity > 0) {
          one(coverProgram, "uBacking", 1); one(coverProgram, "uOpacity", backingOpacity); drawQuad();
        }
        one(coverProgram, "uBacking", 0); one(coverProgram, "uMix", unit(options.mix ?? 1));
        one(coverProgram, "uOpacity", unit(options.opacity)); drawQuad();
        return available();
      } catch { return false; }
    },
    finishWall(options) {
      if (!started || !available()) return null;
      outputGeometry(wallProgram); lighting(wallProgram, options.palette, options.timeSeconds, options.pathIndex);
      one(wallProgram, "uOpacity", unit(options.opacity)); drawQuad();
      return available() ? canvas : null;
    },
    photo(options) {
      if (!started || !available()) return false;
      const texture = sourceTexture(options.image);
      if (!texture) return false;
      try {
        context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
        geometry(photoProgram, irisQuadClipVertices(options.vertices, frame.width, frame.height, options.uv));
        bindTexture(photoProgram, "uImage", texture, 0); lighting(photoProgram, options.palette, options.timeSeconds, options.pathIndex);
        one(photoProgram, "uOpacity", unit(options.opacity)); blend(); drawQuad();
        return available();
      } catch { return false; }
    },
    finishPhoto(typography = []) {
      if (!started || !available()) return null;
      outputGeometry(copyProgram); drawQuad();
      for (const layer of typography) {
        if (!layer.glyphs.length) continue;
        const texture = sourceTexture(layer.atlas, textTextures, 4);
        if (!texture) continue;
        for (const glyph of layer.glyphs) {
          geometry(textProgram, irisQuadClipVertices(glyph.vertices, frame.width, frame.height, glyph.uv));
          bindTexture(textProgram, "uImage", texture, 0);
          // Read the completed photo FBO while writing to the default buffer.
          bindTexture(textProgram, "uBackground", targetTexture!, 1);
          two(textProgram, "uRasterSize", raster.width, raster.height);
          one(textProgram, "uOpacity", unit(glyph.opacity)); blend(); drawQuad();
        }
      }
      return available() ? canvas : null;
    },
    dispose() {
      if (disposed) return;
      disposed = true; started = false;
      canvas.removeEventListener("webglcontextlost", contextLost);
      textures.forEach(texture => context.deleteTexture(texture)); textures.clear();
      textTextures.forEach(texture => context.deleteTexture(texture)); textTextures.clear();
      programs.forEach(program => context.deleteProgram(program.program));
      context.deleteBuffer(vertexBuffer); context.deleteBuffer(indexBuffer);
      context.deleteTexture(targetTexture); context.deleteFramebuffer(framebuffer);
    },
  };
}

function setTextureParameters(gl: Gl) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
