// A media file's length in seconds, read from its bytes alone: an ISO file's movie header (mp4, m4a, mov), a WAV's data
// chunk over its byte rate, an MP3's frame count (Xing, Info or VBRI) or, with none, its frames walked one by one. Pure:
// no decoder, nothing read past the bytes given. Undefined for anything else, or a file cut short of the header its
// length is in. voiceSeconds reads a voice's length from what plays instead, for a file whose sender is billed by it.

/** Whether the bytes at `at` are `text`'s character codes. No allocation: a walk over a 32 MiB file calls it millions
 *  of times. */
const tag = (b: Uint8Array, at: number, text: string): boolean => {
  if (at < 0 || b.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};
const u32 = (b: Uint8Array, at: number): number => (b[at]! * 0x1000000) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const u32le = (b: Uint8Array, at: number): number => b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16) + b[at + 3]! * 0x1000000;
const u16le = (b: Uint8Array, at: number): number => b[at]! + (b[at + 1]! << 8);
const length = (seconds: number): number | undefined => (Number.isFinite(seconds) && seconds > 0 ? seconds : undefined);

/** The boxes of an ISO file between `from` and `to`: each one's type and where its body starts and ends. A box that runs
 *  past `to`, or is smaller than its own header, ends the walk. */
function* boxes(b: Uint8Array, from: number, to: number): Generator<{ type: string; start: number; end: number }> {
  for (let at = from; at + 8 <= to; ) {
    let size = u32(b, at);
    let head = 8;
    if (size === 1) {
      if (at + 16 > to) return;
      size = u32(b, at + 8) * 0x100000000 + u32(b, at + 12);
      head = 16;
    } else if (size === 0) size = to - at;
    if (size < head || at + size > to) return;
    yield { type: String.fromCharCode(b[at + 4]!, b[at + 5]!, b[at + 6]!, b[at + 7]!), start: at + head, end: at + size };
    at += size;
  }
}

/** An ISO file's length: its moov's mvhd, duration over timescale (64-bit in version 1). */
function isoSeconds(b: Uint8Array): number | undefined {
  for (const top of boxes(b, 0, b.length)) {
    if (top.type !== "moov") continue;
    for (const { type, start, end } of boxes(b, top.start, top.end)) {
      if (type !== "mvhd") continue;
      const wide = b[start] === 1;
      if (end - start < (wide ? 32 : 20)) return undefined;
      const scale = u32(b, start + (wide ? 20 : 12));
      const ticks = wide ? u32(b, start + 24) * 0x100000000 + u32(b, start + 28) : u32(b, start + 16);
      return scale > 0 ? length(ticks / scale) : undefined;
    }
  }
  return undefined;
}

/** A WAV's length: its data chunk's bytes (those in the file, when it states more) over its fmt chunk's byte rate. */
function wavSeconds(b: Uint8Array): number | undefined {
  let rate: number | undefined;
  for (let at = 12; at + 8 <= b.length; ) {
    const size = u32le(b, at + 4);
    if (tag(b, at, "fmt ")) {
      if (at + 20 > b.length) return undefined;
      rate = u32le(b, at + 16);
    } else if (tag(b, at, "data")) return rate ? length(Math.min(size, b.length - at - 8) / rate) : undefined;
    at += 8 + size + (size % 2);
  }
  return undefined;
}

// MPEG audio, by version bits (3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5) and layer bits (3: I, 2: II, 1: III).
const RATES: Record<number, readonly number[]> = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] };
const KBPS_V1: Record<number, readonly number[]> = {
  3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};
const KBPS_V2: Record<number, readonly number[]> = {
  3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
type Frame = { rate: number; samples: number; bytes: number; side: number };

/** The MPEG audio frame header at `at`, or undefined when those four bytes are none. */
function frameAt(b: Uint8Array, at: number): Frame | undefined {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) return undefined;
  const version = (b[at + 1]! >> 3) & 3;
  const layer = (b[at + 1]! >> 1) & 3;
  const rate = RATES[version]?.[(b[at + 2]! >> 2) & 3];
  const kbps = (version === 3 ? KBPS_V1 : KBPS_V2)[layer]?.[b[at + 2]! >> 4];
  if (!rate || !kbps) return undefined;
  const padding = (b[at + 2]! >> 1) & 1;
  const mono = b[at + 3]! >> 6 === 3;
  const samples = layer === 3 ? 384 : layer === 2 || version === 3 ? 1152 : 576;
  const bytes = layer === 3 ? (Math.floor((12 * kbps * 1000) / rate) + padding) * 4 : Math.floor(((samples / 8) * kbps * 1000) / rate) + padding;
  return { rate, samples, bytes, side: version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17 };
}

/** The furthest past a tag an MP3's first frame is looked for. */
const SYNC_SCAN = 64 * 1024;

/** Every frame's samples over its rate, from the frame at `at` to `end`. A last frame cut short ends it; bytes that stop
 *  being frames before that give no length, since a bitrate guessed for them could read the file short. */
function walkedSeconds(b: Uint8Array, at: number, end: number): number | undefined {
  let seconds = 0;
  while (at < end) {
    const frame = frameAt(b, at);
    if (!frame) return undefined;
    if (at + frame.bytes > end) break;
    seconds += frame.samples / frame.rate;
    at += frame.bytes;
  }
  return length(seconds);
}

/** Where an MP3's frames may start: past an ID3v2 tag, whose size is four 7-bit bytes, with a 10-byte footer when
 *  flagged; 0 with none. */
const id3End = (b: Uint8Array): number => (tag(b, 0, "ID3") && b.length >= 10 ? 10 + ((b[6]! & 0x7f) << 21) + ((b[7]! & 0x7f) << 14) + ((b[8]! & 0x7f) << 7) + (b[9]! & 0x7f) + (b[5]! & 0x10 ? 10 : 0) : 0);
/** Where an MP3's frames end: before an ID3v1 tag (its last 128 bytes, from "TAG"), else at its end. */
const id3v1Start = (b: Uint8Array): number => b.length - (tag(b, b.length - 128, "TAG") ? 128 : 0);

/** An MP3's length: its first frame's Xing, Info or VBRI frame count times a frame's samples over its rate; with none,
 *  its frames walked one by one (a variable bitrate needs no header), the first taken only when another follows it. */
function mp3Seconds(b: Uint8Array): number | undefined {
  const start = id3End(b);
  const end = id3v1Start(b);
  for (let at = start; at < Math.min(end, start + SYNC_SCAN); at++) {
    const frame = frameAt(b, at);
    if (!frame) continue;
    const xing = at + 4 + frame.side;
    if ((tag(b, xing, "Xing") || tag(b, xing, "Info")) && xing + 12 <= b.length && b[xing + 7]! & 1) return length((u32(b, xing + 8) * frame.samples) / frame.rate);
    if (tag(b, at + 36, "VBRI") && at + 54 <= b.length) return length((u32(b, at + 50) * frame.samples) / frame.rate);
    if (at + frame.bytes === end || frameAt(b, at + frame.bytes)) return walkedSeconds(b, at, end);
  }
  return undefined;
}

/** Whether `b` is an ISO file (mp4, m4a, mov), by its first box. */
const isIso = (b: Uint8Array): boolean => ["ftyp", "moov", "mdat", "free", "wide"].some((type) => tag(b, 4, type));

/** The length of the media file `bytes`, in seconds; undefined when it can't be read from them. */
export function mediaSeconds(bytes: Uint8Array): number | undefined {
  if (isIso(bytes)) return isoSeconds(bytes);
  if (tag(bytes, 0, "RIFF") && tag(bytes, 8, "WAVE")) return wavSeconds(bytes);
  return mp3Seconds(bytes);
}

// A voice's length, for a job billed by it whose sender made the file (a talking head): what a decoder plays, never a
// length a header states, which the sender could write short.

/** An MP3 voice: every frame from its first byte to its last, each its samples over its rate, a last frame cut short
 *  counted whole. Only an ID3v2 tag and the zeros after it may come before the frames, and only an ID3v1 tag after;
 *  any other byte gives no length. A frame count in a Xing, Info or VBRI header is not read: each is its frame. */
function playedMp3Seconds(b: Uint8Array): number | undefined {
  let at = id3End(b);
  while (at < b.length && b[at] === 0) at += 1;
  const end = id3v1Start(b);
  if (at >= end) return undefined;
  let seconds = 0;
  for (let frame = frameAt(b, at); at < end; frame = frameAt(b, at)) {
    if (!frame) return undefined;
    seconds += frame.samples / frame.rate;
    at += frame.bytes;
  }
  return length(seconds);
}

/** The WAV formats whose bytes play at the sample rate, by format tag, and the bits a sample each takes: integer PCM and
 *  IEEE float. Not the extensible header (0xFFFE): its GUID names the codec, which may be a compressed one. */
const PCM_BITS: ReadonlyMap<number, readonly number[]> = new Map([[1, [8, 16, 24, 32]], [3, [32, 64]]]);

/** A WAV voice: every byte after its data chunk's header, to the end of the file (a decoder may play past a data size
 *  stated short), over its sample rate times its block align, a last frame cut short counted whole. Its one fmt chunk
 *  (a decoder plays by the first; a second is refused) must come before the data, name integer PCM or IEEE float
 *  (PCM_BITS) at 1 to 384 kHz, and agree with itself: block align is the channels times the bytes a sample, byte rate
 *  the sample rate times the block align. Anything else gives no length. */
function playedWavSeconds(b: Uint8Array): number | undefined {
  let frame: { rate: number; align: number } | undefined;
  for (let at = 12; at + 8 <= b.length; ) {
    const size = u32le(b, at + 4);
    if (tag(b, at, "fmt ")) {
      if (frame || size < 16 || at + 24 > b.length) return undefined;
      const format = u16le(b, at + 8);
      const channels = u16le(b, at + 10);
      const rate = u32le(b, at + 12);
      const byteRate = u32le(b, at + 16);
      const align = u16le(b, at + 20);
      const bits = u16le(b, at + 22);
      if (!PCM_BITS.get(format)?.includes(bits) || channels < 1 || align !== channels * (bits / 8) || byteRate !== rate * align || rate < 1000 || rate > 384_000) return undefined;
      frame = { rate, align };
    } else if (tag(b, at, "data")) return frame ? length(Math.ceil((b.length - at - 8) / frame.align) / frame.rate) : undefined;
    at += 8 + size + (size % 2);
  }
  return undefined;
}

/** The length of the voice `bytes` play, in seconds: an MP3's frames or a PCM WAV's samples (playedMp3Seconds,
 *  playedWavSeconds). Undefined for anything else, an ISO file included: its only length is its movie header's. */
export function voiceSeconds(bytes: Uint8Array): number | undefined {
  if (isIso(bytes)) return undefined;
  if (tag(bytes, 0, "RIFF") && tag(bytes, 8, "WAVE")) return playedWavSeconds(bytes);
  return playedMp3Seconds(bytes);
}
