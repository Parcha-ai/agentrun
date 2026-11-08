// The owner's take-over reaching the run's own tools (computer-view.ts, workspace/computer-hold.ts, through the run's
// tools as runTools builds them for a desktop): the run's hold is given to runTools (`hold`), so the desktop's ports the
// registry's desktop_screen and desktop_input run on are parked while the owner holds the computer. A screenshot asked
// meanwhile waits and then runs on the screen as the owner left it; an input waits and then is not done, answered as an
// error in the take-over's words; with nobody holding it, both run. The desktop is a loopback fake: nothing leaves this
// process. Driven by events: nothing sleeps.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { computerRoute, registerRunComputer } from "../dist/computer-view.js";
import { localWorkspace, runTools } from "../dist/workspace/index.js";
import { computerHold, heldHands, personHadWords } from "../dist/workspace/computer-hold.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-computer-view-tools-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const DESKTOP_GROUPS = ["screen", "input.pointer", "input.keys"];
const OWNER = { ownerSession: true, token: false, accounts: true };
const call = (tools, name, args) => tools.find((tool) => tool.name === name).call(args, { callId: `c-${name}-${Math.random()}`, signal: new AbortController().signal });

/** A loopback desktop: computerd's screen.shot answers one PNG, input.actions runs every action; each call recorded. */
function fakeDesktop(root) {
  const computer = fakeComputer(root);
  computer.overrides["screen.shot"] = () => ({ id: "s1", size: PNG.length, data: PNG.toString("base64"), eof: true, width: 1, height: 1, scale: 1 });
  computer.overrides["input.actions"] = ({ actions }) => ({ done: actions.length });
  return computer;
}

/** Whether `promise` has settled yet: it is given every queued turn first. */
async function settled(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  return done;
}

test("the owner's take-over parks the run's desktop tools: a screenshot waits and then runs, an input waits and then is an error in the take-over's words; with nobody holding, both run", async (t) => {
  const root = scratch();
  const desktop = fakeDesktop(root);
  const hold = computerHold();
  const run = await runTools(localWorkspace(root), { kind: "desktop", computer: desktop, groups: DESKTOP_GROUPS }, { mode: 1, context: ctx, hold: (ports) => heldHands(ports, hold) });
  const runId = "run-desktop-tools";
  t.after(registerRunComputer(runId, { kind: "desktop", hold, live: () => true, stream: async ({ viewOnly }) => ({ url: `https://stream.example/${viewOnly ? "view" : "drive"}` }) }));
  const tools = run.hostTools(["desktop_screen", "desktop_input"]);
  const sent = () => desktop.methods().filter((method) => method === "screen.shot" || method === "input.actions");

  assert.equal((await call(tools, "desktop_input", { actions: [{ type: "move", at: [1, 1] }] })).isError, false, "nobody holds it: the input runs");
  assert.deepEqual(sent(), ["input.actions"]);

  assert.equal((await computerRoute("takeOverRunComputer", runId, { ...OWNER, body: {} })).taken_over, true);
  const looking = call(tools, "desktop_screen", {});
  const acting = call(tools, "desktop_input", { actions: [{ type: "move", at: [2, 2] }] });
  assert.equal(await settled(looking), false, "the screenshot waits while the owner holds the desktop");
  assert.equal(await settled(acting), false, "so does the input");
  assert.deepEqual(sent(), ["input.actions"], "neither reached the desktop");

  assert.equal((await computerRoute("handBackRunComputer", runId, { ...OWNER, body: {} })).taken_over, false);
  const look = await looking;
  assert.equal(look.isError, false, look.text);
  assert.deepEqual(look.images?.map((image) => image.mimeType), ["image/png"], "the screenshot ran after the hand-back");
  const act = await acting;
  assert.equal(act.isError, true, "the parked input is an error, not a success");
  assert.match(act.text, new RegExp(personHadWords("desktop", "input").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(sent(), ["input.actions", "screen.shot"], "the parked input never reached the desktop");
});
