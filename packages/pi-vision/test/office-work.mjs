// Counts what the reader does, so a test holds a hostile file to work and not to time: a loaded machine makes a bound
// in milliseconds flake, and a bound in bytes inflated, cells built or text joined cannot. The counters see the
// inflater (`fflate`'s `Inflate`, which the reader loads from the same module), every cell an array receives (an
// object with a string `ref`), and the longest string `join` is about to build, measured before it is built. A limit
// turns a reader that would run away into one that throws, so removing a cap fails its test at once, without the
// allocation, instead of hanging the suite.
import * as fflate from "fflate";

export function countWork(t, { cells = Infinity, join = Infinity } = {}) {
  const work = { pushes: 0, bytesIn: 0, bytesOut: 0, cells: 0, longestJoin: 0 };
  const inflatePush = fflate.Inflate.prototype.push;
  const arrayPush = Array.prototype.push;
  const arrayJoin = Array.prototype.join;
  fflate.Inflate.prototype.push = function (chunk, final) {
    work.pushes++;
    work.bytesIn += chunk.length;
    if (!this.counted) {
      const emit = this.ondata;
      this.ondata = (data, last) => { work.bytesOut += data.length; emit(data, last); };
      this.counted = true;
    }
    return inflatePush.call(this, chunk, final);
  };
  Array.prototype.push = function (...items) {
    for (const item of items) if (typeof item?.ref === "string" && ++work.cells > cells) throw new RangeError(`the reader built more than ${cells} cells`);
    return arrayPush.apply(this, items);
  };
  Array.prototype.join = function (separator) {
    const gap = separator === undefined ? "," : String(separator);
    let expected = gap.length * Math.max(0, this.length - 1);
    for (let i = 0; i < this.length; i++) if (typeof this[i] === "string") expected += this[i].length;
    work.longestJoin = Math.max(work.longestJoin, expected);
    if (expected > join) throw new RangeError(`the reader would build a string of ${expected} characters, over ${join}`);
    return arrayJoin.call(this, separator);
  };
  t.after(() => {
    fflate.Inflate.prototype.push = inflatePush;
    Array.prototype.push = arrayPush;
    Array.prototype.join = arrayJoin;
  });
  return work;
}
