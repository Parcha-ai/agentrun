import { describe, expect, it } from "vitest";
import { approvalOf, approvalRefusal, argsShown, priceLine } from "./approval";
import { ClientError, createClient } from "./client";
import type { Run } from "./v2";

// A tool call set to ask parks its run: status input_required, state waiting, and `pending` of kind approval naming the
// call (serve's tool gate). The console answers it at POST /v2/runs/{id}/approvals/{pending.id}.
const APPROVAL = { kind: "approval" as const, id: "ap_0123456789abcdef", tool: "web_fetch", call_id: "call_1", args_preview: "{\"url\":\"http://public.example/\"}", requested_at: "2026-11-04T10:00:00.000Z" };

const refused = (status: number, code: string, details?: Record<string, unknown>) => {
  const e = new ClientError(status, code, `the server's own words (${code})`);
  if (details) e.details = details;
  return e;
};

describe("a pending approval", () => {
  it("is read from a run only while it waits on one: never a question, never a run that waits on nothing", () => {
    const run = { status: "input_required", state: "waiting", pending: APPROVAL } as unknown as Run;
    expect(approvalOf(run)).toEqual(APPROVAL);
    expect(approvalOf({ ...run, pending: { kind: "question", question: "Which one?", asked_at: APPROVAL.requested_at } })).toBeNull();
    expect(approvalOf({ ...run, pending: null })).toBeNull();
    expect(approvalOf({ ...run, pending: undefined })).toBeNull();
    // A stopped run (input_required, idle) waits on nothing, whatever an old read held.
    expect(approvalOf({ ...run, state: "idle" })).toBeNull();
  });

  it("says its price per call: dollars where the tool names one, not metered, or nothing when it names none", () => {
    expect(priceLine(0.02)).toBe("Costs $0.02 per call");
    expect(priceLine(0.005)).toBe("Costs $0.0050 per call");
    expect(priceLine(0)).toBe("Costs $0.00 per call");
    expect(priceLine("not metered")).toBe("Not metered");
    expect(priceLine(undefined)).toBeNull();
  });

  it("shows its arguments laid out when they are whole JSON, and as the server sent them when cut", () => {
    expect(argsShown(APPROVAL.args_preview)).toBe("{\n  \"url\": \"http://public.example/\"\n}");
    const cut = `{"query":"${"x".repeat(40)}…`;
    expect(argsShown(cut)).toBe(cut);
    expect(argsShown("")).toBe("");
  });
});

describe("an answer the server refused, in words", () => {
  it("says a conflicting answer, a stop's withdrawal and a cancel each plainly", () => {
    expect(approvalRefusal(refused(409, "not_continuable", { reason: "already_answered", decision: "allow" }))).toBe("This call was already allowed, in another tab or by another answer. The run shows what happened next.");
    expect(approvalRefusal(refused(409, "not_continuable", { reason: "already_answered", decision: "deny" }))).toBe("This call was already denied, in another tab or by another answer. The run shows what happened next.");
    expect(approvalRefusal(refused(409, "not_continuable", { reason: "already_answered", decision: "withdrawn" }))).toBe("The run was stopped while this call waited, so the call was withdrawn. It never ran.");
    expect(approvalRefusal(refused(409, "not_continuable", { reason: "already_answered", decision: "canceled" }))).toBe("The run was cancelled while this call waited. The call never ran.");
  });

  it("says who may answer, a session that ended, and a call no longer waiting", () => {
    expect(approvalRefusal(refused(403, "forbidden"))).toBe("Only the owner, signed in with the password on this page, can answer an approval.");
    expect(approvalRefusal(refused(401, "unauthenticated"))).toBe("Your sign-in ended. Sign in again to answer.");
    expect(approvalRefusal(refused(404, "not_found"))).toBe("This run no longer waits on that call.");
  });

  it("says any other refusal as the server put it, and a request that never got an answer by its message", () => {
    expect(approvalRefusal(refused(409, "not_continuable", { reason: "something_new" }))).toBe("not_continuable: the server's own words (not_continuable)");
    expect(approvalRefusal(refused(422, "input_invalid"))).toBe("input_invalid: the server's own words (input_invalid)");
    expect(approvalRefusal(new TypeError("Failed to fetch"))).toBe("Failed to fetch");
  });
});

describe("the client's answer", () => {
  it("POSTs the decision, and a note only when given, as same-origin JSON to the run's approval, and takes the 204", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const v2 = createClient({ fetch: (async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response(null, { status: 204 }); }) as typeof fetch });
    await v2.answerApproval("run/1", "ap_0123456789abcdef", "allow");
    await v2.answerApproval("run/1", "ap_0123456789abcdef", "deny", "Not that site.");
    expect(calls.map((c) => [c.url, c.init?.method, c.init?.credentials, new Headers(c.init?.headers).get("content-type")])).toEqual([
      ["/v2/runs/run%2F1/approvals/ap_0123456789abcdef", "POST", "same-origin", "application/json"],
      ["/v2/runs/run%2F1/approvals/ap_0123456789abcdef", "POST", "same-origin", "application/json"],
    ]);
    expect(calls.map((c) => JSON.parse(String(c.init?.body)))).toEqual([{ decision: "allow" }, { decision: "deny", note: "Not that site." }]);
  });

  it("throws a 409 with its details, so the words above can be said", async () => {
    const v2 = createClient({ fetch: (async () => new Response(JSON.stringify({ error: { code: "not_continuable", message: "The tool call ap_1 was already answered: allow.", retryable: false, details: { reason: "already_answered", decision: "allow" } } }), { status: 409, headers: { "content-type": "application/json" } })) as typeof fetch });
    const e = await v2.answerApproval("r1", "ap_1", "deny").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ClientError);
    expect((e as ClientError).details).toEqual({ reason: "already_answered", decision: "allow" });
    expect(approvalRefusal(e)).toMatch(/^This call was already allowed/);
  });
});
