// Plans a bigger, cleaner run: a fixed held-out set first, then practice instances that never repeat it, topped up per
// template until each has enough kept trajectories.
//
//   node topup.ts heldout --per 5 --exclude a.jsonl,b.jsonl --out heldout.jsonl [--templates a,b]
//       new held-out instances, none equal to an instance in the --exclude files
//   node topup.ts train --runs r1.jsonl,r2.jsonl --instances i1.jsonl,i2.jsonl --heldout heldout.jsonl --target 24 --salt c1 --out more.jsonl
//       for each template short of --target kept runs (kept as export.ts keeps them, never on a held-out instance),
//       enough new instances to fill it at that template's observed keep rate

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { canonical } from "./export.ts";
import { TEMPLATES, makeInstances, type Instance } from "./tasks.ts";

const { values: a, positionals } = parseArgs({
  options: { per: { type: "string", default: "5" }, exclude: { type: "string", default: "" }, out: { type: "string" }, runs: { type: "string", default: "" },
    instances: { type: "string", default: "" }, heldout: { type: "string" }, target: { type: "string", default: "24" }, salt: { type: "string", default: "c1" },
    "offline-only": { type: "boolean", default: false }, templates: { type: "string", default: "" }, rate: { type: "string", default: "0.15" } },
  allowPositionals: true,
});
const read = (fs: string) => fs.split(",").filter(Boolean).flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
// A follow-up's identity includes its first task ("Run it again." after different scripts is a different instance).
const key = (x: Instance) => x.prompt + "\u0000" + JSON.stringify(x.files) + "\u0000" + ((x.params?.first as { prompt?: string } | undefined)?.prompt ?? "");
const write = (xs: Instance[]) => { writeFileSync(a.out!, xs.map((x) => JSON.stringify(x)).join("\n") + "\n"); };

if (positionals[0] === "heldout") {
  const taken = new Set(read(a.exclude!).map(key));
  const out: Instance[] = [];
  const only = a.templates!.split(",").filter(Boolean);
  for (const t of TEMPLATES.filter((t) => !t.unseen && (!only.length || only.includes(t.name)))) {
    let k = 0, made = 0;
    while (made < Number(a.per) && k < 400) {
      const x = makeInstances("heldout", 1, `h${k++}`).find((z) => z.template === t.name)!;
      if (taken.has(key(x))) continue;
      taken.add(key(x));
      out.push({ ...x, id: `heldout-${t.name}-${made++}` });
    }
  }
  write(out);
  console.log(JSON.stringify({ heldout: out.length }));
} else if (positionals[0] === "train") {
  const held = new Set(read(a.heldout!).map(key));
  const insts = new Map(read(a.instances!).map((x: Instance) => [x.id, x]));
  const kept: Record<string, number> = {}, tried: Record<string, number> = {};
  for (const r of read(a.runs!).filter((r: any) => r.split === "train")) {
    const inst = insts.get(r.id);
    if (!inst || held.has(key(inst))) continue;
    tried[r.template] = (tried[r.template] ?? 0) + 1;
    if (r.ok && !("reject" in canonical(r.messages, a["offline-only"]))) kept[r.template] = (kept[r.template] ?? 0) + 1;
  }
  const taken = new Set([...held, ...[...insts.values()].map(key)]);
  const out: Instance[] = [];
  const short: Record<string, number> = {};
  const only = a.templates!.split(",").filter(Boolean);
  for (const t of TEMPLATES.filter((t) => !t.unseen && (!only.length || only.includes(t.name)))) {
    const need = Number(a.target) - (kept[t.name] ?? 0);
    if (need <= 0) continue;
    short[t.name] = need;
    // The observed keep rate, or --rate for a template with no runs yet.
    const rate = tried[t.name] ? Math.max(0.15, (kept[t.name] ?? 0) / tried[t.name]!) : Number(a.rate);
    const want = Math.ceil((need / rate) * 1.25);
    let k = 0, made = 0;
    while (made < want && k < 2000) {
      const x = makeInstances("train", 1, `${a.salt}-${k++}`).find((z) => z.template === t.name)!;
      if (taken.has(key(x))) continue;
      taken.add(key(x));
      out.push({ ...x, id: `train-${t.name}-${a.salt}-${made++}` });
    }
  }
  write(out);
  console.log(JSON.stringify({ more: out.length, short }));
}
