// The cluster pool on real Modal, with no VM and no session: create N boxes of D2's image, wait until each is ready, run a command in each through the same
// path the VM uses (gpu-rpc over a loopback), remove everything, and say what it cost in time. Run under the Modal wrapper:
//   with-modal node scripts/pool-smoke.mjs --image im-... [--size 2] [--ready "nvidia-smi -L"] [--cmd "train-skill --help"] [--ttl 20]
import { modalCloud } from "../modal-cloud.ts";
import { createGpuClient, serveGpu } from "../../../03-tab-to-cloud/pipe/gpu-rpc.ts";

const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const image = arg("image", "");
if (!image) throw new Error("--image names the trainer image");
const size = Number(arg("size", 2));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const events = [];
const cloud = await modalCloud({
  disk: "dsk-smoke", region: "aws-us-east-1", model: { baseUrl: "http://127.0.0.1:9/v1", model: "x", budgetTokens: 1 },
  log: (event, data = {}) => { events.push({ event, ...data }); if (/^(pool|cluster)\./.test(event)) console.log(`${at()} ${event} ${JSON.stringify(data).slice(0, 160)}`); },
  control: {}, regions: ["us-east"], appName: arg("app", "pda-demo-d4"), namePrefix: "pda-demo-d4-smoke-",
  cluster: { size, image, cpu: 8, memoryMiB: 65536, ttlMinutes: Number(arg("ttl", 20)), readyCommand: arg("ready", "nvidia-smi -L"), skills: arg("skills", "walk,spin").split(","), start: "now" },
});
let code = 0;
try {
  await cloud.cluster.start();
  console.log(`${at()} pool: ${JSON.stringify(cloud.cluster.status().boxes.map((b) => `${b.index}:${b.state}${b.createMs ? `@${(b.createMs / 1000).toFixed(0)}s` : ""}`))}`);
  // The VM's path: a client over a loopback to the server's handler.
  let client;
  const serving = serveGpu(cloud.cluster.gpu, (frame) => queueMicrotask(() => client.handle(frame)));
  client = createGpuClient((frame) => (queueMicrotask(() => serving.handle(frame)), true));
  for (let i = 0; i < size; i++) {
    const box = await client.acquire(`smoke-${i}`);
    const p = await client.linkBox(box).exec(["sh", "-c", arg("cmd", "nvidia-smi -L; echo; (train-skill --help 2>&1 | head -3) || true")], { mode: "binary", timeoutMs: 60_000 });
    let out = "";
    for await (const c of p.stdout) out += new TextDecoder().decode(c);
    console.log(`${at()} box ${i} exit ${await p.wait()}: ${out.trim().replace(/\n+/g, " | ").slice(0, 240)}`);
    console.log(`${at()} poll ${i}: ${await client.linkBox(box).poll()}`);
  }
} catch (error) {
  code = 1;
  console.log(`FAIL ${error.message}`);
} finally {
  await cloud.close();
  console.log(`${at()} closed`);
}
process.exit(code);
