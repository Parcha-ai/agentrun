// The VM image's recipe and the environment's shape: what a Modal build and the switcher depend on. No Modal, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { vmImageCommands } from "../image.ts";
import { modalGpuEnvironment, modalVmEnvironment } from "../modal-cloud.ts";

test("the image removes the base image's uid-1000 user before the run user is created, and every command is a RUN", () => {
  const commands = vmImageCommands(1000, 1000);
  assert.ok(commands.every((c) => c.startsWith("RUN ")), "only RUN commands, so a Python or TS builder can append them to any base");
  const userdel = commands.findIndex((c) => c.includes("userdel -r ubuntu"));
  const useradd = commands.findIndex((c) => c.includes("useradd") && c.includes("--uid 1000"));
  assert.ok(userdel >= 0 && useradd > userdel, "sudo matches the caller's name, so `id pda` must answer pda");
});

test("the image puts node on the PATH the agent's commands get, and installs the pinned archil client by checksum", () => {
  const joined = vmImageCommands(1500, 1500).join("\n");
  assert.match(joined, /ln -sf \/opt\/node24\/bin\/node \/usr\/local\/bin\/node/);
  assert.match(joined, /archil\.deb/);
  assert.match(joined, /sha256sum -c/);
  assert.match(joined, /--uid 1500 --gid 1500 pda|--uid 1500/);
});

test("the environment is a cloud one when the VM mounts the disk and a remote one when the agent runs through the pipe", () => {
  assert.equal(modalVmEnvironment("mount").kind, "cloud");
  assert.equal(modalVmEnvironment("pipe").kind, "remote");
  assert.equal(modalVmEnvironment("mount").id, "modal-vm");
});

test("without archil the recipe has no FUSE or archil step and everything else is unchanged", () => {
  const all = vmImageCommands(1000, 1000);
  const without = vmImageCommands(1000, 1000, { archil: false });
  assert.equal(without.some((c) => c.includes("archil")), false);
  assert.deepEqual(all.filter((c) => !c.includes("archil.deb")), without);
  assert.equal(all.length - without.length, 1);
});

test("the GPU environment is a remote one (the agent runs through the pipe) and names its GPU", () => {
  const gpu = modalGpuEnvironment("H100");
  assert.equal(gpu.id, "modal-gpu");
  assert.equal(gpu.kind, "remote");
  assert.match(gpu.detail ?? "", /1x H100/);
});

test("the desktop layer is last, so the layers above it stay cached, and pins its browser", () => {
  const plain = vmImageCommands(1000, 1000);
  const withDesktop = vmImageCommands(1000, 1000, { desktop: true });
  assert.deepEqual(withDesktop.slice(0, plain.length), plain);
  assert.ok(withDesktop.length > plain.length);
  assert.match(withDesktop.join("\n"), /playwright@\d+\.\d+\.\d+ install --with-deps chromium/);
  assert.match(withDesktop.join("\n"), /--start-maximized/);
});
