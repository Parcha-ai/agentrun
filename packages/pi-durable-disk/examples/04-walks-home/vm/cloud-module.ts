// `serve.ts --cloud-module 04-walks-home/vm/cloud-module.ts --cloud-arg KEY=VALUE ...`: the Modal VM (and GPU) as the demo server's cloud host.
//   image=im-...        the VM image (default: built from image.ts's commands)      transport=mount|pipe   (default mount on a VM)
//   desktop=true        a desktop in the VM and the computer tool                    regions=us-east,...    where Modal may place sandboxes
//   app=NAME prefix=P   the Modal app and the sandbox names                          warm=true|gpu          keep one pipe VM (or the GPU box) ready (with gpu: warm-commands-file=F warm-env=K=V,.. warm-delay-ms=N compile the creature ahead)
//   vm=false            offer only the GPU environment
//   gpu-image=im-...    offers modal-gpu: this image, gVisor, on the pipe            gpu-type=H100 gpu-note=TEXT   (note: what the agent runs there)
// MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in the environment.
import { readFileSync } from "node:fs";
import type { CloudModuleOptions } from "../../03-tab-to-cloud/pipe/server.ts";
import { modalCloud, type ModalCloudOptions } from "./modal-cloud.ts";

const KNOWN = new Set(["image", "transport", "desktop", "regions", "app", "prefix", "warm", "gpu-image", "gpu-type", "gpu-note", "gpu-ttl-minutes", "gpu-cpu", "gpu-memory-mib", "vm", "warm-commands-file", "warm-env", "warm-delay-ms", "cpu", "memory-mib"]);
const flag = (v: string | undefined) => (v === undefined ? undefined : v === "true" || v === "1" || v === "");

/** The module's `--cloud-arg` pairs as `modalCloud` options; an unknown key or value is an error, not a silent default. */
export function modalOptionsFromArgs(args: Readonly<Record<string, string>>): Pick<ModalCloudOptions, "image" | "transport" | "desktop" | "regions" | "appName" | "namePrefix" | "warm" | "offerVm" | "gpu" | "cpu" | "memoryMiB"> {
  for (const key of Object.keys(args)) if (!KNOWN.has(key)) throw new Error(`--cloud-arg ${key}: not one of ${[...KNOWN].join(", ")}`);
  if (args.transport !== undefined && args.transport !== "mount" && args.transport !== "pipe") throw new Error(`--cloud-arg transport=${args.transport}: mount or pipe`);
  if (args["gpu-type"] !== undefined && args["gpu-image"] === undefined) throw new Error("--cloud-arg gpu-type needs gpu-image");
  const number = (key: string) => {
    const v = args[key];
    if (v === undefined) return undefined;
    if (!(Number(v) > 0)) throw new Error(`--cloud-arg ${key}=${v}: a positive number`);
    return Number(v);
  };
  const gpuTtl = number("gpu-ttl-minutes");
  const warmDelay = number("warm-delay-ms");
  if ((args["warm-commands-file"] !== undefined || args["warm-env"] !== undefined || warmDelay !== undefined) && args.warm !== "gpu") throw new Error("--cloud-arg warm-commands-file, warm-env and warm-delay-ms need warm=gpu");
  // The trainer's compile-only lines, one per line of the file, blank lines and # comments left out.
  const warmCommands = args["warm-commands-file"] ? readFileSync(args["warm-commands-file"], "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : undefined;
  if (warmCommands && warmCommands.length === 0) throw new Error(`--cloud-arg warm-commands-file=${args["warm-commands-file"]} has no command`);
  const warmEnv = args["warm-env"]
    ? Object.fromEntries(args["warm-env"].split(",").map((kv) => {
        const at = kv.indexOf("=");
        if (at < 1) throw new Error(`--cloud-arg warm-env=${args["warm-env"]}: NAME=value pairs separated by commas`);
        return [kv.slice(0, at), kv.slice(at + 1)];
      }))
    : undefined;
  if (args.warm !== undefined && !["gpu", "true", "false", "1", "0", ""].includes(args.warm)) throw new Error(`--cloud-arg warm=${args.warm}: true, false or gpu`);
  if ((args.warm === "gpu" || args.vm === "false") && args["gpu-image"] === undefined) throw new Error("--cloud-arg warm=gpu and vm=false need gpu-image");
  return {
    ...(args.image ? { image: args.image } : {}),
    ...(args.transport ? { transport: args.transport } : {}),
    ...(flag(args.desktop) ? { desktop: true } : {}),
    ...(args.regions ? { regions: args.regions.split(",").map((r) => r.trim()).filter(Boolean) } : {}),
    ...(args.app ? { appName: args.app } : {}),
    ...(args.prefix ? { namePrefix: args.prefix } : {}),
    ...(args.warm === "gpu" ? { warm: "gpu" as const } : flag(args.warm) ? { warm: true } : {}),
    ...(args.vm === "false" ? { offerVm: false } : {}),
    ...(number("cpu") ? { cpu: number("cpu")! } : {}),
    ...(number("memory-mib") ? { memoryMiB: number("memory-mib")! } : {}),
    ...(args["gpu-image"] ? { gpu: { image: args["gpu-image"], ...(args["gpu-type"] ? { type: args["gpu-type"] } : {}), ...(args["gpu-note"] ? { note: args["gpu-note"] } : {}), ...(gpuTtl ? { ttlMinutes: gpuTtl } : {}), ...(number("gpu-cpu") ? { cpu: number("gpu-cpu")! } : {}), ...(number("gpu-memory-mib") ? { memoryMiB: number("gpu-memory-mib")! } : {}), ...(warmCommands ? { warmCommands } : {}), ...(warmEnv ? { warmEnv } : {}), ...(warmDelay ? { warmDelayMs: warmDelay } : {}) } } : {}),
  };
}

export default function cloudModule(options: CloudModuleOptions) {
  return modalCloud({ disk: options.disk, region: options.region, model: options.model, log: options.log, ...(options.ledger ? { ledger: options.ledger } : {}), ...(options.eventsLog ? { eventsLog: options.eventsLog } : {}), ...modalOptionsFromArgs(options.args) });
}
