import { describe, expect, expectTypeOf, it } from "vitest";
import type { components } from "./api.generated";
import type { Agent } from "./agentForm";
import type { Capabilities } from "./client";

// The console's types for GET /capabilities and for an agent are the server's document's (api.generated.ts, which
// scripts/generate-clients.mjs writes from it), so a field the server sends is a field the console reads, by the same
// name and type. The checks are tsc's: `npm run typecheck` fails on a type that drifts from the document.

/** The agent fields the console reads narrower than the document says them (v2.ts Agent says why). */
type Narrowed = "kind" | "revision" | "definition";

describe("the console's served types", () => {
  it("read GET /capabilities as the document says it", () => {
    expectTypeOf<Capabilities>().toEqualTypeOf<components["Capabilities"]>();
    // A model source the server sends (model.ts modelSource and the hosted backend's) is one the console names.
    expectTypeOf<Capabilities["models"]["source"]>().toEqualTypeOf<components["Capabilities"]["models"]["source"]>();
    // Every harness the server lists, with each field of its offer.
    expectTypeOf<Capabilities["harnesses"][number]>().toEqualTypeOf<NonNullable<components["Capabilities"]["harnesses"]>[number]>();
    expect(true).toBe(true);
  });

  it("read an agent as the document says it, but for the fields it narrows", () => {
    // Every agent the console holds is one the document allows: no field the server does not send.
    expectTypeOf<Agent>().toExtend<components["Agent"]>();
    // And each field it does not narrow is the document's own, required where the server always sends it.
    expectTypeOf<Omit<Agent, Narrowed>>().toEqualTypeOf<Omit<components["Agent"], Narrowed>>();
    expect(true).toBe(true);
  });
});
