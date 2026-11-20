// A run's generated media (an image, a clip, a narration) is served with its type and inline, so the console's file
// viewer can play it from the run's file route; a type the table does not know stays a download.
import assert from "node:assert/strict";
import test from "node:test";
import { INLINE_TYPES, typeOf } from "../dist/file-types.js";

test("audio and webm are served with their types, inline", () => {
  const cases = { "media/voice.mp3": "audio/mpeg", "media/voice.wav": "audio/wav", "media/voice.m4a": "audio/mp4", "media/voice.ogg": "audio/ogg", "media/clip.webm": "video/webm", "media/CLIP.MP3": "audio/mpeg" };
  for (const [path, type] of Object.entries(cases)) {
    assert.equal(typeOf(path), type, path);
    assert.ok(INLINE_TYPES.has(type), `${type} inline`);
  }
});

test("the types it served before are unchanged, and an unknown one is still a download", () => {
  assert.equal(typeOf("a.mp4"), "video/mp4");
  assert.equal(typeOf("a.png"), "image/png");
  assert.equal(typeOf("a.pdf"), "application/pdf");
  assert.equal(INLINE_TYPES.has("application/pdf"), false);
  assert.equal(typeOf("a.flac"), undefined);
  assert.equal(typeOf("a.svg"), undefined);
});
