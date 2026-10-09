// The Modal cloud module's arguments: what `--cloud-arg` pairs mean, and that a mistake is an error rather than a default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { modalOptionsFromArgs } from "../cloud-module.ts";

test("pairs become modalCloud options", () => {
  assert.deepEqual(modalOptionsFromArgs({}), {});
  assert.deepEqual(
    modalOptionsFromArgs({ image: "im-1", transport: "pipe", desktop: "true", regions: "us-east, us-west", app: "a", prefix: "p-", warm: "1", cpu: "4", "memory-mib": "8192", "gpu-image": "im-2", "gpu-type": "H100", "gpu-note": "run it", "gpu-ttl-minutes": "30" }),
    { image: "im-1", transport: "pipe", desktop: true, regions: ["us-east", "us-west"], appName: "a", namePrefix: "p-", warm: true, cpu: 4, memoryMiB: 8192, gpu: { image: "im-2", type: "H100", note: "run it", ttlMinutes: 30 } },
  );
  assert.deepEqual(modalOptionsFromArgs({ desktop: "false" }), {}, "false is off");
});

test("an unknown key, a bad transport, a GPU type without an image, a non-number: each is an error", () => {
  assert.throws(() => modalOptionsFromArgs({ imge: "im-1" }), /imge: not one of/);
  assert.throws(() => modalOptionsFromArgs({ transport: "fuse" }), /mount or pipe/);
  assert.throws(() => modalOptionsFromArgs({ "gpu-type": "H100" }), /needs gpu-image/);
  assert.throws(() => modalOptionsFromArgs({ cpu: "many" }), /a positive number/);
});

test("warm=gpu keeps the GPU box ready and vm=false offers only the GPU; both need a GPU image", () => {
  assert.deepEqual(modalOptionsFromArgs({ "gpu-image": "im-2", warm: "gpu", vm: "false" }), { gpu: { image: "im-2" }, warm: "gpu", offerVm: false });
  assert.throws(() => modalOptionsFromArgs({ warm: "gpu" }), /need gpu-image/);
  assert.throws(() => modalOptionsFromArgs({ vm: "false" }), /need gpu-image/);
  assert.throws(() => modalOptionsFromArgs({ "gpu-image": "im-2", warm: "gpuu" }), /true, false or gpu/);
});

test("warm-commands-file, warm-env and warm-delay-ms need warm=gpu; the file's lines are the commands", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const file = join(mkdtempSync(join(tmpdir(), "warm-")), "cmds.txt");
  writeFileSync(file, "# the walker\npython train.py --compile-only --mjcf {mjcf} --body {body}\n\n");
  const got = modalOptionsFromArgs({ "gpu-image": "im-2", warm: "gpu", "warm-commands-file": file, "warm-env": "A=1,B=x=y", "warm-delay-ms": "2000" });
  assert.deepEqual(got.gpu, { image: "im-2", warmCommands: ["python train.py --compile-only --mjcf {mjcf} --body {body}"], warmEnv: { A: "1", B: "x=y" }, warmDelayMs: 2000 });
  assert.throws(() => modalOptionsFromArgs({ "gpu-image": "im-2", "warm-commands-file": file }), /need warm=gpu/);
  assert.throws(() => modalOptionsFromArgs({ "gpu-image": "im-2", warm: "gpu", "warm-env": "novalue" }), /NAME=value pairs/);
  writeFileSync(file, "# nothing\n");
  assert.throws(() => modalOptionsFromArgs({ "gpu-image": "im-2", warm: "gpu", "warm-commands-file": file }), /has no command/);
});

test("a GPU sandbox lives 20 minutes at most unless the caller says otherwise", async () => {
  const { DEFAULT_GPU_TTL_MINUTES } = await import("../modal-cloud.ts");
  assert.ok(DEFAULT_GPU_TTL_MINUTES <= 20, `default ${DEFAULT_GPU_TTL_MINUTES} minutes`);
  assert.equal(modalOptionsFromArgs({ "gpu-image": "im-2", "gpu-ttl-minutes": "30" }).gpu?.ttlMinutes, 30, "a caller's value wins");
});
