import { describe, expect, it } from "vitest";
import { defaultPlaceOf, runsWhere, sandboxReason } from "./agentForm";
import { newAgentPlace, placeLabel, placeOf, placesOf, runnerShellTools } from "./place";
import recorded from "../fixtures/capabilities.json";

// The place shapes are the server's (definition.place, Run.place, capabilities.places); the console names no box itself.
const BOXES = [{ id: "modal", available: false, reason: "modal is not set up on this server." }, { id: "docker", available: true }, { id: "daytona", available: false, reason: "runs in the daytona box are not available yet" }];
const PLACES = { modes: ["runner", "sandbox"], default_place: { mode: "runner" }, boxes: [{ id: "modal", available: false, reason: "modal is not set up on this server." }, { id: "docker", available: true }, { id: "daytona", available: false, reason: "runs in the daytona box are not available yet" }] };

describe("places", () => {
  it("reads a place as the server sends it, and nothing else as one", () => {
    expect(placeOf({ mode: "runner" })).toEqual({ mode: "runner" });
    expect(placeOf({ mode: "sandbox", box: "docker" })).toEqual({ mode: "sandbox", box: "docker" });
    for (const v of [undefined, null, "runner", { mode: "sandbox" }, { mode: "cloud" }]) expect(placeOf(v)).toBeUndefined();
  });

  it("reads capabilities' places, each box with its availability and the server's reason as given", () => {
    // default_place is the one field: where a new agent goes and where a revision with no place runs.
    expect(placesOf({ places: PLACES })).toEqual({ modes: PLACES.modes, boxes: BOXES, defaultPlace: { mode: "runner" } });
    expect(placesOf({ harnesses: [] })).toBeNull();
  });

  // A server with no default place (default_place null: no Docker box, and a runner with no shell) gives a new agent
  // none: it names a box or the runner, and default_reason says so in the words the server refuses a create in.
  it("reads a null default_place as no default, never as the runner or a box", () => {
    const none = placesOf({ places: { ...PLACES, default_place: null, default_reason: "name a box: this server has no Docker box for a new agent." } });
    expect(none).toEqual({ modes: PLACES.modes, boxes: BOXES, defaultPlace: null });
    expect(newAgentPlace(none)).toBeUndefined();
    expect(placeLabel(null)).toBe("No place yet: choose a box, or On the server");
    // Missing or a shape this console does not know is still not read.
    const { default_place: _gone, ...without } = PLACES;
    expect(placesOf({ places: without })).toBeNull();
    expect(placesOf({ places: { ...PLACES, default_place: { mode: "cloud" } } })).toBeNull();
  });

  // The recorded capabilities are a faux server's with no box and no shell on its runner (src/fixtures/README.md).
  it("reads the recorded capabilities' places as today's server sends them there: no default place, with the reason", () => {
    expect(placesOf(recorded.body)?.defaultPlace).toBeNull();
    expect(recorded.body.places.default_reason).toMatch(/^name a box: /);
  });

  it("with no default place, a revision with no place and a shell tool has none to run in; one whose tools need no shell runs on the runner, as the server runs it", () => {
    const none = placesOf({ places: { ...PLACES, default_place: null, default_reason: "name a box" } });
    expect(defaultPlaceOf(false, ["read", "bash"], none)).toBeNull();
    expect(defaultPlaceOf(false, ["read"], none)).toEqual({ mode: "runner" });
    expect(defaultPlaceOf(false, ["bash", "browser"], none)).toEqual({ mode: "runner" });
    expect(defaultPlaceOf(true, ["bash"], none)).toEqual({ mode: "runner" });
    const agentic = (definition: Record<string, unknown>) => ({ kind: "agentic" as const, definition: { version: 1, name: "a", instructions: "", skills: [], tools: ["write", "bash"], ...definition } }) as never;
    expect(runsWhere(agentic({}), none)).toEqual({ place: null, byDefault: true });
    expect(runsWhere(agentic({ tools: ["write"] }), none)).toEqual({ place: { mode: "runner" }, byDefault: true });
    // A shell tool's card on an agent with no place says to choose a box, never that the agent is on the runner.
    const bash = { name: "bash", available: true, sandbox_only: true } as never;
    expect(sandboxReason(bash, null, runnerShellTools(none))).toBe("Sandbox-only: it runs in a box, and this agent has no place yet: choose a box under Where it runs");
    expect(sandboxReason(bash, { mode: "runner" }, runnerShellTools(none))).toBe("Sandbox-only: it runs in a box, and this agent's place is the runner");
  });

  // Where an agent's current revision runs: its own place, else the server's default for it (byDefault); with no place
  // and the server's places not read yet, unknown.
  it("says where an agent's revision runs: its own place, else the server's default for it", () => {
    const docker = placesOf({ places: { ...PLACES, default_place: { mode: "sandbox", box: "docker" } } });
    const agentic = (definition: Record<string, unknown>) => ({ kind: "agentic" as const, definition: { version: 1, name: "a", instructions: "", skills: [], tools: ["write", "bash"], ...definition } }) as never;
    expect(runsWhere(agentic({ place: { mode: "runner" } }), docker)).toEqual({ place: { mode: "runner" }, byDefault: false });
    expect(runsWhere(agentic({}), docker)).toEqual({ place: { mode: "sandbox", box: "docker" }, byDefault: true });
    expect(runsWhere(agentic({ tools: ["browser"] }), docker)).toEqual({ place: { mode: "runner" }, byDefault: true });
    expect(runsWhere(agentic({ tools: ["write"] }), docker)).toEqual({ place: { mode: "runner" }, byDefault: true });
    expect(runsWhere(agentic({ tools: [] }), null)).toEqual({ place: { mode: "runner" }, byDefault: true });
    expect(runsWhere(agentic({}), placesOf({ places: PLACES }))).toEqual({ place: { mode: "runner" }, byDefault: true });
    expect(runsWhere(agentic({}), null)).toBeUndefined();
  });

  // The server's cases (packages/serve/test/default-place.test.mjs): a revision with no place runs where default_place
  // says when it has a shell tool; one whose tools need no shell, one with the browser, and a workflow, on the runner;
  // where default_place is the runner, there.
  it("resolves no place as the server's defaultPlaceOf does at a run", () => {
    const docker = placesOf({ places: { ...PLACES, default_place: { mode: "sandbox", box: "docker" } } });
    expect(defaultPlaceOf(false, ["write"], docker)).toEqual({ mode: "runner" });
    expect(defaultPlaceOf(false, [], docker)).toEqual({ mode: "runner" });
    expect(defaultPlaceOf(false, ["bash"], docker)).toEqual({ mode: "sandbox", box: "docker" });
    expect(defaultPlaceOf(false, ["read", "bash_background"], docker)).toEqual({ mode: "sandbox", box: "docker" });
    expect(defaultPlaceOf(false, ["read", "browser"], docker)).toEqual({ mode: "runner" });
    expect(defaultPlaceOf(true, [], docker)).toEqual({ mode: "runner" });
    expect(defaultPlaceOf(false, ["bash"], placesOf({ places: PLACES }))).toEqual({ mode: "runner" });
  });
});
