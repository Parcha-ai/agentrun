// The provider conformance suite. A provider's own tests call `registerProviderConformance` with the provider, the
// fixtures they built and what each must give; with a twin (a zero-install provider and its binary counterpart), both
// must agree: text equal once whitespace is collapsed, image sizes within 1 px, cells equal. A provider that cannot run
// in the environment skips every case with its typed reason, never silently, and fails instead when
// `requireAvailable` is set (CI's binaries job sets PI_VISION_REQUIRE_BINARIES=1). Each case removes the directories
// its provider calls were given, pass or fail. `providerConformance` gives the
// cases unregistered, so a test can prove the suite fails a provider that breaks it. `fakeProvider` reads a JSON
// document format of its own and proves the suite itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import { visionContext, type VisionEnv } from "../core/env.js";
import { sha256Hex } from "../core/primitives.js";
import { CAPABILITY_METHODS, type Capability, type Cell, type Detection, type MadeBy, type Provider, type ProviderCall, type ProviderSource } from "../core/provider.js";
import { imageSize, pngBytes } from "./fixtures.js";

/** One source and what each capability must give for it. */
export type ConformanceFixture = {
  readonly name: string;
  readonly source: ProviderSource;
  /** What each capability must give for this source; a capability the fixture has no entry for is not run on it. */
  readonly expect: {
    readonly text?: readonly { readonly page: number; readonly contains: readonly string[] }[];
    readonly render?: readonly { readonly page: number; readonly dpi: number; readonly width: number; readonly height: number }[];
    readonly cells?: readonly { readonly sheet: string; readonly cells: readonly Cell[] }[];
    readonly frames?: { readonly atS: readonly number[]; readonly maxEdge: number; readonly width: number; readonly height: number };
    readonly clip?: { readonly fromS: number; readonly toS: number; readonly maxBytes: number };
  };
};

/** What the suite runs: the provider, a twin it must agree with, the environment and the fixtures. */
export type ConformanceOptions = {
  readonly provider: Provider;
  /** A provider of the same job that must agree with this one on every fixture both can read. */
  readonly twin?: Provider;
  readonly env: () => VisionEnv | Promise<VisionEnv>;
  readonly fixtures: readonly ConformanceFixture[];
  /** Fail, instead of skip, when a provider cannot run here. Default: PI_VISION_REQUIRE_BINARIES=1. */
  readonly requireAvailable?: boolean;
};

/** A case resolves when it passes, resolves `{ skip }` when the provider cannot run here, and rejects when it fails. */
export type ConformanceCase = { readonly name: string; run(): Promise<void | { readonly skip: string }> };

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
const within1 = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) <= 1, `${what}: ${actual}, expected ${expected} within 1 px`);
const madeBy = (by: MadeBy, p: Provider, version: string) => assert.deepEqual(by, { provider: p.name, version }, "a result names the provider and the version detect() found");
const can = (p: Provider, capability: Capability) => p.capabilities.includes(capability);

type Skip = { readonly skip: string };
type Rig = {
  readonly provider: Provider;
  readonly ready: (p: Provider) => Promise<{ version: string } | Skip>;
  readonly scoped: (name: string, body: (call: () => Promise<ProviderCall>) => Promise<void | Skip>) => ConformanceCase;
};

function rigFor(options: ConformanceOptions): Rig {
  const required = options.requireAvailable ?? process.env.PI_VISION_REQUIRE_BINARIES === "1";
  const detections = new Map<Provider, Promise<Detection>>();
  const detect = (p: Provider) => {
    if (!detections.has(p)) detections.set(p, Promise.resolve(options.env()).then((env) => p.detect(env)));
    return detections.get(p)!;
  };
  /** The detection when the provider runs here; otherwise a skip, or a failure when availability is required. */
  const ready = async (p: Provider): Promise<{ version: string } | Skip> => {
    const found = await detect(p);
    if (found.available) return { version: found.version };
    const reason = `${p.name} cannot run here: needs ${found.needs}: ${found.reason}`;
    if (required) throw new Error(reason);
    return { skip: reason };
  };
  /** A case whose provider calls each get a directory of their own, all removed when the case ends, pass or fail. */
  const scoped: Rig["scoped"] = (name, body) => ({
    name,
    async run() {
      const made: ProviderCall[] = [];
      const call = async (): Promise<ProviderCall> => {
        const env = await options.env();
        const dir = await env.createTempDir("pi-vision-conformance-", visionContext());
        if (!dir.ok) throw dir.error;
        made.push({ env, signal: undefined, tempDir: dir.value });
        return made.at(-1)!;
      };
      try {
        return await body(call);
      } finally {
        for (const c of made) await c.env.remove(c.tempDir, { recursive: true, force: true }, visionContext());
      }
    },
  });
  return { provider: options.provider, ready, scoped };
}

function contractCases({ provider, env }: Pick<ConformanceOptions, "provider" | "env">): ConformanceCase[] {
  return [
    { name: "detect() resolves to a detection and never throws", async run() {
      const found = await provider.detect(await env());
      if (found.available) assert.ok(typeof found.version === "string" && found.version.length > 0, "an available provider names its version");
      else assert.ok(found.needs && found.reason, "an unavailable provider names what it needs and why");
    } },
    { name: "every capability it declares has its method", async run() {
      assert.ok(provider.name && provider.kinds.length > 0, "a provider has a name and the kinds it reads");
      for (const capability of provider.capabilities) {
        const method = CAPABILITY_METHODS[capability];
        assert.ok(method, `${provider.name} declares ${capability}, which has no method in this release`);
        assert.equal(typeof provider[method], "function", `${provider.name} declares ${capability} without its ${method}()`);
      }
    } },
  ];
}

function fixtureCases({ provider, ready, scoped }: Rig, fixture: ConformanceFixture): ConformanceCase[] {
  const { expect } = fixture;
  const at = (what: string) => `${fixture.name}: ${what}`;
  const cases: ConformanceCase[] = [];
  if (expect.text && can(provider, "text")) cases.push(scoped(at("text"), async (call) => {
    const r = await ready(provider);
    if ("skip" in r) return r;
    const out = await provider.text!(fixture.source, {}, await call());
    madeBy(out.madeBy, provider, r.version);
    for (const want of expect.text!) {
      const page = out.pages.find((p) => p.page === want.page);
      assert.ok(page, `page ${want.page} has a text entry`);
      for (const s of want.contains) assert.ok(collapse(page.text).includes(collapse(s)), `page ${want.page} holds ${JSON.stringify(s)}`);
    }
  }));
  for (const want of (can(provider, "render") && expect.render) || []) cases.push(scoped(at(`render page ${want.page} at ${want.dpi} dpi`), async (call) => {
    const r = await ready(provider);
    if ("skip" in r) return r;
    const out = await provider.render!(fixture.source, { page: want.page, dpi: want.dpi }, await call());
    madeBy(out.madeBy, provider, r.version);
    within1(out.image.width, want.width, "width");
    within1(out.image.height, want.height, "height");
    assert.deepEqual(imageSize(out.image.data), { mimeType: out.image.mimeType, width: out.image.width, height: out.image.height }, "the image's own header says what the result says");
  }));
  if (expect.cells && can(provider, "cells")) cases.push(scoped(at("cells"), async (call) => {
    const r = await ready(provider);
    if ("skip" in r) return r;
    const out = await provider.cells!(fixture.source, {}, await call());
    madeBy(out.madeBy, provider, r.version);
    for (const want of expect.cells!) {
      const sheet = out.sheets.find((s) => s.name === want.sheet);
      assert.ok(sheet, `sheet ${want.sheet} is read`);
      for (const cell of want.cells) assert.deepEqual(sheet.cells.find((c) => c.ref === cell.ref), cell, `${want.sheet}!${cell.ref}`);
    }
  }));
  if (expect.frames && can(provider, "frames")) cases.push(scoped(at(`frames at ${expect.frames.atS.join(", ")} s`), async (call) => {
    const r = await ready(provider);
    if ("skip" in r) return r;
    const want = expect.frames!;
    const out = await provider.frames!(fixture.source, { atS: want.atS, maxEdge: want.maxEdge }, await call());
    madeBy(out.madeBy, provider, r.version);
    assert.deepEqual(out.frames.map((f) => f.atS), [...want.atS], "one frame at each time asked, in order");
    for (const frame of out.frames) {
      within1(frame.width, want.width, `frame at ${frame.atS} s width`);
      within1(frame.height, want.height, `frame at ${frame.atS} s height`);
      assert.ok(Math.max(frame.width, frame.height) <= want.maxEdge, `frame at ${frame.atS} s within ${want.maxEdge} px`);
    }
  }));
  if (expect.clip && can(provider, "clip")) cases.push(scoped(at(`clip ${expect.clip.fromS} to ${expect.clip.toS} s`), async (call) => {
    const r = await ready(provider);
    if ("skip" in r) return r;
    const want = expect.clip!;
    const c = await call();
    const out = await provider.clip!(fixture.source, want, c);
    madeBy(out.madeBy, provider, r.version);
    const info = await c.env.fileInfo(out.path, visionContext());
    assert.ok(info.ok && info.value.size > 0 && info.value.size <= want.maxBytes, `the clip is a file in the environment within ${want.maxBytes} bytes`);
    assert.ok(Math.abs(out.fromS - want.fromS) <= 1 && Math.abs(out.toS - want.toS) <= 1, `the clip covers ${want.fromS} to ${want.toS} s within 1 s`);
  }));
  return cases;
}

function twinCase({ provider, ready, scoped }: Rig, twin: Provider, fixture: ConformanceFixture): ConformanceCase {
  return scoped(`${fixture.name}: ${provider.name} and ${twin.name} agree`, async (call) => {
    for (const p of [provider, twin]) { const r = await ready(p); if ("skip" in r) return r; }
    // Both calls settle before the case's directories are removed; the first failure is the case's.
    const both = async <T>(f: (p: Provider, c: ProviderCall) => Promise<T>): Promise<[T, T]> => {
      const [a, b] = await Promise.allSettled([call().then((c) => f(provider, c)), call().then((c) => f(twin, c))]);
      if (a.status === "rejected") throw a.reason;
      if (b.status === "rejected") throw b.reason;
      return [a.value, b.value];
    };
    let compared = 0;
    if (can(provider, "text") && can(twin, "text")) {
      const [a, b] = await both((p, c) => p.text!(fixture.source, {}, c));
      assert.deepEqual(a.pages.map((p) => [p.page, collapse(p.text)]), b.pages.map((p) => [p.page, collapse(p.text)]), "text, whitespace collapsed");
      compared++;
    }
    for (const want of (can(provider, "render") && can(twin, "render") && fixture.expect.render) || []) {
      const [a, b] = await both((p, c) => p.render!(fixture.source, { page: want.page, dpi: want.dpi }, c));
      within1(a.image.width, b.image.width, `page ${want.page} width`);
      within1(a.image.height, b.image.height, `page ${want.page} height`);
      compared++;
    }
    if (can(provider, "cells") && can(twin, "cells") && fixture.expect.cells) {
      const [a, b] = await both((p, c) => p.cells!(fixture.source, {}, c));
      assert.deepEqual(a.sheets, b.sheets, "cells");
      compared++;
    }
    if (can(provider, "frames") && can(twin, "frames") && fixture.expect.frames) {
      const want = fixture.expect.frames;
      const [a, b] = await both((p, c) => p.frames!(fixture.source, { atS: want.atS, maxEdge: want.maxEdge }, c));
      assert.equal(a.frames.length, b.frames.length, "frame count");
      a.frames.forEach((f, i) => { within1(f.width, b.frames[i]!.width, `frame ${i} width`); within1(f.height, b.frames[i]!.height, `frame ${i} height`); });
      compared++;
    }
    assert.ok(compared > 0, `${provider.name} and ${twin.name} share no capability this fixture exercises`);
  });
}

/** The conformance cases for `options.provider`, unregistered, so a test can show the suite fails a provider that breaks it.
 *  `registerProviderConformance` registers them. */
export function providerConformance(options: ConformanceOptions): ConformanceCase[] {
  const { twin, fixtures } = options;
  const rig = rigFor(options);
  return [
    ...contractCases(options),
    ...fixtures.flatMap((fixture) => fixtureCases(rig, fixture)),
    ...(twin ? fixtures.map((fixture) => twinCase(rig, twin, fixture)) : []),
  ];
}

/** Each case as a `node:test` test named `<provider>: <case>`; a case that cannot run here is a skipped test with its reason. */
export function registerProviderConformance(options: ConformanceOptions): void {
  for (const c of providerConformance(options)) {
    test(`${options.provider.name}: ${c.name}`, async (t) => {
      const result = await c.run();
      if (result && "skip" in result) t.skip(result.skip);
    });
  }
}

/** The fake provider's document: a JSON file of pages, each with its text and its size in points. */
export type FakeDocument = { readonly pages: readonly { readonly text: string; readonly width: number; readonly height: number }[] };

/** Knobs that make the fake provider disagree with a twin, render the wrong size or be unavailable, so the suite is shown to catch each. */
export type FakeProviderOptions = {
  readonly name?: string;
  readonly version?: string;
  /** Default: available. */
  readonly detection?: Detection;
  /** Applied to every page's text: a twin that disagrees. */
  readonly text?: (text: string) => string;
  /** Pixels added to every render's width: a provider that renders the wrong size. */
  readonly widthError?: number;
};

/** A provider of `text` and `render` over `FakeDocument` files, read through the environment. Renders are white PNGs
 *  of the page's size at the dpi asked for. */
export function fakeProvider(options: FakeProviderOptions = {}): Provider {
  const name = options.name ?? "fake";
  const detection: Detection = options.detection ?? { available: true, version: options.version ?? "1.0.0" };
  const by = (): MadeBy => ({ provider: name, version: detection.available ? detection.version : "" });
  const load = async (source: ProviderSource, call: ProviderCall): Promise<FakeDocument> => {
    const read = await call.env.readBinaryFile(source.path, visionContext(call.signal));
    if (!read.ok) throw read.error;
    assert.equal(sha256Hex(read.value), source.sha256, "the bytes read are the source's");
    return JSON.parse(Buffer.from(read.value).toString("utf8")) as FakeDocument;
  };
  return {
    name,
    capabilities: ["text", "render"],
    kinds: ["pdf"],
    detect: async () => detection,
    async text(source, request, call) {
      const doc = await load(source, call);
      const pages = doc.pages.map((p, i) => ({ page: i + 1, text: options.text ? options.text(p.text) : p.text }));
      return { madeBy: by(), pages: request.pages ? pages.filter((p) => p.page >= request.pages!.from && p.page <= request.pages!.to) : pages };
    },
    async render(source, request, call) {
      const page = (await load(source, call)).pages[request.page - 1];
      if (!page) throw new RangeError(`page ${request.page} is not in the document`);
      const width = Math.round((page.width * request.dpi) / 72) + (options.widthError ?? 0);
      const height = Math.round((page.height * request.dpi) / 72);
      return { madeBy: by(), image: { data: pngBytes(width, height), mimeType: "image/png", width, height } };
    },
  };
}
