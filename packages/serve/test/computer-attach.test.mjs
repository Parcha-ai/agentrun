// The attach binding's pure parts on serve's side (computer-attach.ts, workspace/attached-computers.ts): a pairing code's
// form, the pair route's limit by source address, its body's check and its protocol rule, a close reason cut to what a
// close frame holds, and a paired computer as one more provider of the kind registry.
import assert from "node:assert/strict";
import { test } from "node:test";

const { closeReason, newAttachToken, newPairedId, newPairingCode, PAIR_TRIES_PER_MINUTE, pairBodyOf, pairingCodeOf, pairRefusal, PairTries } = await import("../dist/computer-attach.js");
const { pairedEntry, withPaired, ONE_PROCESS_WORDS, pairedProvider } = await import("../dist/workspace/attached-computers.js");
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
    id: "cmp-abc", label: "vesper-mac", kinds: ["desktop"], keys: [], mounts: [], network: ["open"], metered: false, capabilities: ["desktop"], defaultImage: { desktop: "attached" },
  });
  const phone = pairedEntry({ ...row, hello: { ...HELLO, os: "android", kind: "android", groups: ["screen", "input.touch", "apps", "ui"] } }, registry);
  assert.deepEqual(phone.kinds, ["phone"], "a phone pairs as a phone");
  assert.equal(withPaired(registry, []), registry, "none paired: the registry as it is");
  assert.deepEqual(withPaired(registry, [row]).PROVIDERS.map((one) => one.id), [...PROVIDERS.map((one) => one.id), "cmp-abc"]);
  assert.throws(() => pairedProvider(row, undefined), (error) => error.code === "computer_unavailable" && error.message === ONE_PROCESS_WORDS);
});
