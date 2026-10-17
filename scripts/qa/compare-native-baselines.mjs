import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineImagePath, digest, imageOperation, reviewDecision } from '../../tests/native/baselineSupport.mjs';

export async function compareNativeBaselines(candidatePath, approvalPath, outputDirectory) {
  if (approvalPath) {
    const reviewedRoot = await realpath(dirname(approvalPath));
    const difference = relative(reviewedRoot, resolve(outputDirectory));
    assert.ok(difference === '..' || difference.startsWith(`..${sep}`) || isAbsolute(difference), 'Comparison output must remain outside the reviewed reference directory.');
  }
  await mkdir(outputDirectory, { recursive: true });
  const candidate = JSON.parse(await readFile(candidatePath, 'utf8'));
  assert.equal(candidate.format, 'ZoneNativeBaseline'); assert.equal(candidate.version, 1);
  assert.equal(candidate.captureStatus, 'repeatable'); assert.ok(candidate.scenes.length > 0);
  const result = { candidateSourceSha: candidate.artifactSourceSha, status: 'needs-review', scenes: [],
    performance: { verdict: 'observed', candidate: candidate.measurements, threshold: null },
    reason: 'No approved visual reference; no performance budget is inferred from a first measurement.' };
  try {
    if (!approvalPath) return result;
    const approval = JSON.parse(await readFile(approvalPath, 'utf8'));
    if (approval.review?.status !== 'approved') return result;
    assert.ok(typeof approval.candidate === 'string' && !isAbsolute(approval.candidate));
    const root = await realpath(dirname(approvalPath));
    const referencePath = await realpath(resolve(root, approval.candidate));
    assert.ok(relative(root, referencePath) && !relative(root, referencePath).startsWith('..'), 'Reference report must remain inside its reviewed directory.');
    const referenceBytes = await readFile(referencePath);
    assert.equal(digest(referenceBytes), approval.candidateSha256, 'Reviewed report hash changed.');
    const reference = JSON.parse(referenceBytes);
    Object.assign(result, reviewDecision(candidate, reference, approval));
    result.referenceSourceSha = reference.artifactSourceSha; result.review = approval.review;
    if (result.status !== 'comparable') return result;
    result.performance.reference = reference.measurements;
    for (let i = 0; i < candidate.scenes.length; i++) {
      const current = candidate.scenes[i], previous = reference.scenes[i];
      const currentImage = await baselineImagePath(candidatePath, current), previousImage = await baselineImagePath(referencePath, previous);
      let row;
      if (current.viewport.crop.width !== previous.viewport.crop.width || current.viewport.crop.height !== previous.viewport.crop.height) {
        row = { id: current.id, status: 'failed', reason: 'Stable content region dimensions changed under the same environment.' };
      } else {
        const pixels = await imageOperation('Compare', currentImage, resolve(outputDirectory, `${current.id}-diff.png`),
          { ReferencePath: previousImage, Tolerance: approval.limits.perChannelTolerance });
        row = { id: current.id, ...pixels, limits: approval.limits,
          status: pixels.changedRatio <= approval.limits.maxChangedPixelRatio ? 'passed' : 'failed' };
      }
      result.scenes.push(row);
    }
    result.status = result.scenes.some(scene => scene.status === 'failed') ? 'failed' : 'passed';
    result.reason = 'Compared only against an explicitly reviewed, byte-verified reference and its declared limits.';
    return result;
  } catch (error) { result.status = 'failed'; result.error = error.stack ?? String(error); throw error; }
  finally { await writeFile(resolve(outputDirectory, 'comparison.json'), JSON.stringify(result, null, 2)); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i+1]; };
  const candidate = argument('candidate'); assert.ok(candidate, '--candidate is required');
  const result = await compareNativeBaselines(resolve(candidate), argument('reference'), resolve(argument('output', '.tmp/baseline-comparison')));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'passed' ? 0 : result.status === 'failed' ? 1 : 2;
}
