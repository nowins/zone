import { analyzePcmBeatGrid } from "../utils/beatAnalysis";

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const header = new DataView(event.data);
    if (header.getUint32(0, true) !== 1) throw new Error("分析数据版本不匹配");
    const grid = analyzePcmBeatGrid(new Float32Array(event.data, 24), header.getUint32(4, true));
    self.postMessage({ grid });
  } catch {
    self.postMessage({ error: true });
  }
};
