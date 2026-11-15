// Where an email trigger starts watching (trigger-email.ts, through the clock adapter's start hook in triggers.ts): the
// cursor's start (INBOX's UIDVALIDITY and UIDNEXT) is taken when the trigger is made, when an edit changes its mailbox or
// account, and when it is turned on again; never at its first poll. Mail that came after Apply starts runs, mail from
// before does not, and the "Watching" line is written then. An edit of anything else (accept, every_s, the target) keeps
// the cursor. Turned on again, the mail that came while it was off starts no run, and that is said. An account that
// can't be reached when the trigger is made still makes it: the start is taken at the first check that signs in, said,
// and nothing older is replayed; a refused sign-in then is not one of the three that turn a trigger off.
import assert from "node:assert/strict";
import { test } from "node:test";
import { follow, serve } from "./support.mjs";
import { fakeClock, firings, keyOf, made } from "./trigger-support.mjs";
import { checked, emailTrigger, mailbox, saved } from "./email-support.mjs";

const T0 = "2026-06-01T00:00:30Z";
/** The grid's minute `n` after T0's: every_s 60 runs on whole minutes from the epoch. */
const minute = (n) => new Date(Date.parse("2026-06-01T00:01:00Z") + (n - 1) * 60_000).toISOString().replace(".000Z", "Z");
const WATCHING = (box, n) => `Watching ${box} from now: the ${n} message${n === 1 ? "" : "s"} already there won't start runs.`;
const UNCHECKED = "Couldn't check INBOX when it was created; watching from the first check that signs in.";

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

test("the start is taken at creation: the Watching line is written then, and mail between creation and the first poll starts a run", { timeout: 120_000 }, async (t) => {
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
  const made1 = (await api("GET", `/triggers/${id}`)).body;
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

test("turned on again, a trigger takes a new start: mail that came while it was off starts no run, and that is said", { timeout: 150_000 }, async (t) => {
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
  assert.match(shown[0].reason, /^Watching INBOX from now/, JSON.stringify(statuses(shown)));
  assert.match(shown[0].reason, /while it was off/, "the mail that came while it was off is named");
  assert.match(shown[0].reason, /\b1 message\b/, "and counted");

  const next = faux.seed({ from: "bo@example.com", subject: "After on" });
  clock.to(minute(3));
  const later = await firings(api, id, 3);
  assert.deepEqual([later[0].status, later[0].key], ["started", keyOf("email", id, next.messageId)], JSON.stringify(statuses(later)));
  assert.ok(!later.some((f) => f.key === keyOf("email", id, whileOff.messageId)), "the message from while it was off started nothing");
  await follow(api, later[0].run_id, ["completed"]);
});

test("unreachable at creation: the trigger is made and says so; the start is taken at the first check that signs in, said, with no replay", { timeout: 150_000 }, async (t) => {
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
  const [unchecked] = await firings(api, id, 1);
  assert.deepEqual([unchecked.status, unchecked.reason], ["skipped", UNCHECKED]);
  const view = (await api("GET", `/triggers/${id}`)).body;
  assert.deepEqual([view.enabled, view.last_check?.ok], [true, false], JSON.stringify(view.last_check));

  await saved(api, faux);
  clock.to(minute(1));
  await checked(api, id, minute(1));
  const first = await firings(api, id, 2);
  assert.deepEqual([first[0].status, first[0].reason], ["skipped", WATCHING("INBOX", 2)], "the start taken at the first good check, and said");
  assert.ok(!first.some((f) => f.status === "started"), "nothing from before it replayed");
  const next = faux.seed({ from: "ana@example.com", subject: "New" });
  clock.to(minute(2));
  const later = await firings(api, id, 3);
  assert.deepEqual([later[0].status, later[0].key], ["started", keyOf("email", id, next.messageId)]);
  await follow(api, later[0].run_id, ["completed"]);
});

test("a sign-in refused at creation still makes the trigger, and is not one of the three refusals that turn it off", { timeout: 150_000 }, async (t) => {
  const clock = fakeClock(T0);
  const { api } = await serve(t, { triggerClock: clock, runner: false });
  const faux = await mailbox(t);
  await saved(api, faux);
  await made(api, "mail");
  faux.refuseLogin(true);
  const { id } = await trigger(api, emailTrigger("mail", { every_s: 60 }));
  const [unchecked] = await firings(api, id, 1);
  assert.equal(unchecked.reason, UNCHECKED);
  for (const n of [1, 2]) {
    clock.to(minute(n));
    const view = await checked(api, id, minute(n));
    assert.equal(view.enabled, true, `still on after the creation's refusal and ${n} at polls`);
  }
  clock.to(minute(3));
  const off = await checked(api, id, minute(3));
  assert.equal(off.enabled, false, "the third refused poll turns it off");
  assert.equal(off.disabled.reason, "sign_in_refused");
});
