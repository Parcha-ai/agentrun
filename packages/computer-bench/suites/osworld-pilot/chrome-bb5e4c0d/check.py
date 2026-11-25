# OSWorld read Chrome's default search provider's short name and passed "Bing" or "Microsoft Bing". Firefox keeps its
# engines in search.json.mozlz4 in the profile: "mozLz40\0", the decompressed size (uint32, little-endian), then one LZ4
# block. This decodes it, finds the default engine (metaData.defaultEngineId in newer Firefox, metaData.current, a
# name, in older), and applies OSWorld's rule to its name, in any case (an engine id is "bing"). Firefox writes the file about a second after a change.
import json
import struct
import sys
import time

PATH = "/tmp/computer-bench-{{nonce}}/profile/search.json.mozlz4"


def lz4_block(src, size):
    out = bytearray()
    i = 0
    while i < len(src):
        token = src[i]
        i += 1
        length = token >> 4
        if length == 15:
            while True:
                byte = src[i]
                i += 1
                length += byte
                if byte != 255:
                    break
        out += src[i : i + length]
        i += length
        if i >= len(src) or len(out) >= size:
            break
        offset = src[i] | (src[i + 1] << 8)
        i += 2
        length = token & 15
        if length == 15:
            while True:
                byte = src[i]
                i += 1
                length += byte
                if byte != 255:
                    break
        start = len(out) - offset
        for k in range(length + 4):
            out.append(out[start + k])
    return bytes(out)


time.sleep(3)
try:
    with open(PATH, "rb") as f:
        raw = f.read()
except OSError as error:
    print("no search.json.mozlz4: " + str(error))
    sys.exit(1)
if raw[:8] != b"mozLz40\0":
    print("search.json.mozlz4 does not start with mozLz40")
    sys.exit(1)
data = json.loads(lz4_block(raw[12:], struct.unpack("<I", raw[8:12])[0]))
meta = data.get("metaData", {})
engines = data.get("engines", [])
name = meta.get("current")
if meta.get("defaultEngineId"):
    name = next((engine.get("_name") for engine in engines if engine.get("id") == meta["defaultEngineId"]), meta["defaultEngineId"])
if str(name).lower() in ("microsoft bing", "bing"):
    print("The default search engine is Bing.")
else:
    print("The default search engine is " + repr(name) + ".")
