export type MosaicPoint = { x: number; y: number };
const projectedSurfaces = new WeakMap<CanvasRenderingContext2D, HTMLCanvasElement>();

/** A pinhole projection with a bounded local camera, independent of DPR. */
export function projectMosaicPoint(width: number, height: number, angle: number, u: number, v: number): MosaicPoint {
  const x = (u - 0.5) * width, y = (v - 0.5) * height;
  const distance = Math.max(800, width * 3);
  const scale = distance / (distance + x * Math.sin(angle));
  return { x: width / 2 + x * Math.cos(angle) * scale, y: height / 2 + y * scale };
}

/** Sixteen affine triangles approximate perspective-correct texture mapping. */
export function drawProjectedMosaicImage(
  context: CanvasRenderingContext2D, image: HTMLCanvasElement,
  x: number, y: number, width: number, height: number, angle: number,
) {
  let surface = projectedSurfaces.get(context);
  if (!surface) {
    surface = image.ownerDocument.createElement("canvas");
    projectedSurfaces.set(context, surface);
  }
  const rasterScale = Math.min(2, 1024 / (Math.max(width, height) * 1.5));
  const pixelWidth = Math.ceil(width * 1.5 * rasterScale), pixelHeight = Math.ceil(height * 1.5 * rasterScale);
  if (surface.width !== pixelWidth) surface.width = pixelWidth;
  if (surface.height !== pixelHeight) surface.height = pixelHeight;
  const mesh = surface.getContext("2d");
  if (!mesh) return;
  mesh.setTransform(1, 0, 0, 1, 0, 0);
  mesh.clearRect(0, 0, surface.width, surface.height);
  mesh.setTransform(rasterScale, 0, 0, rasterScale, width * 0.25 * rasterScale, height * 0.25 * rasterScale);
  mesh.globalAlpha = 1;
  mesh.imageSmoothingEnabled = true;
  mesh.imageSmoothingQuality = "high";
  const strips = 8;
  for (let index = 0; index < strips; index += 1) {
    const left = index / strips, right = (index + 1) / strips;
    const project = (u: number, v: number) => {
      const point = projectMosaicPoint(width, height, angle, u, v);
      return point;
    };
    const tl = project(left, 0), tr = project(right, 0), bl = project(left, 1), br = project(right, 1);
    drawTriangle(mesh, image, [{ x: left * image.width, y: 0 }, { x: right * image.width, y: 0 }, { x: left * image.width, y: image.height }], [tl, tr, bl], 1 / rasterScale);
    drawTriangle(mesh, image, [{ x: right * image.width, y: 0 }, { x: right * image.width, y: image.height }, { x: left * image.width, y: image.height }], [tr, br, bl], 1 / rasterScale);
  }
  context.save();
  context.beginPath();
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], index) => {
    const point = projectMosaicPoint(width, height, angle, u, v);
    if (index === 0) context.moveTo(x + point.x, y + point.y);
    else context.lineTo(x + point.x, y + point.y);
  });
  context.closePath();
  context.clip();
  // Composite once: overlapped mesh edges must not multiply face opacity.
  context.drawImage(surface, x - width * 0.25, y - height * 0.25, width * 1.5, height * 1.5);
  context.restore();
}

function drawTriangle(context: CanvasRenderingContext2D, image: HTMLCanvasElement, source: MosaicPoint[], target: MosaicPoint[], padding: number) {
  const [s0, s1, s2] = source, [t0, t1, t2] = target;
  const sx1 = s1.x - s0.x, sy1 = s1.y - s0.y, sx2 = s2.x - s0.x, sy2 = s2.y - s0.y;
  const determinant = sx1 * sy2 - sx2 * sy1;
  const tx1 = t1.x - t0.x, ty1 = t1.y - t0.y, tx2 = t2.x - t0.x, ty2 = t2.y - t0.y;
  const a = (tx1 * sy2 - tx2 * sy1) / determinant, c = (tx2 * sx1 - tx1 * sx2) / determinant;
  const b = (ty1 * sy2 - ty2 * sy1) / determinant, d = (ty2 * sx1 - ty1 * sx2) / determinant;
  context.save();
  context.beginPath();
  // Inflate the clip by one raster pixel around its incenter to cover the
  // shared antialias fringe. The final quad clip preserves the outer edges.
  const lengths = [Math.hypot(t2.x - t1.x, t2.y - t1.y), Math.hypot(t0.x - t2.x, t0.y - t2.y), Math.hypot(t1.x - t0.x, t1.y - t0.y)];
  const perimeter = lengths.reduce((sum, length) => sum + length, 0);
  const center = { x: (t0.x * lengths[0] + t1.x * lengths[1] + t2.x * lengths[2]) / perimeter,
    y: (t0.y * lengths[0] + t1.y * lengths[1] + t2.y * lengths[2]) / perimeter };
  const radius = Math.abs(tx1 * ty2 - tx2 * ty1) / perimeter;
  if (radius < 1e-5) { context.restore(); return; }
  const expansion = 1 + padding / radius;
  target.forEach((point, index) => {
    const px = center.x + (point.x - center.x) * expansion, py = center.y + (point.y - center.y) * expansion;
    if (index === 0) context.moveTo(px, py); else context.lineTo(px, py);
  });
  context.closePath();
  context.clip();
  context.transform(a, b, c, d, t0.x - a * s0.x - c * s0.y, t0.y - b * s0.x - d * s0.y);
  context.drawImage(image, 0, 0);
  context.restore();
}
