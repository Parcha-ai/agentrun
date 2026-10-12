// SHA-256 over a stream of chunks (FIPS 180-4). WebCrypto hashes one whole buffer only, and a phone should not hold a 208 MB model part in memory just to
// check it: this reads a file in slices and hashes as it goes. Portable: no Node API.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private readonly h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly w = new Uint32Array(64);
  private readonly block = new Uint8Array(64);
  private filled = 0;
  private bytes = 0;

  update(data: Uint8Array): this {
    let i = 0;
    this.bytes += data.length;
    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, data.length);
      this.block.set(data.subarray(0, take), this.filled);
      this.filled += take;
      i = take;
      if (this.filled < 64) return this;
      this.compress(this.block, 0);
      this.filled = 0;
    }
    for (; i + 64 <= data.length; i += 64) this.compress(data, i);
    if (i < data.length) {
      this.block.set(data.subarray(i), 0);
      this.filled = data.length - i;
    }
    return this;
  }

  hex(): string {
    const bits = this.bytes * 8;
    const pad = new Uint8Array(((this.filled < 56 ? 56 : 120) - this.filled) + 8);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(pad.length - 4, bits >>> 0);
    this.update(pad);
    return [...this.h].map((x) => x.toString(16).padStart(8, "0")).join("");
  }

  private compress(d: Uint8Array, o: number): void {
    const w = this.w;
    for (let t = 0; t < 16; t++) w[t] = (d[o + 4 * t]! << 24) | (d[o + 4 * t + 1]! << 16) | (d[o + 4 * t + 2]! << 8) | d[o + 4 * t + 3]!;
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15]!, b = w[t - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
    }
    const H = this.h;
    let a = H[0]!, b = H[1]!, c = H[2]!, dd = H[3]!, e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[t]! + w[t]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (dd + t1) | 0; dd = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    this.h[0] = (this.h[0]! + a) | 0; this.h[1] = (this.h[1]! + b) | 0; this.h[2] = (this.h[2]! + c) | 0; this.h[3] = (this.h[3]! + dd) | 0;
    this.h[4] = (this.h[4]! + e) | 0; this.h[5] = (this.h[5]! + f) | 0; this.h[6] = (this.h[6]! + g) | 0; this.h[7] = (this.h[7]! + h) | 0;
  }
}
