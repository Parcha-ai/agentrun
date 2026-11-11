// The one rule for a path that names a person's machine: a person's home folder, one user name deep under `home` or
// `Users` at the root, or under Windows' `Users` folder on a drive. A user name is anything but a separator, whitespace
// or a colon, so a name with a letter beyond ASCII (`josé`) or a sign (`user+build`) is one too. The source export
// (export-source.mjs) and the packed packages' check (verify-packages.mjs) both refuse a file that holds one, so the
// rule lives here once. No user name holds a colon (passwd's separator), so a passwd line's `home/<user>:` is no
// folder of one.
//
// Two such paths are not a person's machine:
// - one right after a route parameter (`{name}`, not `${...}`) is an API route template, as an agent's home files'
//   route is;
// - `Shared` under `Users` is macOS's folder shared by every user, no one's home: an Orgo Mac keeps its labels file
//   there (machine-path.test.mjs builds the path).
export const MACHINE_PATH = /(?:(?<!(?<!\$)\{[A-Za-z0-9_]+\})\/(?:home\/|Users\/(?!Shared\/))[^/\s:]+\/|[A-Za-z]:\\Users\\(?!Shared\\)[^\\/\s:]+\\)/;
