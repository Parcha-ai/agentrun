// The run's tree off the scratch disk, before the stop deletes it: every object under the run's directory (its store, its
// work/ with the edited model's requests, run.json), its own paths kept, into a local directory.
//   with-archil -- node chat/pull-run.ts <run id> <dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RunTreeReader {
  listObjects(prefix: string, options?: { recursive?: boolean; continuationToken?: string }): Promise<{ objects: { key: string }[]; isTruncated?: boolean; nextContinuationToken?: string }>;
  getObject(key: string): Promise<Uint8Array>;
}

export async function pullRunTree(control: RunTreeReader, id: string, dir: string, runPath: (id: string) => string): Promise<{ files: number; bytes: number }> {
  const prefix = `${runPath(id)}/`;
  let files = 0;
  let bytes = 0;
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await control.listObjects(prefix, { recursive: true, ...(continuationToken ? { continuationToken } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (continuationToken);
  for (const key of keys) {
    if (key.endsWith("/")) continue;
    const to = join(dir, key.slice(prefix.length));
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    const data = await control.getObject(key);
    writeFileSync(to, data, { mode: 0o600 });
    files++;
    bytes += data.length;
  }
  return { files, bytes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, dir] = process.argv.slice(2);
  if (!id || !dir) throw new Error("usage: node chat/pull-run.ts <run id> <dir>");
  const { configure, getDisk } = await import("disk");
  const { runPath } = await import("@parcha/pi-durable-disk");
  configure({ apiKey: process.env.ARCHIL_API_KEY!, region: process.env.PDA_LIVE_REGION! });
  const disk = (await getDisk(process.env.PDA_LIVE_DISK!)) as unknown as RunTreeReader;
  console.log(JSON.stringify({ id, dir, ...(await pullRunTree(disk, id, dir, runPath)) }));
}
