import assert from "node:assert/strict";
import test from "node:test";
import { createRepeatGuard } from "../dist/index.js";

const failure = (code, detail) => ({ ok: false, code, retryable: true, effect: "none", message: `${code} happened`, ...(detail === undefined ? {} : { detail }) });

test("the third identical call after two identical failures is refused, and acts on nothing", () => {
  const guard = createRepeatGuard();
  guard.note("run", { code: "a" }, failure("code_error", "boom"));
  assert.equal(guard.check("run", { code: "a" }), null, "one failure is not a repeat");
  guard.note("run", { code: "a" }, failure("code_error", "boom"));
  const refused = guard.check("run", { code: "a" });
  assert.equal(refused.code, "refused");
  assert.equal(refused.ok, false);
  assert.equal(refused.retryable, false);
  assert.equal(refused.effect, "none");
  assert.match(refused.message, /^Refused: run with these exact arguments already failed 2 times with the same error \("code_error:boom"\)/);
});

test("checking changes nothing: a refused call stays refused, with the same count", () => {
  const guard = createRepeatGuard();
  for (let i = 0; i < 2; i += 1) guard.note("snapshot", {}, failure("timeout", "slow"));
  for (let i = 0; i < 3; i += 1) assert.match(guard.check("snapshot", {}).message, /failed 2 times/);
  guard.note("snapshot", {}, failure("timeout", "slow"));
  assert.match(guard.check("snapshot", {}).message, /failed 3 times/);
});

test("an error is its code and detail, else its message: a different one starts the count again", () => {
  const guard = createRepeatGuard();
  guard.note("run", {}, failure("code_error", "boom"));
  guard.note("run", {}, failure("code_error", "bang"));
  assert.equal(guard.check("run", {}), null, "same code, different detail");
  guard.note("run", {}, failure("command_failed", "bang"));
  assert.equal(guard.check("run", {}), null, "same detail, different code");
  guard.note("run", {}, failure("command_failed"));
  guard.note("run", {}, failure("command_failed"));
  assert.match(guard.check("run", {}).message, /\("command_failed:command_failed happened"\)/, "no detail: the message is the error");
});

test("a success clears the strikes for those arguments", () => {
  const guard = createRepeatGuard();
  for (let i = 0; i < 2; i += 1) guard.note("run", { code: "a" }, failure("code_error", "boom"));
  guard.note("run", { code: "a" }, null);
  assert.equal(guard.check("run", { code: "a" }), null);
});

test("strikes are kept per tool and per exact arguments; no arguments are the empty object", () => {
  const guard = createRepeatGuard();
  for (let i = 0; i < 2; i += 1) guard.note("browser_read", undefined, failure("not_content", "pdf"));
  assert.ok(guard.check("browser_read", {}), "undefined and {} are the same call");
  assert.equal(guard.check("browser_read", { find: "price" }), null);
  assert.equal(guard.check("snapshot", {}), null);
});

test("a cancelled call is not a strike: it neither counts toward a refusal nor clears one", () => {
  const guard = createRepeatGuard();
  for (let i = 0; i < 3; i += 1) guard.note("snapshot", {}, failure("aborted", "This operation was aborted"));
  assert.equal(guard.check("snapshot", {}), null);
  for (let i = 0; i < 2; i += 1) guard.note("run", { code: "a" }, failure("code_error", "boom"));
  guard.note("run", { code: "a" }, failure("aborted", "This operation was aborted"));
  assert.ok(guard.check("run", { code: "a" }));
});

test("the error quoted in a refusal is cut to 200 characters", () => {
  const guard = createRepeatGuard();
  for (let i = 0; i < 2; i += 1) guard.note("run", {}, failure("code_error", "x".repeat(1_000)));
  const quoted = guard.check("run", {}).message.match(/\("([^"]*)"\)/)[1];
  assert.equal(quoted.length, 200);
});
