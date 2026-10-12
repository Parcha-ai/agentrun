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

/**
 * For each position of a line, whether it lies inside single or double quotes, by bash's rules: a backslash escapes the
 * next character outside quotes and inside double quotes, and nothing inside single quotes.
 */
function quotedPositions(line: string): boolean[] {
  const out: boolean[] = [];
  let q: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q === "'") { out.push(true); if (c === "'") q = null; continue; }
    if (c === "\\") { out.push(q !== null); if (i + 1 < line.length) { out.push(q !== null); i++; } continue; }
    if (q === '"') { out.push(true); if (c === '"') q = null; continue; }
    out.push(false);
    if (c === "'" || c === '"') q = c;
  }
  return out;
}

/** The bodies of $(...) and `...` in a line (outside single quotes, which bash does not expand), nesting included. */
function substitutions(line: string): string[] {
  const out: string[] = [];
  const text = line.replace(/'[^']*'/g, (q) => " ".repeat(q.length));
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
      let depth = 1, j = i + 2;
      for (; j < text.length && depth; j++) depth += text[j] === "(" ? 1 : text[j] === ")" ? -1 : 0;
      out.push(line.slice(i + 2, j - 1));
      i = j - 1;
    } else if (text[i] === "`") {
      const j = text.indexOf("`", i + 1);
      if (j < 0) break;
      out.push(line.slice(i + 1, j));
      i = j;
    }
  }
  return out;
}

/**
 * Programs a command line runs that the offline computer does not have (static: the first word of each simple command,
 * including commands inside $(...), backticks and bash -c / sh -c strings).
 */
export function missingCommands(line: string): string[] {
  const out = new Set<string>();
  for (const inner of substitutions(line)) for (const m of missingCommands(inner)) out.add(m);
  // bash -c / sh -c run their string, unless the words are themselves quoted text (echo 'bash -c "grep x"' only prints).
  const quoted = quotedPositions(line);
  for (const m of line.matchAll(/\b(?:bash|sh)\s+-c\s+(['"])([\s\S]*?)\1/g)) {
    if (quoted[m.index!]) continue;
    for (const x of missingCommands(m[2]!)) out.add(x);
  }
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
