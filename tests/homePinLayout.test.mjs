import assert from "node:assert/strict";
import test from "node:test";
import { layoutHomePins, resolveHomePinPlacement } from "../.tmp/visualizer-tests/utils/homePinLayout.js";

const pins = [
  { id: "artist", size: "wide" },
  { id: "album", size: "wide" },
  { id: "mosaic", size: "large" },
  { id: "podcast", size: "wide" },
  { id: "drag", size: "wide" },
];

test("sparse column placement preserves the mixed-size hole from the reported wall", () => {
  assert.deepEqual([...layoutHomePins(pins).values()], [
    { column: 0, row: 0 }, { column: 0, row: 2 }, { column: 4, row: 0 },
    { column: 4, row: 4 }, { column: 8, row: 0 },
  ]);
});

test("dragging into the lower-left hole inserts before the large tile instead of appending", () => {
  assert.deepEqual(resolveHomePinPlacement(pins, "drag", 0, 4), { target: "mosaic", after: false });
  assert.deepEqual(resolveHomePinPlacement(pins, "podcast", 0, 4), { target: "mosaic", after: false });
  assert.equal(resolveHomePinPlacement(pins, "drag", 8, 0), null, "returning to the original slot cancels the preview");
});

test("all small, medium, wide and large insertion slots remain reachable", () => {
  for (const size of ["small", "medium", "wide", "large"]) {
    const others = pins.slice(0, -1);
    const original = [...others, { id: "drag", size }];
    for (let index = 0; index <= others.length; index++) {
      const candidate = [...others];
      candidate.splice(index, 0, original.at(-1));
      const desired = layoutHomePins(candidate).get("drag");
      const placement = resolveHomePinPlacement(original, "drag", desired.column, desired.row);
      const actual = [...original];
      if (placement) {
        const source = actual.pop();
        actual.splice(actual.findIndex(pin => pin.id === placement.target) + Number(placement.after), 0, source);
      }
      assert.deepEqual(layoutHomePins(actual).get("drag"), desired, `${size}, insertion ${index}`);
    }
  }
});
