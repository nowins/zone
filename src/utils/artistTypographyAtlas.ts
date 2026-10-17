import { ARTIST_TEXT_REFERENCE, artistTextGraphemes, artistTypographyFrame, artistTypographyLines,
  type ArtistTypographyClip, type ArtistTypographyKind, type ArtistTypographyLine, type ArtistTypographyModel } from "./artistTypography.js";
import type { IrisTypography } from "./irisGpuRenderer.js";

const FONT = '"Segoe UI Variable Display", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const MAX_ATLAS_EDGE = 1024;
type Glyph = { text: string; size: number; weight: number; width: number; ascent: number; descent: number;
  left: number; right: number; atlasX: number; atlasY: number; atlasWidth: number; atlasHeight: number };
type PlacedGlyph = { glyph: Glyph; line: ArtistTypographyLine; index: number; count: number; x: number; y: number };
export type ArtistTypographyAtlas = { canvas: HTMLCanvasElement; scale: number; placed: PlacedGlyph[] };

/** Immutable glyphs are rasterized only when local metadata or the clip changes. */
export function createArtistTypographyAtlas(ownerDocument: Document, kind: ArtistTypographyKind,
  model: ArtistTypographyModel): ArtistTypographyAtlas | null {
  const canvas = ownerDocument.createElement("canvas"), context = canvas.getContext("2d");
  if (!context || typeof context.measureText !== "function" || typeof context.fillText !== "function") return null;
  const lines = artistTypographyLines(kind, model), glyphMap = new Map<string, Glyph>();
  const key = (text: string, line: ArtistTypographyLine) => JSON.stringify([text, line.size, line.weight]);
  for (const line of lines) for (const text of artistTextGraphemes(line.text)) {
    const id = key(text, line);
    if (glyphMap.has(id)) continue;
    context.font = `${line.weight} ${line.size}px ${FONT}`;
    const metrics = context.measureText(text);
    const left = Math.max(0, metrics.actualBoundingBoxLeft || 0);
    const right = Math.max(metrics.width, metrics.actualBoundingBoxRight || 0);
    glyphMap.set(id, { text, size: line.size, weight: line.weight, width: metrics.width,
      ascent: Math.max(line.size * .8, metrics.actualBoundingBoxAscent || 0),
      descent: Math.max(line.size * .2, metrics.actualBoundingBoxDescent || 0), left, right,
      atlasX: 0, atlasY: 0, atlasWidth: 0, atlasHeight: 0 });
  }
  const glyphs = [...glyphMap.values()];
  let scale = 2, usedWidth = 1, usedHeight = 1;
  while (scale >= .25) {
    let x = 0, y = 0, rowHeight = 0;
    usedWidth = 1;
    for (const glyph of glyphs) {
      const width = Math.ceil((glyph.left + glyph.right) * scale) + 4;
      const height = Math.ceil((glyph.ascent + glyph.descent) * scale) + 4;
      if (x + width > MAX_ATLAS_EDGE) { x = 0; y += rowHeight; rowHeight = 0; }
      Object.assign(glyph, { atlasX: x, atlasY: y, atlasWidth: width, atlasHeight: height });
      x += width; rowHeight = Math.max(rowHeight, height); usedWidth = Math.max(usedWidth, x);
    }
    usedHeight = y + rowHeight;
    if (usedHeight <= MAX_ATLAS_EDGE && usedWidth <= MAX_ATLAS_EDGE) break;
    scale *= .75;
  }
  if (usedHeight > MAX_ATLAS_EDGE || usedWidth > MAX_ATLAS_EDGE) return null;
  canvas.width = usedWidth; canvas.height = Math.max(1, usedHeight);
  context.fillStyle = "white"; context.textBaseline = "alphabetic";
  for (const glyph of glyphs) {
    context.font = `${glyph.weight} ${glyph.size * scale}px ${FONT}`;
    context.fillText(glyph.text, glyph.atlasX + 2 + glyph.left * scale, glyph.atlasY + 2 + glyph.ascent * scale);
  }
  const placed: PlacedGlyph[] = [];
  let wrappedBottom = 0;
  for (const line of lines) {
    const characters = artistTextGraphemes(line.text);
    let x = 0, y = line.wrap ? Math.max(line.y, wrappedBottom) : line.y;
    let row = 0;
    const availableWidth = ARTIST_TEXT_REFERENCE.width - line.x - 36;
    const measuredWidth = characters.reduce((sum, character) => sum + glyphMap.get(key(character, line))!.width, 0);
    // Balance continuous Chinese titles to avoid one orphan character.
    const rows = Math.max(1, Math.ceil(measuredWidth / availableWidth));
    const maximumWidth = /\p{Script=Han}/u.test(line.text) && !/\s/.test(line.text) && rows === 2
      ? Math.min(availableWidth, measuredWidth / rows + line.size / 2) : availableWidth;
    // Keep whole local words together when they fit; Chinese falls back to graphemes.
    for (let index = 0; index < characters.length; index++) {
      const glyph = glyphMap.get(key(characters[index], line))!;
      if (line.wrap && x > 0) {
        let nextWidth = glyph.width;
        if (index === 0 || /\s/.test(characters[index - 1])) {
          for (let next = index + 1; next < characters.length && !/\s/.test(characters[next]); next++)
            nextWidth += glyphMap.get(key(characters[next], line))!.width;
        }
        if (x + Math.min(nextWidth, maximumWidth) > maximumWidth) { x = 0; y += line.size * 1.02; row++; }
      }
      if (line.wrap && row >= 2) break;
      placed.push({ glyph, line, index, count: characters.length, x: line.x + x, y });
      x += glyph.width;
    }
    if (line.wrap) wrappedBottom = y + line.size * 1.1;
  }
  return { canvas, scale, placed };
}

export function artistTypographyQuads(atlas: ArtistTypographyAtlas, clip: ArtistTypographyClip,
  elapsedMs: number, width: number, height: number, reduced: boolean, opacity = 1): IrisTypography {
  const scale = Math.min(width / ARTIST_TEXT_REFERENCE.width, height / ARTIST_TEXT_REFERENCE.height);
  const offsetX = (width - ARTIST_TEXT_REFERENCE.width * scale) / 2;
  const offsetY = (height - ARTIST_TEXT_REFERENCE.height * scale) / 2;
  const glyphs: IrisTypography["glyphs"][number][] = [];
  for (const item of atlas.placed) {
    const animation = artistTypographyFrame(clip.kind, item.line, item.index, item.count, elapsedMs - clip.originMs, reduced);
    const alpha = animation.opacity * opacity;
    if (alpha <= .001 || /\s/.test(item.glyph.text)) continue;
    const glyph = item.glyph, padding = 2 / atlas.scale;
    const left = item.x - glyph.left - padding, top = item.y - glyph.ascent - padding;
    const right = left + glyph.atlasWidth / atlas.scale, bottom = top + glyph.atlasHeight / atlas.scale;
    const cos = Math.cos(item.line.angle), sin = Math.sin(item.line.angle);
    const vertex = (x: number, y: number) => {
      const dx = x - item.line.x, dy = y - item.line.y;
      return { x: offsetX + (item.line.x + dx * cos - dy * sin + animation.x) * scale,
        y: offsetY + (item.line.y + dx * sin + dy * cos + animation.y) * scale, w: 1 };
    };
    const u = glyph.atlasX / atlas.canvas.width, v = glyph.atlasY / atlas.canvas.height;
    const u2 = (glyph.atlasX + glyph.atlasWidth) / atlas.canvas.width, v2 = (glyph.atlasY + glyph.atlasHeight) / atlas.canvas.height;
    const vertices = [vertex(left, top), vertex(right, top), vertex(right, bottom), vertex(left, bottom)] as const;
    if (vertices.every(point => point.x < 0) || vertices.every(point => point.x > width)
      || vertices.every(point => point.y < 0) || vertices.every(point => point.y > height)) continue;
    glyphs.push({ vertices, uv: [{ u, v }, { u: u2, v }, { u: u2, v: v2 }, { u, v: v2 }], opacity: alpha });
  }
  return { atlas: atlas.canvas, glyphs };
}

/** Canvas degradation retains composition but cannot match the native photo shader. */
export function drawArtistTypography(context: CanvasRenderingContext2D, layers: readonly IrisTypography[]) {
  if (typeof context.save !== "function") return;
  context.save(); context.globalCompositeOperation = "overlay";
  for (const layer of layers) for (const glyph of layer.glyphs) {
    const [a, b, , d] = glyph.vertices, [uv, uv2, , uv4] = glyph.uv;
    context.save(); context.globalAlpha = glyph.opacity;
    context.transform(b.x - a.x, b.y - a.y, d.x - a.x, d.y - a.y, a.x, a.y);
    context.drawImage(layer.atlas, uv.u * layer.atlas.width, uv.v * layer.atlas.height,
      (uv2.u - uv.u) * layer.atlas.width, (uv4.v - uv.v) * layer.atlas.height, 0, 0, 1, 1);
    context.restore();
  }
  context.restore();
}
