// The Debian step every box image recipe with pinned packages shares (media/Dockerfile, documents/Dockerfile), checked
// once: one sed rewrites the archive's and the security archive's URIs to snapshot.debian.org at one instant, over
// https, the step fails if a source still names the live mirror, and apt updates once, after the rewrite. A new image
// gets these checks by calling it.
import assert from "node:assert/strict";

/** Checks the snapshot step in `runs` (a recipe's RUN instructions, continuation lines joined) and returns the instant
 *  its URIs name, as an ISO date, for the image's other pins to be compared with. */
export function snapshotApt(runs) {
  const sources = [...runs.matchAll(/URIs: https:\/\/snapshot\.debian\.org\/archive\/\\1\/(\d{8})T(\d{6})Z#/g)];
  assert.equal(sources.length, 1, "one sed rewrites both archives' URIs to one snapshot, over https");
  assert.doesNotMatch(runs, /http:\/\/snapshot\.debian\.org/, "never the snapshot over plain http");
  assert.match(runs, /s#\^URIs: http:\/\/deb\\\.debian\\\.org\/\(debian\|debian-security\)\$#/, "the archive and the security archive");
  assert.match(runs, /! grep -q 'deb\\\.debian\\\.org' \/etc\/apt\/sources\.list\.d\/debian\.sources/, "the step fails if a source still names the live mirror");
  assert.ok(runs.indexOf("apt-get -o Acquire::Check-Valid-Until=false update") > runs.indexOf("snapshot.debian.org"), "the sources are rewritten before the first update");
  assert.equal([...runs.matchAll(/apt-get (?:-o \S+ )*update/g)].length, 1, "one update, the snapshot's");
  const [, d, t] = sources[0];
  return new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}Z`).toISOString();
}
