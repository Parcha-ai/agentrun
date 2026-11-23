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

// A talking head's voice is priced by its length, and whoever sends the job made the file: voiceSeconds reads what a
// decoder plays, never a length a header states.
const find = (bytes, text) => Buffer.from(bytes).indexOf(text);
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
/** MPEG-1 Layer III frames at 48 kHz, 32 kbit/s, stereo: 1152 samples (24 ms) and 96 bytes each. */
const frames48 = (n) => Array.from({ length: n }, () => [0xff, 0xfb, (1 << 4) | (1 << 2), 0x00, ...new Array(92).fill(0)]).flat();

test("a voice's MP3 length is every audio frame walked from its first byte to its last; a frame count its header states is not read", async () => {
  const { voiceSeconds, mediaSeconds } = await load();
  near(voiceSeconds(SAMPLES.mp3Cbr.bytes), SAMPLES.mp3Cbr.seconds, 0.05, "constant bitrate");
  // ffmpeg wrote 86 frames of 36 ms after its Info frame, which holds the header and no audio: a decoder skips it.
  near(voiceSeconds(SAMPLES.mp3Info.bytes), 86 * 0.036, 1e-9, "with an Info header, the frames after it walked");
  // An Info header that claims 1 frame over a file of 129.
  const forged = Uint8Array.from(SAMPLES.mp3Info.bytes);
  forged.set(u32(1), find(forged, "Info") + 8);
  assert.ok(mediaSeconds(forged) < 0.1, "mediaSeconds takes the header's count");
  near(voiceSeconds(forged), 86 * 0.036, 1e-9, "voiceSeconds walks the frames");
  // A VBRI header that claims 1 frame, on a frame followed by 200 more: the 200 play, the header's frame does not.
  const vbri = [0xff, 0xfb, 0x90, 0x00, ...new Array(32).fill(0), ...ascii("VBRI"), 0, 1, 0, 0, 0, 0, ...u32(417), ...u32(1), ...new Array(417 - 54).fill(0)];
  const vbriFile = new Uint8Array([...vbri, ...Array.from({ length: 200 }, () => [0xff, 0xfb, 0x90, 0x00, ...new Array(413).fill(0)]).flat()]);
  near(voiceSeconds(vbriFile), (200 * 1152) / 44_100, 1e-9, "200 frames, not VBRI's 1");
  // A Xing header frame (after 32 bytes of side information) before 50 frames: the 50. Alone, it plays nothing.
  const xing = [...frames48(1).slice(0, 36), ...ascii("Xing"), ...u32(1), ...u32(1)];
  const xingFrame = [...xing, ...new Array(96 - xing.length).fill(0)];
  near(voiceSeconds(new Uint8Array([...xingFrame, ...frames48(50)])), 50 * 0.024, 1e-9, "50 frames after a Xing frame");
  assert.equal(voiceSeconds(new Uint8Array(xingFrame)), undefined, "a Xing frame alone");
  // Only the first frame can be a header: "Info" in a later frame's side information is audio, counted.
  const late = [...frames48(10), ...frames48(1).slice(0, 36), ...ascii("Info"), ...new Array(56).fill(0), ...frames48(9)];
  near(voiceSeconds(new Uint8Array(late)), 20 * 0.024, 1e-9, "20 frames, Info in the 11th");
  // An ID3v2 tag and the zeros after it, and an ID3v1 tag at the end, are not frames and not refused.
  const tagged = new Uint8Array([...ascii("ID3"), 3, 0, 0, 0, 0, 2, 44, ...new Array(300).fill(0), 0, 0, 0, ...frames48(50), ...ascii("TAG"), ...new Array(125).fill(0)]);
  near(voiceSeconds(tagged), 50 * 0.024, 1e-9, "50 frames between the tags");
  // A last frame cut short is counted whole.
  near(voiceSeconds(new Uint8Array([...frames48(50), ...frames48(1).slice(0, 40)])), 51 * 0.024, 1e-9, "51 frames, the last cut short");
  // Any other bytes, before, between or after the frames: no length.
  for (const [what, bytes] of [
    ["bytes after the frames", [...frames48(50), ...new Array(500).fill(0x41)]],
    ["bytes between frames", [...frames48(20), ...new Array(500).fill(0x41), ...frames48(30)]],
    ["bytes before the first frame", [...new Array(64).fill(0x41), ...frames48(50)]],
    ["no frame", [...ascii("ID3"), 3, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0)]],
  ]) assert.equal(voiceSeconds(new Uint8Array(bytes)), undefined, what);
});

test("a voice's WAV length is its PCM bytes, from its data chunk's header to the end of the file, at its sample rate; fields that disagree are refused", async () => {
  const { voiceSeconds } = await load();
  near(voiceSeconds(SAMPLES.wav.bytes), SAMPLES.wav.seconds, 1e-9, "2 s");
  const fmt = find(SAMPLES.wav.bytes, "fmt ");
  const data = find(SAMPLES.wav.bytes, "data");
  const edited = (at, bytes) => { const copy = Uint8Array.from(SAMPLES.wav.bytes); copy.set(bytes, at); return copy; };
  // A data chunk that states 100 bytes of the 8000 after it: all of them play.
  near(voiceSeconds(edited(data + 4, u32le(100))), SAMPLES.wav.seconds, 1e-9, "the bytes to the end, not the stated size");
  // A byte rate 60 times what the sample rate and block align give.
  assert.equal(voiceSeconds(edited(fmt + 16, u32le(4000 * 60))), undefined, "a byte rate that disagrees");
  assert.equal(voiceSeconds(edited(fmt + 20, [2, 0])), undefined, "a block align that disagrees");
  assert.equal(voiceSeconds(edited(fmt + 8, [0x55, 0])), undefined, "a compressed format (MP3 in a WAV)");
  // The extensible header names its codec in a GUID: refused, as any format but integer PCM and IEEE float.
  assert.equal(voiceSeconds(edited(fmt + 8, [0xfe, 0xff])), undefined, "WAVE_FORMAT_EXTENSIBLE");
  // IEEE float is 32 or 64 bits a sample; integer PCM 8, 16, 24 or 32.
  assert.equal(voiceSeconds(edited(fmt + 8, [3, 0])), undefined, "8-bit float");
  // A second fmt chunk is not read over the first (a decoder plays by the first): the file is refused.
  const bytes = SAMPLES.wav.bytes;
  const second = [...ascii("fmt "), ...u32le(16), 1, 0, 8, 0, ...u32le(384_000), ...u32le(384_000 * 8), 8, 0, 8, 0];
  const twice = new Uint8Array([...bytes.slice(0, data), ...second, ...bytes.slice(data)]);
  assert.equal(voiceSeconds(twice), undefined, "a second fmt chunk");
  // Bytes appended after the data chunk count as voice: a decoder may play them.
  near(voiceSeconds(new Uint8Array([...SAMPLES.wav.bytes, ...new Array(4000).fill(0x80)])), 3, 1e-9, "4000 more bytes, 1 s more");
});

test("a voice in an ISO file (mp4, m4a, mov) reads no length: its only length is the one its movie header states", async () => {
  const { voiceSeconds } = await load();
  for (const name of ["mp4", "mp4Fast", "m4a", "mov"]) assert.equal(voiceSeconds(SAMPLES[name].bytes), undefined, name);
  for (const bytes of [new Uint8Array(0), new TextEncoder().encode("<html></html>")]) assert.equal(voiceSeconds(bytes), undefined);
});
