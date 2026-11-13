// The attach binding's pure parts on serve's side (computer-attach.ts, workspace/attached-computers.ts): a pairing code's
// form, the pair route's limit by source address, its body's check and its protocol rule, a close reason cut to what a
// close frame holds, and a paired computer as one more provider of the kind registry.
import assert from "node:assert/strict";
import { test } from "node:test";

const { closeReason, newAttachToken, newPairedId, newPairingCode, PAIR_TRIES_PER_MINUTE, pairBodyOf, pairedView, pairingCodeOf, pairRefusal, PairTries } = await import("../dist/computer-attach.js");
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
  assert.match(newAttachToken(), /^art_[A-Za-z0-9_-]{43}$/, "art_ and 32 bytes");
});

test("the pair limit lets a source address try ten times a minute, then says how long to wait; another address is not held by it, an IPv6 one counted by its /64", () => {
  const clock = { now: 1_000_000 };
  const tries = new PairTries(() => clock.now);
  for (let i = 0; i < PAIR_TRIES_PER_MINUTE; i++) assert.deepEqual(tries.allow("192.0.2.7"), { ok: true });
  assert.deepEqual(tries.allow("192.0.2.7"), { ok: false, retryAfterMs: 60_000 });
  assert.deepEqual(tries.allow("192.0.2.8"), { ok: true }, "another address");
  clock.now += 30_000;
  assert.deepEqual(tries.allow("192.0.2.7"), { ok: false, retryAfterMs: 30_000 });
  clock.now += 30_000;
  assert.deepEqual(tries.allow("192.0.2.7"), { ok: true }, "a minute on");
  for (let i = 0; i < PAIR_TRIES_PER_MINUTE; i++) tries.allow(`2001:db8:1:2::${i + 1}`);
  assert.equal(tries.allow("2001:db8:1:2::ff").ok, false, "one /64");
  const small = new PairTries(() => clock.now, 2);
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

test("a hello of another protocol version is refused in words that say which side to update; the server's own pairs", () => {
  assert.equal(pairRefusal("Ada's Mac", HELLO), undefined);
  assert.match(pairRefusal("Ada's Mac", { ...HELLO, protocol: "0.1", version: "0.1.4" }), /^Ada's Mac's driver 0\.1\.4 speaks protocol 0\.1, and this server 0\.2: update whichever is older .*then pair with the same code$/);
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
  assert.equal(servesNoKind("box", { ...HELLO, kind: "toaster" }), "box's driver serves no kind: it says toaster, which no kind of computer is: update the driver on box");

  // Paired before its driver lost a group: its run is refused saying why, then the providers to pick instead.
  const registry = withPaired({ SETTING_KINDS, PROVIDERS, servingRefusals }, [{ id: "cmp-abc", name: "vesper-mac", hello: screenOnly, driver: "0.2.0", labels: {}, createdAt: 1, seenAt: null, revokedAt: null }]);
  const { refused } = await resolveComputer({ kind: "desktop", provider: "cmp-abc" }, 1, registry, {});
  assert.match(refused, /^vesper-mac is a computer of your own, and its driver gives no desktop computer: it says desktop but declares no input\.pointer, input\.keys\. Update the driver on vesper-mac, or pick one of /);
  const cloud = PROVIDERS.find((entry) => entry.kinds.includes("desktop"));
  assert.match(refused, new RegExp(cloud.label), "the cloud computers to pick instead");
});

test("a paired computer is listed as its hello says, the live one's while attached, with the run that holds it and the deadline its hold ends by", () => {
  const row = { id: "cmp-abc", name: "desk", hello: { ...HELLO, os: "windows", osVersion: "11" }, driver: "0.2.0", labels: {}, pairingId: "pairing-x", createdAt: 0, seenAt: 1000, revokedAt: null };
  const features = { "ui.tree": { off: "no grant" }, "ui.image": true };
  // A driver's malformed features are left out of the list: only true or {off: words} reach the console.
  const live = { ...row.hello, version: "0.2.1", osVersion: "11 24H2", device: { maker: "Acme", model: "Book" }, screen: { width: 1920, height: 1080, scale: 1 }, features: { ...features, "apps.launch": null, "ui.act": { off: 3 }, "ui.wait": "yes" } };
  const deadline = new Date(5000);
  const hub = (attached, holder) => ({ online: () => attached, hello: () => (attached ? live : undefined), claimed: () => (holder ? { "agentrun.run": holder } : undefined), deadline: () => (holder ? deadline : undefined) });
  assert.deepEqual(pairedView(row, hub(false), ["desktop"]), {
    id: "cmp-abc", name: "desk", kind: "desktop", serves: ["desktop"], unserved: null, os: "windows", os_version: "11", device: null, arch: "arm64", screen: null, groups: HELLO.groups, features: {},
    driver: "0.2.0", online: false, held_by_run: null, held_until: null, pairing: "pairing-x", created_at: new Date(0).toISOString(), seen_at: new Date(1000).toISOString(),
  });
  const held = pairedView(row, hub(true, "run-1"), ["desktop"]);
  assert.deepEqual({ os_version: held.os_version, device: held.device, screen: held.screen, features: held.features, driver: held.driver, online: held.online }, { os_version: "11 24H2", device: live.device, screen: live.screen, features, driver: "0.2.1", online: true });
  assert.deepEqual({ held_by_run: held.held_by_run, held_until: held.held_until }, { held_by_run: "run-1", held_until: deadline.toISOString() });
  const lacking = pairedView({ ...row, hello: { ...row.hello, groups: ["screen"] } }, hub(false), []);
  assert.equal(lacking.unserved, "desk's driver serves no kind: it says desktop but declares no input.pointer, input.keys: update the driver on desk", "one that serves no kind says why");
});
