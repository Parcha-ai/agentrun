import { describe, expect, it } from "vitest";
import { defaultPlaceOf } from "./agentForm";
import { placeOf, placesOf, placeWords } from "./place";

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
    expect(placesOf({ places: PLACES })).toEqual({ modes: PLACES.modes, default: "runner", boxes: BOXES, defaultPlace: { mode: "runner" } });
    // default_place is the one field: where a new agent goes and where a revision with no place runs.
    expect(placesOf({ places: { ...PLACES, default_place: { mode: "sandbox", box: "docker" } } })?.default).toBe("sandbox");
    expect(placesOf({ harnesses: [] })).toBeNull();
  });

  it("says where an agent runs in words", () => {
    expect(placeWords({ mode: "sandbox", box: "docker" }, placesOf({ places: PLACES }))).toBe("Runs in a docker box");
    expect(placeWords({ mode: "runner" }, null)).toBe("Runs on the server");
    expect(placeWords(undefined, placesOf({ places: PLACES }))).toBe("Runs on the server");
    expect(placeWords(undefined, placesOf({ places: { ...PLACES, default_place: { mode: "sandbox", box: "docker" } } }))).toBe("Runs in a docker box");
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
