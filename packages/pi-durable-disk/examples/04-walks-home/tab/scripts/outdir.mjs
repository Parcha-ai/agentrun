// The output directory argument of the check scripts. A shell expands a leading "~" only when it is typed, not when it arrives through a
// variable, so "~/x" can reach a script as text: it means the home directory, not a folder named "~" in the working directory.
export function outDir(arg, env = process.env) {
  const dir = arg ?? '.';
  const home = env.HOME;
  return home && (dir === '~' || dir.startsWith('~/')) ? home + dir.slice(1) : dir;
}
