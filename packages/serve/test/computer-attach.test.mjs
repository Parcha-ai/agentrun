// The attach binding's pure parts on serve's side (computer-attach.ts, workspace/attached-computers.ts): a pairing code's
// form, the pair route's limit by source address, its body's check and its protocol rule, a close reason cut to what a
// close frame holds, and a paired computer as one more provider of the kind registry.
import assert from "node:assert/strict";
import { test } from "node:test";

const { MACHINE_TOKEN_SOURCE, newMachineToken } = await import("@parcha/agentrun-computer");
const { closeReason, createAttachRoutes, newPairedId, newPairingCode, PAIR_TRIES_PER_MINUTE, pairBodyOf, pairedView, pairingCodeOf, pairRefusal, pairTries } = await import("../dist/computer-attach.js");
const { notAttachedWords, ROUTE_PREFIX } = await import("../dist/workspace/paired-route.js");
const { AttachHub } = await import("@parcha/agentrun-computer");
const { helloLacks, pairedEntry, servesNoKind, withPaired, ONE_PROCESS_WORDS, pairedProvider } = await import("../dist/workspace/attached-computers.js");
const { resolveComputer } = await import("../dist/workspace/resolve-computer.js");
const { PAIRING_CODE_PATTERN, PROTOCOL_VERSION, PROVIDERS, SETTING_KINDS, servingRefusals } = await import("@parcha/agentrun-computer");

const HELLO = { protocol: PROTOCOL_VERSION, version: "0.2.0", os: "macos", kind: "desktop", arch: "arm64", groups: ["apps", "ui", "screen", "input.pointer", "input.keys"] };

test("a pairing code is eight characters of the alphabet in two groups of four; a typed one is read in any case, with or without its dash", () => {
  for (let i = 0; i < 200; i++) assert.match(newPairingCode(), PAIRING_CODE_PATTERN);
  assert.equal(newPairingCode(() => 0), "AAAA-AAAA");
  assert.equal(pairingCodeOf("k7pd w3qx"), "K7PD-W3QX");
  assert.equal(pairingCodeOf("K7PDW3QX"), "K7PD-W3QX");
  assert.equal(pairingCodeOf(" k7pd-w3qx "), "K7PD-W3QX");
  for (const bad of ["K7PD-W3Q", "K7PD-W3QXY", "K0PD-W3QX", "K1PD-W3QX", "KIPD-W3QX", "KOPD-W3QX", 12345678, undefined]) assert.equal(pairingCodeOf(bad), undefined, `${bad} is no code`);
  assert.match(newPairedId(), /^cmp-[a-z2-9]{16}$/);
  assert.match(newMachineToken(), new RegExp(`^${MACHINE_TOKEN_SOURCE}$`), "art_ and 32 bytes in base64url");
});

test("the pair limit lets a source address try ten times a minute, then says how long to wait; another address is not held by it, an IPv6 one counted by its /64", () => {
  const clock = { now: 1_000_000 };
  const tries = pairTries(() => clock.now);
  for (let i = 0; i < PAIR_TRIES_PER_MINUTE; i++) assert.deepEqual(tries.allow("192.0.2.7"), { ok: true });
  assert.deepEqual(tries.allow("192.0.2.7"), { ok: false, retryAfterMs: 60_000 });
  assert.deepEqual(tries.allow("192.0.2.8"), { ok: true }, "another address");
  clock.now += 30_000;
  assert.deepEqual(tries.allow("192.0.2.7"), { ok: false, retryAfterMs: 30_000 });
  clock.now += 30_000;
  assert.deepEqual(tries.allow("192.0.2.7"), { ok: true }, "a minute on");
  for (let i = 0; i < PAIR_TRIES_PER_MINUTE; i++) tries.allow(`2001:db8:1:2::${i + 1}`);
  assert.equal(tries.allow("2001:db8:1:2::ff").ok, false, "one /64");
  const small = pairTries(() => clock.now, 2);
  small.allow("192.0.2.1");
  small.allow("192.0.2.2");
  assert.deepEqual(small.allow("192.0.2.3"), { ok: true }, "a full table still lets a new address try");
  for (let i = 1; i < PAIR_TRIES_PER_MINUTE; i++) assert.deepEqual(small.allow(i % 2 ? "192.0.2.3" : `192.0.2.${100 + i}`), { ok: true });
  assert.equal(small.allow("192.0.2.3").ok, false, "the addresses a full table has no room for are counted together, never let through uncounted");
  clock.now += 60_000;
  assert.deepEqual(small.allow("192.0.2.3"), { ok: true }, "a minute on, the table has room again");
});

test("the pair body: its code in its one form, a name on one line, and the driver's hello; each wrong field named", () => {
  assert.deepEqual(pairBodyOf({ code: "k7pd w3qx", name: "  Ada's Mac ", hello: HELLO }), { code: "K7PD-W3QX", name: "Ada's Mac", hello: HELLO });
  const fields = (body) => {
    try {
      pairBodyOf(body);
    } catch (error) {
      assert.equal(error.code, "input_invalid");
      return error.extra.fields.map((field) => field.field);
    }
    assert.fail("refused");
  };
  assert.deepEqual(fields([]), ["body"]);
  assert.deepEqual(fields({ code: "nope", name: "", hello: HELLO }), ["code", "name"]);
  assert.deepEqual(fields({ code: "K7PD-W3QX", name: "a\nb", hello: HELLO }), ["name"]);
  assert.deepEqual(fields({ code: "K7PD-W3QX", name: "x".repeat(101), hello: HELLO }), ["name"]);
  assert.deepEqual(fields({ code: "K7PD-W3QX", name: "Mac", hello: { ...HELLO, os: "beos", kind: "toaster", groups: "screen", version: "" } }), ["hello.version", "hello.os", "hello.kind", "hello.groups"]);
  assert.deepEqual(fields({ code: "K7PD-W3QX", name: "Mac" }), ["hello"]);
});

test("a hello of a protocol this server does not take is refused in words that name the side to update; the server's own pairs, and so does one a minor step ahead", () => {
  assert.equal(pairRefusal("Ada's Mac", HELLO), undefined);
  assert.equal(pairRefusal("Ada's Mac", { ...HELLO, protocol: "0.3" }), undefined);
  // 0.1 is before 0.2 replaced apps.ui_tree with ui: that driver would pair without its UI tools.
  assert.equal(pairRefusal("Ada's Mac", { ...HELLO, protocol: "0.1", version: "0.1.4" }), "Ada's Mac's driver 0.1.4 speaks protocol 0.1, and this server 0.2: update the driver on Ada's Mac, then pair with the same code");
  assert.equal(pairRefusal("Ada's Mac", { ...HELLO, protocol: "1.0", version: "1.0.4" }), "Ada's Mac's driver 1.0.4 speaks protocol 1.0, and this server 0.2: the server is older, so once whoever runs it updates it, pair with the same code");
  // A number-led version of another shape reads past 0.2 part by part, but no server takes its shape: the driver is
  // the side to update.
  for (const protocol of ["0.2.1", "0.3-beta"]) {
    assert.equal(pairRefusal("Ada's Mac", { ...HELLO, protocol, version: "0.2.9" }), `Ada's Mac's driver 0.2.9 speaks protocol ${protocol}, and this server 0.2: update the driver on Ada's Mac, then pair with the same code`, protocol);
  }
});

test("a close reason is cut to the 123 bytes a close frame holds, never inside a character", () => {
  assert.equal(closeReason("short"), "short");
  const long = closeReason("é".repeat(100));
  assert.ok(Buffer.byteLength(long) <= 123, `${Buffer.byteLength(long)} bytes`);
  assert.match(long, /^(é)+\.\.\.$/);
});

test("a paired computer is one more provider of the registry: its id, its name, the kinds its paired hello serves, no keys, no mount, the machine's own network; a runner with no hub refuses it in words", () => {
  const registry = { SETTING_KINDS, PROVIDERS, servingRefusals };
  const row = { id: "cmp-abc", name: "vesper-mac", hello: HELLO, driver: "0.2.0", labels: {}, createdAt: 1, seenAt: null, revokedAt: null };
  const entry = pairedEntry(row, registry);
  assert.deepEqual({ ...entry, capabilities: entry.capabilities.map((one) => one.kind) }, {
    id: "cmp-abc", label: "vesper-mac (macos)", kinds: ["desktop"], keys: [], mounts: [], network: ["open"], metered: false, capabilities: ["desktop"], defaultImage: { desktop: "attached" },
    // Each kind it doesn't serve, with why: what the resolver says in its one "<label> gives no <kind> computer" shape.
    unserved: {
      sandbox: "it is a computer of your own, and only a Linux box paired with computerd and no display can be a sandbox computer; give this agent vesper-mac as a desktop computer",
      phone: "it is a computer of your own, and it says desktop, which no phone computer is; update the driver on vesper-mac",
      browser: "it is a computer of your own, and a paired computer can't be a browser computer yet; give this agent vesper-mac as a desktop computer",
    },
  });
  const phone = pairedEntry({ ...row, hello: { ...HELLO, os: "android", kind: "android", groups: ["screen", "input.touch", "apps", "ui"] } }, registry);
  assert.deepEqual({ kinds: phone.kinds, label: phone.label }, { kinds: ["phone"], label: "vesper-mac (android)" }, "a phone pairs as a phone, named by its os");
  assert.equal(withPaired(registry, []), registry, "none paired: the registry as it is");
  assert.deepEqual(withPaired(registry, [row]).PROVIDERS.map((one) => one.id), [...PROVIDERS.map((one) => one.id), "cmp-abc"]);
  assert.throws(() => pairedProvider(row, undefined), (error) => error.code === "computer_unavailable" && error.message === ONE_PROCESS_WORDS);
});

test("a hello that serves no kind is said in words naming what its driver lacks, at pairing and at a run's start", async () => {
  const screenOnly = { ...HELLO, groups: ["screen"] };
  assert.equal(helloLacks(HELLO, "desktop"), undefined);
  assert.equal(helloLacks(screenOnly, "desktop"), "it says desktop but declares no input.pointer, input.keys");
  assert.equal(helloLacks(HELLO, "phone"), "it says desktop, which no phone computer is");
  assert.equal(servesNoKind("vesper-mac", HELLO), undefined);
  assert.equal(servesNoKind("vesper-mac", screenOnly), "vesper-mac's driver serves no kind: it says desktop but declares no input.pointer, input.keys: update the driver on vesper-mac");
  assert.equal(servesNoKind("pixel", { ...HELLO, kind: "android", groups: ["screen"] }), "pixel's driver serves no kind: it says android but declares no input.touch, apps: update the driver on pixel");
  // A kind the attach path has no connection for (a browser's CDP) is refused by kind, whatever the OS.
  const browserSays = "a paired computer can't serve browser sessions yet, so pair a desktop or phone driver";
  assert.equal(servesNoKind("ada-chrome", { ...HELLO, os: "linux", kind: "browser", groups: ["cdp"] }), `ada-chrome's driver is a browser: ${browserSays}`);
  assert.equal(servesNoKind("ada-chrome", { ...HELLO, os: "macos", kind: "browser", groups: ["cdp"] }), `ada-chrome's driver is a browser: ${browserSays}`);
  // A Linux box's computerd with no display is a sandbox (paired-sandbox.test.mjs): one without exec serves none.
  assert.equal(servesNoKind("lab", { ...HELLO, os: "linux", kind: "linux", groups: ["files", "processes"] }), "lab's driver serves no kind: it says linux but declares no exec: update the driver on lab");
  assert.equal(servesNoKind("box", { ...HELLO, kind: "toaster" }), "box's driver serves no kind: it says toaster, which no kind of computer is: update the driver on box");

  // Paired before its driver lost a group: its run is refused saying why, then the providers to pick instead.
  const registry = withPaired({ SETTING_KINDS, PROVIDERS, servingRefusals }, [{ id: "cmp-abc", name: "vesper-mac", hello: screenOnly, driver: "0.2.0", labels: {}, createdAt: 1, seenAt: null, revokedAt: null }]);
  const { refused } = await resolveComputer({ kind: "desktop", provider: "cmp-abc" }, 1, registry, {});
  assert.match(refused, /^vesper-mac \(macos\) gives no desktop computer: it is a computer of your own, and it says desktop but declares no input\.pointer, input\.keys; update the driver on vesper-mac\. Pick one of /);
  const cloud = PROVIDERS.find((entry) => entry.kinds.includes("desktop"));
  assert.match(refused, new RegExp(cloud.label), "the cloud computers to pick instead");
});

test("a paired Mac never runs a run's shell or holds its folder, granted exec and files or not; a sandbox naming it is refused before the run starts, in words", async () => {
  const keys = { keysOf: async () => ({}) };
  const row = { id: "cmp-abc", name: "vesper-mac", hello: HELLO, driver: "0.2.0", labels: {}, createdAt: 1, seenAt: null, revokedAt: null };
  const granted = { ...row, hello: { ...HELLO, groups: ["exec", "files", ...HELLO.groups] } };
  for (const mode of [1, 2]) {
    for (const one of [row, granted]) {
      const desktop = await resolveComputer({ kind: "desktop", provider: "cmp-abc" }, mode, withPaired({ SETTING_KINDS, PROVIDERS, servingRefusals }, [one]), keys);
      assert.deepEqual({ refused: desktop.refused, folder: desktop.folder, ports: desktop.ports }, { refused: undefined, folder: undefined, ports: ["screen", "input"] }, `Mode ${mode}, groups ${one.hello.groups}`);
    }
    const { refused } = await resolveComputer({ kind: "sandbox", provider: "cmp-abc" }, mode, withPaired({ SETTING_KINDS, PROVIDERS, servingRefusals }, [row]), keys);
    assert.match(refused, /^vesper-mac \(macos\) gives no sandbox computer: it is a computer of your own, and only a Linux box paired with computerd and no display can be a sandbox computer; give this agent vesper-mac as a desktop computer\. Pick one of /);
  }
});

test("a paired computer is listed as its hello says, the live one's while attached, with the run that holds it and the deadline its hold ends by", () => {
  const row = { id: "cmp-abc", name: "desk", hello: { ...HELLO, os: "windows", osVersion: "11" }, driver: "0.2.0", labels: {}, pairingId: "pairing-x", createdAt: 0, seenAt: 1000, revokedAt: null };
  const features = { "ui.tree": { off: "no grant" }, "ui.image": true };
  // A driver's malformed features are left out of the list: only true or {off: words} reach the console.
  const live = { ...row.hello, version: "0.2.1", osVersion: "11 24H2", device: { maker: "Acme", model: "Book" }, screen: { width: 1920, height: 1080, scale: 1 }, features: { ...features, "apps.launch": null, "ui.act": { off: 3 }, "ui.wait": "yes" } };
  const deadline = new Date(5000);
  const liveSince = new Date(7000);
  const hub = (attached, holder) => ({ online: () => attached, since: () => (attached ? liveSince : undefined), hello: () => (attached ? live : undefined), claimed: () => (holder ? { "agentrun.run": holder } : undefined), deadline: () => (holder ? deadline : undefined) });
  assert.deepEqual(pairedView(row, hub(false), ["desktop"]), {
    id: "cmp-abc", name: "desk", kind: "desktop", serves: ["desktop"], unserved: null, runs_refused: null, os: "windows", os_version: "11", device: null, arch: "arm64", screen: null, groups: HELLO.groups, features: {},
    driver: "0.2.0", online: false, held_by_run: null, held_until: null, held_on: null, hold_note: null, pairing: "pairing-x", created_at: new Date(0).toISOString(), seen_at: new Date(1000).toISOString(),
  });
  // Routed to a runner, the route names the run, its runner and its hold's end, and a relayed socket is online.
  const route = { runner: "runner-b", incarnation: "inc-1", run: "run-2", until: 9000, refused: null };
  const relayed = pairedView(row, hub(false), ["desktop"], null, route, true);
  assert.deepEqual({ online: relayed.online, held_by_run: relayed.held_by_run, held_until: relayed.held_until, held_on: relayed.held_on, hold_note: relayed.hold_note }, { online: true, held_by_run: "run-2", held_until: new Date(9000).toISOString(), held_on: "runner-b", hold_note: null });
  const noted = pairedView(row, hub(false), ["desktop"], "apart words", { runner: null, incarnation: null, run: null, until: null, refused: "a note" });
  assert.deepEqual({ online: noted.online, held_by_run: noted.held_by_run, held_on: noted.held_on, hold_note: noted.hold_note, runs_refused: noted.runs_refused }, { online: false, held_by_run: null, held_on: null, hold_note: "a note", runs_refused: "apart words" });
  const held = pairedView(row, hub(true, "run-1"), ["desktop"]);
  assert.deepEqual({ os_version: held.os_version, device: held.device, screen: held.screen, features: held.features, driver: held.driver, online: held.online }, { os_version: "11 24H2", device: live.device, screen: live.screen, features, driver: "0.2.1", online: true });
  assert.deepEqual({ held_by_run: held.held_by_run, held_until: held.held_until }, { held_by_run: "run-1", held_until: deadline.toISOString() });
  assert.equal(held.seen_at, liveSince.toISOString(), "attached, it was seen when its live socket said hello");
  // The hub has the socket live before the store keeps its first hello: listed between the two, it is online and seen.
  const first = pairedView({ ...row, seenAt: null }, hub(true), ["desktop"]);
  assert.deepEqual({ online: first.online, seen_at: first.seen_at }, { online: true, seen_at: liveSince.toISOString() }, "online is never listed as never seen");
  assert.equal(pairedView({ ...row, seenAt: null }, hub(false), ["desktop"]).seen_at, null, "never attached, never seen");
  const lacking = pairedView({ ...row, hello: { ...row.hello, groups: ["screen"] } }, hub(false), []);
  assert.equal(lacking.unserved, "desk's driver serves no kind: it says desktop but declares no input.pointer, input.keys: update the driver on desk", "one that serves no kind says why");
});

test("the server's route tick with its runner beside it: while no route row is there and no box is relayed, each tick is one read of the routes and nothing else; a row there it judges as a runner apart's server does", async () => {
  const calls = [];
  const rows = [];
  const settings = {
    get: async (key) => (calls.push(["get", key]), undefined),
    putIfAbsent: async (key) => (calls.push(["putIfAbsent", key]), undefined),
    replaceIf: async (key) => (calls.push(["replaceIf", key]), true),
    removeIf: async (key) => (calls.push(["removeIf", key]), true),
    remove: async (key) => void calls.push(["remove", key]),
    all: async (filter) => (calls.push(["all", filter?.prefix]), [...rows]),
  };
  let lists = 0;
  const pairedComputers = { list: async () => (lists++, [{ id: "cmp-desk", name: "desk-1" }]) };
  const attach = createAttachRoutes({ store: { pairedComputers, mintedTokens: {}, settings }, hub: new AttachHub(), runnerApart: false });
  await attach.tick();
  await attach.tick();
  assert.equal(lists, 1, "the paired computers are read once, at the first tick");
  assert.deepEqual(calls, [["all", ROUTE_PREFIX], ["all", ROUTE_PREFIX]], "each tick reads the routes' prefix once, and does nothing else");

  calls.length = 0;
  rows.push({ key: `${ROUTE_PREFIX}cmp-desk`, value: { runner: null, incarnation: null, run: null, until: null, refused: null }, updatedAt: 0 });
  await attach.tick();
  assert.deepEqual(calls, [["all", ROUTE_PREFIX], ["removeIf", `${ROUTE_PREFIX}cmp-desk`]], "a row there is judged: an empty one goes");
  await attach.close();
});

/** The route tick over store fakes, on a server whose runner runs apart: `settings` keeps its writes (`writes`) and
 *  lists `rows`; the paired computers' `list()` answers one held read, which lands when the test calls `release` with
 *  the snapshot it took. `paired` adds the paired store's other calls a test needs. */
function heldFirstRead(paired = {}) {
  const writes = [];
  const rows = [];
  let lists = 0;
  let alls = 0;
  let release;
  const read = new Promise((done) => (release = done));
  const settings = {
    get: async () => undefined,
    putIfAbsent: async (key, value) => (writes.push(["putIfAbsent", key, value]), undefined),
    replaceIf: async (key, _seen, value) => (writes.push(["replaceIf", key, value]), true),
    removeIf: async (key) => (writes.push(["removeIf", key]), true),
    remove: async (key) => void writes.push(["remove", key]),
    all: async () => (alls++, [...rows]),
  };
  const pairedComputers = { list: () => (lists++, read), ...paired };
  const attach = createAttachRoutes({ store: { pairedComputers, mintedTokens: {}, settings }, hub: new AttachHub(), runnerApart: true });
  return { attach, writes, rows, release: (snapshot) => release(snapshot), lists: () => lists, alls: () => alls };
}

/** A run's route on a runner apart. */
const APART_ROUTE = { runner: "runner-a", incarnation: "inc-a", run: "run-1", until: 1_000_000 };

test("the route tick's first read of the paired computers, held while a computer pairs, keeps that pair over the earlier snapshot it lands with: the new computer's route to a runner apart is noted not attached now, never emptied, the snapshot empty or not", { timeout: 10_000 }, async () => {
  for (const snapshot of [[], [{ id: "cmp-old", name: "desk-old" }]]) {
    const side = heldFirstRead({ pair: async () => true });
    const ticked = side.attach.tick();
    assert.equal(side.lists(), 1, "the first tick is reading the paired computers");
    const { computer } = await side.attach.pair({ code: newPairingCode(), name: "desk-new", hello: HELLO }, "203.0.113.7");
    const key = `${ROUTE_PREFIX}${computer}`;
    side.rows.push({ key, value: { ...APART_ROUTE, refused: null }, updatedAt: 0 });
    // The read lands only now, with the snapshot it took before the pair committed: the new computer is not in it.
    side.release(snapshot);
    await ticked;
    const noted = { ...APART_ROUTE, refused: notAttachedWords("desk-new") };
    assert.deepEqual(side.writes, [["replaceIf", key, noted]], `the computer paired during the first read is known (a snapshot of ${snapshot.length}): its route to the runner apart is noted not attached now, never emptied`);
    side.writes.length = 0;
    side.rows[0] = { key, value: noted, updatedAt: 1 };
    await side.attach.tick();
    assert.deepEqual(side.writes, [], "the next tick leaves its noted route as it is");
    await side.attach.close();
  }
});

test("the route tick's first read of the paired computers, held while a computer is removed, keeps that removal over the earlier snapshot that still lists it: its route goes, never noted as a known box's", { timeout: 10_000 }, async () => {
  const side = heldFirstRead({ get: async (id) => ({ id, name: "desk-gone", revokedAt: null }), revoke: async () => true });
  const ticked = side.attach.tick();
  assert.equal(side.lists(), 1, "the first tick is reading the paired computers");
  await side.attach.remove("cmp-gone");
  const key = `${ROUTE_PREFIX}cmp-gone`;
  assert.deepEqual(side.writes, [["remove", key]], "the remove takes its route away");
  side.writes.length = 0;
  // A route row naming it is there again (a take that read the row before the revoke committed), and the read lands
  // with the snapshot it took before the revoke: the removed computer still in it.
  side.rows.push({ key, value: { ...APART_ROUTE, refused: null }, updatedAt: 0 });
  side.release([{ id: "cmp-old", name: "desk-old" }, { id: "cmp-gone", name: "desk-gone" }]);
  await ticked;
  assert.deepEqual(side.writes, [["removeIf", key]], "the computer removed during the first read is not known: its route goes");
  await side.attach.close();
});

test("two route ticks at once: a tick while another is still running does nothing, so two first reads of the paired computers never overwrite each other", { timeout: 10_000 }, async () => {
  const side = heldFirstRead();
  const first = side.attach.tick();
  const second = side.attach.tick();
  assert.equal(side.lists(), 1, "a tick while the first is still reading reads the paired computers no second time");
  side.release([{ id: "cmp-desk", name: "desk-1" }]);
  await Promise.all([first, second]);
  assert.equal(side.alls(), 1, "nor the routes: one tick runs at a time");
  await side.attach.tick();
  assert.deepEqual([side.lists(), side.alls()], [1, 2], "the next tick, once the first is done, runs: the paired computers kept, the routes read again");
  await side.attach.close();
});
