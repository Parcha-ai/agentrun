// The `read` contract hosts already ship, held string for string: the five media arguments in their order, each one's
// schema and description, and the text appended to the file tool's description. Hosts' stored instructions name these
// arguments, so a change here is a change for every host; it is never made to pass this test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LOOK_TOOL, MISS_CODES, READ_MEDIA_ARGUMENTS, READ_MEDIA_DESCRIPTION, READ_MEDIA_PARAMETERS, visionSection, withReadMedia } from "@parcha/pi-vision";

const SNAPSHOT = {
  parameters: {
    "ask": {
      "type": "string",
      "description": "A question about what the image, video, video window or document page shows. The answer comes back with the media; a route that cannot see the media is answered by the harness's eyes."
    },
    "from_s": {
      "type": "number",
      "description": "Video only: start of the window to look at, in seconds."
    },
    "to_s": {
      "type": "number",
      "description": "Video only: end of the window to look at, in seconds (must be greater than from_s)."
    },
    "page": {
      "type": "integer",
      "minimum": 1,
      "description": "PDF or office document only: the page to read (1-based). Its text comes back; a page with no text layer, or a page read with ask, is rendered and looked at."
    },
    "char_offset": {
      "type": "integer",
      "minimum": 0,
      "description": "Characters to skip at the start of the `offset` line (0-based). A line longer than the read limit comes back in consecutive windows; continue with the offset and char_offset each window names."
    }
  },
  description: " Video files (mp4, webm, mov, mkv) come back as the video, or as the from_s..to_s window of it; pass `ask` with any image, video or PDF page to have a question about it answered. A browser session's recording listed as `session:<id>` is read the same way: `ask` (and a from_s..to_s window) is answered from what the recording shows. PDFs and office documents (docx, pptx, odt and the like) read as their extracted text, paged like any file; `page` reads one page. A page with no text layer (a scan), or a read with `ask`, renders the page (default 1) and looks at it. Spreadsheets are read with bash (the read says how). Every look is filed under evidence/ and is citable. A directory reads as a listing of its entries.",
};

test("the media arguments and their schemas are the ones hosts ship, in the same order", () => {
  assert.deepEqual(READ_MEDIA_PARAMETERS, SNAPSHOT.parameters);
  assert.deepEqual(Object.keys(READ_MEDIA_PARAMETERS), Object.keys(SNAPSHOT.parameters));
  assert.deepEqual([...READ_MEDIA_ARGUMENTS], ["ask", "from_s", "to_s", "page", "char_offset"]);
});

test("the media description is the one hosts ship, byte for byte", () => {
  assert.equal(READ_MEDIA_DESCRIPTION, SNAPSHOT.description);
});

test("a file tool keeps everything of its own and gains the media arguments and description after its own", () => {
  const tool = { name: "read", label: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] }, extra: 1 };
  const read = withReadMedia(tool);
  assert.equal(read.description, `Read a file.${SNAPSHOT.description}`);
  assert.deepEqual(Object.keys(read.parameters.properties), ["path", "offset", "limit", "ask", "from_s", "to_s", "page", "char_offset"]);
  assert.deepEqual(read.parameters.required, ["path"]);
  assert.equal(read.name, "read");
  assert.equal(read.extra, 1);
  assert.deepEqual(tool.parameters.properties, { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, "the tool given is not changed");
});

test("look takes a source and a question, and pages, a window and a region as its options", () => {
  assert.equal(LOOK_TOOL.name, "look");
  assert.equal(LOOK_TOOL.replay, "safe");
  const { properties, required, additionalProperties } = LOOK_TOOL.parameters;
  assert.deepEqual(Object.keys(properties), ["source", "ask", "pages", "from_s", "to_s", "region"]);
  assert.deepEqual(required, ["source", "ask"]);
  assert.equal(additionalProperties, false);
  assert.deepEqual(Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, v.type])), { source: "string", ask: "string", pages: "string", from_s: "number", to_s: "number", region: "string" });
});

test("the miss codes keep the three hosts already write, and add the rest", () => {
  assert.deepEqual(MISS_CODES.slice(0, 3), ["no_vision_route", "look_failed", "video_unseeable"]);
  assert.deepEqual([...MISS_CODES].sort(), ["look_failed", "needs", "no_vision_route", "not_ready", "over_budget", "refused", "unreadable", "unsupported", "video_unseeable"]);
  assert.ok(Object.isFrozen(MISS_CODES));
});

test("the section is static, and a host's addendum comes after it", () => {
  const section = visionSection();
  assert.equal(visionSection(""), section);
  assert.equal(visionSection("  "), section);
  assert.equal(visionSection("Recordings are read by handle."), `${section}\nRecordings are read by handle.`);
});
