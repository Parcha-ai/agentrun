// The open flags of a name below a run's folder (src/workspace/beneath.ts beneathFlags), computed on every platform's
// values from any host: macOS's kernel refuses O_NOFOLLOW beside O_NOFOLLOW_ANY (EINVAL), which failed every folder
// open of a local run on a Mac, and only a Mac runner would see a change that put the pair back. So the pair is held
// apart here, on Linux CI, with macOS's own values, and every open in beneath.ts goes through the one function.
import assert from "node:assert/strict";
import { constants, readFileSync } from "node:fs";
import test from "node:test";
import { beneathFlags, DARWIN_NO_LINK } from "../dist/workspace/beneath.js";

/** macOS's other open flags (sys/fcntl.h), for the flag sets local.ts and grep's worker pass. */
const DARWIN = { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_NONBLOCK: 0x4, O_APPEND: 0x8, O_CREAT: 0x200, O_EXCL: 0x800, O_DIRECTORY: 0x100000 };
const { O_NOFOLLOW, O_NOFOLLOW_ANY } = DARWIN_NO_LINK;
/** Every flag set the workspace opens with, as macOS has them: with and without the caller's own O_NOFOLLOW. */
const SETS = [
  DARWIN.O_RDONLY | DARWIN.O_DIRECTORY | O_NOFOLLOW,
  DARWIN.O_RDONLY | O_NOFOLLOW | DARWIN.O_NONBLOCK,
  DARWIN.O_WRONLY | O_NOFOLLOW | DARWIN.O_NONBLOCK,
  DARWIN.O_RDWR | DARWIN.O_CREAT | DARWIN.O_EXCL | O_NOFOLLOW,
  DARWIN.O_RDWR | DARWIN.O_APPEND | O_NOFOLLOW | DARWIN.O_NONBLOCK,
  DARWIN.O_RDWR | DARWIN.O_APPEND | DARWIN.O_CREAT | DARWIN.O_EXCL | O_NOFOLLOW,
  DARWIN.O_RDONLY,
  DARWIN.O_RDONLY | DARWIN.O_DIRECTORY,
];

test("macOS's values are its own: O_NOFOLLOW 0x100, O_NOFOLLOW_ANY 0x20000000", () => {
  assert.deepEqual(DARWIN_NO_LINK, { O_NOFOLLOW: 0x100, O_NOFOLLOW_ANY: 0x20000000 });
  // On a Mac, node's own O_NOFOLLOW is the one beneathFlags strips by default (the Mac CI step runs this file).
  if (process.platform === "darwin") assert.equal(constants.O_NOFOLLOW, DARWIN_NO_LINK.O_NOFOLLOW);
});

test("on darwin every open below the root holds O_NOFOLLOW_ANY and never O_NOFOLLOW beside it, its other flags kept", () => {
  for (const flags of SETS) {
    const how = beneathFlags(flags, "darwin", DARWIN_NO_LINK);
    const words = `flags 0x${flags.toString(16)} -> 0x${how.toString(16)}`;
    assert.equal(how & O_NOFOLLOW_ANY, O_NOFOLLOW_ANY, `${words}: O_NOFOLLOW_ANY set`);
    assert.equal(how & O_NOFOLLOW, 0, `${words}: O_NOFOLLOW clear, which the kernel refuses beside O_NOFOLLOW_ANY`);
    assert.equal(how & ~(O_NOFOLLOW | O_NOFOLLOW_ANY), flags & ~O_NOFOLLOW, `${words}: every other flag as the caller gave it`);
  }
});

test("on linux an open below the root adds O_NOFOLLOW to the caller's flags, and nothing else", () => {
  const linux = { O_NOFOLLOW: constants.O_NOFOLLOW, O_NOFOLLOW_ANY: O_NOFOLLOW_ANY };
  for (const flags of [constants.O_RDONLY | constants.O_DIRECTORY, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, constants.O_RDONLY | constants.O_NOFOLLOW]) {
    assert.equal(beneathFlags(flags, "linux", linux), flags | constants.O_NOFOLLOW, `flags 0x${flags.toString(16)}`);
  }
  assert.equal(beneathFlags(constants.O_RDONLY, "linux"), constants.O_RDONLY | constants.O_NOFOLLOW, "this process's own values by default");
});

test("every open in beneath.ts takes its flags from beneathFlags: no other line names O_NOFOLLOW_ANY", () => {
  const source = readFileSync(new URL("../src/workspace/beneath.ts", import.meta.url), "utf8");
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line));
  const naming = code.filter((line) => line.includes("O_NOFOLLOW_ANY"));
  assert.ok(naming.every((line) => /\bNoLinkFlags\b|DARWIN_NO_LINK|noLink\.O_NOFOLLOW_ANY|readonly O_NOFOLLOW_ANY/.test(line)), `lines naming O_NOFOLLOW_ANY outside beneathFlags: ${naming.join(" | ")}`);
  for (const call of ["openBeneath", "openBeneathSync"]) {
    const body = source.slice(source.indexOf(`export ${call === "openBeneath" ? "async " : ""}function ${call}(`));
    assert.match(body.slice(0, body.indexOf("\n}\n")), /beneathFlags\(flags, process\.platform\)/, `${call} computes its flags with beneathFlags`);
  }
});
