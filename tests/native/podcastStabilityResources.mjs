import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
async function readLines(file) {
  const content = await fs.readFile(file, "utf8").catch(() => "");
  return content.replace(/^\uFEFF/, "").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const trend = rows => {
  const times = rows.map(row => (row.at - rows[0].at) / 60000);
  const meanTime = times.reduce((sum, value) => sum + value, 0) / times.length;
  const meanMemory = rows.reduce((sum, row) => sum + row.privateBytes, 0) / rows.length;
  const denominator = times.reduce((sum, time) => sum + (time - meanTime) ** 2, 0);
  return denominator ? rows.reduce((sum, row, index) => sum + (times[index] - meanTime) * (row.privateBytes - meanMemory), 0) / denominator / 1048576 : null;
};

export async function summarizeResources(file, warmupMs = 300000) {
  const samples = await readLines(file);
  if (!samples.length) return null;
  const sum = (rows, field) => rows.reduce((value, row) => value + row[field], 0);
  const series = samples.map(sample => ({ at: Date.parse(sample.at), processes: sample.processes.length,
    privateBytes: sum(sample.processes, "privateBytes"), handles: sum(sample.processes, "handles"),
    rootPrivateBytes: sample.processes.find(row => row.name === "zone-player")?.privateBytes }));
  const warm = series.filter(row => row.at - series[0].at >= warmupMs);
  const rows = warm.length >= 2 ? warm : series;
  const window = Math.min(12, Math.max(1, Math.floor(rows.length / 3)));
  const first = rows.slice(0, window); const last = rows.slice(-window);
  return { samples: samples.length, observedMinutes: (series.at(-1).at - series[0].at) / 60000,
    warmupExcludedMinutes: (rows[0].at - series[0].at) / 60000,
    privateMiB: { firstMedian: median(first.map(row => row.privateBytes)) / 1048576,
      lastMedian: median(last.map(row => row.privateBytes)) / 1048576,
      peak: Math.max(...series.map(row => row.privateBytes)) / 1048576, slopeMiBPerMinute: trend(rows) },
    rootPrivateMiB: { firstMedian: median(first.map(row => row.rootPrivateBytes)) / 1048576,
      lastMedian: median(last.map(row => row.rootPrivateBytes)) / 1048576 },
    handles: { firstMedian: median(first.map(row => row.handles)), lastMedian: median(last.map(row => row.handles)),
      min: Math.min(...rows.map(row => row.handles)), max: Math.max(...rows.map(row => row.handles)) },
    processes: { min: Math.min(...rows.map(row => row.processes)), max: Math.max(...rows.map(row => row.processes)) } };
}

export async function summarizeResourceStages(resourcesFile, eventsFile) {
  const samples = await readLines(resourcesFile);
  const stages = (await readLines(eventsFile)).filter(event => event.kind === "resource-stage");
  return stages.map(stage => {
    const end = Date.parse(stage.at);
    const rows = samples.filter(row => Date.parse(row.at) <= end && Date.parse(row.at) >= end - 12000);
    const totals = field => rows.map(row => row.processes.reduce((sum, process) => sum + process[field], 0));
    return { stage: stage.stage, samples: rows.length,
      privateMiB: median(totals("privateBytes")) / 1048576, handles: median(totals("handles")),
      rootPrivateMiB: median(rows.map(row => row.processes.find(process => process.name === "zone-player")?.privateBytes)) / 1048576 };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [resourcesFile, eventsFile] = process.argv.slice(2);
  console.log(JSON.stringify({ resources: await summarizeResources(resourcesFile),
    stages: eventsFile ? await summarizeResourceStages(resourcesFile, eventsFile) : [] }, null, 2));
}
