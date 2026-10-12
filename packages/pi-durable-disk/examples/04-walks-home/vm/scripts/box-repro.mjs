// One box of D2's image: put files on it, run a command, print its exit and output (stdout and stderr). Under the Modal wrapper:
//   with-modal node scripts/box-repro.mjs --image im-... --put /workspace/body/body.xml=./body.xml --put ... --cmd "train-skill walk --body /workspace/body --out /workspace/skills/walk"
import { readFileSync } from "node:fs";
import { modalCloud } from "../modal-cloud.ts";
import { createGpuClient, serveGpu } from "../../../03-tab-to-cloud/pipe/gpu-rpc.ts";

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const puts = args.flatMap((a, i) => (a === "--put" ? [args[i + 1]] : []));
const image = arg("image", "");
if (!image) throw new Error("--image names the trainer image");
const cloud = await modalCloud({
  disk: "dsk-smoke", region: "aws-us-east-1", model: { baseUrl: "http://127.0.0.1:9/v1", model: "x", budgetTokens: 1 },
  log: () => undefined, control: {}, regions: ["us-east"], appName: arg("app", "pda-demo-d4"), namePrefix: "pda-demo-d4-repro-",
  cluster: { size: 1, image, cpu: 8, memoryMiB: 65536, ttlMinutes: 15, readyCommand: "nvidia-smi -L", skills: ["walk"], start: "now" },
});
let code = 0;
try {
  await cloud.cluster.start();
  let client;
  const serving = serveGpu(cloud.cluster.gpuFor("repro"), (frame) => queueMicrotask(() => client.handle(frame)));
  client = createGpuClient((frame) => (queueMicrotask(() => serving.handle(frame)), true));
  const id = await client.acquire("repro");
  const box = client.linkBox(id);
  const run = async (argv, stdin) => {
    const p = await box.exec(argv, { mode: "binary", timeoutMs: Number(arg("timeout-ms", 120000)) });
    if (stdin) { await p.stdin.writeBytes(stdin); }
    await p.stdin.close();
    let out = "", err = "";
    await Promise.all([(async () => { for await (const c of p.stdout) out += new TextDecoder().decode(c); })(), (async () => { for await (const c of p.stderr) err += new TextDecoder().decode(c); })()]);
    return { code: await p.wait(), out, err };
  };
  for (const spec of puts) {
    const [to, from] = [spec.slice(0, spec.indexOf("=")), spec.slice(spec.indexOf("=") + 1)];
    const r = await run(["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", to], readFileSync(from));
    if (r.code !== 0) throw new Error(`put ${to}: ${r.err}`);
  }
  const r = await run(["sh", "-c", arg("cmd", "ls /workspace")]);
  code = r.code === 0 ? 0 : 1; // the script says whether the remote command worked
  console.log(`exit ${r.code}\n--- stdout\n${r.out.slice(-3000)}\n--- stderr\n${r.err.slice(-3000)}`);
  await client.release("repro");
} catch (error) {
  code = 1;
  console.log(`FAIL ${error.stack ?? error.message}`);
} finally {
  await cloud.close();
}
process.exit(code);
