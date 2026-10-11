// The offline tab's command set (D3 measured edgejs.webc's /bin in real Chrome, 2026-10-11): bash with uutils coreutils
// and node. grep, sed, awk, find, xargs, diff, python3 and curl are not there. missingCommands() reads a bash command
// line statically and names the programs it runs that the offline computer lacks.

export const OFFLINE_BIN = new Set(("[ arch b2sum base32 base64 basename basenc bash cat cksum comm coreutils cp csplit cut date dd " +
  "dir dircolors dirname echo env expand expr factor false fmt fold head hostid join link ln ls md5sum mkdir mktemp mv nice " +
  "nl node nohup npm nproc numfmt od paste pathchk pnpm pr printenv printf ptx pwd readlink realpath rm rmdir seq sh " +
  "sha1sum sha224sum sha256sum sha384sum sha512sum shred shuf sleep sort split sum tac tail tee test touch tr true truncate " +
  "tsort tty uname unexpand uniq unlink vdir wc yes").split(" "));

const BUILTINS = new Set((": cd echo printf test [ [[ ]] true false read export local set unset shift source . eval exec exit " +
  "return break continue for while until do done if then else elif fi case esac in function select time declare let " +
  "pushd popd dirs type command builtin alias hash umask wait trap { } ! ((").split(" "));

/** Programs a command line runs that the offline computer does not have (static: first word of each simple command). */
export function missingCommands(line: string): string[] {
  const out = new Set<string>();
  // Leave quoted strings out so their words are not read as commands.
  const bare = line.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const seg of bare.split(/\|\||&&|[|;&\n]|\$\(|`|\bthen\b|\bdo\b|\belse\b/)) {
    const words = seg.trim().replace(/^[({!]+\s*/, "").split(/\s+/).filter(Boolean);
    let w = words[0];
    let i = 0;
    while (w !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) w = words[++i]; // VAR=x cmd
    if (!w || BUILTINS.has(w) || /^[<>0-9]/.test(w) || w.startsWith("$") || w.startsWith("./")) continue;
    const name = w.split("/").pop()!;
    if (!OFFLINE_BIN.has(name)) out.add(name);
  }
  return [...out];
}
