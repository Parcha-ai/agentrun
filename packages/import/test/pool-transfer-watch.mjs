// Loaded first in a pool worker (pool-transfer.test.mjs): adds to each reply the arrays of its indexes (mine, missed)
// that are not in the reply's transfer list, so would be copied to the main thread rather than moved.
import { parentPort } from "node:worker_threads";

const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message, transfer = []) => {
  const moved = new Set(transfer);
  const copied = [];
  const arrays = [];
  for (const index of ["mine", "missed"]) {
    for (const kind of ["uuids", "others"]) {
      const table = message?.[index]?.[kind];
      if (!table) continue;
      for (const [name, value] of Object.entries(table)) {
        if (!ArrayBuffer.isView(value)) continue;
        arrays.push(`${index}.${kind}.${name}`);
        if (!moved.has(value.buffer)) copied.push(`${index}.${kind}.${name}`);
      }
    }
  }
  return post(message && typeof message === "object" ? { ...message, watched: { arrays, copied } } : message, transfer);
};
