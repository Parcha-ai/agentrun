// Writes words.json: for each command line below, the words bash gives its command, so shell-lex.test.mjs can check
// shell-lex.ts's word values against the shell without running bash in CI. The lines are synthetic. Each holds no
// expansion (`$` other than `$'`, a backtick, a `~` or `#` opening a word), no unquoted operator and no quote across
// a line break (the lexer reads one as a character, by design): the lines where bash and the lexer must agree word for
// word. The generator refuses any other line. Run it again to regenerate after
// editing LINES, and commit both files.
//
//   node packages/serve/test/fixtures/shell-lex-words/generate.mjs           # write words.json (needs bash)
//   node packages/serve/test/fixtures/shell-lex-words/generate.mjs --check   # exit 1 if words.json differs
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "words.json");

const LINES = [
  "a b c",
  "-u admin:pw",
  "-a 'two words'",
  "'a b' \"c d\"",
  "'a'\"b\"c",
  "\"a b\"'c d'e\\ f",
  "\"\" ''",
  "a\"\"b",
  "\"'\" '\"'",
  "\"a\tb\"",
  "\"a\\\"b\" \"c\\\\d\" \"e\\$f\" \"g\\h\" \"i\\`j\"",
  "a\\ b c\\\\d \\'e\\\"",
  "a\\;b a\\|b a\\&b a\\>b a\\(b\\)",
  "\\$HOME '$HOME' \"\\$(x)\"",
  "$'a\\tb' $'\\x41\\x4a' $'\\101' $'\\n' $'it\\'s' $'\\e[0m'",
  "$'a\\\\b' $'\\\"q\\\"' $'\\?' $'\\x7' $'\\0101'",
  "$'-u' $'admin:Copper9lumen9'",
  "-p'secret pass' --user=\"u:p w\"",
  "--user=a:b -pabc x=y",
  "\"semi;colon\" 'pipe|bar' \"amp&er\" \"paren()\" 'lt<gt>'",
  "a\\\nb",
  "a \\\n b",
  "-a \\\n Copper9lumen9",
  "x\\\n\\\ny",
  "héllo 'wörld' \"naïve\"",
  "a\\\\",
  "'it'\\''s'",
  "\"a\"'b'$'c'd",
  "-H \"Authorization: Bearer abc\" -u 'a:b c'",
  "a# b#c",
];

/** Why bash and the lexer may differ on `line`, or undefined: an expansion, an unquoted operator or comment. */
function refused(line) {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote && c === "\n") return `a quote across a line break at ${i}`;
    const start = i === 0 || " \t".includes(line[i - 1]);
    if (quote === "'") {
      if (c === "'") quote = "";
    } else if (quote === "$'") {
      if (c === "\\") i++;
      else if (c === "'") quote = "";
    } else if (quote === '"') {
      if (c === "\\") i++;
      else if (c === '"') quote = "";
      else if (c === "$" || c === "`") return `an expansion in double quotes at ${i}`;
    } else if (c === "\\") i++;
    else if (c === "'") quote = "'";
    else if (c === '"') quote = '"';
    else if (c === "$" && line[i + 1] === "'") (quote = "$'"), i++;
    else if (c === "$" || c === "`") return `an expansion at ${i}`;
    else if (start && (c === "~" || c === "#")) return `a word opening with ${c} at ${i}`;
    else if (";&|<>()\n".includes(c)) return `an unquoted operator at ${i}`;
    else if ("*?[{".includes(c)) return `a glob or brace at ${i}`;
  }
  return quote ? "an unclosed quote" : undefined;
}

function wordsOf(line) {
  const why = refused(line);
  if (why) throw new Error(`refused ${JSON.stringify(line)}: ${why}`);
  const run = spawnSync("bash", ["--norc", "--noprofile", "-c", `printf '%s\\0' ${line}`], { encoding: "utf8", env: { PATH: process.env.PATH, LC_ALL: "C.UTF-8" } });
  if (run.status !== 0 || run.stderr) throw new Error(`bash failed on ${JSON.stringify(line)}: ${run.stderr}`);
  return run.stdout.split("\0").slice(0, -1);
}

const bash = spawnSync("bash", ["--norc", "--noprofile", "-c", "echo $BASH_VERSION"], { encoding: "utf8" }).stdout.trim();
const body = `${JSON.stringify({ bash, lines: LINES.map((line) => ({ line, words: wordsOf(line) })) }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const now = JSON.parse(readFileSync(OUT, "utf8"));
  const want = JSON.parse(body);
  if (JSON.stringify(now.lines) !== JSON.stringify(want.lines)) {
    console.error("words.json differs from what bash gives; run generate.mjs and commit it");
    process.exit(1);
  }
  console.log(`words.json matches bash ${bash} (${want.lines.length} lines)`);
} else {
  writeFileSync(OUT, body);
  console.log(`wrote words.json: ${LINES.length} lines, bash ${bash}`);
}
