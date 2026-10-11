// A rehearsal helper: put a creature's files into the run's work/creature/ on the disk, as the creature tab does when a design is
// saved, so the agent finds them in its workspace when the page attaches. The take itself needs none of this (the tab writes them).
//   node scripts/seed-creature.ts <run link> <body.json> [creature.xml]       (ARCHIL_API_KEY, PDA_LIVE_DISK, PDA_LIVE_REGION in the environment)
import { readFileSync } from "node:fs";
import { configure, getDisk } from "disk";

const [link, body, xml] = [process.argv[2]!, process.argv[3]!, process.argv[4]];
const run = new URL(link).pathname.split("/").pop()!;
configure({ apiKey: process.env.ARCHIL_API_KEY!, region: process.env.PDA_LIVE_REGION! });
const disk = await getDisk(process.env.PDA_LIVE_DISK!);
const put = async (name: string, file: string) => {
  const bytes = readFileSync(file);
  const owner = { uid: Number(process.env.PDA_UID ?? 1000), gid: Number(process.env.PDA_GID ?? 1000) };
  const put = (disk as unknown as { putObject(key: string, body: Uint8Array | string, meta?: Record<string, unknown>): Promise<unknown> }).putObject.bind(disk);
  // The run user owns the workspace: directory markers and the file get its ids, as when the pipe writes them.
  await put(`runs/${run}/work/`, "", { ...owner, mode: 0o755 });
  await put(`runs/${run}/work/creature/`, "", { ...owner, mode: 0o755 });
  await put(`runs/${run}/work/creature/${name}`, bytes, { ...owner, mode: 0o644 });
  console.log(JSON.stringify({ seeded: `creature/${name}`, bytes: bytes.length }));
};
await put("body.json", body);
if (xml) await put("creature.xml", xml);
