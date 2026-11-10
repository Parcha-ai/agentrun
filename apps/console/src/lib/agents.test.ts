import { describe, expect, it } from "vitest";
import { byName } from "./agents";

describe("byName: the one order of every agent picker", () => {
  it("is by name, ignoring case and accents, the id breaking a tie", () => {
    const agents = [{ id: "b2", name: "beta" }, { id: "z", name: "zeta" }, { id: "b1", name: "Beta" }, { id: "e", name: "éclair" }, { id: "a", name: "Alpha" }];
    expect([...agents].sort(byName).map((a) => a.id)).toEqual(["a", "b1", "b2", "e", "z"]);
  });
  it("reads a number in a name as a number: agent 9 before agent 10", () => {
    const agents = [{ id: "x", name: "agent 10" }, { id: "y", name: "agent 9" }, { id: "w", name: "agent 1" }];
    expect([...agents].sort(byName).map((a) => a.name)).toEqual(["agent 1", "agent 9", "agent 10"]);
  });
});
