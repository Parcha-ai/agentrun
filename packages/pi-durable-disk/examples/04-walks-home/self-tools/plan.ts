// Writes the task instances for a run: train (the teacher's practice), heldout (new instances of the practised
// templates) and unseen (templates never practised). A held-out instance never repeats a training one.
//
//   node plan.ts --out DIR [--train 9] [--heldout 2] [--unseen 5]

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { makeInstances, type Instance } from "./tasks.ts";

const { values: a } = parseArgs({ options: { out: { type: "string" }, train: { type: "string", default: "9" }, heldout: { type: "string", default: "2" }, unseen: { type: "string", default: "5" } } });
const key = (x: Instance) => x.prompt + "\u0000" + JSON.stringify(x.files);
const train = makeInstances("train", Number(a.train));
const seen = new Set(train.map(key));
const heldout: Instance[] = [];
for (const x of makeInstances("heldout", Number(a.heldout))) {
  let y = x;
  for (let k = 1; seen.has(key(y)) && k < 50; k++) y = makeInstances("heldout", Number(a.heldout), `r${k}`).find((z) => z.id === `${x.id}r${k}`)!;
  if (seen.has(key(y))) continue; // the template has no unseen variation left
  seen.add(key(y));
  heldout.push(y);
}
const unseen = makeInstances("unseen", Number(a.unseen));
mkdirSync(a.out!, { recursive: true });
for (const [name, xs] of [["train", train], ["heldout", heldout], ["unseen", unseen]] as const) {
  writeFileSync(join(a.out!, `${name}.jsonl`), xs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  console.log(name, xs.length);
}
