// A screenshot of a region: a clip in CSS pixels, a snapshot ID or a CSS selector, through the same capture as the whole page.
import assert from "node:assert/strict";
import test from "node:test";
import { regionOf } from "../dist/core/clip.js";

const VIEWPORT = { width: 1288, height: 711 };
const refusal = (what) => (error) => { assert.equal(error?.failure?.code, "refused", String(error?.message)); assert.equal(error.failure.effect, "none"); assert.match(error.failure.message, what); assert.match(error.failure.message, /No capture was made/); return true; };
const locating = (found) => async (target) => (target ? { viewport: VIEWPORT, ...found } : { viewport: VIEWPORT });

test("no region asked for is no region: the whole page", async () => {
  assert.equal(await regionOf({}, undefined), null);
  assert.equal(await regionOf({ fullPage: true }, undefined), null);
});

test("a clip inside the viewport is the region; one that is empty, outside it, malformed or beside another target is refused", async () => {
  assert.deepEqual(await regionOf({ clip: { x: 10, y: 20, width: 300, height: 200 } }, locating({})), { clip: { x: 10, y: 20, width: 300, height: 200 }, of: null });
  assert.deepEqual((await regionOf({ clip: { x: 0, y: 0, width: 1288, height: 711 } }, locating({}))).clip, { x: 0, y: 0, width: 1288, height: 711 }, "the whole viewport is inside it");
  for (const [clip, why] of [
    [{ x: 0, y: 0, width: 0, height: 10 }, /empty/], [{ x: 0, y: 0, width: 10, height: 0 }, /empty/], [{ x: 0, y: 0, width: -5, height: 10 }, /empty/],
    [{ x: 1200, y: 0, width: 200, height: 10 }, /leaves the viewport \(1288 wide, 711 high\)/], [{ x: 0, y: 700, width: 10, height: 20 }, /leaves the viewport/],
    [{ x: -1, y: 0, width: 10, height: 10 }, /leaves the viewport/], [{ x: 0, y: -30, width: 10, height: 10 }, /leaves the viewport/],
    [{ x: 0, y: 0, width: "wide", height: 10 }, /numbers/], [{ x: 0, y: 0, width: 10 }, /numbers/],
  ]) await assert.rejects(regionOf({ clip }, locating({})), refusal(why), JSON.stringify(clip));
  await assert.rejects(regionOf({ clip: { x: 0, y: 0, width: 5, height: 5 }, selector: "#a" }, locating({})), refusal(/one of clip, id or selector/));
  await assert.rejects(regionOf({ id: "1-2", selector: "#a" }, locating({})), refusal(/one of clip, id or selector/));
  await assert.rejects(regionOf({ clip: { x: 0, y: 0, width: 5, height: 5 } }, undefined), refusal(/cannot place a region/));
});

test("an element is the region when it matches exactly once and has an area inside the viewport; every other answer is refused, with the count", async () => {
  const box = { x: 40.25, y: 120, width: 600, height: 340 };
  assert.deepEqual(await regionOf({ selector: "#chart" }, locating({ matches: 1, box })), { clip: box, of: { selector: "#chart" } });
  assert.deepEqual(await regionOf({ id: " 1-42 " }, locating({ matches: 1, box })), { clip: box, of: { id: "1-42" } }, "an ID is trimmed");
  await assert.rejects(regionOf({ selector: "#nope" }, locating({ matches: 0, box: null })), refusal(/selector #nope matches nothing/));
  await assert.rejects(regionOf({ id: "1-9" }, locating({ matches: 0, box: null })), refusal(/id 1-9 matches nothing/));
  await assert.rejects(regionOf({ selector: "li" }, locating({ matches: 7, box: null })), refusal(/selector li matches 7 elements; it must match exactly one/));
  await assert.rejects(regionOf({ selector: "#hidden" }, locating({ matches: 1, box: { x: 0, y: 0, width: 0, height: 0 } })), refusal(/no area/));
  await assert.rejects(regionOf({ selector: "#gone" }, locating({ matches: 1, box: null })), refusal(/no area/));
  await assert.rejects(regionOf({ selector: "#tall" }, locating({ matches: 1, box: { x: 0, y: 0, width: 400, height: 2000 } })), refusal(/does not fit the viewport \(1288 wide, 711 high\) once scrolled into view/));
  assert.equal(await regionOf({ selector: "   " }, locating({})), null, "a blank selector is none");
  assert.equal(await regionOf({ id: "" }, locating({})), null, "a blank id is none");
});

test("what a model fills in for every optional property is no region: blank id or selector, a clip of zero width and height, and fullPage beside a region", async () => {
  // The route's model sends every property of a tool's schema, with an empty value for the ones it has no use for.
  assert.equal(await regionOf({ clip: { x: 0, y: 0, width: 0, height: 0 }, id: "", selector: "" }, locating({})), null, "all unset: the whole page");
  assert.equal(await regionOf({ clip: { x: 5, y: 7, width: 0, height: 0 }, id: "  ", selector: "\n" }, locating({})), null, "a clip with no size is unset wherever it sits, and blank text is unset");
  assert.deepEqual((await regionOf({ clip: { x: 0, y: 0, width: 0, height: 0 }, id: "", selector: "#chart" }, locating({ matches: 1, box: { x: 1, y: 2, width: 30, height: 40 } }))).of, { selector: "#chart" }, "the one that is set is the region");
  assert.deepEqual((await regionOf({ clip: { x: 10, y: 20, width: 300, height: 200 }, id: "", selector: "", fullPage: true }, locating({}))).clip, { x: 10, y: 20, width: 300, height: 200 }, "fullPage does not refuse a region: the region wins");
  assert.equal(await regionOf({ fullPage: true, clip: { x: 0, y: 0, width: 0, height: 0 }, id: "", selector: "" }, locating({})), null, "fullPage alone is the whole page, for tools.ts to capture");
  // A clip with one dimension zero is still a mistake the model should hear about, and so is a real value beside another real value.
  await assert.rejects(regionOf({ clip: { x: 0, y: 0, width: 0, height: 10 }, id: "", selector: "" }, locating({})), refusal(/empty/));
  await assert.rejects(regionOf({ clip: { x: 0, y: 0, width: 5, height: 5 }, id: "1-2", selector: "" }, locating({})), refusal(/one of clip, id or selector/));
});
