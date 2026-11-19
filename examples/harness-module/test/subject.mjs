// @ts-check
// The conformance suite's subject for this module's harness: serve's ACP adapter, the one kit.acpEntry builds this
// harness on, driven by the kernel's adapter loop, on the fake ACP agent. The fake's model is the suite's script, so the
// suite needs no binary, no model and no key. It plays Goose: it resumes with session/load, takes our tools over HTTP,
// and asks permission before each.
//
// This file is its own module because the suite's process cases start a runner process that imports it and runs the
// same subject there (`process` below).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpAdapter, acpFacts } from "@parcha/agentrun-harness-acp";
import { fakeAgentRecipe } from "@parcha/agentrun-harness-acp/testing";
import { createAdapterLoop, MAX_RESTARTS, suiteHostTools } from "@parcha/agentrun-serve/conformance";
import { ID } from "../index.mjs";

/** The folders this module's loops made, removed by closeAll. */
const dirs = /** @type {string[]} */ ([]);
/** The sessions opened and not closed yet: a crash case freezes its loop in this process, which leaves that session's
 *  agent running until closeAll closes it. */
const open = /** @type {Set<import("@parcha/agentrun-kernel").AdapterSession>} */ (new Set());

/** `adapter`, its sessions kept in `open` until each closes. */
function tracked(/** @type {import("@parcha/agentrun-kernel").AgentAdapter} */ adapter) {
  return {
    ...adapter,
    check: adapter.check.bind(adapter),
    open: /** @type {import("@parcha/agentrun-kernel").AgentAdapter["open"]} */ (async (spec, io) => {
      const session = await adapter.open(spec, io);
      const close = session.close.bind(session);
      session.close = async () => {
        open.delete(session);
        await close();
      };
      open.add(session);
      return session;
    }),
  };
}

/** @param {import("@parcha/agentrun-serve/conformance").ConformanceSetup} setup */
function spec(setup) {
  const { script, tools, hooks, agentId } = setup;
  // One folder per loop: a resume on another runner opens the session from the run's journal, not from this folder.
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "harness-module-conformance-"));
  dirs.push(dir);
  const recipe = fakeAgentRecipe(ID, dir, script, { load: true, http: true, style: "goose" });
  /** @type {import("@parcha/agentrun-serve/conformance").AdapterRunSpec} */
  const run = {
    ...(agentId ? { agentId } : {}),
    adapter: tracked(acpAdapter({ recipe, sessionsDir: join(dir, "sessions") })),
    record: "loop",
    session: { key: "root", label: "root", system: ["Follow the script."], tools: suiteHostTools(tools), context: "fresh" },
    input: "Follow the script.",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    hooks,
    gate: (call) => (tools[call.tool]?.ask ? "ask" : "allow"),
  };
  return async () => run;
}

/** @type {import("@parcha/agentrun-serve/conformance").ConformanceSubject} */
export const subject = {
  name: `${ID} on the fake ACP agent`,
  createLoop: (setup) => createAdapterLoop(spec(setup), { restartLimit: MAX_RESTARTS }),
  process: { module: import.meta.url, export: "subject" },
  // What an ACP adapter declares (no steer, no rerun of a started call, no recovery of a cut answer): the suite skips
  // the cases those rule out and says why.
  facts: acpFacts(ID),
};

/** Closes the sessions still open, then removes the folders the loops made. */
export async function closeAll() {
  for (const session of [...open]) await session.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
