// The differential corpus: command lines whose passwords the scrubber's five command readers (redis-cli -a, a registry
// login -p, mysql -p, npm set _authToken, curl -u) read. expected.json records which characters main's scrubber cut in
// each row (generate.mjs); scrub-differential.test.mjs requires every one of them cut still. Every input is synthetic.
const PW = "Copper9lumen9";
const NBSP = "\u00a0";
const IDEO = "\u3000";

/** Each read command: its name, and the rest of a line that gives it the password. */
const COMMANDS = [
  { name: "curl", rest: `-u admin:${PW} https://x.io` },
  { name: "redis-cli", rest: `-h db -a ${PW} ping` },
  { name: "mysql", rest: `-h db -p${PW} app` },
  { name: "docker", rest: `login -u bot -p ${PW} r.io` },
  { name: "npm", rest: `config set //r/:_authToken ${PW}` },
];
/** The ways a transcript writes a command's name. */
const NAMES = {
  bare: (n) => n,
  dquoted: (n) => `"${n}"`,
  squoted: (n) => `'${n}'`,
  ansi: (n) => `$'${n}'`,
  "escaped-first": (n) => `\\${n}`,
  "escaped-blank": (n) => `${n}\\`,
  continued: (n) => `${n} \\\n `,
  exe: (n) => `${n}.exe`,
  "windows-path": (n) => `C:\\tools\\${n}.exe`,
  "unix-path": (n) => `/usr/local/bin/${n}`,
  nbsp: (n) => `${n}${NBSP}`,
  ideographic: (n) => `${n}${IDEO}`,
};
/** The substitutions a password's command sits in, inside an outer command's argument. */
const CONTAINERS = {
  sub: (c) => `$(${c})`,
  tick: (c) => `\`${c}\``,
  dq: (c) => `"$(${c})"`,
  "locale-dq": (c) => `$"$(${c})"`,
  brace: (c) => `\${x:-$(${c})}`,
  "brace-tick": (c) => `\${x:-\`${c}\`}`,
  "dq-brace": (c) => `"\${x:-$(${c})}"`,
  "sub-in-sub": (c) => `$(echo $(${c}))`,
};
const OUTER = [(arg) => `curl -H ${arg} https://x.io`, (arg) => `redis-cli -h ${arg} ping`, (arg) => `echo ${arg}`];
/** Redirections written before or after the password's flag. */
const REDIRECTS = [">out.txt", "> out.txt", ">>log", "2>err", "2>/dev/null", "&>all", "<in.txt", "< in.txt", ">&2", "2>&1", "<<<word", ">-x"];
/** The rows of reviews of the lexer change: each was cut by main's readers. */
const REVIEWED = [
  `redis-cli -h o'neil -a ${PW} ping 'x'`,
  `redis-cli -h db's -a ${PW} ping  # Bob's box`,
  `redis-cli -h o'neil ping; redis-cli -a ${PW} ping 'x'`,
  `mysql -h o'neil -p${PW} app 'x'`,
  `docker login -u o'neil -p ${PW} r.io 'x'`,
  `npm config set o'x //r/:_authToken ${PW} 'y'`,
  `curl -H 'it's' -u admin:${PW} https://x 'y'`,
  `curl -d o'neil -u admin:${PW} https://x 'y'`,
  `redis-cli -h \${HOST -a ${PW} }`,
  `mysql -h \${HOST -p${PW} }`,
  `docker login -u \${HOST -p ${PW} }`,
  `curl -H \${HOST -u admin:${PW} }`,
  `{"type":"text","text":"redis-cli -h \${HOST -a ${PW}"}`,
  `{"cmd":"redis-cli -h 'db -a ${PW}","note":"it's"}`,
  `redis-cli -h 'db -a ${PW} x'`,
  `mysql -e "select 1 -p${PW}"`,
  `curl -H "X: a -u admin:${PW}" https://x`,
  `curl -u admin:Copper&9lumen9 https://x`,
  `curl --user admin:Copper&9lumen9 https://x`,
  `curl -u admin:Copper(9lumen9 https://x`,
  `curl -u admin:Copper)9lumen9 https://x`,
  `curl -u admin:Copper<9lumen9 https://x`,
  `curl -u admin:Copper>9lumen9 https://x`,
  `curl -u admin:${PW}<in`,
  `curl -H \${x:-$(curl -u admin:${PW} https://x.io)} https://x.io`,
  `curl -H $"$(curl -u admin:${PW} https://x.io)" https://x.io`,
  `redis-cli -h "$(vault read -a ${PW})" ping`,
  `redis-cli >-a report.txt -a ${PW} ping`,
];

/** Every row: { id, class, text }. The ids are stable: expected.json is keyed by them. */
export function corpus() {
  const rows = [];
  for (const { name, rest } of COMMANDS) {
    for (const [form, write] of Object.entries(NAMES)) rows.push({ id: `name/${form}/${name}`, class: `name/${form}`, text: `${write(name)} ${rest}` });
  }
  const inner = COMMANDS.map(({ name, rest }) => `${name} ${rest}`);
  for (const [kind, wrap] of Object.entries(CONTAINERS)) {
    OUTER.forEach((outer, o) => inner.forEach((command, c) => rows.push({ id: `container/${kind}/${o}/${COMMANDS[c].name}`, class: `container/${kind}`, text: outer(wrap(command)) })));
  }
  REDIRECTS.forEach((redirect, r) => {
    for (const { name, rest } of COMMANDS) {
      rows.push({ id: `redirect/before/${r}/${name}`, class: "redirect/before", text: `${name} ${redirect} ${rest}` });
      rows.push({ id: `redirect/after/${r}/${name}`, class: "redirect/after", text: `${name} ${rest} ${redirect}` });
    }
  });
  REVIEWED.forEach((text, r) => rows.push({ id: `reviewed/${r}`, class: "reviewed", text }));
  return rows;
}

/** The forms each row is read in: as written, and as a JSON text block's string. */
export const WRAPS = { raw: (s) => s, json: (s) => JSON.stringify({ type: "text", text: s }) };

/** The characters a scrub's cuts cover, as merged [start, end) spans. */
export function covered(cuts) {
  const spans = cuts.map((cut) => [cut.start, cut.end]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [start, end] of spans) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** The parts of `want`'s spans that `have`'s spans leave uncovered. */
export function uncovered(want, have) {
  const out = [];
  for (const [start, end] of want) {
    let at = start;
    for (const [s, e] of have) {
      if (e <= at || s >= end) continue;
      if (s > at) out.push([at, s]);
      at = Math.max(at, e);
      if (at >= end) break;
    }
    if (at < end) out.push([at, end]);
  }
  return out;
}
