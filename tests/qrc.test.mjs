import assert from "node:assert/strict";
import test from "node:test";
import { parseTtml } from "../.tmp/visualizer-tests/utils/lyrics.js";
import {
  extractQrcLyricContent,
  isEncryptedQrc,
  parseQqLyricsResponse,
  qrcToTtml,
} from "../.tmp/visualizer-tests/utils/qrc.js";

test("QQ lyric response extraction tolerates its malformed XML wrapper", () => {
  const response = `<!--<root><miniversion="1" /><content><![CDATA[AABBCCDD00112233]]></content>
    <contentts><![CDATA[[00:01.00]你好 &amp; 世界]]></contentts></root>-->`;

  assert.deepEqual(parseQqLyricsResponse(response), {
    original: "AABBCCDD00112233",
    translation: "[00:01.00]你好 & 世界",
  });
  assert.equal(isEncryptedQrc(" AABBCCDD00112233\n"), true);
  assert.equal(isEncryptedQrc("[00:01.00]plain"), false);
});

test("QRC XML payload converts to TTML with exact word ranges and translation", () => {
  const qrc = extractQrcLyricContent(`<?xml version="1.0"?><QrcInfos><Lyric_1
    LyricContent="[1000,2200]He said &quot;hello&quot; (1000,500)&amp;(1500,200)world(1700,1500)" /></QrcInfos>`);
  const ttml = qrcToTtml(qrc, "[00:01.00]你好世界");
  const document = parseTtml("qq-track", "provider:qq:1", ttml, 4);

  assert.equal(document?.format, "word");
  assert.equal(document?.lines[0].text, 'He said "hello" &world');
  assert.equal(document?.lines[0].translation, "你好世界");
  assert.deepEqual(document?.lines[0].words, [
    { text: 'He said "hello" ', start: 1, end: 1.5 },
    { text: "&", start: 1.5, end: 1.7 },
    { text: "world", start: 1.7, end: 3.2 },
  ]);
});
