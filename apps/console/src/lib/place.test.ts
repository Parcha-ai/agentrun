import { describe, expect, it } from "vitest";
import { defaultPlaceOf, runsWhere } from "./agentForm";
import { placeOf, placesOf } from "./place";

// The place shapes are the server's (definition.place, Run.place, capabilities.places); the console names no box itself.
const BOXES = [{ id: "bwrap", available: false, reason: "bwrap is not set up on this server." }, { id: "docker", available: true }, { id: "daytona", available: false, reason: "runs in the daytona box are not available yet" }];
const PLACES = { modes: ["runner", "sandbox"], default_place: { mode: "runner" }, boxes: [{ id: "bwrap", available: false, reason: "bwrap is not set up on this server." }, { id: "docker", available: true }, { id: "daytona", available: false, reason: "runs in the daytona box are not available yet" }] };

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

  // Where an agent's current revision runs: its own place, else the server's default for it (byDefault); with no place
  // and the server's places not read yet, unknown.
  it("says where an agent's revision runs: its own place, else the server's default for it", () => {
    const docker = placesOf({ places: { ...PLACES, default_place: { mode: "sandbox", box: "docker" } } });
    const agentic = (definition: Record<string, unknown>) => ({ kind: "agentic" as const, definition: { version: 1, name: "a", instructions: "", skills: [], tools: ["write"], ...definition } }) as never;
    expect(runsWhere(agentic({ place: { mode: "runner" } }), docker)).toEqual({ place: { mode: "runner" }, byDefault: false });
    expect(runsWhere(agentic({}), docker)).toEqual({ place: { mode: "sandbox", box: "docker" }, byDefault: true });
    expect(runsWhere(agentic({ tools: ["browser"] }), docker)).toEqual({ place: { mode: "runner" }, byDefault: true });
    expect(runsWhere(agentic({}), placesOf({ places: PLACES }))).toEqual({ place: { mode: "runner" }, byDefault: true });
    expect(runsWhere(agentic({}), null)).toBeUndefined();
  });

  // The server's cases (packages/serve/test/default-place.test.mjs): a revision with no place runs where default_place
  // says; one with the browser, and a workflow, on the runner; where default_place is the runner, there.
  it("resolves no place as the server's defaultPlaceOf does at a run", () => {
    const docker = placesOf({ places: { ...PLACES, default_place: { mode: "sandbox", box: "docker" } } });
    expect(defaultPlaceOf(false, ["write"], docker)).toEqual({ mode: "sandbox", box: "docker" });
    expect(defaultPlaceOf(false, ["bash"], docker)).toEqual({ mode: "sandbox", box: "docker" });
    expect(defaultPlaceOf(false, ["read", "browser"], docker)).toEqual({ mode: "runner" });
    expect(defaultPlaceOf(true, [], docker)).toEqual({ mode: "runner" });
    expect(defaultPlaceOf(false, ["bash"], placesOf({ places: PLACES }))).toEqual({ mode: "runner" });
  });
});
