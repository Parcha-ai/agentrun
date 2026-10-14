import assert from "node:assert/strict";
import test from "node:test";
import { classifyBrowserError, FAILURE_CODES, NAVIGATED_SNAPSHOT_ERROR, NO_HYDRATED_SNAPSHOT_ERROR, STALE_SNAPSHOT_ID_ERROR, transportFactOf } from "../dist/index.js";

const named = (name, message = "boom", extra = {}) => Object.assign(new Error(message), { name }, extra);
const code = (error, effectful = false, facts) => classifyBrowserError(error, effectful, facts).code;

test("the code comes from typed facts, never from the words of a message", () => {
  for (const message of ["401 Unauthorized", "403 Forbidden", "Request timed out after 30000 ms", "connect ECONNREFUSED 127.0.0.1:9222", "This operation was aborted", "The browser session ended", `Error: ${NO_HYDRATED_SNAPSHOT_ERROR}`]) {
    assert.equal(code(new Error(message)), "command_failed", message);
    assert.equal(code(new Error(message), true), "code_error", message);
  }
});

test("a cancelled call is aborted whatever else the error carries", () => {
  assert.equal(code(new Error("x"), true, { aborted: true }), "aborted");
  assert.equal(code(new DOMException("stop", "AbortError")), "aborted");
  assert.equal(code(Object.assign(new Error("x"), { status: 401 }), false, { aborted: true, sessionEnded: true, timedOut: true }), "aborted");
  const failure = classifyBrowserError(new Error("x"), true, { aborted: true });
  assert.equal(failure.retryable, false);
  assert.equal(failure.effect, "possibly_effected");
});

test("401 and 403 are auth, and an auth failure never possibly acted", () => {
  for (const status of [401, 403]) {
    for (const error of [Object.assign(new Error("x"), { status }), new Error("wrapped", { cause: Object.assign(new Error("y"), { status }) }), Object.assign(new Error("x"), { statusCode: status }), Object.assign(new Error("x"), { transport: { status } })]) {
      const failure = classifyBrowserError(error, true, { sessionEnded: true, timedOut: true });
      assert.equal(failure.code, "auth", `${status} ${error.message}`);
      assert.equal(failure.effect, "none");
      assert.equal(failure.retryable, false);
    }
  }
  assert.notEqual(code(Object.assign(new Error("x"), { status: 500 })), "auth");
});

test("an ended session outranks a timeout, and both are retryable", () => {
  const ended = classifyBrowserError(new Error("x"), true, { sessionEnded: true, timedOut: true });
  assert.equal(ended.code, "session_ended");
  assert.equal(ended.retryable, true);
  assert.equal(ended.effect, "possibly_effected");
  assert.equal(code(new Error("x"), false, { timedOut: true }), "timeout");
  assert.equal(code(new DOMException("slow", "TimeoutError")), "timeout");
  assert.equal(classifyBrowserError(new Error("x"), false, { timedOut: true }).retryable, true);
});

test("a stale snapshot is known by its exact refusal text, and acted on nothing", () => {
  const stale = STALE_SNAPSHOT_ID_ERROR.replace("${id}", "e12");
  for (const message of [NO_HYDRATED_SNAPSHOT_ERROR, NAVIGATED_SNAPSHOT_ERROR, stale]) {
    const failure = classifyBrowserError(new Error(message), true);
    assert.equal(failure.code, "stale_snapshot", message);
    assert.equal(failure.effect, "none");
    assert.equal(failure.retryable, true);
  }
  assert.equal(code(new Error(STALE_SNAPSHOT_ID_ERROR.replace("${id}", ""))), "command_failed", "the template with no ID is not a refusal");
  assert.equal(code(new Error(`${NAVIGATED_SNAPSHOT_ERROR} `)), "command_failed");
});

test("an unreachable browser is known by its cause code or class name anywhere down the cause chain", () => {
  for (const cause of ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]) {
    const error = new TypeError("fetch failed", { cause: Object.assign(new Error("inner"), { code: cause }) });
    const failure = classifyBrowserError(error, true);
    assert.equal(failure.code, "browser_unavailable", cause);
    assert.equal(failure.retryable, false);
    assert.equal(failure.effect, "possibly_effected");
  }
  assert.equal(code(named("CDPConnectionClosedError")), "browser_unavailable");
  assert.equal(code(Object.assign(new Error("x"), { code: "ERR_SOMETHING_ELSE" })), "command_failed");
});

test("the message and detail carry the error and its cause, bounded", () => {
  const failure = classifyBrowserError(new Error("outer", { cause: new Error("inner") }), false);
  assert.equal(failure.detail, "outer: inner");
  assert.match(failure.message, /: outer: inner$/);
  const long = classifyBrowserError(new Error("x".repeat(5_000)), true);
  assert.equal(long.detail.length, 2_000);
  assert.ok(long.message.length <= "Your browser code threw: ".length + 600);
  assert.equal(classifyBrowserError("a thrown string", false).detail, "a thrown string");
});

test("every code a classification returns is a declared failure code, and the list is frozen", () => {
  assert.ok(Object.isFrozen(FAILURE_CODES));
  assert.equal(new Set(FAILURE_CODES).size, FAILURE_CODES.length);
  const errors = [new Error("x"), new DOMException("x", "AbortError"), Object.assign(new Error("x"), { status: 401 }), new Error(NAVIGATED_SNAPSHOT_ERROR), named("CDPConnectionClosedError"), new DOMException("x", "TimeoutError"), null, undefined, 42];
  const factsList = [{}, { aborted: true }, { sessionEnded: true }, { timedOut: true }];
  for (const error of errors) for (const facts of factsList) for (const effectful of [false, true]) {
    const failure = classifyBrowserError(error, effectful, facts);
    assert.ok(FAILURE_CODES.includes(failure.code), failure.code);
    assert.equal(failure.ok, false);
  }
});

test("transport facts: the throw site's record first, then class name, code and status down the cause chain, first found wins", () => {
  const deep = Object.assign(new Error("deep"), { code: "ECONNRESET", status: 500, transport: { errorName: "Ignored", status: 599 } });
  const error = Object.assign(new Error("top", { cause: deep }), { name: "BrowserbaseError", transport: { status: 502 } });
  assert.deepEqual(transportFactOf(error), { status: 502, errorName: "BrowserbaseError", causeCode: "ECONNRESET" });
  assert.deepEqual(transportFactOf(new Error("plain", { cause: new TypeError("t") })), { errorName: "TypeError" }, "the bare Error class names nothing");
  assert.deepEqual(transportFactOf(Object.assign(new Error("x"), { code: "", status: 4.5 })), {}, "an empty code and a non-integer status are not facts");
});

test("transport facts end on a cyclic cause chain and on a value that is not an object", () => {
  const cyclic = new Error("loop");
  cyclic.cause = cyclic;
  assert.deepEqual(transportFactOf(cyclic), {});
  for (const value of [null, undefined, "string", 7]) assert.deepEqual(transportFactOf(value), {});
});
