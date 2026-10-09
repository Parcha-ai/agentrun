// The VM image's recipe and the environment's shape: what a Modal build and the switcher depend on. No Modal, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { vmImageCommands } from "../image.ts";
import { modalVmEnvironment } from "../modal-cloud.ts";

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
