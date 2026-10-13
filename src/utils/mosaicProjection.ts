export type MosaicPoint = { x: number; y: number };
export type MosaicRect = MosaicPoint & { width: number; height: number };
export type MosaicCamera = {
  distance: number;
  centerX: number;
  centerY: number;
  scale: number;
  offsetX: number;
  offsetY: number;
};
const projectedSurfaces = new WeakMap<CanvasRenderingContext2D, HTMLCanvasElement>();

/** Default Iris window: Eye.z=-10, Zn=5, units=max(viewport)/2.
 * Canvas compensates the D3D9 half-pixel offset after viewport mapping. */
export function createMosaicCamera(width: number, height: number, scale = 1, driftX = 0, driftY = 0): MosaicCamera {
  return {
    distance: 5 * Math.max(1, width, height), centerX: width / 2 + 0.5, centerY: height / 2 + 0.5,
    scale, offsetX: width / 2 * (1 - scale) + driftX * scale,
    offsetY: height / 2 * (1 - scale) + driftY * scale,
  };
}

/** Rotate in the wall, project through its shared camera, then return to the
 * wall's Canvas coordinates. Depth includes the parent wall scale. */
export function projectMosaicPoint(tile: MosaicRect, camera: MosaicCamera, angle: number, u: number, v: number): MosaicPoint {
  const dx = (u - 0.5) * tile.width, dy = (v - 0.5) * tile.height;
  const x = (tile.x + tile.width / 2 + dx * Math.cos(angle)) * camera.scale + camera.offsetX;
  const y = (tile.y + tile.height / 2 + dy) * camera.scale + camera.offsetY;
  // Iris row-vector Y rotation sends the right edge toward Eye.z < 0.
  const depth = -dx * Math.sin(angle) * camera.scale;
  const ratio = camera.distance / (camera.distance + depth);
  return {
    x: (camera.centerX + (x - camera.centerX) * ratio - camera.offsetX) / camera.scale,
    y: (camera.centerY + (y - camera.centerY) * ratio - camera.offsetY) / camera.scale,
  };
}

/** Sixteen affine triangles approximate perspective-correct texture mapping. */
export function drawProjectedMosaicImage(
  context: CanvasRenderingContext2D, image: HTMLCanvasElement,
  tile: MosaicRect, camera: MosaicCamera, angle: number,
) {
  const project = (u: number, v: number) => projectMosaicPoint(tile, camera, angle, u, v);
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => project(u, v));
  const leftBound = Math.min(...corners.map(point => point.x)), topBound = Math.min(...corners.map(point => point.y));
  const width = Math.max(1e-5, Math.max(...corners.map(point => point.x)) - leftBound);
  const height = Math.max(1e-5, Math.max(...corners.map(point => point.y)) - topBound);
  let surface = projectedSurfaces.get(context);
  if (!surface) {
    surface = image.ownerDocument.createElement("canvas");
    projectedSurfaces.set(context, surface);
  }
  const rasterScale = Math.min(2, 1022 / Math.max(width, height));
  const padding = 1 / rasterScale;
  const pixelWidth = Math.min(1024, Math.ceil(width * rasterScale) + 2);
  const pixelHeight = Math.min(1024, Math.ceil(height * rasterScale) + 2);
  if (surface.width !== pixelWidth) surface.width = pixelWidth;
  if (surface.height !== pixelHeight) surface.height = pixelHeight;
  const mesh = surface.getContext("2d");
  if (!mesh) return;
  mesh.setTransform(1, 0, 0, 1, 0, 0);
  mesh.clearRect(0, 0, surface.width, surface.height);
  mesh.setTransform(rasterScale, 0, 0, rasterScale, 1 - leftBound * rasterScale, 1 - topBound * rasterScale);
  mesh.globalAlpha = 1;
  mesh.imageSmoothingEnabled = true;
  mesh.imageSmoothingQuality = "high";
  const strips = 8;
  for (let index = 0; index < strips; index += 1) {
    const left = index / strips, right = (index + 1) / strips;
    const tl = project(left, 0), tr = project(right, 0), bl = project(left, 1), br = project(right, 1);
    drawTriangle(mesh, image, [{ x: left * image.width, y: 0 }, { x: right * image.width, y: 0 }, { x: left * image.width, y: image.height }], [tl, tr, bl], 1 / rasterScale);
    drawTriangle(mesh, image, [{ x: right * image.width, y: 0 }, { x: right * image.width, y: image.height }, { x: left * image.width, y: image.height }], [tr, br, bl], 1 / rasterScale);
  }
  context.save();
  context.beginPath();
  corners.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();
  context.clip();
  // Composite once: overlapped mesh edges must not multiply face opacity.
  context.drawImage(surface, leftBound - padding, topBound - padding, surface.width / rasterScale, surface.height / rasterScale);
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
