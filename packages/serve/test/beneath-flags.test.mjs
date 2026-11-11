// The open flags of a name below a run's folder (src/workspace/beneath.ts beneathFlags), computed on every platform's
// values from any host: macOS's kernel refuses O_NOFOLLOW beside O_NOFOLLOW_ANY (EINVAL), which failed every folder
// open of a local run on a Mac, and only a Mac runner would see a change that put the pair back. So the pair is held
// apart here, on Linux CI, with macOS's own values, and every open in beneath.ts goes through the one function.
import assert from "node:assert/strict";
import { constants, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
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
  // Read by TypeScript's parser, so only code counts: a comment or a string never passes or fails it.
  const file = ts.createSourceFile("beneath.ts", readFileSync(new URL("../src/workspace/beneath.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const text = (node) => node.getText(file);
  const where = (node) => `beneath.ts:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${text(node).slice(0, 120)}`;
  /** The declarations that may name macOS's flag: its type, its values, and the one function that combines it. */
  const allowed = (node) => {
    for (let at = node; at; at = at.parent) {
      if (ts.isInterfaceDeclaration(at) && at.name.text === "NoLinkFlags") return true;
      if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name) && at.name.text === "DARWIN_NO_LINK") return true;
      if (ts.isFunctionDeclaration(at) && at.name?.text === "beneathFlags") return true;
    }
    return false;
  };
  const opens = [];
  const hows = [];
  const visit = (node) => {
    const names = (ts.isIdentifier(node) && ["O_NOFOLLOW_ANY", "DARWIN_NO_LINK"].includes(node.text)) || (ts.isNumericLiteral(node) && Number(node.text) === DARWIN_NO_LINK.O_NOFOLLOW_ANY);
    // A property name O_NOFOLLOW_ANY of NoLinkFlags or its literal is the declaration's; anything else names it in code.
    if (names && !allowed(node)) assert.fail(`macOS's O_NOFOLLOW_ANY named outside beneathFlags: ${where(node)}`);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["open", "openSync"].includes(node.expression.text)) opens.push(node);
    // The Linux walk's step opens with the flags it is handed: each call hands it how or the folder flags.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "step") {
      const flags = node.arguments[2];
      assert.ok(flags && ts.isIdentifier(flags) && ["how", "DIR_FLAGS"].includes(flags.text), `a step of the walk passes other flags: ${where(node)}`);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "how") hows.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(opens.length >= 8, `${opens.length} opens found`);
  // Every open passes the flags beneathFlags gave (how), or the Linux walk's folder flags (DIR_FLAGS), which a darwin
  // open never reaches: each darwin open is a return inside `if (DARWIN)`, and passes how.
  for (const call of opens) {
    const flags = call.arguments[1];
    assert.ok(flags && ts.isIdentifier(flags) && ["how", "DIR_FLAGS"].includes(flags.text), `an open passes flags other than beneathFlags' or the walk's: ${where(call)}`);
    let branch = call.parent;
    while (branch && !ts.isIfStatement(branch) && !ts.isFunctionDeclaration(branch)) branch = branch.parent;
    if (branch && ts.isIfStatement(branch) && text(branch.expression) === "DARWIN") assert.equal(flags.text, "how", `a darwin open passes beneathFlags' flags: ${where(call)}`);
  }
  assert.equal(opens.filter((call) => { let at = call.parent; while (at && !ts.isIfStatement(at)) at = at.parent; return at && text(at.expression) === "DARWIN"; }).length, 2, "openBeneath's and openBeneathSync's darwin opens");
  // `how` is beneathFlags' answer for this process's platform, wherever it is declared.
  assert.equal(hows.length, 2, "openBeneath and openBeneathSync each compute how");
  for (const how of hows) assert.equal(text(how.initializer), "beneathFlags(flags, process.platform)", where(how));
  const walk = file.statements.flatMap((s) => (ts.isVariableStatement(s) ? [...s.declarationList.declarations] : [])).find((d) => text(d.name) === "DIR_FLAGS");
  assert.equal(text(walk.initializer), "O_RDONLY | O_DIRECTORY | O_NOFOLLOW", "the Linux walk's folder flags");
});
