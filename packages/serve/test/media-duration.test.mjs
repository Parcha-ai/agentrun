// A media file's length read from its bytes (media-duration.ts mediaSeconds), for a fal job billed by the length of the
// media it is given. Real files made with ffmpeg (fixtures/media-samples.mjs), each expected at what ffprobe reads of it;
// the headers ffmpeg does not write (VBRI, a 64-bit mvhd) are built here by their published layouts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SAMPLES } from "./fixtures/media-samples.mjs";

const load = () => import("../dist/media-duration.js");
const near = (actual, expected, within, what) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) <= within, `${what}: ${actual}, not ${expected}`);
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (text) => [...text].map((c) => c.charCodeAt(0));
const box = (type, ...parts) => { const body = parts.flat(); return [...u32(body.length + 8), ...ascii(type), ...body]; };

test("an mp4, an m4a and a mov read their movie header's length, wherever moov is", async () => {
  const { mediaSeconds } = await load();
  for (const name of ["mp4", "mp4Fast", "m4a", "mov"]) near(mediaSeconds(SAMPLES[name].bytes), SAMPLES[name].seconds, 0.05, name);
});

test("an mvhd of version 1 reads its 64-bit length", async () => {
  const { mediaSeconds } = await load();
  // version 1: created and modified (8 bytes each), timescale 1000, duration 90 500 in 64 bits.
  const mvhd = box("mvhd", [1, 0, 0, 0], new Array(16).fill(0), u32(1000), u32(0), u32(90_500), new Array(80).fill(0));
  const file = new Uint8Array([...box("ftyp", ascii("isom"), u32(0)), ...box("mdat", [1, 2, 3]), ...box("moov", mvhd)]);
  near(mediaSeconds(file), 90.5, 1e-9, "90.5 s");
});

test("a wav reads its data chunk's bytes over its byte rate", async () => {
  const { mediaSeconds } = await load();
  near(mediaSeconds(SAMPLES.wav.bytes), SAMPLES.wav.seconds, 0.001, "wav");
});

test("an mp3 reads its Info header's frame count; one with none, its frames, past an ID3 tag", async () => {
  const { mediaSeconds } = await load();
  near(mediaSeconds(SAMPLES.mp3Info.bytes), SAMPLES.mp3Info.seconds, 0.001, "Info header");
  near(mediaSeconds(SAMPLES.mp3Cbr.bytes), SAMPLES.mp3Cbr.seconds, 0.05, "constant bitrate");
  // An ID3v2.3 tag of 300 bytes before the first frame (its size is four 7-bit bytes).
  const tagged = new Uint8Array([...ascii("ID3"), 3, 0, 0, 0, 0, 2, 44, ...new Array(300).fill(0), ...SAMPLES.mp3Cbr.bytes]);
  near(mediaSeconds(tagged), SAMPLES.mp3Cbr.seconds, 0.05, "constant bitrate after an ID3 tag");
});

test("an mp3 with no frame-count header is read frame by frame: a variable bitrate is never taken from its first frame", async () => {
  const { mediaSeconds } = await load();
  // MPEG-1 Layer III, 44.1 kHz, stereo, no CRC: 1152 samples a frame. Byte 2's high nibble is the bitrate index:
  // 14 is 320 kbit/s (1044 bytes a frame), 1 is 32 kbit/s (104 bytes). A first frame at 320, then 200 at 32.
  const at = (index, bytes) => [0xff, 0xfb, index << 4, 0x00, ...new Array(bytes - 4).fill(0)];
  const quiet = Array.from({ length: 200 }, () => at(1, 104)).flat();
  const vbr = [...at(14, 1044), ...quiet];
  const seconds = (201 * 1152) / 44_100;
  near(mediaSeconds(new Uint8Array(vbr)), seconds, 1e-9, "201 frames, not the first frame's bitrate over the bytes");
  // A trailing ID3v1 tag (128 bytes from "TAG") and a last frame cut short are not frames, and end the walk.
  near(mediaSeconds(new Uint8Array([...vbr, ...ascii("TAG"), ...new Array(125).fill(0)])), seconds, 1e-9, "before an ID3v1 tag");
  near(mediaSeconds(new Uint8Array([...vbr, ...at(1, 104).slice(0, 50)])), seconds, 1e-9, "a last frame cut short");
  // Bytes that stop being frames midway: the length can't be known, so none is given.
  assert.equal(mediaSeconds(new Uint8Array([...vbr.slice(0, 1044 + 104 * 50), ...new Array(5000).fill(0x41), ...quiet])), undefined, "frames broken midway");
});

test("an mp3 with a VBRI header reads its frame count", async () => {
  const { mediaSeconds } = await load();
  // An MPEG-1 Layer III frame header (44.1 kHz, 128 kbit/s, stereo): 1152 samples a frame; VBRI sits 32 bytes after it.
  // VBRI: version (2), delay (2), quality (2), bytes (4), frames (4).
  const frame = [0xff, 0xfb, 0x90, 0x00, ...new Array(32).fill(0), ...ascii("VBRI"), 0, 1, 0, 0, 0, 0, ...u32(400_000), ...u32(1000), ...new Array(400).fill(0)];
  near(mediaSeconds(new Uint8Array(frame)), (1000 * 1152) / 44_100, 1e-9, "1000 frames of 1152 samples at 44.1 kHz");
});

test("bytes that are none of these, or cut short of their header, read no length", async () => {
  const { mediaSeconds } = await load();
  assert.equal(mediaSeconds(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), undefined, "a PNG");
  assert.equal(mediaSeconds(new Uint8Array(0)), undefined, "nothing");
  assert.equal(mediaSeconds(new TextEncoder().encode("<html><body>not found</body></html>")), undefined, "a page");
  // The mp4 with moov after mdat, cut before moov: no movie header to read.
  assert.equal(mediaSeconds(SAMPLES.mp4.bytes.subarray(0, 200)), undefined, "an mp4 cut before its moov");
  assert.equal(mediaSeconds(SAMPLES.wav.bytes.subarray(0, 20)), undefined, "a wav cut in its fmt chunk");
  // A box whose size runs past the file, and one of size 0 inside moov: never read past the bytes, never looped on.
  assert.equal(mediaSeconds(new Uint8Array([...box("ftyp", ascii("isom")), ...u32(0x7fffffff), ...ascii("moov"), 0, 0, 0, 0, ...ascii("mvhd")])), undefined, "a moov that runs past the file");
});
