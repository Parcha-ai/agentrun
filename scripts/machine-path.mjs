// The one rule for a path that names a person's machine: a person's home folder, one user name deep (letters, digits,
// dots, underscores and hyphens) under `home` or `Users` at the root, or under Windows' `Users` folder on a drive. The
// source export (export-source.mjs) and the packed packages' check (verify-packages.mjs) both refuse a file that holds
// one, so the rule lives here once. A name is a user name, so a passwd line's `home/<user>:` is no folder of one.
//
// Two such paths are not a person's machine:
// - one right after a route parameter (`{name}`, not `${...}`) is an API route template, as an agent's home files'
//   route is;
// - `Shared` under `Users` is macOS's folder shared by every user, no one's home: an Orgo Mac keeps its labels file
//   there (machine-path.test.mjs builds the path).
export const MACHINE_PATH = /(?:(?<!(?<!\$)\{[A-Za-z0-9_]+\})\/(?:home\/|Users\/(?!Shared\/))[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\(?!Shared\\)[A-Za-z0-9._-]+\\)/;
