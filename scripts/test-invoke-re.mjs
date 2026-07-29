import { readFileSync } from "node:fs";
const s = readFileSync("src/views/PodcastView.tsx", "utf8");
const re2 =
  /await invoke<PodcastRefreshReport>\([\s\S]*?"podcast_refresh_feeds"[\s\S]*?\)/g;
console.log("matches2", (s.match(re2) || []).length);
console.log((s.match(re2) || [])[0]);
console.log("---");
// non-greedy ) might stop too early at generic type?
const re3 =
  /await invoke<PodcastRefreshReport>\(\s*"podcast_refresh_feeds",\s*\{[^}]*\},\s*\)/g;
console.log("matches3", (s.match(re3) || []).length);
console.log((s.match(re3) || [])[0]);
