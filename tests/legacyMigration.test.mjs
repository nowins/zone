import assert from "node:assert/strict";
import test from "node:test";
import { migrateLegacyState } from "../.tmp/visualizer-tests/utils/legacyMigration.js";

function storage(raw) {
  const entries = new Map([["legacy", raw]]);
  return { entries, getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
}
test("failed import survives restart and successful retry preserves a recovery backup", async () => {
  const raw = JSON.stringify({ playlists: [{ id: "mine" }], homePins: [{ id: "pin" }] });
  const store = storage(raw);
  await assert.rejects(migrateLegacyState(store, "legacy", async () => { throw Error("database busy"); }));
  assert.equal(store.getItem("legacy"), raw);
  const result = await migrateLegacyState(store, "legacy", async value => value);
  assert.equal(result.playlists[0].id, "mine");
  assert.equal(store.getItem("legacy"), null);
  assert.equal(store.getItem("legacy-backup"), raw);
  let imports = 0;
  await migrateLegacyState(store, "legacy", async () => { imports++; });
  assert.equal(imports, 0);
});
test("malformed legacy data and backup-write failures never discard the original", async () => {
  const invalid = storage("{bad");
  await assert.rejects(migrateLegacyState(invalid, "legacy", async () => {}));
  assert.equal(invalid.getItem("legacy"), "{bad");
  const full = storage("{}");
  full.setItem = () => { throw Error("quota"); };
  await assert.rejects(migrateLegacyState(full, "legacy", async () => ({})));
  assert.equal(full.getItem("legacy"), "{}");
});
