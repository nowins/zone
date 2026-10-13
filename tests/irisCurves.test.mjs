import assert from "node:assert/strict";
import test from "node:test";
import {
  irisBezier,
  irisEaseIn,
  irisExponential,
  irisLogarithmic,
  irisSCurve,
} from "../.tmp/visualizer-tests/motion/irisCurves.js";

function near(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);
}

test("Iris Bezier uses quintic ordinate controls rather than CSS cubic coordinates", () => {
  near(irisBezier(0.25, 1, 1), 0.3671875);
  near(irisBezier(0.5, 1, 1), 0.8125);
  near(irisBezier(0.75, 1, 1), 0.984375);
  near(irisBezier(0.5, 0, 1), 0.5);
  near(irisBezier(0.5, 0, 0), 0.1875);
  near(irisBezier(0.5, 0.2, 0.8), 0.5);
  assert.notEqual(irisBezier(0.5, 1, 1), 0.875, "the former cubic approximation advances too quickly");
});

test("native exponential and logarithmic anchors retain the reciprocal and linear limits", () => {
  near(irisExponential(0.5, 25), 1 / 6);
  near(irisLogarithmic(0.5, 25), 5 / 6);
  near(irisExponential(0.5, 1_000_000), 1 / 1001);
  near(irisLogarithmic(0.5, 1_000_000), 1000 / 1001);
  for (const t of [0, 0.2, 0.5, 0.9, 1]) {
    assert.equal(irisExponential(t, 1), t);
    assert.equal(irisLogarithmic(t, 1), t);
    near(irisExponential(t, 1 + 1e-12), t);
    near(irisExponential(t, 1 - 1e-12), t);
  }
  assert.ok(Number.isFinite(irisExponential(0.9, Number.MAX_VALUE)), "large finite weights cannot overflow the normalized quotient");
});

test("SCurve matches native weight 2.5 anchors and joins the mirrored halves continuously", () => {
  near(irisSCurve(0.25, 2.5), 0.19371294336139656);
  near(irisSCurve(0.5, 2.5), 0.5);
  near(irisSCurve(0.75, 2.5), 0.8062870566386034);
  const delta = 1e-6;
  const before = (0.5 - irisSCurve(0.5 - delta, 2.5)) / delta;
  const after = (irisSCurve(0.5 + delta, 2.5) - 0.5) / delta;
  near(before, after, 1e-8);
  for (const t of [0.1, 0.3, 0.7, 0.9]) near(irisSCurve(t, 2.5) + irisSCurve(1 - t, 2.5), 1);
});

test("GridShow EaseIn alpha and scale preserve their independent native joins", () => {
  // Decimal anchors independently evaluated at 55 digits from the native formula.
  near(irisEaseIn(0.5, 5, 0.5), 0.6661875990895327);
  near(irisEaseIn(0.75, 5, 0.5), 0.8968462951855624);
  near(irisEaseIn(0.5, 10, 0.5), 0.7166494787033926);
  near(irisEaseIn(0.75, 10, 0.5), 0.9319241664225868);
  for (const weight of [5, 10]) {
    const join = irisEaseIn(0.5, weight, 0.5);
    const before = irisEaseIn(0.5 - 1e-8, weight, 0.5);
    const after = irisEaseIn(0.5 + 1e-8, weight, 0.5);
    assert.ok(before < join && after > join);
    near(before, after, 4e-8);
    near(irisEaseIn(0.25, weight, 0.5), join / 2, 1e-12);
  }
});

test("used Iris curves are bounded, monotonic, and exact at clamped endpoints", () => {
  const curves = [
    t => irisBezier(t, 1, 1),
    t => irisEaseIn(t, 5, 0.5),
    t => irisEaseIn(t, 10, 0.5),
    ...[0.1, 1, 2.5, 10, 5000].flatMap(weight => [
      t => irisExponential(t, weight), t => irisLogarithmic(t, weight), t => irisSCurve(t, weight),
    ]),
  ];
  for (const curve of curves) {
    assert.equal(curve(-1), 0);
    assert.equal(curve(0), 0);
    assert.equal(curve(1), 1);
    assert.equal(curve(2), 1);
    let previous = 0;
    for (let step = 1; step <= 1000; step++) {
      const current = curve(step / 1000);
      assert.ok(Number.isFinite(current) && current >= previous && current <= 1);
      previous = current;
    }
  }
});
