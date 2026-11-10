import { describe, expect, it } from "vitest";
import { authMode, signInProblem, takeSetupCode } from "./auth";
import { ClientError } from "./client";
import fresh from "../fixtures/auth.session-new.json";
import signedIn from "../fixtures/auth.session-signed-in.json";
import signedOut from "../fixtures/auth.session-signed-out.json";
import wrong from "../fixtures/auth.sign-in-wrong.json";
import short from "../fixtures/auth.setup-short.json";
import again from "../fixtures/auth.setup-again.json";

const err = (r: { status: number; body: { error: { code: string; message: string; fields?: unknown } } }) =>
  Object.assign(new ClientError(r.status, r.body.error.code, r.body.error.message), { fields: r.body.error.fields });

describe("authMode", () => {
  it("reads the server's session: no password yet is setup, a password and no session is sign-in, a session is in", () => {
    expect(authMode({ status: fresh.status, body: fresh.body })).toBe("setup");
    expect(authMode({ status: signedOut.status, body: signedOut.body })).toBe("sign_in");
    expect(authMode({ status: signedIn.status, body: signedIn.body })).toBe("signed_in");
  });
  // A server without accounts answers its session read too (accounts: false), never a 404.
  it("a server without accounts is reached through the link it printed", () => {
    expect(authMode({ status: 200, body: { accounts: false, secrets_writable: false, secrets_reason: "token" } })).toBe("token_link");
    expect(authMode({ status: 200, body: { accounts: false, secrets_writable: false, secrets_reason: "token" } }, 401)).toBe("token_link");
  });
  it("a server without accounts whose protected read already succeeds (a token is sent) is in", () => {
    expect(authMode({ status: 200, body: { accounts: false, secrets_writable: true } }, 200)).toBe("signed_in");
  });
  it("a 404 is no longer read as a server without accounts", () => {
    expect(authMode({ status: 404, body: null }, 200)).not.toBe("signed_in");
  });
});

describe("signInProblem", () => {
  it("says a wrong password plainly, and a limit with its wait", () => {
    expect(signInProblem(err(wrong as never))).toBe("That is not the password.");
    expect(signInProblem(Object.assign(new ClientError(429, "rate_limited", "too many sign-ins; try again later"), {}))).toBe("Too many sign-ins from here. Try again in 15 minutes.");
  });
  it("on setup: a refused code, from the link or typed, says what to do: the newest link in the server's log, or the token", () => {
    const refused = new ClientError(403, "forbidden", "that is not the setup code in the server's log");
    expect(signInProblem(refused)).toBe("That setup code was refused: open the newest setup link in the server's log, or paste the server's token (AGENTRUN_TOKEN) here.");
  });
  it("on setup: a password the server refuses names why, and an owner already set says to sign in", () => {
    expect(signInProblem(err(short as never))).toBe((short.body.error as { fields?: { message: string }[] }).fields?.[0]?.message ?? short.body.error.message);
    expect(signInProblem(err(again as never))).toBe("This server has its owner already: sign in.");
  });
});

describe("takeSetupCode", () => {
  it("takes the setup code from the fragment once and leaves the rest of it", () => {
    expect(takeSetupCode("#code=abc-123")).toEqual({ code: "abc-123", rest: "" });
    expect(takeSetupCode("#code=abc&x=1")).toEqual({ code: "abc", rest: "#x=1" });
  });
  it("keeps only the printed code's base64url run: a character a chat app added after it (or an invisible one) is no part of it", () => {
    expect(takeSetupCode("#code=abc-123.").code).toBe("abc-123");
    expect(takeSetupCode("#code=abc_9)").code).toBe("abc_9");
    expect(takeSetupCode("#code=Abc123%E2%80%8B").code).toBe("Abc123");
    expect(takeSetupCode("#code=Abc123%E2%81%A0").code).toBe("Abc123");
    expect(takeSetupCode("#code=Abc123%EF%BB%BF").code).toBe("Abc123");
    // One inside the code ends the run there: what follows is not sent, and the server says the code was refused.
    expect(takeSetupCode("#code=Abc%E2%80%8B123").code).toBe("Abc");
    expect(takeSetupCode("#code=abc-123.&x=1")).toEqual({ code: "abc-123", rest: "#x=1" });
  });
  it("is nothing when the fragment has no code (a console route)", () => {
    expect(takeSetupCode("#/runs/r1")).toEqual({ code: null, rest: "#/runs/r1" });
    expect(takeSetupCode("")).toEqual({ code: null, rest: "" });
  });
});

describe("authMode on a server with no accounts that answers its session read", () => {
  it("reads accounts: false as a 404 does: in when a protected read succeeds, else the token link", () => {
    expect(authMode({ status: 200, body: { accounts: false, secrets_writable: true } }, 200)).toBe("signed_in");
    expect(authMode({ status: 200, body: { accounts: false, secrets_writable: false } }, 401)).toBe("token_link");
  });
});
