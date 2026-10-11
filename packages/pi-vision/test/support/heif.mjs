// A still image in a HEIF container, built by hand around the stream ffmpeg encodes: HEVC makes a HEIC file, AV1 an AVIF
// file. The container is the same for both, so an AV1 image that decodes proves the container, and a HEVC image that does
// not is the codec. Nothing here is a real picture: the stream is ffmpeg's test pattern.

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type, ...payload) => { const body = Buffer.concat(payload); return Buffer.concat([u32(8 + body.length), Buffer.from(type, "latin1"), body]); };
const full = (type, version, ...payload) => box(type, u32(version << 24), ...payload);

/** The NAL units of an Annex B HEVC stream, start codes removed. */
function nalUnits(stream) {
  const starts = [];
  for (let i = 0; i + 3 <= stream.length; i++) if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1) { starts.push(i + 3); i += 2; }
  return starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] - 3 : stream.length;
    let nal = stream.subarray(start, end);
    while (k + 1 < starts.length && nal.at(-1) === 0) nal = nal.subarray(0, -1);
    return nal;
  });
}

/** The OBUs of a low-overhead AV1 stream, each with its header and size field. */
function obus(stream) {
  const out = [];
  for (let at = 0; at < stream.length; ) {
    const type = (stream[at] >> 3) & 0xf;
    let at2 = at + 1 + ((stream[at] >> 2) & 1), size = 0;
    for (let shift = 0; ; shift += 7) { const byte = stream[at2++]; size |= (byte & 0x7f) << shift; if (!(byte & 0x80)) break; }
    out.push({ type, bytes: stream.subarray(at, at2 + size) });
    at = at2 + size;
  }
  return out;
}

/** The `hvcC` box for the parameter sets and the profile, tier and level the SPS states. */
function hvcC(nals) {
  const sets = [32, 33, 34].map((type) => nals.find((nal) => ((nal[0] >> 1) & 0x3f) === type));
  const ptl = sets[1].subarray(3, 15);
  const arrays = sets.map((nal, i) => Buffer.concat([Buffer.from([0x80 | (32 + i)]), u16(1), u16(nal.length), nal]));
  return box("hvcC", Buffer.from([1]), ptl.subarray(0, 1), ptl.subarray(1, 5), ptl.subarray(5, 11), ptl.subarray(11, 12), u16(0xf000), Buffer.from([0xfc, 0xfd, 0xf8, 0xf8]), u16(0), Buffer.from([0x0f, 3]), ...arrays);
}

/** `kind` is `"hevc"` (a `.hevc` stream, Annex B) or `"av1"` (an `.obu` stream); the result is the whole file. */
export function heifFile(kind, stream, { width, height }) {
  const hevc = kind === "hevc";
  const nals = hevc ? nalUnits(stream) : [];
  const sample = hevc
    ? Buffer.concat(nals.filter((nal) => ((nal[0] >> 1) & 0x3f) < 32).map((nal) => Buffer.concat([u32(nal.length), nal])))
    : Buffer.concat(obus(stream).filter((obu) => obu.type !== 2).map((obu) => obu.bytes));
  const ftyp = box("ftyp", Buffer.from(hevc ? "heic" : "avif", "latin1"), u32(0), Buffer.from(hevc ? "mif1heic" : "mif1avif", "latin1"));
  const properties = box("ipco", hevc ? hvcC(nals) : box("av1C", Buffer.from([0x81, 0x00, 0x0c, 0x00])), full("ispe", 0, u32(width), u32(height)));
  const meta = (offset) => box("meta", u32(0),
    full("hdlr", 0, u32(0), Buffer.from("pict", "latin1"), Buffer.alloc(13)),
    full("pitm", 0, u16(1)),
    full("iloc", 0, Buffer.from([0x44, 0x00]), u16(1), u16(1), u16(0), u16(1), u32(offset), u32(sample.length)),
    full("iinf", 0, u16(1), full("infe", 2, u16(1), u16(0), Buffer.from(hevc ? "hvc1" : "av01", "latin1"), Buffer.alloc(1))),
    box("iprp", properties, full("ipma", 0, u32(1), u16(1), Buffer.from([2, 0x81, 0x02]))));
  const at = ftyp.length + meta(0).length + 8;
  return Buffer.concat([ftyp, meta(at), box("mdat", sample)]);
}
