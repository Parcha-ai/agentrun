// DockerProvider.attach's read of a machine (`docker inspect`, through execFile) takes the call's signal end to end: a
// docker CLI that never answers is answered aborted once the signal aborts, and the docker process it ran is killed,
// never left behind. What the runner's read-back of a run's computer's mount gives it (the claim's signal: serve's
// computer-for-claim.ts readBack), so a wedged Docker daemon holds no runner's close. Over the fake docker CLI on a
// fresh folder (fake-docker.mjs), its inspect held.
import assert from "node:assert/strict";
import { test } from "node:test";
import { container, fakeDocker } from "./fake-docker.mjs";

const C = "computer-0123456789ab";

const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Whether the process `pid` is still there. */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** "pending" when `promise` has not settled within `ms`, else what it settled with (its timer holds no process open). */
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("pending"), ms).unref())]);

test("DockerProvider.attach: a docker inspect that never answers ends with the call's signal, answered aborted, and the docker process it ran is killed", async () => {
  const { provider, proceed, heldPid } = fakeDocker({ containers: [container({ name: C })], hold: ["inspect"] });
  try {
    const cut = new AbortController();
    const going = provider.attach({ id: C }, { signal: cut.signal });
    const pid = await until(() => heldPid("inspect"));
    assert.ok(alive(pid), "docker inspect is running, held");
    assert.equal(await within(going, 200), "pending", "the read waits on it");
    cut.abort(new Error("the runner is closing"));
    const answer = await within(going, 2_000);
    assert.notEqual(answer, "pending", "answered once the signal aborts");
    assert.deepEqual({ ok: answer.ok, code: answer.error?.code }, { ok: false, code: "aborted" }, JSON.stringify(answer));
    await until(() => !alive(pid), 5_000);
  } finally {
    proceed("inspect");
  }
});
