// Where an email trigger starts watching (trigger-email.ts, through its poll in triggers.ts): a poll with no cursor, or
// one on another mailbox or account, takes the mailbox's end (its UIDVALIDITY and UIDNEXT) and says so ("Watching"). The
// engine kicks a poll at once when the trigger is made, turned on again (its cursor forgotten first) or its source edited
// (its cursor kept), so mail that came after Apply starts runs and mail from before does not. An edit of accept or
// every_s keeps the cursor. Turned on again, the mail that came while it was off starts no run. An account that can't be
// reached when the trigger is made still makes it: its first check says so on the trigger, and the first check that signs
// in takes the start, says it couldn't check until then, and replays nothing older. A refused sign-in at creation is one
// of the three that turn a trigger off, as any poll's is.
import assert from "node:assert/strict";
import { test } from "node:test";
import { follow, serve } from "./support.mjs";
import { fakeClock, firings, keyOf, made, until } from "./trigger-support.mjs";
import { checked, emailTrigger, mailbox, saved } from "./email-support.mjs";

const T0 = "2026-06-01T00:00:30Z";
/** The grid's minute `n` after T0's: every_s 60 runs on whole minutes from the epoch. */
const minute = (n) => new Date(Date.parse("2026-06-01T00:01:00Z") + (n - 1) * 60_000).toISOString().replace(".000Z", "Z");
const WATCHING = (box, n) => `Watching ${box} from now: the ${n} message${n === 1 ? "" : "s"} already there won't start runs.`;
const UNCHECKED_TILL_NOW = (n) => `Couldn't check INBOX until now; watching from now: the ${n} message${n === 1 ? "" : "s"} there won't start runs.`;

/** The trigger made: 201, its id. */
async function trigger(api, body) {
  const res = await api("POST", "/triggers", body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/** The trigger patched: 200. */
async function patched(api, id, body) {
  const res = await api("PATCH", `/triggers/${id}`, body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

const statuses = (list) => list.map((f) => [f.status, f.reason ?? f.key]);

test("the first poll is kicked at creation: the Watching line is written then, with no clock moved, and mail after it starts a run", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock(T0);
  const { api } = await serve(t, { triggerClock: clock });
  const faux = await mailbox(t);
  for (const n of [1, 2, 3]) faux.seed({ from: "old@example.com", subject: `Old ${n}`, text: "From before." });
  await saved(api, faux);
  await made(api, "mail");
  const { id } = await trigger(api, emailTrigger("mail", { every_s: 60 }));
  // No clock moved: the line is the creation's own.
  const [watching] = await firings(api, id, 1);
  assert.deepEqual([watching.status, watching.run_id, watching.by, watching.reason], ["skipped", null, "email", WATCHING("INBOX", 3)]);
  assert.ok(faux.commands().some((c) => /^EXAMINE "?INBOX"?/i.test(c)), `INBOX examined at creation: ${faux.commands().join("\n")}`);
  const made1 = await checked(api, id, T0);
  assert.equal(made1.last_check?.ok, true, `the creation's check is its last check: ${JSON.stringify(made1.last_check)}`);

  const between = faux.seed({ from: "ana@example.com", subject: "Right after Apply" });
  clock.to(minute(1));
  const after = await firings(api, id, 2);
  assert.deepEqual(after.map((f) => f.status), ["started", "skipped"], JSON.stringify(after));
  assert.equal(after[0].key, keyOf("email", id, between.messageId), "the message that came after Apply started a run");
  await follow(api, after[0].run_id, ["completed"]);
  assert.equal(after.filter((f) => f.reason?.startsWith("Watching")).length, 1, "one Watching line: the first poll writes none");
});

test("an edit of the mailbox takes a new start; an edit of the filter keeps the cursor", { timeout: 150_000 }, async (t) => {
  const clock = fakeClock(T0);
  const { api } = await serve(t, { triggerClock: clock });
  const faux = await mailbox(t);
  faux.seed({ mailbox: "Archive", subject: "Archived before" });
  await saved(api, faux);
  await made(api, "mail");
  const { id } = await trigger(api, emailTrigger("mail", { every_s: 60 }));
  await firings(api, id, 1);

  // A filter edit after a message came: the cursor is kept, so the message is still new to it.
  const kept = faux.seed({ from: "ana@example.com", subject: "Keep 1" });
  await patched(api, id, { source: { kind: "email", every_s: 60, accept: [{ event: "message", where: [{ pointer: "/subject", prefix: "Keep" }] }] } });
  clock.to(minute(1));
  const afterFilter = await firings(api, id, 2);
  assert.deepEqual(afterFilter.map((f) => f.status), ["started", "skipped"], `the filter edit kept the cursor: ${JSON.stringify(statuses(afterFilter))}`);
  assert.equal(afterFilter[0].key, keyOf("email", id, kept.messageId));
  assert.equal(afterFilter.filter((f) => f.reason?.startsWith("Watching")).length, 1, "no second Watching line for a filter edit");
  await follow(api, afterFilter[0].run_id, ["completed"]);

  // A mailbox edit: a new start, on Archive, said at the edit; what was there stays.
  await patched(api, id, { source: { kind: "email", every_s: 60, mailbox: "Archive" } });
  const afterMove = await firings(api, id, 3);
  assert.equal(afterMove[0].reason, WATCHING("Archive", 1), JSON.stringify(statuses(afterMove)));
  const fresh = faux.seed({ mailbox: "Archive", from: "bo@example.com", subject: "Into Archive" });
  clock.to(minute(2));
  const later = await firings(api, id, 4);
  assert.deepEqual([later[0].status, later[0].key], ["started", keyOf("email", id, fresh.messageId)], JSON.stringify(statuses(later)));
  await follow(api, later[0].run_id, ["completed"]);
});

/** A trigger made while its start is held at the mail server (INBOX's EXAMINE): the POST in flight, the trigger's id
 *  once it is stored, and the release that lets the start answer. */
async function heldStart(api, faux, body) {
  const release = faux.hold(/^EXAMINE "?INBOX"?/i);
  const creating = api("POST", "/triggers", body);
  const id = await until(async () => faux.commands().some((c) => /^EXAMINE "?INBOX"?/i.test(c)) && (await api("GET", "/triggers")).body.triggers.find((one) => one.name === body.name)?.id);
  assert.ok(id, "the start reached the mail server, the trigger stored");
  return { id, release, creating };
}

for (const [what, edit, at] of [
  ["its filter", { kind: "email", every_s: 60, accept: [{ event: "message", where: [{ pointer: "/subject", prefix: "After" }] }] }, minute(1)],
  ["every_s", { kind: "email", every_s: 120 }, minute(2)],
]) {
  test(`an edit of ${what} while the start is still being taken keeps that start: mail after it starts a run`, { timeout: 150_000 }, async (t) => {
    const clock = fakeClock(T0);
    const { api } = await serve(t, { triggerClock: clock });
    const faux = await mailbox(t);
    faux.seed({ from: "old@example.com", subject: "Before" });
    await saved(api, faux);
    await made(api, "mail");
    const { id, release, creating } = await heldStart(api, faux, emailTrigger("mail", { every_s: 60 }));
    await patched(api, id, { source: edit });
    release();
    assert.equal((await creating).status, 201);
    const [watching] = await firings(api, id, 1);
    assert.deepEqual([watching.status, watching.reason], ["skipped", WATCHING("INBOX", 1)], "the held start is kept, said at the creation");

    const after = faux.seed({ from: "ana@example.com", subject: "After the edit" });
    clock.to(at);
    await checked(api, id, at);
    const shown = await firings(api, id, 1);
    assert.ok(shown.some((f) => f.status === "started" && f.key === keyOf("email", id, after.messageId)), `the message after the start started a run: ${JSON.stringify(statuses(shown))}`);
    assert.equal(shown.filter((f) => f.reason?.startsWith("Watching")).length, 1, "one start: the first poll took none");
    const started = shown.find((f) => f.status === "started");
    if (started) await follow(api, started.run_id, ["completed"]);
  });
}

test("a create whose start an edit of its filter drops answers once the start after it is taken: mail right after the answer starts a run", { timeout: 150_000 }, async (t) => {
  const clock = fakeClock(T0);
  const { api } = await serve(t, { triggerClock: clock });
  const faux = await mailbox(t);
  faux.seed({ from: "old@example.com", subject: "After, but before" });
  await saved(api, faux);
  await made(api, "mail");
  const { id, release, creating } = await heldStart(api, faux, emailTrigger("mail", { every_s: 60 }));
  await patched(api, id, { source: { kind: "email", every_s: 60, accept: [{ event: "message", where: [{ pointer: "/subject", prefix: "After" }] }] } });
  // The start after the edit's, held at the server too: the create answers before it only if it doesn't wait for it.
  const next = faux.hold(/^EXAMINE "?INBOX"?/i);
  release();
  let answered;
  void creating.then((res) => (answered = res));
  const examined = () => faux.commands().filter((c) => /^EXAMINE "?INBOX"?/i.test(c)).length;
  assert.ok(await until(() => answered || examined() >= 2, 15_000), "the create answered, or the start after the edit reached the server");
  if (!answered) {
    next();
    await creating;
  }
  assert.equal(answered?.status, 201, JSON.stringify(answered?.body));
  // Mail right after the create's answer: after the start, so it starts a run.
  const after = faux.seed({ from: "ana@example.com", subject: "After the answer" });
  next();
  clock.to(minute(1));
  await checked(api, id, minute(1));
  const shown = await firings(api, id, 2);
  assert.ok(shown.some((f) => f.status === "started" && f.key === keyOf("email", id, after.messageId)), `the message after the answer started a run: ${JSON.stringify(statuses(shown))}`);
  assert.deepEqual(shown.filter((f) => f.reason?.startsWith("Watching")).map((f) => f.reason), [WATCHING("INBOX", 1)], "one start, said once");
  const started = shown.find((f) => f.status === "started");
  if (started) await follow(api, started.run_id, ["completed"]);
});

test("an edit of the mailbox while the start is still being taken takes the new start; the held one is dropped", { timeout: 150_000 }, async (t) => {
  const clock = fakeClock(T0);
  const { api } = await serve(t, { triggerClock: clock });
  const faux = await mailbox(t);
  faux.seed({ mailbox: "Archive", subject: "Archived before" });
  await saved(api, faux);
  await made(api, "mail");
  const { id, release, creating } = await heldStart(api, faux, emailTrigger("mail", { every_s: 60 }));
  await patched(api, id, { source: { kind: "email", every_s: 60, mailbox: "Archive" } });
  release();
  assert.equal((await creating).status, 201);
  const made1 = await firings(api, id, 1);
  assert.deepEqual(made1.filter((f) => f.reason?.startsWith("Watching")).map((f) => f.reason), [WATCHING("Archive", 1)], `only the move's start is said: ${JSON.stringify(statuses(made1))}`);

  const inbox = faux.seed({ from: "old@example.com", subject: "Into INBOX" });
  const archived = faux.seed({ mailbox: "Archive", from: "bo@example.com", subject: "Into Archive" });
  clock.to(minute(1));
  await checked(api, id, minute(1));
  const shown = await firings(api, id, 2);
  assert.deepEqual(shown.filter((f) => f.status === "started").map((f) => f.key), [keyOf("email", id, archived.messageId)], JSON.stringify(statuses(shown)));
  assert.ok(!shown.some((f) => f.key === keyOf("email", id, inbox.messageId)), "INBOX is no longer read");
  await follow(api, shown.find((f) => f.status === "started").run_id, ["completed"]);
});

test("turned on again, a trigger forgets its cursor and polls at once: mail that came while it was off starts no run, and is counted", { timeout: 150_000 }, async (t) => {
  const clock = fakeClock(T0);
  const { api } = await serve(t, { triggerClock: clock });
  const faux = await mailbox(t);
  await saved(api, faux);
  await made(api, "mail");
  const { id } = await trigger(api, emailTrigger("mail", { every_s: 60 }));
  clock.to(minute(1));
  await checked(api, id, minute(1));
  await patched(api, id, { enabled: false });
  const whileOff = faux.seed({ from: "ana@example.com", subject: "While off" });
  clock.to(minute(2));
  await patched(api, id, { enabled: true });
  const shown = await firings(api, id, 2);
  assert.deepEqual([shown[0].status, shown[0].run_id], ["skipped", null]);
  assert.equal(shown[0].reason, WATCHING("INBOX", 1), `the mail that came while it was off is counted as already there: ${JSON.stringify(statuses(shown))}`);

  const next = faux.seed({ from: "bo@example.com", subject: "After on" });
  clock.to(minute(3));
  const later = await firings(api, id, 3);
  assert.deepEqual([later[0].status, later[0].key], ["started", keyOf("email", id, next.messageId)], JSON.stringify(statuses(later)));
  assert.ok(!later.some((f) => f.key === keyOf("email", id, whileOff.messageId)), "the message from while it was off started nothing");
  await follow(api, later[0].run_id, ["completed"]);
});

test("unreachable at creation: the trigger is made and its check says so; the first check that signs in takes the start and says it couldn't check until then, with no replay", { timeout: 150_000 }, async (t) => {
  const clock = fakeClock(T0);
  const { api } = await serve(t, { triggerClock: clock });
  const faux = await mailbox(t);
  faux.seed({ from: "old@example.com", subject: "Old 1" });
  faux.seed({ from: "old@example.com", subject: "Old 2" });
  // A port nothing listens on: the account saved there can't be reached.
  const closed = await mailbox(t);
  const unreachable = { host: "127.0.0.1", port: closed.imap.port };
  await closed.close();
  await saved(api, faux, { imap: unreachable });
  await made(api, "mail");
  const created = await api("POST", "/triggers", emailTrigger("mail", { every_s: 60 }));
  assert.equal(created.status, 201, `still made: ${JSON.stringify(created.body)}`);
  const { id } = created.body;
  const view = await checked(api, id, T0);
  assert.deepEqual([view.enabled, view.last_check?.ok], [true, false], JSON.stringify(view.last_check));
  assert.deepEqual((await api("GET", `/triggers/${id}/firings`)).body.firings, [], "a failed check writes no history line");

  await saved(api, faux);
  clock.to(minute(1));
  await checked(api, id, minute(1));
  const first = await firings(api, id, 1);
  assert.deepEqual([first[0].status, first[0].reason], ["skipped", UNCHECKED_TILL_NOW(2)], "the start taken at the first good check, said once");
  assert.ok(!first.some((f) => f.status === "started"), "nothing from before it replayed");
  const next = faux.seed({ from: "ana@example.com", subject: "New" });
  clock.to(minute(2));
  const later = await firings(api, id, 2);
  assert.deepEqual([later[0].status, later[0].key], ["started", keyOf("email", id, next.messageId)]);
  assert.equal(later.filter((f) => f.reason?.startsWith("Couldn't check")).length, 1, "said once");
  await follow(api, later[0].run_id, ["completed"]);
});

test("a sign-in refused at creation still makes the trigger, and is one of the three refusals that turn it off", { timeout: 150_000 }, async (t) => {
  const clock = fakeClock(T0);
  const { api } = await serve(t, { triggerClock: clock, runner: false });
  const faux = await mailbox(t);
  await saved(api, faux);
  await made(api, "mail");
  faux.refuseLogin(true);
  const { id } = await trigger(api, emailTrigger("mail", { every_s: 60 }));
  const first = await checked(api, id, T0);
  assert.deepEqual([first.enabled, first.last_check.ok], [true, false], "the creation's check, refused");
  clock.to(minute(1));
  const view = await checked(api, id, minute(1));
  assert.equal(view.enabled, true, "still on after the creation's refusal and one at a poll");
  clock.to(minute(2));
  const off = await checked(api, id, minute(2));
  assert.equal(off.enabled, false, "the third refused check, the creation's counted, turns it off");
  assert.equal(off.disabled.reason, "sign_in_refused");
});
