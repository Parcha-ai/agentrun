// A test helper that builds a run's cap or spec from an options bag reads only the options it names: one it does not read
// (a stale caller's, such as capRun's old `beforeRequest`) would be dropped in silence and the test would run without
// what it meant to set (an uncapped run where a cap was meant). So such a helper refuses an option it does not know, in
// words, before it builds anything.

/** Throws, naming `helper` and the options it does not read, when `given` has any key outside `known`. */
export function strictOptions(helper, given, known) {
  const unknown = Object.keys(given ?? {}).filter((key) => !known.includes(key));
  if (unknown.length) throw new Error(`${helper}: it does not read ${unknown.map((key) => `\`${key}\``).join(", ")} (it reads ${known.map((key) => `\`${key}\``).join(", ")}); a test that sets one would run without it`);
}
