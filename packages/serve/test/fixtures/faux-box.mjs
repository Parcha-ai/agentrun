// A faux box provider standing in for Docker (`startServe({ fauxBox })`): pi-transport's local box, its workspace the
// source of the spec's work mount, so a command's files land in the run's work/ as a bind would put them. A local box
// shares this machine (its files, /proc and network), so what it proves is the wiring: what the spec asks, which
// environment a command gets, and when a box is made, found and destroyed. Every spec, and every command a box runs, is
// written down under `<data>/faux-boxes/` for the tests to read.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { localBoxes } from "@parcha/pi-transport/box/local";

export const fauxRoot = (data) => join(data, "faux-boxes");

export default function fauxBoxes(data) {
  const root = fauxRoot(data);
  mkdirSync(root, { recursive: true });
  const local = localBoxes({ root });
  const note = (file, value) => appendFileSync(join(root, file), `${JSON.stringify(value)}\n`);
  const counted = (box) => ({
    id: box.id,
    facts: () => box.facts(),
    exec: (command, options, context) => (note("execs.jsonl", { box: box.id, command: command.slice(0, 2) }), box.exec(command, options, context)),
    upload: (files, context) => box.upload(files, context),
    download: (paths, context) => box.download(paths, context),
    status: (context) => box.status(context),
    destroy: (context) => (note("destroyed.jsonl", { box: box.id }), box.destroy(context)),
  });
  return {
    name: "faux",
    mounts: true,
    async create(spec, context) {
      note("specs.jsonl", spec);
      const work = spec.mounts?.find((mount) => mount.target === spec.workspace);
      const { mounts: _mounts, network: _network, workspace: _workspace, ...rest } = spec;
      const made = await local.create({ ...rest, ...(work ? { workspace: work.source } : {}) }, context);
      return made.ok ? { ok: true, value: counted(made.value) } : made;
    },
    async attach(id, context) {
      const found = await local.attach(id, context);
      return found.ok && found.value ? { ok: true, value: counted(found.value) } : found;
    },
    list: (labels, context) => local.list(labels, context),
  };
}
