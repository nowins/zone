import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export function summarizeDurations(samples) {
  assert.ok(samples.length >= 5 && samples.every(value => Number.isFinite(value) && value >= 0), 'At least five finite duration samples are required.');
  const sorted = [...samples].sort((a, b) => a - b);
  return { unit: 'ms', samples, count: samples.length, median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1], min: sorted[0], max: sorted.at(-1), verdict: 'observed', threshold: null };
}
export async function imageOperation(action, input, output, options = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(import.meta.dirname, 'baselineImage.ps1'),
    '-Action', action, '-InputPath', input, '-OutputPath', output];
  for (const [name, value] of Object.entries(options)) args.push(`-${name}`, String(value));
  const result = await promisify(execFile)('powershell.exe', args, { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}
export async function baselineImagePath(reportPath, entry) {
  assert.match(entry.image, /^[a-z0-9-]+\.png$/);
  const root = await realpath(dirname(reportPath)), file = await realpath(resolve(root, entry.image));
  const difference = relative(root, file);
  assert.ok(difference && !difference.startsWith('..') && !isAbsolute(difference), 'Baseline image escaped report directory.');
  assert.equal(digest(await readFile(file)), entry.sha256, 'Baseline PNG bytes do not match the recorded hash.');
  return file;
}
export function reviewDecision(candidate, reference, approval) {
  if (!approval || approval.review?.status !== 'approved') return { status: 'needs-review', reason: 'No reviewed reference; candidate capture is not visual approval.' };
  assert.equal(approval.format, 'ZoneNativeBaselineReference'); assert.equal(approval.version, 1);
  assert.ok(typeof approval.review.reviewer === 'string' && approval.review.reviewer.trim());
  assert.ok(Number.isFinite(Date.parse(approval.review.reviewedAt)));
  assert.ok(Number.isInteger(approval.limits?.perChannelTolerance) && approval.limits.perChannelTolerance >= 0 && approval.limits.perChannelTolerance <= 255);
  assert.ok(Number.isFinite(approval.limits?.maxChangedPixelRatio) && approval.limits.maxChangedPixelRatio >= 0 && approval.limits.maxChangedPixelRatio <= 1);
  assert.equal(candidate.format, 'ZoneNativeBaseline'); assert.equal(reference.format, 'ZoneNativeBaseline');
  assert.equal(candidate.captureStatus, 'repeatable'); assert.equal(reference.captureStatus, 'repeatable');
  if (canonical(candidate.compatibility) !== canonical(reference.compatibility)) return { status: 'incompatible', reason: 'Viewport, renderer, image, fonts or fixture environment changed; review a new candidate.' };
  assert.deepEqual(candidate.scenes.map(scene => scene.id), reference.scenes.map(scene => scene.id));
  return { status: 'comparable' };
}
