import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const testsDir = "tests";
const extra = [
  "src/views/podcast/usePodcastViewModel.ts",
  "src/views/podcast/api.ts",
  "src/views/podcast/screens/ListenScreen.tsx",
  "src/views/podcast/screens/DiscoverScreen.tsx",
  "src/views/podcast/screens/LibraryScreen.tsx",
  "src/views/podcast/screens/PlaylistScreen.tsx",
  "src/views/podcast/screens/ShowScreen.tsx",
  "src/views/podcast/screens/EpisodeScreen.tsx",
];

for (const file of readdirSync(testsDir)) {
  if (!file.endsWith(".mjs")) continue;
  const path = join(testsDir, file);
  let src = readFileSync(path, "utf8");
  if (!src.includes("PodcastView.tsx")) continue;
  if (src.includes("usePodcastViewModel.ts")) {
    console.log("skip", file);
    continue;
  }

  if (src.includes('"src/views/PodcastView.tsx"')) {
    src = src.replace(
      '"src/views/PodcastView.tsx",',
      `"src/views/PodcastView.tsx",\n  ${extra.map((e) => `"${e}"`).join(",\n  ")},`,
    );
  }

  if (src.includes('"../src/views/PodcastView.tsx"')) {
    const relExtra = extra.map((e) => `"../${e}"`);
    src = src.replace(
      '"../src/views/PodcastView.tsx",',
      `"../src/views/PodcastView.tsx",\n  ${relExtra.join(",\n  ")},`,
    );
  }

  if (src.includes('readFileSync("src/views/PodcastView.tsx"')) {
    src = src.replace(
      'const viewSource = readFileSync("src/views/PodcastView.tsx", "utf8");',
      `const viewSource = [\n  "src/views/PodcastView.tsx",\n  ${extra
        .map((e) => `"${e}"`)
        .join(",\n  ")},\n].map((path) => readFileSync(path, "utf8")).join("\\n");`,
    );
  }

  writeFileSync(path, src);
  console.log("updated", file);
}
