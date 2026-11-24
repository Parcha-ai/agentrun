// fakeBin on a box whose bin holds a dangling symlink (GitHub's ubuntu runner image of 11-17 has
// /usr/bin/grub-ntldr-img pointing at nothing) and a merged /usr, where /bin lists the same names again.
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeBin } from "./fake-bin.mjs";

test("a dangling link in a bin listed twice (merged /usr) is linked once, and the skipped program is left out", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "fake-bin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const usrBin = join(dir, "usr-bin");
  const bin = join(dir, "bin");
  mkdirSync(usrBin);
  mkdirSync(bin);
  writeFileSync(join(usrBin, "ls"), "");
  writeFileSync(join(usrBin, "script"), "");
  symlinkSync(join(dir, "nowhere"), join(usrBin, "grub-ntldr-img"));

  fakeBin(bin, ["script"], [usrBin, usrBin]);

  assert.deepEqual(readdirSync(bin).sort(), ["grub-ntldr-img", "ls"]);
  assert.ok(lstatSync(join(bin, "grub-ntldr-img")).isSymbolicLink());
  assert.equal(readlinkSync(join(bin, "ls")), join(usrBin, "ls"));
});
