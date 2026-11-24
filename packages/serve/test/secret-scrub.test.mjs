// Scrubber beta 1 (secret-cut.ts scrub, secret-rules.ts SCRUB_RULES): one pass over a text that cuts, by anchored rules
// only, known formats, values the server holds, whole dumps (env output, .env files, ~/.ssh), values beside a label and
// personal details. Every cut names its rule, its kind and whether a preview may restore it (fixed per kind), and its
// shape (prefix class and length), never its value. Count mode returns counts and cuts, never text; cut mode fails closed.
// Every fixture here is synthetic and built at run time: no real key, path, address or session text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import v8 from "node:v8";
import vm from "node:vm";
import * as secretCut from "../dist/secret-cut.js";
import { SECRET_SHAPES, shapeSpans } from "../dist/redact/match.js";

const { RULE_PATTERNS = {}, SCRUB_RULES, scrub, scrubWith } = secretCut;
import { AKIA, BLOB, GHP, HELD, HEX64, JWT, macHome, NPM, PEM, SK, unixHome, windowsHome } from "./scrub-positives.mjs";

/** Restorable, by kind: the contract's fixed map. */
const RESTORABLE = { format: false, held: false, dump: false, label: true, personal: true, jev: true };
/** A PEM header, built so the source-export scan reads no key block in this file. */
const RSA_HEADER = `-----${"BEGIN"} RSA PRIVATE KEY-----`;

const cutOf = async (text, held, homes) => {
  const out = await scrub(text, { mode: "cut", held, ...(homes ? { homes } : {}) });
  assert.equal(out.ok, true, `scrub failed closed on ${JSON.stringify(text.slice(0, 80))}`);
  return out;
};
/** The one cut of `text`, asserting there is exactly one. */
const oneCut = async (text, held) => {
  const out = await cutOf(text, held);
  assert.equal(out.cuts.length, 1, `cuts: ${JSON.stringify(out.cuts)} of ${JSON.stringify(text)}`);
  return { ...out, cut: out.cuts[0] };
};
/** `value` with one letter or digit (its first from the third on) percent-encoded: a form valueMatcher decodes and no
 *  held form is (a held form encodes the whole value). */
const partlyEncoded = (value) => {
  const at = value.slice(2).search(/[A-Za-z0-9]/) + 2;
  return `${value.slice(0, at)}%${value.charCodeAt(at).toString(16).toUpperCase()}${value.slice(at + 1)}`;
};
const kept = async (text, held, homes) => {
  const out = await cutOf(text, held, homes);
  assert.deepEqual(out.cuts, [], `expected no cut of ${JSON.stringify(text)}`);
  assert.equal(out.text, text);
};

test("SCRUB_RULES: unique ids, a known kind each, restorable fixed by kind", () => {
  const ids = SCRUB_RULES.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const rule of SCRUB_RULES) {
    assert.ok(rule.kind in RESTORABLE, `${rule.id}: kind ${rule.kind}`);
    assert.equal(rule.restorable, RESTORABLE[rule.kind], `${rule.id} restorable`);
  }
  for (const id of ["sk-key", "github-token", "aws-access-key", "jwt", "private-key-block", "bearer-token", "url-password", "url-credential", "secretlint", "held-value", "env-dump", "env-file", "ssh-file", "secret-assign", "sshpass", "mysql-password", "password-flag", "auth-header", "curl-user", "home-path", "email", "private-ip"]) {
    assert.ok(ids.includes(id), `rule ${id}`);
  }
});

test("format: a known key is cut whole, not restorable, its shape a public prefix and a length", async () => {
  for (const [secret, rule, prefix] of [[SK, "sk-key", "sk-"], [GHP, "github-token", "ghp_"], [AKIA, "aws-access-key", "AKIA"], [JWT, "jwt", "eyJ"]]) {
    const { text, cut } = await oneCut(`the tool printed ${secret} and went on`);
    assert.equal(text, `the tool printed [redacted:${rule}] and went on`);
    assert.equal(cut.rule, rule);
    assert.equal(cut.kind, "format");
    assert.equal(cut.restorable, false);
    assert.equal(cut.shape, `${prefix}…[${secret.length}]`);
    assert.equal(cut.end - cut.start, secret.length);
  }
});

test("format: a private key's PEM block is one cut, BEGIN to END", async () => {
  const { text, cut } = await oneCut(`key:\n${PEM}\ndone`);
  assert.equal(text, "key:\n[redacted:private-key-block]\ndone");
  assert.equal(cut.kind, "format");
});

test("format: secretlint's hits are cut too (a token SHAPES has no shape for)", async () => {
  const { text, cut } = await oneCut(`//registry.npmjs.org/:_authToken=${NPM}\n`);
  assert.ok(!text.includes(NPM), text);
  assert.equal(cut.kind, "format");
  assert.equal(cut.restorable, false);
});

test("held: a held value in every form the redactors know is cut, not restorable", async () => {
  const forms = [HELD, JSON.stringify(`a"${HELD}`).slice(1, -1), Buffer.from(HELD).toString("base64"), Buffer.from(HELD).toString("hex"), encodeURIComponent(`${HELD}/x y`)];
  for (const form of forms) {
    const out = await cutOf(`seen: ${form} end`, [HELD]);
    assert.ok(out.cuts.length >= 1, form);
    assert.ok(out.cuts.every((cut) => cut.rule === "held-value" && cut.kind === "held" && cut.restorable === false), JSON.stringify(out.cuts));
    assert.ok(!out.text.includes(HELD), out.text);
  }
});

test("held: a value shorter than 8 characters is not held (it would match text by chance)", async () => {
  await kept("the word abc appears", ["abc"]);
});

test("held: a value left in the text in a form the pass cannot cut in place fails closed", async () => {
  // Partly percent-encoded: valueMatcher's decoded view sees it, no held form stands in place (a split by a blank is
  // cut whole since ruling XIV).
  const out = await scrub(`printed ${partlyEncoded(HELD)}`, { mode: "cut", held: [HELD] });
  assert.deepEqual(out, { ok: false, counts: {} });
});

test("label: a password typed beside its label is cut, the label kept, restorable", async () => {
  const cases = [
    ["PGPASSWORD=s3cretPgPw psql -h db", "PGPASSWORD=[redacted:secret-assign] psql -h db", "secret-assign"],
    ["MYSQL_PWD='my sql pw' mysql", "MYSQL_PWD='[redacted:secret-assign]' mysql", "secret-assign"],
    ["export DB_PASSWORD=\"hunter2hunter\"", "export DB_PASSWORD=\"[redacted:secret-assign]\"", "secret-assign"],
    ["sshpass -p 'Pa55word!' ssh box", "sshpass -p '[redacted:sshpass]' ssh box", "sshpass"],
    ["sshpass -pPa55word ssh box", "sshpass -p[redacted:sshpass] ssh box", "sshpass"],
    ["mysql -uroot -pR00tPass shop", "mysql -uroot -p[redacted:mysql-password] shop", "mysql-password"],
    ["mysqldump -u root -pR00tPass shop > dump.sql", "mysqldump -u root -p[redacted:mysql-password] shop > dump.sql", "mysql-password"],
    ["psql --password=pgFlagPw1 -h db", "psql --password=[redacted:password-flag] -h db", "password-flag"],
    ["tool login --password pgFlagPw2", "tool login --password [redacted:password-flag]", "password-flag"],
    ["curl -H 'Authorization: Basic dXNlcjpwYXNzd29yZA==' https://api.example.com", "curl -H 'Authorization: Basic [redacted:auth-header]' https://api.example.com", "auth-header"],
    ["curl -H \"X-Api-Key: plainKeyValue123\" https://api.example.com", "curl -H \"X-Api-Key: [redacted:auth-header]\" https://api.example.com", "auth-header"],
    ["curl -u admin:adminPw99 https://api.example.com", "curl -u admin:[redacted:curl-user] https://api.example.com", "curl-user"],
  ];
  for (const [input, expected, rule] of cases) {
    const { text, cut } = await oneCut(input);
    assert.equal(text, expected);
    assert.equal(cut.rule, rule);
    assert.equal(cut.kind, "label");
    assert.equal(cut.restorable, true);
  }
});

test("label: -p outside a mysql command and lowercase unquoted names are no password", async () => {
  await kept("mkdir -p build/out && ssh -p 2222 host");
  // Ruling IX (and D): `-p` then a blank prompts for the password; the word after it is the database.
  await kept("mysqldump -u root -p R00tPass shop > dump.sql");
  await kept("client = make_client(api_key=api_key, token=tok)");
});

test("label: placeholders are never cut", async () => {
  for (const text of [
    "PGPASSWORD=$PGPASS psql",
    "DB_PASSWORD=${DB_PASSWORD} ./run",
    "API_KEY=<token> ./run",
    "API_KEY=*** ./run",
    "API_KEY=YOUR_API_KEY ./run",
    "API_KEY=xxx ./run",
    "curl -H 'Authorization: Bearer $TOKEN' https://api.example.com",
    "curl -u admin:$ADMIN_PASS https://api.example.com",
    "sshpass -p \"$SSHPASS\" ssh box",
    "tool --password=<password>",
  ]) await kept(text);
});

test("overlap: a known format beside a label wins (not restorable beats restorable on one span)", async () => {
  const { text, cut } = await oneCut(`curl -H "Authorization: Bearer ${GHP}" https://api.example.com`);
  assert.equal(text, `curl -H "Authorization: Bearer [redacted:github-token]" https://api.example.com`);
  assert.equal(cut.restorable, false);
  assert.equal(cut.kind, "format");
});

test("overlap: a held value inside a label's value makes the whole cut not restorable", async () => {
  const { text, cut } = await oneCut(`PGPASSWORD=pre${HELD} psql`, [HELD]);
  assert.equal(text, "PGPASSWORD=[redacted:held-value] psql");
  assert.equal(cut.kind, "held");
  assert.equal(cut.restorable, false);
});

test("dump: env output after its command is dropped whole as one cut, the command kept", async () => {
  const text = ["$ env", "PATH=/usr/bin:/bin", "SHELL=/bin/bash", "LANG=C.UTF-8", `SOME_TOKEN=${HELD}x`, "$ echo done"].join("\n");
  const { text: out, cut } = await oneCut(text);
  assert.equal(out, ["$ env", "[redacted:env-dump 4 lines]", "$ echo done"].join("\n"));
  assert.equal(cut.kind, "dump");
  assert.equal(cut.restorable, false);
});

test("dump: an env block with no command is found by its shape (8 lines or more, two of PATH, HOME, SHELL, USER, PWD, LANG)", async () => {
  const text = ["HOME=/srv/h", "PATH=/usr/bin", "HOSTNAME=box1", "TERM=xterm", "SHLVL=1", "COLOR=blue", "SIZE=9", "MODE=fast"].join("\n");
  const { text: out } = await oneCut(text);
  assert.equal(out, "[redacted:env-dump 8 lines]");
  // Seven lines are a script's, not a dump (ruling G).
  await kept(text.split("\n").slice(0, 7).join("\n"));
});

test("dump: export -p output (declare -x lines) is one dump", async () => {
  const text = ['declare -x COLOR="blue"', 'declare -x SIZE="9"', 'declare -x MODE="fast"'].join("\n");
  assert.equal((await oneCut(text)).text, "[redacted:env-dump 3 lines]");
});

test("dump: three plain assignments with no command and no env names are not a dump", async () => {
  await kept(["COLOR=blue", "SIZE=9", "MODE=fast"].join("\n"));
});

test("dump: a .env file read is dropped whole; a .env.example is not", async () => {
  const body = ["# app", "DATABASE_URL=postgres://db/app", "", "FEATURE_X=on"];
  const { text, cut } = await oneCut(["$ cat .env.local", ...body, "$ ls"].join("\n"));
  assert.equal(text, ["$ cat .env.local", "[redacted:env-file 4 lines]", "$ ls"].join("\n"));
  assert.equal(cut.rule, "env-file");
  await kept(["$ cat .env.example", "# app", "FEATURE_X=on"].join("\n"));
});

test("dump: a text given as a .env file's content (opts.path) is one dump", async () => {
  const out = await scrub("A=1\nB=2", { mode: "cut", path: "/srv/app/.env.production" });
  assert.equal(out.ok && out.text, "[redacted:env-file 2 lines]");
});

test("dump: ~/.ssh contents are dropped: a config read, and a key file read", async () => {
  const config = ["$ cat ~/.ssh/config", "Host build", "  HostName build.internal", "  User deploy", "  IdentityFile ~/.ssh/id_build", "$ pwd"].join("\n");
  assert.equal((await oneCut(config)).text, ["$ cat ~/.ssh/config", "[redacted:ssh-file 4 lines]", "$ pwd"].join("\n"));
  const keys = [`ssh-ed25519 ${BLOB} one@box`, `ssh-ed25519 ${BLOB}Q two@box`].join("\n");
  const { text, cut } = await oneCut(`$ cat ~/.ssh/authorized_keys\n${keys}`);
  assert.equal(text, "$ cat ~/.ssh/authorized_keys\n[redacted:ssh-file 2 lines]");
  assert.equal(cut.kind, "dump");
});

test("personal: a home path keeps its structure; the user segment is cut, restorable", async () => {
  for (const [input, expected] of [
    [`open ${unixHome("alicea")}/proj/x.ts`, `open ${unixHome("<user>")}/proj/x.ts`],
    [`at ${macHome("bobb")}/Library/a`, `at ${macHome("<user>")}/Library/a`],
    [`${windowsHome("carolc")}\\Desktop`, `${windowsHome("<user>")}\\Desktop`],
    [`cd ${unixHome("daved")}/x`, `cd ${unixHome("<user>")}/x`],
  ]) {
    const { text, cut } = await oneCut(input);
    assert.equal(text, expected);
    assert.equal(cut.kind, "personal");
    assert.equal(cut.restorable, true);
  }
  await kept(`cd ${unixHome("$USER")}/x and ${unixHome("<user>")}/y and ${macHome("Shared")}/z`);
  // Ruling E/VII: /home/<u> with no path segment after it is cut only when it is a held home; /root is never cut.
  await kept(`cd ${unixHome("daved")} and cd /root and cat /root/.bashrc`, undefined, []);
});

test("personal: an email is cut; SSH remotes, noreply trailers, image names and example domains are not", async () => {
  const { text, cut } = await oneCut("mail erin.e@corp-mail.io today");
  assert.equal(text, "mail [redacted:email] today");
  assert.equal(cut.rule, "email");
  assert.equal(cut.restorable, true);
  await kept("git clone git@github.com:org/repo.git");
  await kept("Co-Authored-By: Bot <noreply@anthropic.com>\nCo-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>");
  await kept("![logo](assets/logo@2x.png) and a@b.example.com and pkg react@18.3.1");
});

test("personal: private addresses are cut; loopback, unspecified, public, versions and ranges are not", async () => {
  for (const ip of ["10.1.2.3", "172.20.0.5", "192.168.1.20", "100.100.5.6", "fd12:3456::1", "fe80::1"]) {
    const { text, cut } = await oneCut(`host ${ip} up`);
    assert.equal(text, "host [redacted:private-ip] up");
    assert.equal(cut.kind, "personal");
  }
  await kept("127.0.0.1 and 0.0.0.0 and 8.8.8.8 and 172.32.0.1 and 100.128.0.1");
  await kept("node v10.2.3.4 and version 10.2.3.4 and the range 10.0.0.0/8");
});

test("no entropy-only rule: a random-looking token with no anchor is kept", async () => {
  await kept("the id is Qx7Lm2Pz9Wk4Rt8Yb3Nc6Vd1Hj5Fg0Sa and it is fine");
});

test("count mode: counts and cuts, never text, never a value", async () => {
  const input = `PGPASSWORD=s3cretPgPw ${SK} ${unixHome("alicea")}/x ${HELD}`;
  const out = await scrub(input, { mode: "count", held: [HELD] });
  assert.equal("text" in out, false);
  assert.deepEqual(out.counts, { "secret-assign": 1, "sk-key": 1, "home-path": 1, "held-value": 1 });
  const json = JSON.stringify(out);
  for (const value of ["s3cretPgPw", SK, "alicea", HELD]) assert.ok(!json.includes(value), value);
});

test("cut mode: each cut's span is in the input, and replacing the spans gives the output", async () => {
  const input = `a ${SK} b PGPASSWORD=s3cretPgPw c ${unixHome("alicea")}/x d erin.e@corp-mail.io`;
  const out = await cutOf(input);
  let rebuilt = "";
  let from = 0;
  for (const cut of out.cuts) {
    assert.ok(cut.start >= from && cut.end > cut.start);
    rebuilt += `${input.slice(from, cut.start)}${cut.rule === "home-path" ? "<user>" : `[redacted:${cut.rule}]`}`;
    from = cut.end;
  }
  assert.equal(rebuilt + input.slice(from), out.text);
  assert.ok(!JSON.stringify(out.cuts).includes("s3cretPgPw"));
  assert.deepEqual(out.counts, { "sk-key": 1, "secret-assign": 1, "home-path": 1, email: 1 });
});

test("cut mode fails closed: a rule that throws gives {ok:false} and no text at all", async () => {
  const throwing = { id: "boom", kind: "label", restorable: true, find: () => { throw new Error(`leak ${SK}`); } };
  const out = await scrubWith([...SCRUB_RULES, throwing], `secret ${SK} here`, { mode: "cut" });
  assert.deepEqual(out, { ok: false, counts: {} });
  assert.ok(!JSON.stringify(out).includes(SK));
});

test("count mode does not swallow a throw (a scorer must not read zero for an error)", async () => {
  const throwing = { id: "boom", kind: "label", restorable: true, find: () => { throw new Error("boom"); } };
  await assert.rejects(scrubWith([throwing], "text", { mode: "count" }));
});

test("every cut's restorable follows its kind", async () => {
  const input = [`${SK}`, "PGPASSWORD=s3cretPgPw", `${unixHome("alicea")}/x`, HELD, "$ env", "PATH=/a", "HOME=/b", "SHELL=/c"].join("\n");
  const out = await cutOf(input, [HELD]);
  assert.ok(out.cuts.length >= 5);
  for (const cut of out.cuts) assert.equal(cut.restorable, RESTORABLE[cut.kind], cut.rule);
});

test("adversarial repeats finish (bounded gaps keep each rule linear)", async () => {
  for (const text of ["a@".repeat(50_000), `PG${"PASSWORD"}=`.repeat(20_000), "/home/".repeat(30_000), `${RSA_HEADER}\n`.repeat(5_000), "Authorization: ".repeat(20_000), "mysql -p".repeat(20_000), "10.".repeat(60_000), "fd00:".repeat(40_000), "\\n".repeat(200_000), "\\u001b".repeat(100_000), "C:\\n".repeat(100_000), `${windowsHome("a")}\\t`.repeat(50_000)]) {
    const out = await scrub(text, { mode: "count" });
    assert.ok(out.counts);
  }
});

test("amendment 1a: each cut's outStart/outEnd is its replacement's span in the output; count mode has neither", async () => {
  const input = `a ${SK} b PGPASSWORD=s3cretPgPw c\n$ env\nPATH=/a\nHOME=/b\nSHELL=/c\nend`;
  const out = await cutOf(input);
  for (const cut of out.cuts) {
    const expected = cut.kind === "dump" ? `[redacted:${cut.rule} 3 lines]` : `[redacted:${cut.rule}]`;
    assert.equal(out.text.slice(cut.outStart, cut.outEnd), expected);
  }
  const counted = await scrub(input, { mode: "count" });
  for (const cut of counted.cuts) assert.ok(!("outStart" in cut) && !("outEnd" in cut));
});

test("amendment 1b: keep leaves a restorable cut's text in place, reported kept; it never keeps format, held or dump", async () => {
  const input = `mail erin.e@corp-mail.io key ${SK} held ${HELD} PGPASSWORD=s3cretPgPw\n$ env\nPATH=/a\nHOME=/b\nSHELL=/c`;
  const out = await cutOf(input, [HELD]);
  const all = await scrub(input, { mode: "cut", held: [HELD], keep: () => true });
  assert.equal(all.ok, true);
  assert.ok(all.text.includes("erin.e@corp-mail.io") && all.text.includes("PGPASSWORD=s3cretPgPw"), all.text);
  for (const value of [SK, HELD, "PATH=/a"]) assert.ok(!all.text.includes(value), value);
  assert.equal(all.cuts.length, out.cuts.length);
  for (const cut of all.cuts) {
    assert.equal(cut.kept === true, cut.restorable, cut.rule);
    assert.equal(all.text.slice(cut.outStart, cut.outEnd), cut.kept ? input.slice(cut.start, cut.end) : cut.kind === "dump" ? `[redacted:${cut.rule} 3 lines]` : `[redacted:${cut.rule}]`);
  }
  // keep sees each restorable cut alone and chooses: keep the email, cut the password.
  const asked = [];
  const some = await scrub(input, { mode: "cut", held: [HELD], keep: (cut) => (asked.push(cut.kind), cut.rule === "email") });
  assert.ok(asked.every((kind) => RESTORABLE[kind]), asked.join());
  assert.ok(some.text.includes("erin.e@corp-mail.io") && some.text.includes("PGPASSWORD=[redacted:secret-assign]"), some.text);
});

test("amendment 1b: a keep that throws fails closed", async () => {
  const out = await scrub("mail erin.e@corp-mail.io", { mode: "cut", keep: () => { throw new Error("no"); } });
  assert.deepEqual(out, { ok: false, counts: {} });
});

// ---------- kind by anchor, placeholders, and the contract's amendment 2 rulings

test("SCRUB_RULES: each rule's kind is what anchors its match (a format names itself; a label, a URL's userinfo or parameter, a scheme name the slot)", () => {
  const table = Object.fromEntries(SCRUB_RULES.map((rule) => [rule.id, rule.kind]));
  assert.deepEqual(table, {
    "aws-access-key": "format",
    "google-api-key": "format",
    "private-key-block": "format",
    "github-token": "format",
    "sk-key": "format",
    "slack-token": "format",
    jwt: "format",
    "webhook-secret": "format",
    "url-password": "label",
    "bearer-token": "label",
    "url-credential": "label",
    // Ruling L: vendor keys a public prefix names.
    "huggingface-token": "format",
    "digitalocean-token": "format",
    "pypi-token": "format",
    "sendgrid-key": "format",
    // Ruling LXII a: a PEM block's base64 names itself.
    "base64-pem": "format",
    secretlint: "format",
    "held-value": "held",
    "env-dump": "dump",
    "env-file": "dump",
    "credential-file": "dump",
    "ssh-file": "dump",
    "secret-assign": "label",
    sshpass: "label",
    "mysql-password": "label",
    "password-flag": "label",
    "auth-header": "label",
    "curl-user": "label",
    // Rulings LXI, LXII: a Secret's map, a docker config's key, a connection string's or a query's password key.
    "k8s-secret": "label",
    "docker-auth": "label",
    "connection-string": "label",
    "query-password": "label",
    "home-path": "personal",
    email: "personal",
    "private-ip": "personal",
  });
});

test("url-credential is a label: restorable, and a placeholder in its slot is kept", async () => {
  const { cut } = await oneCut(`GET https://api.example.com/v1?q=x&api_key=${"k7Hq2Zp4W".repeat(3)}`);
  assert.equal(cut.rule, "url-credential");
  assert.equal(cut.kind, "label");
  assert.equal(cut.restorable, true);
  await kept("curl \"https://serpapi.com/search.json?engine=google&q=coffee&api_key=${SERPAPI_API_KEY}\"");
  await kept("GET https://api.example.com/v1?api_key=YOUR_SERPAPI_API_KEY_HERE");
});

/** Each label rule with its value slot (`@`), and a literal it must cut there: a placeholder in the same slot is kept. */
const LABEL_SLOTS = [
  ["secret-assign", "PGPASSWORD=@ psql -h db", "s3cretPgPw"],
  ["secret-assign", `export DB_${"PASSWORD"}="@"`, "hunter2hunter"],
  ["sshpass", "sshpass -p '@' ssh box", "Pa55word!"],
  ["mysql-password", "mysql -u root -p@ shop", "R00tPass"],
  ["password-flag", "psql --password=@ -h db", "pgFlagPw1"],
  ["auth-header", "curl -H 'X-Api-Key: @' https://api.example.com", "plainKeyValue123"],
  ["curl-user", "curl -u admin:@ https://api.example.com", "adminPw99"],
  ["url-credential", "GET https://api.example.com/v1?token=@&page=2", "k7Hq2Zp4Wk7Hq2Zp4W"],
  ["url-password", "postgres://app:@@db.internal:5432/app", "Pg9vLq29vLq2"],
];
/** The placeholder shapes, exactly: a variable, a <slot>, a {{template}}, a trailing ellipsis, YOUR_*, the upper-case
 *  markers, x-runs, *** and a cut already made. */
const PLACEHOLDERS = ["$DB_PASS", "${DB_PASS}", "%DB_PASS%", "<your-password>", "{{db_pass}}", "abc...", "sk-proj-...", "<token>…", "YOUR_DB_PASSWORD_HERE", "your-db-password", "REPLACE_ME", "CHANGEME", "CHANGE_ME", "TODO", "xxx", "xxxxxxxxxxxxxxxxxxxx", "XXXX-XXXX-XXXX", "***", "********", "[redacted]", "[redacted:secret-assign]"];

test("placeholders: every label rule keeps a placeholder in its value slot, and cuts a literal there", async () => {
  for (const [rule, slot, literal] of LABEL_SLOTS) {
    const { cut } = await oneCut(slot.replace("@", literal));
    assert.equal(cut.rule, rule, slot);
    assert.equal(cut.kind, "label", slot);
    for (const placeholder of PLACEHOLDERS) {
      const out = await cutOf(slot.replace("@", placeholder));
      assert.deepEqual(out.cuts.filter((each) => each.kind === "label"), [], `${rule} cut the placeholder ${placeholder} in ${slot}`);
    }
  }
});

test("placeholders: a weak or test password is a value, not a marker (GRAY.md item 4): changeme, hunter2, test are cut", async () => {
  for (const value of ["changeme", "hunter2", "password123", "letmein!"]) {
    const { cut } = await oneCut(`PGPASSWORD=${value} psql`);
    assert.equal(cut.rule, "secret-assign", value);
  }
  // A marker is the upper-case token alone: CHANGEME is kept, changeme (a live default in many images) is cut.
  await kept("PGPASSWORD=CHANGEME psql");
});

test("ruling VII: a home path's user segment is rewritten to <user> for every user (default users too), personal, restorable, counted; /root is not cut", async () => {
  const cases = [
    [`open ${unixHome("alicea")}/proj/x.ts`, `open ${unixHome("<user>")}/proj/x.ts`],
    [`cd ${unixHome("ubuntu")}/work && ls ${unixHome("runner")}/w`, `cd ${unixHome("<user>")}/work && ls ${unixHome("<user>")}/w`],
    [`at ${macHome("bobb")}/Library/a`, `at ${macHome("<user>")}/Library/a`],
    [`dir ${windowsHome("carolc")}\\Desktop`, `dir ${windowsHome("<user>")}\\Desktop`],
  ];
  for (const [input, expected] of cases) {
    const out = await cutOf(input);
    assert.equal(out.text, expected);
    assert.ok(out.cuts.length >= 1);
    for (const cut of out.cuts) {
      assert.equal(cut.rule, "home-path");
      assert.equal(cut.kind, "personal");
      assert.equal(cut.restorable, true);
      assert.equal(out.text.slice(cut.outStart, cut.outEnd), "<user>");
      assert.ok(/^[^\\/]+$/.test(input.slice(cut.start, cut.end)), input.slice(cut.start, cut.end));
    }
    assert.equal(out.counts["home-path"], out.cuts.length);
    const counted = await scrub(input, { mode: "count" });
    assert.equal(counted.counts["home-path"], out.cuts.length);
    const restored = await scrub(input, { mode: "cut", keep: () => true });
    assert.equal(restored.text, input);
  }
  await kept(`User directories are mounted at /home; run ls -la /home/ to see them. Shared files: ${macHome("Shared")}/x. Also /rootfs/a and /var/root.`);
  await kept("cat /root/.bashrc; cd /root/x", undefined, []);
});

test("amendment 2: 100.64.0.0/10 (CGNAT, a tailnet) is personal; its neighbours are not", async () => {
  for (const ip of ["100.64.0.1", "100.100.5.6", "100.127.255.254"]) {
    const { cut } = await oneCut(`peer ${ip} up`);
    assert.equal(cut.rule, "private-ip");
    assert.equal(cut.kind, "personal");
  }
  await kept("peers 100.63.255.254 and 100.128.0.1 up");
});

test("amendment 2: a human's users.noreply.github.com address is personal; a bot's stays", async () => {
  for (const address of ["12345+octo-person@users.noreply.github.com", "octo-person@users.noreply.github.com"]) {
    const { cut } = await oneCut(`Co-authored-by: Octo <${address}>`);
    assert.equal(cut.rule, "email");
    assert.equal(cut.kind, "personal");
  }
  await kept("Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>\nCo-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>\nFrom: GitHub <noreply@github.com>");
});

test("amendment 2: hex after 'key' in fixed tool output or a published vector is never cut; a key-shaped variable's hex is", async () => {
  await kept(`Cache restored from key: Linux-node-${HEX64}`);
  await kept(`Key  = ${"0b".repeat(20)}\nData = 4869205468657265`);
  await kept(`KEY: ${"000102030405060708090a0b0c0d0e0f"}\nPLAINTEXT: 00112233445566778899aabbccddeeff`);
  await kept(`key=${HEX64}`);
  for (const text of [`SECRET_KEY=${HEX64}`, `export API_TOKEN=${HEX64}`]) {
    const { cut } = await oneCut(text);
    assert.equal(cut.rule, "secret-assign");
    assert.equal(cut.kind, "label");
  }
});

test("JSON escapes are boundaries: a value never starts on an escape's letter nor runs through one", async () => {
  await kept(JSON.stringify("origin\tgit@github.com:example-org/widgets.git (fetch)"));
  await kept(JSON.stringify("mysql -u root -p\nEnter password:"));
  await kept(JSON.stringify("a\u001b[0m b\rc"));
  const { cut, text } = await oneCut(JSON.stringify(`line one\nPGPASSWORD=s3cretPgPw\npsql`));
  assert.equal(cut.rule, "secret-assign");
  assert.equal(text, JSON.stringify("line one\nPGPASSWORD=[redacted:secret-assign]\npsql"));
  // An escaped quote ends a bare value; the escaped value inside escaped quotes is cut, its quotes kept.
  assert.equal((await oneCut(JSON.stringify(`DB_${"PASSWORD"}="hunter2hunter" ./run`))).text, JSON.stringify(`DB_${"PASSWORD"}="[redacted:secret-assign]" ./run`));
  // A dump in a JSON string is dropped by its lines, the escaped line breaks around it kept.
  const dump = await oneCut(JSON.stringify(["$ env", "PATH=/usr/bin", "SHELL=/bin/sh", "LANG=C", "$ ls"].join("\n")));
  assert.equal(dump.text, JSON.stringify(["$ env", "[redacted:env-dump 3 lines]", "$ ls"].join("\n")));
});

// ---------- the review's findings (P0 1-4, P1 5-10, P2 11-15) and the TL's rulings A-H, each pinned by behaviour

/** A fixed pseudo-random run of `n` characters of `alpha`: synthetic, the same every run. */
const R = (n, seed = 7, alpha = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789") => {
  let s = "";
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += alpha[x % alpha.length];
  }
  return s;
};
const TOK = R(40);
const SKP = `sk-${"proj"}-${R(48, 9)}`;
/** No cut of `text` leaves any of `secrets`, and the scrub did not fail closed. */
const gone = async (text, secrets, opts = {}) => {
  const out = await scrub(text, { mode: "cut", ...opts });
  assert.equal(out.ok, true, `failed closed on ${JSON.stringify(text.slice(0, 120))}`);
  for (const secret of secrets) assert.ok(!out.text.includes(secret), `${JSON.stringify(secret.slice(0, 12))}… left in ${JSON.stringify(out.text.slice(0, 300))}`);
  return out;
};
/** The text's JSON escapes, each as a span: [start, end). */
const escapesOf = (text) => [...text.matchAll(/\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4})/g)].map((m) => [m.index, m.index + m[0].length]);
const insideEscape = (text, offset) => escapesOf(text).some(([a, b]) => a < offset && offset < b);

test("P0 1 (ruling A): every decoded JSON level up to 3 is read: a key escaped two and three times is cut", async () => {
  const body = `line one\n${SKP}\nSERVICE_TOKEN=${R(16, 3)}\n`;
  for (const text of [JSON.stringify(JSON.stringify(body)), JSON.stringify(JSON.stringify(JSON.stringify(body)))]) {
    const out = await gone(text, [SKP, R(16, 3)]);
    assert.ok(out.cuts.some((cut) => cut.rule === "sk-key") && out.cuts.some((cut) => cut.rule === "secret-assign"), JSON.stringify(out.cuts));
    let parsed = out.text;
    for (let level = 0; level < 2; level++) parsed = JSON.parse(parsed);
  }
  const env = "$ printenv\nHOME=/srv/dev\nPATH=/usr/bin\nINTERNAL_HOST=db7.corp-sample.io\nFOO_PIN=8841203\n";
  const out = await gone(JSON.stringify(JSON.stringify({ stdout: env })), ["8841203", "db7.corp-sample.io"]);
  assert.ok(out.cuts.some((cut) => cut.rule === "env-dump"), JSON.stringify(out.cuts));
});

test("P0 2 (ruling A): a Windows drive path no longer hides what follows it (no DRIVE_PATH exception in a decoded view)", async () => {
  const cases = [
    `{"out":"ComSpec=C:\\\\WINDOWS\\\\system32\\\\cmd.exe\\nOPENAI_API_KEY=${SKP}\\nMY_TOKEN=${TOK}\\nHOMEDRIVE=C:"}`,
    `{"o":"Q:\\n${SKP}"}`,
    `{"o":"a:\\nMY_TOKEN=${TOK}"}`,
    JSON.stringify(`C:\\repo\\notes.txt\n${SKP}\n`),
    JSON.stringify(`C:\\proj> set\nALLUSERSPROFILE=C:\\ProgramData\nMY_TOKEN=${TOK}\nUSERNAME=dev\n`),
  ];
  for (const text of cases) {
    const out = await gone(text, [SKP, TOK]);
    JSON.parse(out.text);
  }
});

test("P0 3 (ruling A): the final check reads every decoded view: a held value only a decoded view shows, in a form no cut finds (full-width letters, NFKC), fails closed, and count mode says blocked", async () => {
  const held = `Hq7${R(20, 11)}`;
  // Each character written as the JSON escape of its full-width form: the raw text holds no letter of it, and the
  // decoded view's full-width text is the held value only after NFKC (valueMatcher's), which no held form is.
  const split = `"v=${[...held].map((c) => `\\u${(c.charCodeAt(0) + 0xfee0).toString(16)}`).join("")}"`;
  assert.deepEqual(await scrub(split, { mode: "cut", held: [held] }), { ok: false, counts: {} });
  assert.equal((await scrub(split, { mode: "count", held: [held] })).blocked, true);
  const twice = JSON.stringify(split);
  assert.deepEqual(await scrub(twice, { mode: "cut", held: [held] }), { ok: false, counts: {} });
});

/** Each unbounded quantifier in a regex's source (`*`, `+`, `{n,}`), outside a character class and not escaped. */
function unboundedIn(source) {
  const out = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "*" || c === "+") out.push(`${c} at ${i}`);
    else if (c === "{" && /^\{\d+,\}/.test(source.slice(i))) out.push(`${/^\{\d+,\}/.exec(source.slice(i))[0]} at ${i}`);
  }
  return out;
}
/** Patterns that may hold an unbounded quantifier, each with why it still reads a text in linear time. */
const UNBOUNDED_ALLOWED = {
  ENV_FILE_LINE: "anchored ^...$ and tested once per line: its .* runs to that line's end and no further",
};

test("P0 4 (ruling B): every rule regex is bounded: no *, + or {n,} outside the allowlist, each allowed one with a reason", () => {
  const problems = [];
  // SECRET_SHAPES (redact/match.ts) are scanners, not regexes: linear by construction, pinned by its own tests.
  assert.ok(SECRET_SHAPES.every((shape) => typeof shape.scan === "function"), "every SECRET_SHAPES entry is a scanner");
  for (const [name, pattern] of Object.entries(RULE_PATTERNS)) {
    assert.ok(pattern instanceof RegExp, name);
    const found = unboundedIn(pattern.source);
    if (found.length && !UNBOUNDED_ALLOWED[name]) problems.push(`${name}: ${found.join(", ")} in /${pattern.source}/`);
  }
  for (const [name, reason] of Object.entries(UNBOUNDED_ALLOWED)) assert.ok(RULE_PATTERNS[name] && reason.length > 20, `allowlist entry ${name} names a pattern and a reason`);
  assert.equal(problems.length, 0, problems.join("\n"));
  // Every module-level regex of the rules is in RULE_PATTERNS, so none escapes the walk.
  const source = readFileSync(new URL("../src/secret-rules.ts", import.meta.url), "utf8");
  const declared = [...source.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*)\s*(?::[^=]{1,80})?=\s*(?:\/|new RegExp\()/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 20, `found ${declared.length} module-level regexes`);
  for (const name of declared) assert.ok(Object.hasOwn(RULE_PATTERNS, name), `${name} is not in RULE_PATTERNS`);
  // No regex literal inside a function body: each is a named module-level constant the walk reads.
  const inline = source.split("\n").filter((line) => /^\s+/.test(line) && /(?:\.(?:test|exec|replace|match|matchAll|split|search)\(\s*\/(?![/*]))|(?:=\s*\/[^/*\s])/.test(line));
  assert.deepEqual(inline, [], "inline regex literals");
});

test("the lexer's regexes are bounded too: each is a module-level literal with no *, + or {n,}", () => {
  const source = readFileSync(new URL("../src/shell-lex.ts", import.meta.url), "utf8");
  const declared = [...source.matchAll(/^const ([A-Z][A-Z0-9_]*) = \/(.{1,200})\/[a-z]{0,4};$/gm)];
  assert.ok(declared.length >= 4, `found ${declared.length} module-level regexes in shell-lex.ts`);
  const problems = declared.flatMap((m) => (unboundedIn(m[2]).length ? [`${m[1]}: ${unboundedIn(m[2]).join(", ")} in /${m[2]}/`] : []));
  assert.equal(problems.length, 0, problems.join("\n"));
  const inline = source.split("\n").filter((line) => /new RegExp\(/.test(line) || (/^\s+/.test(line) && /(?:\.(?:test|exec|replace|match|matchAll|split|search)\(\s*\/(?![/*]))|(?:=\s*\/[^/*\s])/.test(line)));
  assert.deepEqual(inline, [], "inline or built regexes in shell-lex.ts");
});

test("P0 4 (ruling B): adversarial repeats of every rule's start finish in count mode (no timing asserted)", async () => {
  const N = 32 * 1024;
  const rep = (s) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const cases = ["eyJ", "sk-", "Bearer ", "Authorization:", 'A_KEY="', 'A_KEY=\\"', "A_KEY=\\\"a\\", "a@a.", "fc00:", `${RSA_HEADER}\n`, "curl -u ", "mysql -p ", "--password ", "/home/", "a:\\", "\\n", "\\u0041", "A=1\n", "cat .env\n", "://a:", "?token=", "C:\\Users\\", " ", "\n", "password: ", '"token": "', "Cookie: a=", "docker login -p ", "machine x password "];
  for (const piece of cases) {
    const counted = await scrub(rep(piece), { mode: "count" });
    assert.ok(Array.isArray(counted.cuts), piece);
  }
  const blob = await scrub(`eyJ${"a".repeat(8)}.${rep("eyJ")}`, { mode: "count" });
  assert.ok(Array.isArray(blob.cuts));
  const spaces = await scrub(`${" ".repeat(N)}x`, { mode: "cut", path: "/srv/.env" });
  assert.equal(spaces.ok, true);
});

test("P0 4 (ruling B): the time budget wraps the final check too, and fails closed (a fake clock, no wall time)", async () => {
  let clock = 0;
  // A format rule that cuts PLANT; read again in the final check (no PLANT left), it moves the clock past the budget.
  const plant = { id: "plant", kind: "format", restorable: false, find: (text) => {
    const at = text.indexOf("PLANT");
    if (at < 0) clock += 10_000;
    return at < 0 ? [] : [{ start: at, end: at + 5 }];
  } };
  const limits = { budgetMs: 5_000, now: () => clock };
  assert.deepEqual(await scrubWith([plant], "a PLANT b", { mode: "cut" }, limits), { ok: false, counts: {} });
  clock = 0;
  await assert.rejects(scrubWith([plant], "a PLANT b", { mode: "count" }, limits));
  clock = 0;
  const fine = await scrubWith([plant], "a PLANT b", { mode: "cut" }, { budgetMs: 1e12, now: () => clock });
  assert.equal(fine.ok && fine.text, "a [redacted:plant] b");
});

test("P2 15 (ruling B): a text over the chunk limit is read in overlapping chunks, never truncated or skipped", async () => {
  const limits = { maxChars: 4096, overlap: 1024 };
  const filler = (n) => "lorem ipsum dolor ".repeat(Math.ceil(n / 18)).slice(0, n);
  // A key across the first chunk's end, one deep in the last chunk, a held value at the very end.
  const held = `Hq7${R(20, 11)}`;
  const text = `${filler(4096 - 21)} ${SKP} ${filler(9000)} OPENAI=${SKP.replace("proj", "test")} ${filler(3000)} ${held}`;
  const out = await scrubWith(SCRUB_RULES, text, { mode: "cut", held: [held] }, limits);
  assert.equal(out.ok, true);
  for (const secret of [SKP, SKP.replace("proj", "test"), held]) assert.ok(!out.text.includes(secret));
  assert.equal(out.cuts.length, 3, JSON.stringify(out.cuts.map((cut) => cut.rule)));
  const counted = await scrubWith(SCRUB_RULES, text, { mode: "count", held: [held] }, limits);
  assert.deepEqual(counted.counts, out.counts);
});

test("P1 5 (ruling C): every secretlint find is kind format, so keep never restores one (an AWS secret after its name)", async () => {
  const secret = R(40, 21, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+");
  const out = await gone(`aws_secret_access_key = ${secret}`, [secret], { keep: () => true });
  assert.ok(out.cuts.length >= 1);
  for (const cut of out.cuts) assert.equal(cut.restorable, false, cut.rule);
  assert.ok(SCRUB_RULES.filter((rule) => rule.id.startsWith("secretlint")).every((rule) => rule.kind === "format"));
});

test("P1 6 (ruling C): on overlap, kind decides first (held > format > dump > label > personal), then length", async () => {
  const at = (id, kind, start, end) => ({ id, kind, restorable: kind === "label" || kind === "personal", find: () => [{ start, end }] });
  const text = "0123456789abcdefghijklmnopqrstuvwxyz";
  const named = async (...rules) => (await scrubWith(rules, text, { mode: "count" })).cuts.map((cut) => `${cut.rule}:${cut.start}-${cut.end}`);
  assert.deepEqual(await named(at("p", "personal", 0, 30), at("l", "label", 5, 10)), ["l:0-30"]);
  assert.deepEqual(await named(at("l", "label", 0, 30), at("d", "dump", 5, 10)), ["d:0-30"]);
  assert.deepEqual(await named(at("d", "dump", 0, 30), at("f", "format", 5, 10)), ["f:0-30"]);
  assert.deepEqual(await named(at("f", "format", 0, 30), at("h", "held", 5, 10)), ["h:0-30"]);
  assert.deepEqual(await named(at("l1", "label", 0, 8), at("l2", "label", 4, 20)), ["l2:0-20"]);
  // A URL's password is url-password's (label), never an email's; the host stays.
  const pw = R(20, 4);
  const url = await gone(`postgres://app:${pw}@db.corp-sample.io/prod`, [pw]);
  assert.equal(url.text, `${"postgres:"}//app:[redacted:url-password]@db.corp-sample.io/prod`);
  const git = await gone(`${"https:"}//bot:${pw}@git.corp-sample.io`, [pw]);
  assert.deepEqual(git.cuts.map((cut) => cut.rule), ["url-password"]);
});

test("P1 7 (ruling D): a placeholder is a whole-value shape: a trailing ellipsis is stripped and the rest judged", async () => {
  await gone(`curl -H "Authorization: Bearer ${TOK}..."`, [TOK]);
  await gone(`the header is Bearer ${TOK}...`, [TOK]);
  await gone(`PGPASSWORD=${TOK}… psql`, [TOK]);
  await gone(`tool --password ${TOK}...`, [TOK]);
  for (const text of ["API_KEY=abc... ./run", "OPENAI_API_KEY=sk-proj-... ./run", "export ANTHROPIC_API_KEY=sk-ant-...", "Authorization: Bearer <token>…"]) await kept(text);
});

test("P1 8 (ruling D): metavars, type words and code expressions are no value; mysql -p word is a database; _FILE names are no secret", async () => {
  for (const text of [
    "interface Req { Authorization: string; }\nconst h = { Authorization: getAuthHeader() };",
    "def handler(Authorization: Optional[str] = Header(None)):",
    "Set the Authorization: header before sending.",
    `type Headers = { Authorization: string; "X-Api-Key"?: string }`,
    "axios.get(url, { headers: { Authorization: authHeader } })",
    "Pass the token in the Authorization: header, e.g. Authorization: Bearer <token>.",
    `tokenizer = AutoTokenizer.from_pretrained(name, token=hf_token)\nmodel(max_tokens=1024, password_file="pw.txt")`,
    "  --token TOKEN        GitHub token to use\n  --password PASSWORD  the password\n  --api-key KEY        your key",
    "  --password string   Password for the registry\n  --token-file path   read token",
    "mysql -u root -p shopdb < schema.sql\nmysqldump -u root -p inventory > out.sql",
    `mysql -u root -p app_development -e "show tables"`,
    "SSL_KEY_FILE=/etc/ssl/k.pem TOKEN_PATH=/run/secrets/t CREDENTIALS_DIR=/srv/creds ./run",
    "password: str\napi_key: SecretStr\ntoken: Optional[str] = None",
  ]) await kept(text);
  // A literal is still cut beside the same labels.
  await gone(`curl -H 'X-Api-Key: ${R(24, 5)}' https://api.corp-sample.io`, [R(24, 5)]);
  await gone("mysql -u root -pR00tPass99 shop", ["R00tPass99"]);
});

test("P1 8 (rulings E, VII): /home/<u> is cut only before another path segment or as a held home, /root never; /Users and C:\\Users always", async () => {
  await kept(`<Route path="/home/settings" element={<Settings/>} />\nnavigate("/home/feed")`, undefined, []);
  await kept(`cd /home/dana and "/root" and ls /home/ and cat /root/.cache/pip`, undefined, []);
  for (const [input, expected] of [[`open /${"ho"}me/dana/x.ts`, `open /${"ho"}me/<user>/x.ts`], ["at /Users/dana and C:\\Users\\dana", "at /Users/<user> and C:\\Users\\<user>"]]) {
    assert.equal((await cutOf(input, undefined, [])).text, expected);
  }
  // A held home is cut bare too (ruling VII: /root never).
  assert.equal((await cutOf("cd /home/dana; ls /root", undefined, ["/home/dana", "/root"])).text, "cd /home/<user>; ls /root");
});

test("P1 8 (ruling G): a 3-line script is no env dump; ssh-keyscan's public host keys are not cut", async () => {
  await kept("HOME=/tmp/h\nPATH=/usr/bin:/bin\nCI=true\nnpm test");
  await kept(`$ ssh-keyscan github.com\ngithub.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"OMqqnkVzrm0SdG6UOoqKLs".repeat(2)}`);
});

test("P1 9 (ruling A): a cut never starts or ends inside an escape: a cut JSON string stays valid JSON", async () => {
  for (const value of [{ o: "C:\\proj\nbob.lee@corp-sample.io\n10.1.2.3" }, { o: `C:\\proj\tAPI_TOKEN="${R(16, 6)}"` }, { o: `C:\\x\\home\n/${"ho"}me/alice/p` }, { o: `x\u00e9\n${SKP}\n\u{1F600} /${"ho"}me/alice/q` }]) {
    const text = JSON.stringify(value);
    const out = await cutOf(text);
    JSON.parse(out.text);
    for (const cut of out.cuts) {
      assert.ok(!insideEscape(text, cut.start) && !insideEscape(text, cut.end), `${cut.rule} ${cut.start}-${cut.end} splits an escape of ${text}`);
    }
    assert.ok(!out.text.includes("bob.lee") && !out.text.includes("alice") && !out.text.includes(SKP), out.text);
  }
});

test("P1 10 (ruling F): a held value is searched in the raw text too (a held value holding a backslash), and count mode reports blocked as cut fails", async () => {
  const held = `ab\\nCD${R(12, 3)}`;
  for (const text of [`pass=${held} end`, `the value ${held} end`]) {
    const out = await gone(text, [held], { held: [held] });
    assert.deepEqual(out.cuts.map((cut) => cut.rule), ["held-value"]);
    const counted = await scrub(text, { mode: "count", held: [held] });
    assert.deepEqual(counted.counts, { "held-value": 1 });
    assert.equal(counted.blocked, false);
  }
  const split = `v=${partlyEncoded(held)}`;
  assert.equal((await scrub(split, { mode: "cut", held: [held] })).ok, false);
  assert.equal((await scrub(split, { mode: "count", held: [held] })).blocked, true);
  assert.equal((await scrub(`plain ${SKP}`, { mode: "count" })).blocked, false);
});

test("P2 11 (ruling G): secret-assign reads name: value, \"name\": \"value\" and name = \"value\" when the name is key-shaped", async () => {
  await gone(`database:\n  host: db.corp.lan\n  password: ${TOK}\n`, [TOK]);
  await gone(JSON.stringify({ user: "svc", password: TOK, client_secret: R(32, 2) }), [TOK, R(32, 2)]);
  await gone(`api_key = "${TOK}"\n`, [TOK]);
  await gone(`[default]\naws_secret_access_key = ${R(40, 8)}\n`, [R(40, 8)]);
  await gone(`environment:\n  POSTGRES_PASSWORD: ${TOK}\n  API_TOKEN: ${R(30, 2)}\n`, [TOK, R(30, 2)]);
  await gone(`users:\n- name: admin\n  user:\n    token: ${R(32, 4)}`, [R(32, 4)]);
  // Not a key-shaped name, a bare `key`, or a value in prose: kept.
  await kept("host: db.corp.lan\nkey: database-password\nKEY: 000102030405060708090a0b0c0d0e0f");
});

test("P2 11 (ruling G): auth-header covers Cookie, Set-Cookie, X-Api-Key, X-Auth-*, Proxy-Authorization, and JSON header objects", async () => {
  await gone(`{"headers":{"Authorization":"Bearer ${TOK}","Cookie":"session=${R(32, 2)}"}}`, [TOK, R(32, 2)]);
  await gone(`curl -H 'Cookie: sessionid=${R(32, 2)}; csrftoken=${R(32, 3)}' https://app.corp-sample.io/api`, [R(32, 2), R(32, 3)]);
  await gone(`HTTP/1.1 200 OK\r\nSet-Cookie: sid=${R(32, 4)}; Path=/; HttpOnly\r\n`, [R(32, 4)]);
  await gone(`+ curl -sS -H 'X-Auth-Key: ${R(16, 5)}' https://api.corp-sample.io`, [R(16, 5)]);
  await gone(`Proxy-Authorization: Basic ${R(24, 6)}`, [R(24, 6)]);
});

test("P2 11 (ruling G): password-flag covers docker login -p, redis-cli -a and openssl pass:", async () => {
  await gone(`docker login -u bot -p ${TOK} registry.corp-sample.io`, [TOK]);
  await gone(`redis-cli -h cache -a ${TOK} ping`, [TOK]);
  await gone(`openssl rsa -in k.pem -passin pass:${TOK}`, [TOK]);
  await gone(`machine api.corp-sample.io login bot password ${R(16, 7)}`, [R(16, 7)]);
  await kept("docker run -p 8080:80 app && redis-cli -h cache ping && openssl rsa -in k.pem -passin env:PASS");
});

test("P2 12 (ruling G): env dumps with their command (any length, line numbers allowed), printenv NAME, and credential files read are dumps", async () => {
  await gone(`$ printenv MY_SERVICE_TOKEN\n${TOK}\n`, [TOK]);
  await gone(`$ printenv\nMY_SERVICE_TOKEN=${TOK}\nDB_HOST=prod-db.corp.lan\n`, [TOK, "prod-db.corp.lan"]);
  const numbered = ["$ env", ...["PATH=/usr/bin", "LANG=C", `FOO_PIN=${R(12, 2)}`].map((line, i) => `${String(i + 1).padStart(6)}→${line}`)].join("\n");
  const out = await gone(numbered, [R(12, 2)]);
  assert.deepEqual(out.cuts.map((cut) => cut.rule), ["env-dump"]);
  for (const [path, body] of [["~/.netrc", `machine h login u password ${R(16, 3)}`], ["~/.pgpass", `db.corp-sample.io:5432:prod:app:${R(16, 3)}`], ["~/.docker/config.json", `{"auths":{"registry.corp-sample.io":{"auth":"${R(28, 3)}"}}}`], ["~/.kube/config", `users:\n- name: admin\n  user:\n    client-key-data: ${R(28, 3)}`], ["~/.ssh/known_hosts", `h1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${R(43, 3)}`]]) {
    const read = await gone(`$ cat ${path}\n${body}\n$ ls`, [R(16, 3)]);
    assert.ok(read.cuts.some((cut) => cut.kind === "dump"), `${path}: ${JSON.stringify(read.cuts)}`);
    assert.ok(read.text.endsWith("\n$ ls"), read.text);
    const whole = await scrub(body, { mode: "cut", path: path.replace("~", "/srv/u") });
    assert.equal(whole.ok && whole.cuts.length === 1 && whole.cuts[0].kind, "dump", path);
  }
});

test("item 1: only RFC 2606/6761 test names are exempt from the email rule: .internal and .local addresses are personal", async () => {
  for (const address of ["jane@corp.internal", "x@host.local"]) {
    const { cut } = await oneCut(`mail ${address} now`);
    assert.equal(cut.rule, "email");
  }
  await kept("x@example.com and y@foo.test and z@a.example.org and w@box.invalid and v@my.localhost");
});

// ---------- the fp-sweep rulings (FIXES-scrubber.md I-IX), each pinned by behaviour; their shapes are in the negatives
// corpus too (fixtures/scrub-negatives/sweep-shapes.txt)

test("I (name grammar): the credential word is the name's last segment, and a bare key needs a qualifier", async () => {
  for (const name of ["STRIPE_SECRET_KEY", "OPENAI_API_KEY", "SECRET_KEY", "MASTER_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "MYSQL_PWD", "PGPASSWORD", "JWT_SECRET", "SENTRY_DSN", "GITHUB_PAT", "DB_PASS", "CLIENT_CREDENTIALS"]) {
    await gone(`${name}=${TOK}`, [TOK]);
  }
  for (const text of [`apiKey: "${TOK}"`, `client_secret = "${TOK}"`, `"accessToken": "${TOK}"`, `private_key: "${TOK}"`]) await gone(text, [TOK]);
  for (const text of [
    `TOKEN_TYPE=${TOK}`,
    `GIT_CONFIG_KEY_0=${TOK}`,
    `SECRET_NAME=${TOK}`,
    `cache_key = "orders:recent:v2"`,
    `sort_key="created_at"`,
    `KEY_PREFIX="${TOK}"`,
    `SSH_KEY_FILE=/srv/k`,
    `token_type: "Bearer"`,
    `foreign_key="widget_run.id"`,
  ]) await kept(text);
});

test("II (value grammar): references, secret-manager schemes, elided values and punctuation are no value", async () => {
  for (const text of [
    `export WIDGET_API_KEY="${"$"}(pass show widgets/api)"`,
    "export ACCESS_TOKEN=\"${ACCESS_TOKEN:-}\"",
    "export SERVICE_TOKEN=`vault-read -q WIDGETS_KEY`",
    `curl -H "Authorization: Bearer $KEY:$SID" https://api.corp-sample.io`,
    "DB_PASSWORD=op://Infra/widgets-db/password",
    `STRIPE_SECRET_KEY="op://Payments/stripe-live/credential"`,
    "DB_PASSWORD=vault:secret/data/widgets#password",
    "DB_PASSWORD=arn:aws:secretsmanager:us-east-1:123456789012:secret:widgets-db",
    "DB_PASSWORD=projects/widgets/secrets/db-password/versions/3",
    "API_TOKEN: ${{ secrets.API_TOKEN }}",
    "WIDGETS_API_KEY=wk_live_<redacted>",
    "WIDGETS_API_KEY=wk_live_ab…yz ./run",
    "sshpass -p •••• ssh box",
    "DB_PASSWORD=***abc ./run",
    "TOKEN=ab[redacted:held-value]cd ./run",
    "Labels: PGPASSWORD=, sshpass -p, mysql -p, --password ... are restorable.",
    "lower-case names: WIDGET_API_KEY=..., BOX_SESSION_TOKEN=...",
    'return f"postgresql+asyncpg://{self.user}:{self.password}@{self.host}:{self.port}/{self.dbname}"',
    "const dsn = `mysql://${cfg.user}:${cfg.pass}@${cfg.host}/widgets`;",
  ]) await kept(text);
  // A value with trailing punctuation, a full value before a trailing ellipsis (ruling D), a quoted value however it
  // starts: still cut.
  await gone(`DB_PASSWORD=${TOK}.`, [TOK]);
  await gone(`PGPASSWORD=${TOK}… psql`, [TOK]);
  await gone(`DB_PASSWORD="!${TOK}"`, [TOK]);
  await gone("mysql -uroot -proot shop", ["-proot"]);
});

test("III (code context): a header name used as a code key cuts only a string literal", async () => {
  for (const text of [
    "seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });",
    'headers = {"Authorization": authorization} if authorization else {}',
    'return { headers: { "x-api-key": got.key }, ...(query ? { query } : {}) };',
    '"headers": {"x-api-key": os.environ["WIDGETS_MCP_KEY"]},',
  ]) await kept(text);
  await gone(`headers = {"Authorization": "Token ${TOK}"}`, [TOK]);
  await gone(`fetch(u, { headers: { "x-api-key": "${TOK}" } })`, [TOK]);
  await gone(`X-Api-Key: ${TOK}\nAccept: */*`, [TOK]);
  await gone(`curl -H 'x-api-key: ${TOK}' https://api.corp-sample.io`, [TOK]);
});

test("IV (format prefixes): a known prefix inside a longer base64 run is no key; a key standing alone or after = is", async () => {
  const run = (n, seed) => R(n, seed, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
  const google = `AI${"za"}Sy${R(33, 5, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")}`;
  const aws = `AK${"IA"}${R(16, 6, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`;
  for (const inner of [google, aws, SKP, `gh${"p_"}${R(36, 7, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")}`]) {
    await kept(`data:image/png;base64,${run(60, 1)}${inner}${run(60, 2)}=`);
    await gone(`key ${inner} here`, [inner]);
    const assigned = await gone(`MAPS=${inner}\n`, [inner]);
    assert.equal(assigned.cuts[0].kind, "format", inner.slice(0, 4));
  }
});

test("V, XXV (private-key-block): a BEGIN line with no body is no key; with a base64 line after it it is, END or not", async () => {
  await kept(`if (line.startsWith("${RSA_HEADER}")) return "pem";`);
  await kept(`const huge = \`\${"${RSA_HEADER}\\n".repeat(5_000)}\`;`);
  // A base64 line of 40 characters after the BEGIN line is a key cut short (ruling XXV, which supersedes this test's
  // 64-character floor for a block read line by line).
  await gone(`${RSA_HEADER}\n${R(40, 3)}\n`, [R(40, 3)]);
  const body = R(64, 4, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
  const out = await gone(`${RSA_HEADER}\n${body}\n`, [body]);
  assert.deepEqual(out.cuts.map((cut) => cut.rule), ["private-key-block"]);
});

test("VI (email): an address on a trailer line naming a [bot] identity stays; a person's is cut", async () => {
  await kept("Signed-off-by: lintbot[bot] <support@forgehub-widgets.io>\nCo-authored-by: depbump[bot] <noreply@forgehub-widgets.io>");
  await gone("Signed-off-by: Dana Lee <dana.lee@corp-sample.io>", ["dana.lee@corp-sample.io"]);
});

test("VII (home paths): only the user segment is rewritten to <user>; a Claude project slug's user too, when held or under .claude/projects/", async () => {
  const cases = [
    ["ls ~/.claude/projects/-home-dana-worktrees-x/abc.jsonl", "ls ~/.claude/projects/-home-<user>-worktrees-x/abc.jsonl", []],
    ["see -Users-dana-proj in the list", "see -Users-<user>-proj in the list", ["/Users/dana"]],
    ["cd /home/dana", "cd /home/<user>", ["/home/dana"]],
  ];
  for (const [input, expected, homes] of cases) {
    const out = await cutOf(input, undefined, homes);
    assert.equal(out.text, expected);
    assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["home-path", "personal", true]]);
  }
  await kept("see -home-dana-proj and the route /home/settings and /root/.cache", undefined, []);
});

test("VIII (idempotence): every positive cut once is clean: scrub(cut(x)) makes no cut, and cut(cut(x)) == cut(x)", async () => {
  const { POSITIVES } = await import("./scrub-positives.mjs");
  const problems = [];
  for (const p of POSITIVES) {
    for (const text of [p.text, JSON.stringify(p.text)]) {
      const once = await scrub(text, { mode: "cut", held: p.held });
      if (!once.ok) {
        problems.push(`${p.id}: failed closed`);
        continue;
      }
      const counted = await scrub(once.text, { mode: "count", held: p.held });
      if (counted.cuts.length || counted.blocked) problems.push(`${p.id}: cut again ${JSON.stringify(counted.cuts.map((cut) => `${cut.rule} ${once.text.slice(cut.start, cut.end)}`))}`);
      const twice = await scrub(once.text, { mode: "cut", held: p.held });
      if (!twice.ok || twice.text !== once.text) problems.push(`${p.id}: cut(cut(x)) != cut(x)`);
    }
  }
  assert.deepEqual(problems, []);
});

// ---------- re-review round 2 (FIXES-scrubber.md rulings X-XV; repros work/review/q1-q5.mjs, values invented here)

const UPPER32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const JWT_LIVE = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "u-1842", exp: 2000000000, scope: "admin" })}.${R(43, 21)}`;

test("X (N1): a known prefix's boundary is its own alphabet's: a key in a URL or file path, after SLACK_ or a lone +, is cut", async () => {
  const ghp = `ghp_${R(36, 5)}`;
  const xoxb = `xoxb-${R(12, 3, "0123456789")}-${R(24, 4)}`;
  const akia = `AKIA${R(16, 6, UPPER32)}`;
  const skAnt = `sk-${"ant"}-api03-${R(80, 8)}`;
  const cases = [
    [`curl https://proxy.corp-sample.io/${ghp}/repos`, ghp],
    [`GET https://api.corp-sample.io/v1/${SKP}/status`, SKP],
    [`saved to /tmp/keys/${SKP}`, SKP],
    [`${SKP}/`, SKP],
    // `+` is no base64url character: for sk- and ghp_ it is a boundary even right after a letter.
    [`x+${SKP}`, SKP],
    [`q+${ghp}`, ghp],
    [`SLACK_${xoxb}`, xoxb],
    [`"key="+${akia}`, akia],
    [`s3://bucket/${akia}`, akia],
    [`/v1/${skAnt}`, skAnt],
    [`open https://app.corp-sample.io/auth/magic/${JWT_LIVE}`, JWT_LIVE],
    [`https://app.corp-sample.io/invite/${JWT_LIVE}/accept`, JWT_LIVE],
    [`"+${JWT_LIVE}`, JWT_LIVE],
  ];
  for (const [text, secret] of cases) {
    for (const form of [text, JSON.stringify(text)]) {
      const out = await gone(form, [secret, secret.slice(-16)]);
      assert.ok(out.cuts.every((cut) => cut.kind === "format"), JSON.stringify(out.cuts));
      assert.equal((await scrub(form, { mode: "count" })).blocked, false);
    }
  }
});

test("XI: a key's run is cut whole to its end at any length: redact/match.ts reads a shape's run once, with no bound (a run past 16384 failed closed before #3622's scanners)", async () => {
  const long = `sk-${R(20_000, 3)}`;
  const out = await gone(`k ${long} end`, [long.slice(3, 40), long.slice(-40)]);
  assert.equal(out.text, "k [redacted:sk-key] end");
  const ghp = `ghp_${R(36, 5)}_${R(20, 6)}`;
  assert.equal((await gone(`t ${ghp} u`, [ghp.slice(-20)])).text, "t [redacted:github-token] u");
  const huge = `sk-${R(70_000, 4)}`;
  const cut = await gone(`k ${huge} end`, [huge.slice(3, 40), huge.slice(-40)]);
  assert.equal(cut.text, "k [redacted:sk-key] end");
  // No byte of the key is left: not one 8-character window of its run stands in the output.
  for (let at = 3; at + 8 <= huge.length; at += 997) assert.ok(!cut.text.includes(huge.slice(at, at + 8)), `window at ${at}`);
  // 2 MB of one key's run is cut whole, read once: CPU time, the scanner is linear.
  const run = `sk-${"Tq7Wm2Rk9Zx".repeat(Math.ceil(2_000_000 / 11))}`;
  const before = process.cpuUsage();
  const big = await scrub(`k ${run} end`, { mode: "cut" });
  const used = process.cpuUsage(before);
  const ms = (used.user + used.system) / 1000;
  assert.equal(big.ok, true);
  assert.equal(big.text, "k [redacted:sk-key] end");
  assert.ok(ms < 2_000, `2 MB sk- run: ${Math.round(ms)} ms CPU`);
});

test("XII (N2): code shapes are no value in code alone; after UPPER_NAME=, a YAML key at a line's start or a flag, a real-shaped password is cut", async () => {
  const b64 = R(40, 13, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
  const letters = R(32, 14, LETTERS);
  const cases = [
    ["SuperSecretPassword", "export PGPASSWORD=SuperSecretPassword"],
    ["myPassword", "DB_PASSWORD=myPassword"],
    ["hunter_two", "ADMIN_PASSWORD=hunter_two"],
    [letters, `export API_TOKEN=${letters}`],
    [`+${b64}=`, `DB_PASSWORD=+${b64}=`],
    [`/${b64}=`, `DB_PASSWORD=/${b64}=`],
    [`/${b64}=`, `password: /${b64}=`],
    ["!Qz8vT2pLw", "password: !Qz8vT2pLw"],
    ["-Xy8Kp2Lm9Qr", "REDIS_PASSWORD=-Xy8Kp2Lm9Qr"],
    ["Summer_Time_Rain", "--password Summer_Time_Rain"],
    ["MyRegistryPass", "docker login -u bot -p MyRegistryPass registry.corp-sample.io"],
    ["correct.horse.battery.staple", "SECRET_KEY=correct.horse.battery.staple"],
  ];
  for (const [value, text] of cases) {
    const out = await gone(text, [value]);
    assert.ok(out.cuts.length >= 1 && out.cuts.every((cut) => cut.kind === "label"), `${text}: ${JSON.stringify(out.cuts)}`);
  }
  // Code stays code: a call, a member chain, a name in code's casing, where code puts a value.
  for (const text of [
    "client = Client(api_key=settings.api_key)",
    "password = config.password",
    "API_TOKEN=get_token()",
    "connect(password=db_password)",
    'headers = {"Authorization": authorization}',
  ]) await kept(text);
  // YAML's own shapes after a key are no value: a tag, an alias, a block indicator, an anchor, null and ~.
  for (const text of ["password: !Ref DbPassword", "password: !Sub", "db_password: !vault |", "password: |", "api_token: >-", "password: *db_pw", "password: &db_pw", "api_secret: ~", "smtp_password: null"]) await kept(text);
});

test("XIII: a drive path's separator is never cut: C:\\Users\\<user> keeps its backslash; the \\n before an email in raw JSON is kept", async () => {
  for (const user of ["bob", "nina", "tom", "frank", "rachel", "ub01"]) {
    assert.equal((await cutOf(`C:\\Users\\${user}\\proj`, undefined, [])).text, "C:\\Users\\<user>\\proj");
  }
  assert.equal((await cutOf(JSON.stringify({ p: "C:\\Users\\bob\\proj" }), undefined, [])).text, JSON.stringify({ p: "C:\\Users\\<user>\\proj" }));
  const raw = JSON.stringify({ o: "C:\\proj\nbob.lee@corp-sample.io\n10.1.2.3" });
  const out = await cutOf(raw);
  assert.equal(out.text, JSON.stringify({ o: "C:\\proj\n[redacted:email]\n[redacted:private-ip]" }));
});

test("XIV: a held value split by a blank is cut whole, whatever label cut overlaps it", async () => {
  const held = `Hq7${R(20, 11)}`;
  for (const text of [`MY_TOKEN=${held.slice(0, 12)} ${held.slice(12)}`, `v=${held.slice(0, 10)}\n${held.slice(10)}`, JSON.stringify(`v=${held.slice(0, 10)}\n${held.slice(10)}`)]) {
    const out = await gone(text, [held.slice(0, 10), held.slice(12)], { held: [held] });
    assert.ok(out.cuts.some((cut) => cut.kind === "held"), JSON.stringify(out.cuts));
    assert.equal((await scrub(text, { mode: "count", held: [held] })).blocked, false);
  }
});

test("XV: a chunk never starts inside an escape: a hit right after an escape split by the chunk start keeps the escape whole", async () => {
  const limits = { maxChars: 4096, overlap: 1024 };
  // The second chunk starts at 3072: put the escape's backslash at 3071 and its letter at 3072.
  for (const at of [3070, 3071, 3072]) {
    const body = `${"a ".repeat(4096).slice(0, at - 1)}\nbob.lee@corp-sample.io\n${"b ".repeat(3000)}`;
    const text = JSON.stringify(body);
    const out = await scrubWith(SCRUB_RULES, text, { mode: "cut" }, limits);
    assert.equal(out.ok, true);
    assert.ok(!out.text.includes("bob.lee@"), out.text.slice(at - 20, at + 40));
    assert.equal(JSON.parse(out.text).includes("\n[redacted:email]\n"), true);
  }
});

// ---------- round 3 (FIXES-scrubber.md rulings XVI-XXV, fp-sweep's provisional confirm; values invented here)

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

test("XVI: in a YAML key's slot a PascalCase value is a type only with a type's suffix; any other is a value", async () => {
  for (const [value, text] of [["SuperSecretPassword", "password: SuperSecretPassword"], ["MyPassword123", "password: MyPassword123"], ["WinterIsComing", "  db_password: WinterIsComing"]]) {
    const out = await gone(text, [value]);
    assert.deepEqual(out.cuts.map((cut) => cut.kind), ["label"], text);
  }
  for (const text of ["api_key: SecretStr", "    token: WidgetSettings", "    password: PasswordType", "    api_secret: OptionalAny", "    secret: WidgetToken | None"]) await kept(text);
});

test("XVII, XVIII: an email's local part starts and ends with a letter or digit; a call, a systemd unit, a role address is none; a blanked escape's letter is never its first", async () => {
  for (const text of [
    "+@router.post(WIDGETS_PATH)",
    "4021-@pytest.mark.parametrize(",
    "LIKE '%@corp-sample.io%'",
    "systemctl status getty@tty1.service",
    "user.slice/user@1001.service/app.slice",
    "x.y@widgets.build(arg)",
    "postmaster@corp-sample.io",
    "mailer-daemon@corp-sample.io",
    "git@forgehub.io:widgets/app.git",
    '"remote:\\\\tgit@forgehub.io:widgets/app.git"',
  ]) await kept(text);
  for (const text of ["mail jane.doe@corp-sample.io now", "a+b@corp-sample.io", "x_9@corp-sample.io", "ops@corp-sample.io (pager)"]) {
    assert.ok((await cutOf(text)).cuts.some((cut) => cut.rule === "email"), text);
  }
  // A JSON-escaped escape (`\\t`, `\\u0009`) before an address: the letter is the escape's, never the local part's.
  assert.equal((await cutOf('"to:\\\\tjane.doe@corp-sample.io"')).text, '"to:\\\\t[redacted:email]"');
  assert.equal((await cutOf('"to:\\\\u0009jane.doe@corp-sample.io"')).text, '"to:\\\\u0009[redacted:email]"');
  assert.equal((await cutOf(JSON.stringify("to:\tjane.doe@corp-sample.io"))).text, JSON.stringify("to:\t[redacted:email]"));
});

test("XIX: in code a value equal to its own name is a name; after UPPER_NAME=, a YAML key or a flag it is still a weak password", async () => {
  const word = `${"pass"}word`;
  for (const text of ['    API_KEY = "api_key"', '    SESSION_TOKEN = "session-token"', `const auth = { ${word}: "${word.toUpperCase()}" };`]) await kept(text);
  for (const [text, out] of [
    [`DB_PASSWORD=${word}`, "DB_PASSWORD=[redacted:secret-assign]"],
    [`${word}: ${word}`, `${word}: [redacted:secret-assign]`],
    [`--${word} ${word}`, `--${word} [redacted:password-flag]`],
    ["export API_TOKEN=api_token", "export API_TOKEN=[redacted:secret-assign]"],
  ]) assert.equal((await cutOf(text)).text, out);
});

test("XX, XXII: bare credentials and bare pass are no credential word; a qualified one is", async () => {
  for (const text of ['const res = await fetch(url, { cache: "no-store", credentials: "omit" });', 'fetch("/api/widgets", { credentials: "same-origin" })', '| 1c | PASS: "Proxy refused the connection" |', "PASS=all_green_here"]) await kept(text);
  const v = R(20, 31);
  for (const text of [`AWS_CREDENTIALS=${v}`, `"db_credentials": "${v}"`, `DB_PASS=${v}`, `SMTP_PASS: ${v}`, `SSHPASS=${v}`, `smtpPass: "${v}"`]) await gone(text, [v]);
});

test("XXI: in code an unquoted identifier before , ) or } is a reference; in a config's slot it is a value", async () => {
  for (const text of ["\t\tWIDGET_ATTACH_TOKEN: token,", "  return { api_secret: apiSecret }", "client = WidgetClient(api_key=api_key, timeout=30)"]) await kept(text);
  const v = R(20, 32);
  for (const text of [`API_TOKEN: ${v}`, `password: ${v}`, `DB_PASSWORD=${v}`]) await gone(text, [v]);
});

test("XXIII: a cookie whose values are expansions or placeholders is none; one with a value is cut", async () => {
  for (const text of ['S=(-H "cookie: __Host-widget-session=$SESSION" -H "origin: $BASE")', "curl -H 'Cookie: sid=${SID}; csrftoken=$(cat .csrf)' https://app.corp-sample.io"]) await kept(text);
  const v = R(24, 33);
  await gone(`curl -H 'Cookie: session=${v}' https://app.corp-sample.io`, [v]);
  await gone(`curl -H 'Cookie: sid=$SID; session=${v}' https://app.corp-sample.io`, [v]);
});

test("XXIV: curl's argv ends at ; | && || $( a backtick or a line's end: -u after it is another command's", async () => {
  for (const text of [
    "code=$(curl -s -o /dev/null -w '%{http_code}' https://widgets.example/health); echo \"$(date -u +%H:%M) $code\"",
    "curl -s https://widgets.example/v | jq -r .v && date -u +%FT%H:%M",
    "curl -s https://widgets.example/v || date -u +%s",
    "curl -sI https://widgets.example $(date -u +%s)",
  ]) await kept(text);
  const v = R(16, 34);
  await gone(`curl -u bot:${v} https://api.corp-sample.io`, [v]);
  await gone(`curl -s \\\n  -u bot:${v} https://api.corp-sample.io`, [v]);
  await gone(`cd /tmp; curl -fsS -u bot:${v} https://api.corp-sample.io | jq .`, [v]);
});

test("XXV: a BEGIN line and one base64 body line or more is a key, cut to its END or its body's end; a lone BEGIN line is none", async () => {
  const B = `-----BEGIN ${"RSA"} PRIVATE KEY-----`;
  const E = `-----END ${"RSA"} PRIVATE KEY-----`;
  const body = [R(64, 41, BASE64), R(64, 42, BASE64), R(40, 43, BASE64)];
  const lines = (prefix, list) => list.map((line, i) => `${prefix(i + 1)}${line}`).join("\n");
  const cases = [
    [[B, body[0]].join("\n"), ""],
    [[B, body[2]].join("\n"), ""],
    [[B, ...body].join("\n"), "\n$ ls\nkey.pem"],
    [lines((n) => `${String(n).padStart(6)}→`, [B, ...body]), "\n     5→"],
    [lines((n) => `${String(n).padStart(6)}→`, [B, ...body, E]), "\n     6→after"],
    [lines((n) => `${String(n).padStart(6)}\t`, [B, ...body]), ""],
    [lines((n) => `key.pem:${n}:`, [B, ...body]), "\nother.txt:1:plain"],
    [lines(() => "+", [B, ...body]), "\n+"],
  ];
  for (const [key, after] of cases) {
    for (const text of [`${key}${after}`, JSON.stringify(`${key}${after}`)]) {
      const out = await gone(text, body.map((line) => line.slice(0, 24)));
      assert.ok(out.cuts.some((cut) => cut.rule === "private-key-block"), text.slice(0, 80));
      if (text.startsWith("\"")) continue;
      assert.ok(out.text.endsWith(after), `${JSON.stringify(after)} kept after the key: ${JSON.stringify(out.text.slice(-60))}`);
    }
  }
  for (const text of [B, `${B}\nconst x = 1;`, `${B}\n${E}`, `if (line.startsWith("${B}")) return "pem";`]) await kept(text);
});

test("url-password: a literal DSN's password is cut, an empty user's too; an interpolated one is none", async () => {
  const cases = [
    [`${"postgres:"}//app:devpass@localhost/db`, `${"postgres:"}//app:[redacted:url-password]@localhost/db`],
    [`${"mysql:"}//root:root@127.0.0.1`, `${"mysql:"}//root:[redacted:url-password]@127.0.0.1`],
    [`engine = create_engine("${"postgresql:"}//app:devpass@localhost:5432/app")`, `engine = create_engine("${"postgresql:"}//app:[redacted:url-password]@localhost:5432/app")`],
    [`DATABASE_URL=${"postgres:"}//app:devpass@db:5432/app`, `DATABASE_URL=${"postgres:"}//app:[redacted:url-password]@db:5432/app`],
    [`REDIS_URL=${"redis:"}//:s3cretpw@cache:6379/0`, `REDIS_URL=${"redis:"}//:[redacted:url-password]@cache:6379/0`],
  ];
  for (const [text, out] of cases) assert.equal((await cutOf(text)).text, out);
  for (const text of ['return f"postgresql://{user}:{password}@{host}:{port}/{database}"', "const dsn = `mysql://${cfg.user}:${cfg.pass}@${cfg.host}/widgets`;"]) await kept(text);
});

// ---------- round 4 (FIXES-scrubber.md rulings XXVII-XXXIII, scrub-review round 3; repros work/review/r1-r9.mjs,
// values invented here). Principle: a slot that can't be decided is config's, cut; code needs evidence.

const LEADS = {
  none: () => "",
  read: (n) => `${String(n).padStart(6)}→`,
  "cat -n": (n) => `${String(n).padStart(6)}\t`,
  "grep -n": (n) => `deploy/conf.d/app.yml:${n + 40}:`,
  "grep -C": (n) => `deploy/conf.d/app.yml-${n + 40}-`,
  "diff +": () => "+",
  "diff -": () => "-",
};
const WRAPPERS = {
  raw: (text) => text,
  "1x JSON": (text) => JSON.stringify({ content: text }),
  "2x JSON": (text) => JSON.stringify(JSON.stringify({ content: text })),
  tool_result: (text) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_01", content: text }] } }),
  // A ConfigMap's: a Secret's stringData value is cut whole (ruling LXII b, its own test).
  "pretty JSON": (text) => JSON.stringify({ kind: "ConfigMap", data: { "app.conf": text } }, null, 2),
};
const PEM_BODY = [R(64, 51, BASE64), R(64, 52, BASE64), R(64, 53, BASE64), R(28, 54, BASE64)];
const SLOTS = {
  "YAML key": (v) => [`password: ${v}`],
  "UPPER=": (v) => [`DB_PASSWORD=${v}`],
  "compose map": (v) => [`      POSTGRES_PASSWORD: ${v}`],
  properties: (v) => [`spring.datasource.password=${v}`],
  INI: (v) => ["[client]", `password = ${v}`],
  "PEM full": () => [`-----BEGIN ${"RSA"} PRIVATE KEY-----`, ...PEM_BODY, `-----END ${"RSA"} PRIVATE KEY-----`],
  "PEM truncated": () => [`-----BEGIN ${"RSA"} PRIVATE KEY-----`, ...PEM_BODY.slice(0, 3)],
  // XLI: a first body line that opens with the character after the BEGIN line's lead (`k: -----BEGIN`, then `k...`),
  // or with a lead's own last character (a diff's `+`): the lead never takes a body character.
  "PEM inline k": () => [`k: -----BEGIN ${"RSA"} PRIVATE KEY-----`, `k${PEM_BODY[0].slice(1)}`, ...PEM_BODY.slice(1, 3)],
  "PEM +": () => [`-----BEGIN ${"RSA"} PRIVATE KEY-----`, `+${PEM_BODY[0].slice(1)}`, ...PEM_BODY.slice(1, 3)],
  // XLIX: values a rule reads to the next blank, so at a JSON string's end they would run into its closing quote.
  netrc: (v) => [`machine api.corp-sample.io login bot password ${v}`],
  cookie: (v) => [`curl -H "Cookie: session=${v}; theme=dark" https:${"//"}app.corp-sample.io/`],
  "export -p": (v) => ["$ export -p", "declare -x LANG=\"C.UTF-8\"", `declare -x APP_SECRET=\"${v}\"`],
};
/** Whether `out` parses as `text` does, with the same structure: the same keys, array lengths and types, and each
 *  string that held JSON still JSON of the same structure (ruling XLIX). */
const sameJson = (text, out) => {
  const shape = (a, b) => {
    if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) return false;
    if (typeof a === "string") {
      let inner;
      try {
        inner = JSON.parse(a);
      } catch {
        return true;
      }
      if (typeof inner !== "object" || inner === null) return true;
      try {
        return shape(inner, JSON.parse(b));
      } catch {
        return false;
      }
    }
    if (a === null || typeof a !== "object") return true;
    const keys = Object.keys(a);
    return keys.join("\0") === Object.keys(b).join("\0") && keys.every((key) => shape(a[key], b[key]));
  };
  try {
    return shape(JSON.parse(text), JSON.parse(out));
  } catch {
    return false;
  }
};

test("XXVII, XXVIII: a line start under any lead, in any wrapper, opens the config slot and a PEM block (generated matrix)", async () => {
  const value = R(20, 50);
  const misses = [];
  for (const [leadName, lead] of Object.entries(LEADS)) {
    for (const [wrapName, wrap] of Object.entries(WRAPPERS)) {
      for (const [slotName, slot] of Object.entries(SLOTS)) {
        // The slot as its text's (its decoded string's) first line, a middle one, its last, and its only one.
        for (const at of ["first line", "middle", "last line", "only line"]) {
          const lines = [...(at === "first line" || at === "only line" ? [] : ["db:"]), ...slot(value), ...(at === "last line" || at === "only line" ? [] : ["host: db.corp-sample.io"])];
          const text = wrap(lines.map((line, i) => `${lead(i + 1)}${line}`).join("\n"));
          const secrets = slotName.startsWith("PEM") ? PEM_BODY.slice(0, 3).map((line) => line.slice(0, 24)) : [value];
          const out = await scrub(text, { mode: "cut" });
          const left = out.ok ? secrets.filter((secret) => out.text.includes(secret)) : ["(failed closed)"];
          if (left.length) misses.push(`${leadName} x ${wrapName} x ${slotName} (${at}): ${left.join(",")}`);
          else if (wrapName !== "raw" && !sameJson(text, out.text)) misses.push(`${leadName} x ${wrapName} x ${slotName} (${at}): the cut output no longer parses as its JSON`);
          else if (at !== "last line" && at !== "only line" && !out.text.includes("host: db.corp-sample.io")) misses.push(`${leadName} x ${wrapName} x ${slotName} (${at}): cut past its block`);
        }
      }
    }
  }
  assert.deepEqual(misses, []);
});

test("XXVII: with no line start a config slot stays config's; code needs evidence (braces, a call, a keyword, a code expression)", async () => {
  const v = R(20, 55);
  for (const text of [`the db password: ${v}`, `see: password = ${v}`, `  then api_token: ${v}`]) await gone(text, [v]);
  // Values code's reading keeps (an identifier's shape): with no evidence of code they are config's, cut.
  for (const [text, value] of [["the db password: amber_tide_rain", "amber_tide_rain"], ["see: password = SuperSecretValue", "SuperSecretValue"], ["  then api_token: corpTokenValue", "corpTokenValue"]]) await gone(text, [value]);
  for (const text of [
    "const token = options.token",
    "  self.api_key = settings.api_key",
    "    password = self.settings.db_password",
    "let secret = config.jwtSecret",
    "  token = request.headers.get('X-Token')",
    "    self.token=token_value",
    "const token = rawTokenValue",
    "client.connect(password = sessionPasswordValue",
  ]) await kept(text);
});

test("XXVII: a dump's lines drop grep -n's path lead as they drop cat -n's", async () => {
  const pin = R(12, 67);
  const text = ["$ env | grep -n .", ...["PATH=/usr/bin", "LANG=C", `FOO_PIN=${pin}`].map((line, i) => `out/env.txt:${i + 1}:${line}`), "$ ls"].join("\n");
  const out = await gone(text, [pin]);
  assert.deepEqual(out.cuts.map((cut) => cut.rule), ["env-dump"]);
});

test("XXIX: a URL's password holding / + or @ is cut to the last @ before a host", async () => {
  const pw = `${R(4, 56)}/${R(6, 57)}+${R(5, 58)}=`;
  for (const [scheme, user] of [["postgres", "svc"], ["mongodb+srv", "svc"], ["amqp", "svc"], ["redis", ""], ["redis", "default"], ["https", "bot"]]) {
    const text = `${scheme}:${"//"}${user}:${pw}@db.corp-sample.io:5432/app`;
    const out = await gone(text, [pw.slice(5)]);
    assert.equal(out.text, `${scheme}:${"//"}${user}:[redacted:url-password]@db.corp-sample.io:5432/app`);
  }
  const at = `${R(5, 59)}@${R(8, 60)}`;
  assert.equal((await cutOf(`redis-cli -u redis:${"//"}:${at}@cache.corp-sample.io:6379`)).text, `redis-cli -u redis:${"//"}:[redacted:url-password]@cache.corp-sample.io:6379`);
  for (const text of [`see http:${"//"}[::1]:8080/a@b`, `redis:${"//"}:\${REDIS_PASSWORD}@cache:6379`, `redis:${"//"}:<password>@host`, `redis:${"//"}:@cache.corp-sample.io:6379`]) await kept(text);
});

test("XXX: a line-start lowercase name=value, an INI section's lines and npmrc's auth keys are config's", async () => {
  const v = R(20, 61);
  for (const text of [`password=${v}`, `api_key=${v}`, `[client]\nuser = app\npassword = ${v}`, `[db]\npassword = ops.vault.${v}`, `${"//"}registry.npmjs.org/:_authToken=${v}`, `${"//"}npm.corp-sample.io/:_password=${v}`, `_auth=${v}`]) {
    const out = await gone(text, [v]);
    assert.ok(out.cuts.every((cut) => cut.kind === "label"), `${text}: ${JSON.stringify(out.cuts)}`);
  }
  // Under a section header, a code expression is still a config's value; outside one, it is code.
  await gone("[db]\nhost = db.corp-sample.io\npassword = ops.vault.dbpass", ["ops.vault.dbpass"]);
  await kept("def connect(self):\n    password = self.settings.db_password\n    return password");
});

test("XXXI: a type named ...Token in a YAML key's slot is a type", async () => {
  for (const text of ["class Creds(BaseModel):\n    token: AccessToken", "  refresh_token: RefreshToken"]) await kept(text);
});

test("XXXII: a held value is found across one blank run per split, never across words", async () => {
  const held = `alpha${"beta"}gammadelta`;
  for (const text of ["alpha beta gammadelta", "the alpha, beta gamma delta", "alpha\nbeta\ngammadelta rays"]) {
    const out = await scrub(text, { mode: "cut", held: [held] });
    assert.ok(!out.ok || out.cuts.every((cut) => cut.kind !== "held"), `${JSON.stringify(text)}: ${JSON.stringify(out)}`);
  }
  const h2 = `Hq7${R(20, 62)}`;
  await gone(`v=${h2.slice(0, 10)}\n${h2.slice(10)}`, [h2.slice(0, 10), h2.slice(10)], { held: [h2] });
});

test("XXXIII: an escape's letter five levels down never glues onto a key; a short last body line before END is the key's; a chunked scan's overlap holds a key's run", async () => {
  const nest = (text, times) => (times === 0 ? text : nest(JSON.stringify(text), times - 1));
  const ghp = `ghp_${R(36, 63)}`;
  for (const level of [1, 3, 5]) {
    await gone(nest(`line\n${SKP}\n`, level), [SKP.slice(8)]);
    await gone(nest(`a\t${ghp}`, level), [ghp.slice(4)]);
  }
  const body = [R(64, 64, BASE64), R(64, 65, BASE64), `${R(10, 66, BASE64)}==`];
  const pem = [`-----BEGIN ${"RSA"} PRIVATE KEY-----`, ...body, `-----END ${"RSA"} PRIVATE KEY-----`].map((line, i) => `${String(i + 1).padStart(6)}→${line}`).join("\n");
  for (const text of [pem, JSON.stringify({ content: pem })]) await gone(text, [body[0].slice(0, 20), body[2].slice(0, 10)]);
  // XXVIII: a BEGIN line's prefix holds more than its lead (a key inline in a file the Read tool shows): the lead is
  // the run of that prefix the next line opens with.
  const inline = [`key = """-----BEGIN ${"RSA"} PRIVATE KEY-----`, ...body.slice(0, 2), `-----END ${"RSA"} PRIVATE KEY-----"""`].map((line, i) => `${String(i + 1).padStart(6)}→${line}`).join("\n");
  // And its end, when the BEGIN line has more before its lead (a label on the first line alone).
  const labeled = `result: ${pem}`;
  for (const text of [inline, JSON.stringify({ content: inline }), labeled, JSON.stringify({ content: labeled })]) {
    const out = await gone(text, [body[0].slice(0, 20), body[1].slice(0, 20)]);
    assert.ok(!out.text.includes("PRIVATE KEY"), `one cut from BEGIN through END: ${out.text}`);
  }
  await assert.rejects(scrubWith(SCRUB_RULES, "x", { mode: "count" }, { maxChars: 1 << 20, overlap: 1024 }), /overlap/);
});

// ---------- fp-sweep's final run (FIXES-scrubber.md rulings XXXV-XXXVIII, folded into round 3; values invented here)

test("XXXV: a bracketed IPv6 host is a host, never a URL's userinfo", async () => {
  // The tail after the bracket is no address here (no TLD): an address there is the email rule's, a ULA host
  // private-ip's, both cut by their own rules.
  for (const text of [`v6_row = "http:${"//"}[::1]:8443;widgets@localhost"`, `row = "https:${"//"}[2001:db8::7]:9443,ops@widgets-gw"`]) await kept(text);
  const pw = R(16, 70);
  assert.equal((await cutOf(`postgres:${"//"}svc:${pw}@[2001:db8::7]:5432/app`)).text, `postgres:${"//"}svc:[redacted:url-password]@[2001:db8::7]:5432/app`);
});

test("XXXVI: the email rule never fires inside a URL's userinfo", async () => {
  await kept(`const content = [\`url https:${"//"}admin:\${pw}x@db.corp-sample.io/x\`];`);
  const out = await gone(`https:${"//"}bob.smith:${R(16, 71)}@corp-sample.io/x`, [R(16, 71)]);
  assert.deepEqual(out.cuts.map((cut) => cut.rule), ["url-password"]);
});

test("XXXVII: a bare pat is a pattern; *_PAT is a token", async () => {
  await kept(`pat="^(widget $TAG .* done|WARN(429|503))"; grep -q -E "$pat" "$LOG"`);
  const v = R(20, 72);
  for (const text of [`GITHUB_PAT=${v}`, `GH_PAT="${v}"`, `export DEPLOY_PAT=${v}`]) await gone(text, [v]);
});

test("XXXVIII: an escaped expansion (\\$VAR, \\${VAR}) is a reference", async () => {
  for (const text of [`sed -i "s|^PGPASSWORD=\\"\\$PGPASSWORD\\" psql|PGPASSWORD=\\$PGPASSWORD psql|" run.sh`, `DB_PASSWORD=\\$DB_PASSWORD`, `API_TOKEN=\\\${API_TOKEN}`]) await kept(text);
});

// ---------- review round 4 (FIXES-scrubber.md rulings XXXIX-XLIII; repros work/review/r10-r16.mjs, values invented here)

test("XXXIX: a JSON string's quotes bound its lines in every view, escapes or none", async () => {
  const P = "SuperSecretPassword";
  for (const line of [`password=${P}`, `db.password=${P}`, `password: ${P}`, `  password: ${P}`, `    11→password: ${P}`]) {
    await gone(JSON.stringify({ exit: 0, stdout: line }), [P]);
    await gone(JSON.stringify({ exit: 0, stdout: line }, null, 2), [P]);
  }
});

test("XL: a `-` before a name is a flag's unless a line start or a digit stands before it", async () => {
  const P = "SuperSecretPassword";
  for (const text of [`-PGPASSWORD=${P}`, `-  password: ${P}`, `-DB_PASSWORD = ${P}`, `app.env-3-DB_PASSWORD=${P}`, `3-DB_PASSWORD=${P}`, JSON.stringify({ diff: `-PGPASSWORD=${P}` }), `-DDB_PASSWORD=${P}`]) await gone(text, [P]);
  // A flag's name (a blank or a letter before its `-`), its value whatever it is: kept by XL alone.
  const flag = "java -DDB_PASSWORD=x.y.z -jar app.jar";
  for (const text of ["run --db-password=$DB_PASSWORD", "java -Dapp.mode=prod -jar app.jar", "x --api-key=${KEY}", flag, JSON.stringify({ cmd: flag })]) await kept(text);
});

test("XLI: a PEM lead holds on the first two lines after BEGIN and never ends on a base64 character", async () => {
  const B = (n, step) => Array.from({ length: n }, (_, i) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[(i * step + 7) % 64]).join("");
  const body = [B(64, 5), B(64, 11), B(64, 13), B(28, 17)];
  const read = (lines) => lines.map((line, i) => `${String(i + 1).padStart(6)}→${line}`).join("\n");
  const begin = `-----BEGIN ${"RSA"} PRIVATE KEY-----`;
  const end = `-----END ${"RSA"} PRIVATE KEY-----`;
  for (const text of [
    // Two body lines open with the prefix's last character: two lines hold `k`, the base64 rule drops it.
    read([`k: ${begin}`, `k${body[0].slice(1)}`, `k${body[1].slice(1)}`, body[2], body[3], end]),
    // The first line after BEGIN opens like the prefix (`Proc` then `:`/`-`), the second does not: two lines drop it.
    read([`Proc: ${begin}`, "Proc-Type: 4,ENCRYPTED", `DEK-Info: AES-128-CBC,${"0F".repeat(16)}`, "", ...body, end]),
  ]) {
    for (const form of [text, JSON.stringify({ content: text })]) await gone(form, body.slice(0, 3).map((line) => line.slice(4, 28)));
  }
});

test("XLII, XLIII: a port is no URL password; the email skip is the URL userinfo url-password reads", async () => {
  for (const text of [
    `GET http:${"//"}localhost:5173/@vite/client 404`,
    `http:${"//"}localhost:5173/@fs/srv/app/src/main.tsx`,
    `http:${"//"}localhost:4873/@myorg/widgets`,
    `http:${"//"}localhost:8080/npm/react@18.2.0/index.js`,
    `https:${"//"}cdn.corp-sample.io:443/npm/lodash@4.17.21/lodash.min.js`,
    `ws:${"//"}localhost:3000/socket@v2`,
    `skopeo copy docker:${"//"}registry.corp-sample.io:5000/team/app@sha256:${"9f86d081".repeat(8)} dir:/tmp/x`,
  ]) await kept(text);
  const who = "nancy.ortiz";
  for (const text of [
    `Invite sent: http:${"//"}localhost:3000/invite?to=${who}@corp-sample.io.`,
    `open http:${"//"}localhost:3000/invite?to=${who}@corp-sample.io!`,
    `http:${"//"}app.corp-sample.io:8080/users?email=${who}@corp-sample.io&x=1`,
    `ssh:${"//"}deploy:22/x then mail ${who}@corp-sample.io`,
  ]) {
    const out = await gone(text, [who]);
    assert.ok(out.cuts.some((cut) => cut.rule === "email"), `${text}: ${JSON.stringify(out.cuts)}`);
  }
  // Inside the userinfo url-password reads, an address is none (XXXVI), whatever it decides of the password.
  await kept(`const content = [\`url https:${"//"}admin:\${pw}x@db.corp-sample.io/x\`];`);
  // A user with no password, `://` right before it, is a URL's user, not an address (kept from XXXVI).
  await kept(`git clone ssh:${"//"}deploy@git.corp-sample.io/app.git`);
});

// ---------- review round 4, second part (FIXES-scrubber.md: XLII final, fp-sweep's XLV-XLVII, the scorer's XLIX-LI;
// repros work/review/r17.mjs, values invented here)

test("XLII final: a port is digits then `/` after a host-shaped part; digits before `@`, or after a user, are a password", async () => {
  const sha = "9f86d081".repeat(8);
  for (const [text, secret] of [
    [`postgres:${"//"}app:12345@db.corp-sample.io:5432/x`, "12345"],
    [`redis:${"//"}:4821@cache.corp-sample.io:6379`, "4821"],
    [`mysql:${"//"}root:1234@localhost/app`, "1234"],
    [`redis:${"//"}:123456@cache`, "123456"],
    [`redis:${"//"}:12345@[::1]:6379`, "12345"],
    [`http:${"//"}localhost:3000@corp-sample.io`, "3000"],
    [`ftp:${"//"}bob:12/25/1990@files.corp-sample.io/`, "12/25/1990"],
    [`postgres:${"//"}app:2024/Spring!@db.corp-sample.io/x`, "2024/Spring!"],
    [`postgres:${"//"}app:12345/@db.corp-sample.io/x`, "12345/"],
    [`postgres:${"//"}app:1/Zq8RtYw2Lp4Kx9Vb+@db.corp-sample.io/x`, "Zq8RtYw2Lp4Kx9Vb"],
  ]) {
    const out = await gone(text, [secret]);
    assert.ok(out.cuts.some((cut) => cut.rule === "url-password"), `${text}: ${JSON.stringify(out.cuts)}`);
  }
  for (const text of [
    `http:${"//"}localhost:5173/@vite/client`,
    `http:${"//"}127.0.0.1:4873/@myorg/widgets`,
    `docker:${"//"}registry.corp-sample.io:5000/team/app@sha256:${sha}`,
    `https:${"//"}cdn.corp-sample.io:443/npm/lodash@4.17.21/x.js`,
  ]) await kept(text);
  // A dotless compose service is no host by shape: its port reads as a password, a restorable false cut (accepted).
  const compose = await scrub(`http:${"//"}api:8080/@vite/client`, { mode: "count" });
  assert.deepEqual(compose.cuts.map((cut) => [cut.rule, cut.restorable]), [["url-password", true]]);
});

test("XLV: a trailing `,`, `)` or `}` is code's evidence, stripped before the value checks", async () => {
  for (const text of ["        token=token,", "        api_key=settings.widget_api_key,", "API_KEY=api_key,", "    client_secret=client_secret)", "  {password=password}", "    token: token}", "  api_key: settings.widget_api_key}"]) await kept(text);
  // With no ending a line's whole lower-case `name=value` is still config's.
  await gone("        password=Zq8RtYw2Lp4Kx9Vb", ["Zq8RtYw2Lp4Kx9Vb"]);
});

test("XLVI: string bounds hold inside a string only; a value outside every string is bounded by line breaks", async () => {
  for (const text of [`TOKEN = os.environ["WIDGETS_TOKEN"]; print("ready\\n")`, `env = {"DB_PWD": params["password"], "HOME": str(ROOT)}; log.write("ok\\n")`]) {
    await kept(text);
    await kept(JSON.stringify({ content: text }));
  }
  for (const text of [`x = "password: hunter2x"`, `x = "a \\"q\\" then password: hunter2x"`, `say "hi\nx = "password: hunter2x"`]) {
    await gone(text, ["hunter2x"]);
    await gone(JSON.stringify({ content: text }), ["hunter2x"]);
  }
  for (const line of ["password=SuperSecretPassword", "db.password=SuperSecretPassword"]) await gone(JSON.stringify({ exit: 0, stdout: line }), ["SuperSecretPassword"]);
});

test("XLVII: a member chain rooted at the environment is a reference in every slot", async () => {
  for (const text of [
    "  apiKey: process.env.WIDGETS_API_KEY",
    "  token: import.meta.env.VITE_WIDGET_TOKEN",
    `password = os.environ.get("DB_PASSWORD")`,
    `API_TOKEN=os.environ["API_TOKEN"]`,
    `  secret: System.getenv("APP_SECRET")`,
    `api_key: ENV["API_KEY"]`,
  ]) await kept(text);
});

test("XLIX: a cut that starts inside a JSON string ends by its closing quote; the output still parses", async () => {
  const v = "Copper8lumen80";
  for (const line of [`machine api.corp-sample.io login bot password ${v}`, `curl -H "Cookie: session=${v}"`, `$ export -p\ndeclare -x APP_SECRET="${v}"`]) {
    for (const text of [JSON.stringify({ type: "text", text: line }), JSON.stringify({ data: JSON.stringify({ type: "text", text: line }) }), JSON.stringify({ message: { content: [{ type: "tool_result", content: line }] } })]) {
      const out = await gone(text, [v]);
      assert.ok(sameJson(text, out.text), `${text} -> ${out.text}`);
    }
  }
});

test("L: Hugging Face, DigitalOcean, PyPI and SendGrid keys are formats, bounded like X's prefixes", async () => {
  const keys = {
    "huggingface-token": `hf_${"FakeAbCdEfGhIjKl"}MnOpQrStUvWxYz012345`,
    "digitalocean-token": `dop_v1_${"0123456789abcdef".repeat(4)}`,
    "pypi-token": `pypi-AgEIcHlwaS5vcmc${"FakeAbCdEfGhIjKl".repeat(4)}`,
    "sendgrid-key": `SG.${"FakeAbCdEfGhIjKlMnOpQr"}.${"Zq8RtYw2Lp4Kx9Vb".repeat(2)}Zq8RtYw2Lp4`,
  };
  for (const [rule, key] of Object.entries(keys)) {
    for (const text of [`token ${key} ok`, `TOKEN=${key}`, `GET https:${"//"}api.corp-sample.io/v1/${key}/x`, JSON.stringify({ content: `key: ${key}` })]) {
      const out = await gone(text, [key.slice(0, 24)]);
      assert.ok(out.cuts.some((cut) => cut.rule === rule && cut.kind === "format" && cut.restorable === false), `${text}: ${JSON.stringify(out.cuts)}`);
    }
  }
  for (const text of [`doo_v1_${"0123456789abcdef".repeat(4)}`, `dor_v1_${"fedcba9876543210".repeat(4)}`]) {
    const out = await gone(text, [text.slice(0, 24)]);
    assert.deepEqual(out.cuts.map((cut) => cut.rule), ["digitalocean-token"]);
  }
  // Inside a longer base64 run (an inline image), a prefix opens no key.
  await kept(`data:image/png;base64,iVBORw0KGgoxyz${keys["huggingface-token"]}AAAA`);
});

test("LI: a write to the environment under a credential's name is a label on the value", async () => {
  const v = "Zq8RtYw2Lp4Kx9Vb";
  for (const text of [`os.environ["DB_PASSWORD"] = "${v}"`, `process.env.DB_PASSWORD = "${v}"`, `ENV["API_TOKEN"]="${v}"`, `os.environ['API_TOKEN'] = '${v}'`, `import.meta.env.VITE_API_TOKEN = "${v}"`]) {
    const out = await gone(text, [v]);
    assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind]), [["secret-assign", "label"]]);
    await gone(JSON.stringify({ content: text }), [v]);
  }
  for (const text of [`os.environ["DB_PASSWORD"] = os.environ["OLD_DB_PASSWORD"]`, `os.environ["DB_PASSWORD"] = get_secret("db")`, `os.environ["DB_HOST"] = "${v}"`]) await kept(text);
});

test("LIII, LIX: a bare name written to the environment or to a self./this./cls. member is a variable; a literal there is cut, and so is settings.SECRET_KEY = secret_key (a member chain alone is no code evidence)", async () => {
  // The round-5 repros, and the same evidence in each form (an environment root, `self.`/`this.`, `;`).
  for (const text of [`os.environ["PGPASSWORD"] = password`, "self.DB_PASSWORD = password", "process.env.DB_PASSWORD = password;", `ENV["API_TOKEN"] = api_token`, "import.meta.env.VITE_API_TOKEN = cfg.apiToken", "self.DB_PASSWORD=password", "app.config.SECRET_KEY = secretKey,", "process.env.API_TOKEN = token;"]) {
    await kept(text);
    await kept(JSON.stringify({ type: "tool_result", content: text }));
  }
  const v = "Zq8RtYw2Lp4";
  // A quoted literal, a value with a digit, or no code on the left side: still a label cut, in JSON too.
  for (const [text, secret] of [[`os.environ["PGPASSWORD"] = "hunter2"`, "hunter2"], [`self.DB_PASSWORD = "hunter2"`, "hunter2"], [`os.environ["PGPASSWORD"] = hunter2`, "hunter2"], [`self.DB_PASSWORD = ${v}`, v], [`settings.SECRET_KEY=${v}`, v], [`os.environ["PGPASSWORD"] = 12345678`, "12345678"], ["PGPASSWORD=sunshine; psql -h db", "sunshine"], ["spring.datasource.password=sunshine", "sunshine"], ["mail.smtp.password = sunshine", "sunshine"], ["notes/app.properties:12:db.password = sunshine", "sunshine"]]) {
    for (const wrapped of [text, JSON.stringify({ type: "tool_result", content: text })]) {
      const out = await gone(wrapped, [secret]);
      assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind]), [["secret-assign", "label"]], wrapped);
    }
  }
  // Declined for beta 1: the spaced `=` alone is no code's evidence (INI and my.cnf space it too). A restorable cut,
  // raw and in JSON (round 5's other repros).
  // LIX: `settings.` alone is a dotted key's as much as an object's, so the round-5 `settings.SECRET_KEY = secret_key`
  // is a restorable cut too (gray, the beta 2/3 grader's).
  for (const [text, secret] of [["PGPASSWORD = password", "password"], ["PGPASSWORD = db_password", "db_password"], ["DB_PASSWORD = password", "password"], ["settings.SECRET_KEY = secret_key", "secret_key"]]) {
    for (const wrapped of [text, JSON.stringify({ type: "tool_result", content: text })]) {
      const out = await gone(wrapped, [secret]);
      assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["secret-assign", "label", true]], wrapped);
    }
  }
});

test("LIV: a slot reads what follows its value on its own line or in its own string; every wrapper cuts as raw does", async () => {
  // Every code slot kind (XXI/XLV entries, kwargs, member and environment writes, quoted keys, config lines) with a
  // credential-named bare literal: the cuts in json1, json2 and a tool_result are the raw text's.
  const slots = [
    (v) => `os.environ["DB_PASSWORD"] = ${v}`, (v) => `ENV["API_TOKEN"]=${v}`, (v) => `process.env.DB_PASSWORD = ${v}`, (v) => `import.meta.env.VITE_API_TOKEN = ${v}`,
    (v) => `self.DB_PASSWORD = ${v}`, (v) => `this.apiToken = ${v}`, (v) => `settings.SECRET_KEY = ${v}`, (v) => `self.api_token=${v}`,
    (v) => `client = Client(api_key=${v}`, (v) => `connect(host="db", password=${v}`, (v) => `conf = { token: ${v}`, (v) => `  apiKey: ${v}`, (v) => `    token=${v}`,
    (v) => `{"password": ${v}`, (v) => `  "api_key": ${v}`, (v) => `headers = {"X-Api-Key": ${v}`, (v) => `os.environ['DB_PASSWORD'] = ${v}`, (v) => `cfg = {'token': ${v}`, (v) => `ENV["DB_PASSWORD"] = ${v}`,
    (v) => `API_KEY=${v}`, (v) => `api_key=${v}`, (v) => `password: ${v}`, (v) => `export DB_PASSWORD=${v}`, (v) => `password = ${v}`, (v) => `DB_PASSWORD = ${v}`,
    (v) => `f(token=${v})`, (v) => `{token: ${v}}`, (v) => `token=${v},`, (v) => `Client(api_key=${v}, timeout=3)`, (v) => `x = { password: ${v} }`,
  ];
  const wrappers = [
    (s) => JSON.stringify({ type: "text", text: s }),
    (s) => JSON.stringify({ type: "progress", data: JSON.stringify({ type: "text", text: s }) }),
    (s) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: s }] } }),
  ];
  const cutsOf = async (text, value) => (await scrub(text, { mode: "count" })).cuts.map((cut) => `${cut.rule}:${text.slice(cut.start, cut.end).includes(value.slice(0, 6))}`).sort().join(",");
  const differ = [];
  for (const slot of slots) {
    for (const v of ["Zq8RtYw2Lp4", "sunshine", "Zq8!Rt#Yw2Lp"]) {
      const want = await cutsOf(slot(v), v);
      for (const wrap of wrappers) if ((await cutsOf(wrap(slot(v)), v)) !== want) differ.push(wrap(slot(v)));
    }
  }
  assert.deepEqual(differ, []);
  // The engine's bound itself: a label rule that finds `K["NAME"] = value` only where the subscript's quotes are real
  // (so only in the view that decodes the string, whose own quotes it blanked) gives no code flag; the string's end
  // and the `}`, `,` or `)` after it must not read as an entry's end, so the value is cut in every wrapper as raw.
  const subscript = { id: "secret-assign", kind: "label", restorable: true, find: (text) => [...text.matchAll(/K\["PASS"\] = ([A-Za-z0-9]{1,64})/dg)].map((m) => ({ start: m.indices[1][0], end: m.indices[1][1], name: "PASS" })) };
  const line = `K["PASS"] = Zq8RtYw2Lp4`;
  for (const text of [line, JSON.stringify({ text: line }), JSON.stringify([line, "x"]), JSON.stringify({ data: JSON.stringify({ text: line }) }), JSON.stringify({ content: [{ type: "tool_result", content: line }] })]) {
    const out = await scrubWith([subscript], text, { mode: "count" });
    assert.equal(out.cuts.length, 1, text);
  }
});

test("LII: npmrc's auth keys open after every line lead the line-anchored rules read", async () => {
  const v = "Zq8RtYw2Lp4Kx9Vb3Nm";
  const leads = {
    none: () => "",
    read: (n) => `${String(n).padStart(6)}\u2192`,
    "cat-n": (n) => `${String(n).padStart(6)}\t`,
    "grep-n": (n) => `notes/setup.txt:${n + 40}:`,
    "grep-C": (n) => `notes/setup.txt-${n + 40}-`,
    "grep-bare": (n) => `${n + 40}:`,
    "diff-plus": () => "+",
    "diff-minus": () => "-",
  };
  const led = (lines, lead) => lines.map((line, i) => `${lead(i + 1)}${line}`).join("\n");
  for (const [name, lead] of Object.entries(leads)) {
    for (const lines of [[`registry=https:${"//"}npm.corp-sample.io/`, `${"//"}npm.corp-sample.io/:_authToken=${v}`], [`${"//"}npm.corp-sample.io/:username=ci`, `${"//"}npm.corp-sample.io/:_password=${v}`], ["always-auth=true", `_auth=${v}`]]) {
      const text = led(lines, lead);
      for (const wrapped of [text, JSON.stringify({ type: "tool_result", content: text })]) {
        const out = await gone(wrapped, [v]);
        assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind]), [["secret-assign", "label"]], `${name}: ${wrapped}`);
      }
    }
    // A non-credential npmrc line under the same lead stays.
    const keep = led([`registry=https:${"//"}npm.corp-sample.io/`, `${"//"}npm.corp-sample.io/:always-auth=true`], lead);
    await kept(keep);
    await kept(JSON.stringify({ type: "tool_result", content: keep }));
  }
  // Mid-line, the key itself is the anchor (ruling LVIII, its test): a `-` or a `12:` before it is no lead, the key is cut.
});

test("LV, LVII: inside quotes the quotes bound the value; its edge blanks are judged trimmed and cut with it", async () => {
  const v = "Copper8lumen80";
  // The credential names built from parts, so the source export scan reads no credential literal in this file.
  const PG = ["PGPASS", "WORD"].join("");
  const DBP = ["DB_PASS", "WORD"].join("");
  const PWD = ["pass", "word"].join("");
  const wrappers = [
    (s) => s,
    (s) => JSON.stringify({ type: "text", text: s }),
    (s) => JSON.stringify({ type: "progress", data: JSON.stringify({ type: "text", text: s }) }),
    (s) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: s }] } }),
  ];
  // The Greptile repro and its kin: one label cut that takes the whole quoted contents, blanks included.
  // An edge token that mixes punctuation with word characters is the value's (LVII).
  for (const [text, inner] of [[`${PG}=" ${v} "`, ` ${v} `], [`export ${DBP}=' ${v}'`, ` ${v}`], [`${PWD}: "${v}  "`, `${v}  `], [`API_TOKEN=" ${v}"; curl -s x`, ` ${v}`], [`${PG}=" !Copper8 "`, " !Copper8 "], [`${PG}=" Copper8! "`, " Copper8! "], [`${PG}=" pa+ss word "`, " pa+ss word "]]) {
    for (const wrap of wrappers) {
      const wrapped = wrap(text);
      const out = await gone(wrapped, [inner.trim()]);
      assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind]), [["secret-assign", "label"]], wrapped);
    }
    const { cut } = await oneCut(text);
    assert.equal(text.slice(cut.start, cut.end), inner, text);
  }
  // Blanks alone, under 3 characters once trimmed (as `ab` unquoted is), or a reference or a placeholder inside the
  // blanks, stay.
  for (const text of [`${PG}=" "`, `${PG}="   "`, `${PG}=" ab "`, `${PG}="  ab"`, `${PG}=" $PW "`, `${PG}=" \${PW} "`, `${DBP}=' <password> '`, `API_TOKEN=" op://Infra/db/password "`]) {
    for (const wrap of wrappers) await kept(wrap(text));
  }
  // Blank-edged contents whose first or last token is punctuation alone sit between one string's close and the next
  // one's open: no value, in any language's concatenation (EDGE_BLANK kept these before LV; sweep-shapes class Z9).
  for (const text of [`cmd = "${PG}=" + pw + " psql -h db"`, `$cmd = "${PG}=" . $pw . " psql";`, `print("${PG}=", pw, " psql")`, `sql = "${PWD}=" || pw || " x"`, `local s = "token=" .. tok .. " end"`, `["mysql -p" + "y".repeat(9)]`, `s = "API_TOKEN=" & tok & " end"`]) {
    for (const wrap of wrappers) await kept(wrap(text));
  }
});

test("LVI: the command a text is the output of is its context: a read of a credential file or an env command's output is a dump", async () => {
  const pw = "Copper8lumen80";
  const pgpass = `db:5432:app:svc:${pw}`;
  const env = `APP_REGION=north\nAPP_SEED=${pw}`;
  for (const [text, command, rule] of [[pgpass, "cat ~/.pgpass", "credential-file"], [`machine h.sample.zz login svc password ${pw}`, "cat ~/.netrc", "credential-file"], [env, "cat .env", "env-file"], [env, "env", "env-dump"], [env, "$ env | sort", "env-dump"], [pw, "printenv APP_SEED", "env-dump"], [`a\nb\n${pw}`, "less ~/.ssh/id_ed25519", "ssh-file"]]) {
    const out = await gone(text, [pw], { command });
    assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [[rule, "dump", false]], `${command}: ${JSON.stringify(out.cuts)}`);
  }
  // No context, an unrelated read, or a command that is no read or dump: the output alone is no dump (no unanchored
  // pgpass or env shape).
  for (const [text, command] of [[pgpass, undefined], [pgpass, "cat notes.txt"], [pgpass, "echo ok"], [env, "echo ok"], [env, undefined], [`no names here, just ${pw}`, "env"]]) {
    const out = await scrub(text, { mode: "count", ...(command !== undefined ? { command } : {}) });
    assert.deepEqual(out.cuts, [], `${command}: ${JSON.stringify(out.cuts)}`);
  }
});

test("LIX: a dotted name is no code evidence alone; a self./this./cls. root, a trailing `;` or an environment root is", async () => {
  const wrappers = [
    (s) => s,
    (s) => JSON.stringify({ type: "text", text: s }),
    (s) => JSON.stringify({ type: "progress", data: JSON.stringify({ type: "text", text: s }) }),
    (s) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: s }] } }),
  ];
  // .properties, .ini and spring-style dotted keys: undecidable, so cut (restorable).
  for (const text of ["service.DB_PASSWORD=sunshine", "spring.datasource.password=sunshine", "app.db.PASSWORD = sunshine", "x = 1; service.DB_PASSWORD=sunshine"]) {
    for (const wrap of wrappers) {
      const wrapped = wrap(text);
      const out = await gone(wrapped, ["sunshine"]);
      assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["secret-assign", "label", true]], wrapped);
    }
  }
  // A language root, a statement's `;` or the environment's root: a variable, kept.
  for (const text of ["self.DB_PASSWORD = password", "this.DB_PASSWORD = password;", "cls.DB_PASSWORD = password", "process.env.DB_PASSWORD = password;", "app.db.PASSWORD = password;", "service.DB_PASSWORD=db_password;"]) {
    for (const wrap of wrappers) await kept(wrap(text));
  }
});

test("LX: on a certain-code left side an identifier followed by `[`, `(` or `.` starts a reference; a literal is still cut", async () => {
  const wrappers = [
    (s) => s,
    (s) => JSON.stringify({ type: "text", text: s }),
    (s) => JSON.stringify({ type: "progress", data: JSON.stringify({ type: "text", text: s }) }),
    (s) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: s }] } }),
  ];
  for (const text of [`os.environ["DB_PASSWORD"] = config["password"]`, `os.environ["DB_PASSWORD"] = get_secret("db")`, `os.environ["DB_PASSWORD"] = settings.db.password`, `process.env.DB_PASSWORD = cfg["pw"];`, `ENV["API_TOKEN"] = vault.read("api")`, `os.environ["DB_PASSWORD"] = keys[0]`, `self.DB_PASSWORD = get_secret("db")`, `this.apiToken = cfg["token"];`]) {
    for (const wrap of wrappers) await kept(wrap(text));
  }
  for (const [text, secret] of [[`os.environ["DB_PASSWORD"] = "sunshine1"`, "sunshine1"], [`os.environ["DB_PASSWORD"] = sunshine1`, "sunshine1"], [`process.env.API_TOKEN = "Zq8RtYw2Lp4";`, "Zq8RtYw2Lp4"]]) {
    for (const wrap of wrappers) {
      const wrapped = wrap(text);
      const out = await gone(wrapped, [secret]);
      assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind]), [["secret-assign", "label"]], wrapped);
    }
  }
});

test("LVIII: an npm `_`-key is its own anchor: any character but a letter, a digit, `_`, `$` or `.` before it, anywhere on its line", async () => {
  const t = "Zq8RtYw2Lp4Kx9VbN3mQa7Hs2Df5Gj8K";
  const wrappers = [
    (s) => s,
    (s) => JSON.stringify({ type: "text", text: s }),
    (s) => JSON.stringify({ type: "progress", data: JSON.stringify({ type: "text", text: s }) }),
    (s) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: s }] } }),
  ];
  // r18's mid-line section, and LII's old mid-line keeps: a label cut of the value.
  for (const text of [`build log x\u2192_authToken=${t}`, `foo 12:_authToken=${t}`, `foo +_authToken=${t}`, `x -${"//"}npm.corp-sample.io/:_authToken=${t}`, `see 12:_auth=${t}`, `(_password=${t})`, `npm config set ${"//"}npm.corp-sample.io/:_authToken=${t} --location=user`]) {
    for (const wrap of wrappers) {
      const wrapped = wrap(text);
      const out = await gone(wrapped, [t]);
      assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["secret-assign", "label", true]], wrapped);
    }
  }
  // No `=` after the key, a reference as its value, a short value, or the key a member's (`._auth`) or a longer name's
  // tail (`foo_authToken`, `a__auth`): as before.
  for (const text of ["the field is 12:_auth", "_authToken=\${NPM_TOKEN}", "see x\u2192_authToken=\${NPM_TOKEN}", "note a:12:_authToken=abc", "echo x-12-_authToken=foo", `a__auth=${t}`, `this._auth=t.authToken`, `self._password=cfg.pw`]) {
    for (const wrap of wrappers) await kept(wrap(text));
  }
  // `x_password=` stays secret-assign's NAME=value cut, as before; `foo_authToken=` is one too since a camel hump
  // separates a name's segments whatever its value (ruling LXXII: FOO_AUTH_TOKEN), never NPMRC_AUTH's.
  for (const text of [`x_password=${t}`, `foo_authToken=${t}`]) {
    const out = await gone(text, [t]);
    assert.deepEqual(out.cuts.map((cut) => cut.rule), ["secret-assign"]);
  }
});

/** The four ways a run's text reaches the scrubber: raw, a JSON string, a JSON string in a JSON string, a tool result. */
/** This process's CPU time in ms: the timing pins measure the reading's own work, never the wall clock a shared CI
 *  runner stretches (eight test files at once: 55b0239695's shard ran LXXXIII's 2 MB at 3.4 s wall). */
const cpuNow = () => {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
};
const FOUR_WRAPS = [
  (s) => s,
  (s) => JSON.stringify({ type: "text", text: s }),
  (s) => JSON.stringify({ type: "progress", data: JSON.stringify({ type: "text", text: s }) }),
  (s) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: s }] } }),
];
/** Each text, in every wrapper, has `secret` gone, in one restorable label cut of `rule`. */
const labelCutIn = async (texts, secret, rule) => {
  for (const text of texts) {
    for (const wrap of FOUR_WRAPS) {
      const wrapped = wrap(text);
      const out = await gone(wrapped, [secret]);
      assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [[rule, "label", true]], wrapped);
    }
  }
};

test("LXI a: a connection string's password (libpq, ADO, ODBC), any case, mid-line, is a label cut", async () => {
  const pw = "Tq7Wm2Rk9Zx";
  await labelCutIn([
    `psql "host=db user=app password=${pw} dbname=x"`,
    `Server=db;Database=x;User Id=sa;Password=${pw};`,
    `Driver={ODBC};Server=x;UID=sa;PWD=${pw};`,
    `Driver={ODBC};Server=x;UID=sa;PWD={${pw}};`,
    `conn = connect("host=db passwd=${pw}")`,
  ], pw, "connection-string");
  // An empty value's blank then a word that is no assignment: still that name's value (secret-assign's, as before).
  await labelCutIn([`password= ${pw}`], pw, "secret-assign");
  // No value, a reference, a placeholder, an elided value, code's names and a format string's fields, the shell's
  // working directory: kept.
  for (const text of ["password=", "pwd=$(pwd)", `psql "host=db.sample.zz user=app password= dbname=widgets"`, "password=<your-password>", "the password=... field", "cd /srv; PWD=/srv/app make", "conn = connect(host=h, password=password)", "    password=pw,", "connect(user=u, password=settings.DB_PASS)", "f\"host={host} password={password}\"", "s = \"Server=x;PWD={pw!r};\"", "Driver={ODBC};UID=sa;PWD={db_secret};", "def f(password=None):", "kwargs: password=getpass()"]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});

test("LXVII: `name= next=v` is an empty value only where the context decides it (a connection string, a command prefix); a config line's next word is its value, cut", async () => {
  // A .env's or a .properties' `DB_PASSWORD= realm=Amber9` may hold the password `realm=Amber9`: undecidable, so cut.
  await labelCutIn([
    "DB_PASSWORD= realm=Amber9",
    "db.password= realm=Amber9",
    "DB_PASSWORD= realm=Amber9\nDB_USER=app",
    "config.env:3:DB_PASSWORD= realm=Amber9",
  ], "realm=Amber9", "secret-assign");
  // Blanks separate assignments here, so the blank ends an empty value: an assignment right before it on its line, or
  // a command it prefixes.
  for (const text of [`psql "host=db.sample.zz user=app password= dbname=widgets"`, "TOKEN= OTHER=1 ./run.sh", "env A=1 DB_PASSWORD= realm=Amber9 ./run.sh", "export A=1 DB_PASSWORD= realm=Amber9"]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});

test("LXI b: a query string's or a form body's password is cut at any length; other names keep url-credential's least", async () => {
  const pw = "Tq7Wm2Rk9Zx";
  await labelCutIn([`curl -d "user=bob&password=${pw}" https://x.io/login`, `https://api.x.io/login?user=bob&password=${pw}`, `GET /login?pwd=${pw}&next=1`], pw, "query-password");
  await labelCutIn(["login?user=bob&passwd=abc"], "abc", "query-password");
  for (const text of ["https://x.io/a?password=&next=1", "https://x.io/a?password=$PW", "?pwd=/var/www", `https://x.io/a?token=${pw}`, "url = f\"?user={u}&password={pw}\""]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});

test("LXI c: a lower-case credential name=value before a command is its environment, cut as an upper-case one is", async () => {
  const pw = "Tq7Wm2Rk9Zx";
  await labelCutIn([`db_password=${pw} ./run.sh`, `x=1 db_password=${pw} ./run.sh`, `echo ok && db_password=${pw} npm test`, `a | api_key=${pw} python x.py`, `env api_token=${pw} node app.js`, `$ db_password=${pw} make deploy`, `+ db_password=${pw} ./run.sh`], pw, "secret-assign");
  // No command after it, a reference, a keyword argument, a short value: kept as before.
  for (const text of [`f(db_password=${pw}, x)`, "db_password=$PW ./run.sh", "db_password=${DB_PASS} ./run", "run(token=tok) and go", "token=abc is wrong"]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});

/** A PEM block base64'd whole, as a k8s Secret or a kubeconfig stores it: built at run time, its body synthetic. */
const base64Pem = (seed) => Buffer.from(`-----${"BEGIN"} PRIVATE KEY-----\n${R(64, seed, BASE64)}\n${R(64, seed + 1, BASE64)}\n-----${"END"} PRIVATE KEY-----\n`).toString("base64");

test("LXII a: a PEM block stored base64'd (`LS0tLS1CRUdJTi`...) is a format cut, a wrap's lines with it", async () => {
  const pem = base64Pem(61);
  // `base64`'s 76-column wrap: every line of it gone (each is in the unwrapped run too).
  const wrapLines = pem.match(/.{1,76}/g);
  for (const text of [`  tls.key: ${pem}`, `    client-key-data: ${pem}`, `{"key":"${pem}"}`, `$ base64 key.pem\n${wrapLines.join("\n")}\n$ ls`]) {
    for (const wrap of FOUR_WRAPS) {
      const wrapped = wrap(text);
      const out = await gone(wrapped, [pem.slice(20, 44), ...wrapLines.slice(1)]);
      assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["base64-pem", "format", false]], wrapped);
    }
  }
  // No PEM header at a run's start, one too short to hold a block, or inside a longer run: kept.
  for (const text of [`  tls.key: ${Buffer.from(R(90, 62)).toString("base64")}`, "  x: LS0tLS1CRUdJTiBQUklW", `  x: QQ${pem}`]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});

test("LXII b: a k8s Secret's data/stringData values and a kubeconfig's *-key-data are cut, dotted keys too; a ConfigMap's are not", async () => {
  const v = Buffer.from(R(18, 63)).toString("base64");
  const secretYaml = (entries) => ["apiVersion: v1", "kind: Secret", "metadata:", "  name: app", "type: Opaque", "data:", ...entries].join("\n");
  const texts = [
    secretYaml([`  api: ${v}`]),
    secretYaml([`  tls.key: ${v}`]),
    secretYaml([`  .dockerconfigjson: ${v}`]),
    secretYaml([`  "db-url": "${v}"`]),
    ["kind: Secret", "stringData:", "  app.conf: |", `    region: north`, `    seed: ${v}`].join("\n"),
    secretYaml([`  api: ${v}`]).split("\n").map((line, i) => `${String(i + 1).padStart(6)}→${line}`).join("\n"),
    JSON.stringify({ apiVersion: "v1", kind: "Secret", data: { api: v, "tls.key": v } }, null, 2),
    `users:\n- name: u\n  user:\n    client-key-data: ${v}`,
  ];
  for (const text of texts) {
    for (const wrap of FOUR_WRAPS) {
      const wrapped = wrap(text);
      const out = await gone(wrapped, [v]);
      assert.ok(out.cuts.length > 0 && out.cuts.every((cut) => cut.rule === "k8s-secret" && cut.kind === "label" && cut.restorable), `${wrapped}: ${JSON.stringify(out.cuts)}`);
    }
  }
  // The XXVII matrix's pretty-JSON text under a Secret's stringData is cut whole, one k8s-secret cut over the value;
  // the matrix's own wrapper (a ConfigMap's data) gets no k8s-secret cut, so widening (b) to ConfigMaps goes red here.
  const conf = ["db:", ...SLOTS["YAML key"](v).map((line) => `  ${line}`), "  host: db.corp-sample.io"].join("\n");
  const secretForm = JSON.stringify({ kind: "Secret", stringData: { "app.conf": conf } }, null, 2);
  const encoded = JSON.stringify(conf).slice(1, -1);
  const whole = await gone(secretForm, [v, "db.corp-sample.io"]);
  const at = secretForm.indexOf(encoded);
  assert.ok(whole.cuts.some((cut) => cut.rule === "k8s-secret" && cut.start <= at && cut.end >= at + encoded.length), JSON.stringify(whole.cuts));
  const configMap = await scrub(WRAPPERS["pretty JSON"](conf), { mode: "count" });
  assert.ok(!configMap.cuts.some((cut) => cut.rule === "k8s-secret"), JSON.stringify(configMap.cuts));
  // A ConfigMap, a data map with no Secret kind, a Secret's template slots, the ConfigMap after a Secret's `---`: kept.
  for (const text of [
    ["apiVersion: v1", "kind: ConfigMap", "data:", `  api: ${v}`].join("\n"),
    ["data:", `  api: ${v}`].join("\n"),
    ["kind: Secret", "data:", "  api: {{ .Values.api | b64enc }}", "  x: $(APP_SECRET)"].join("\n"),
    ["kind: Secret", "---", "kind: ConfigMap", "data:", `  api: ${v}`].join("\n"),
    JSON.stringify({ kind: "ConfigMap", data: { api: v } }),
  ]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});

test("LXII c: a docker config's \"auth\" under \"auths\", or in a config.json read, is cut; an \"auth\" anywhere else is not", async () => {
  const v = Buffer.from(`bob:${R(14, 64)}`).toString("base64");
  const config = JSON.stringify({ auths: { "reg.corp-sample.io": { auth: v } } }, null, 2);
  for (const wrap of FOUR_WRAPS) {
    const out = await gone(wrap(config), [v]);
    assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["docker-auth", "label", true]]);
  }
  const alone = `{"auth": "${v}"}`;
  const out = await gone(alone, [v], { path: "build/config.json" });
  assert.deepEqual(out.cuts.map((cut) => cut.rule), ["docker-auth"]);
  for (const wrap of FOUR_WRAPS) await kept(wrap(alone));
  await kept(alone.replace("auth", "author"));
});

test("LXII d: a credential file's or a .env's path anywhere in the call's command makes its output a dump", async () => {
  const pw = "Copper8lumen80";
  const pgpass = `db:5432:app:svc:${pw}`;
  for (const [text, command, rule] of [
    [pgpass, "grep app ~/.pgpass", "credential-file"],
    [pgpass, 'awk -F: "{print}" "$HOME/.pgpass"', "credential-file"],
    [pgpass, "cut -d: -f1-5 ~/.pgpass | head -n 3", "credential-file"],
    [`machine h.sample.zz login svc password ${pw}`, "tail -n 1 ~/.netrc", "credential-file"],
    [`{"auths":{"r.io":{"auth":"${pw}"}}}`, "jq . ~/.docker/config.json", "credential-file"],
    [`APP_REGION=north\nAPP_SEED=${pw}`, "grep -v ^# .env", "env-file"],
    [`APP_REGION=north\nAPP_SEED=${pw}`, "docker compose --env-file=.env.prod config", "env-file"],
    [`Host build\n  # seed ${pw}`, "sed -n 1,5p ~/.ssh/config", "ssh-file"],
    // LXII d superseded LVI's keep of this one: ~/.pgpass in the command, though no single read prints it whole.
    [pgpass, "cat ~/.pgpass | wc -l\nls", "credential-file"],
  ]) {
    const out = await gone(text, [pw], { command });
    assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [[rule, "dump", false]], `${command}: ${JSON.stringify(out.cuts)}`);
  }
  // No credential path in the command, a template .env, a path that only ends like one: no dump.
  for (const command of ["grep app notes.txt", "cat .env.example", "grep -r pgpass docs/", "ls ~/.ssh/"]) {
    const out = await scrub(pgpass, { mode: "count", command });
    assert.deepEqual(out.cuts, [], `${command}: ${JSON.stringify(out.cuts)}`);
  }
});

test("LXIII: a 2 MB line of minified JSON scrubs in cut mode in under 5 s (pairQuotes is linear: the old per-pair line search took 7 s)", async () => {
  const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, name: `item${i}`, ok: true, tags: ["a", "b"], note: "plain words here" }));
  const text = JSON.stringify({ tool_result: JSON.stringify(rows) });
  assert.ok(text.length > 2_000_000 && !text.includes("\n"));
  const started = cpuNow();
  const out = await scrub(text, { mode: "cut" });
  const took = cpuNow() - started;
  assert.equal(out.ok, true);
  assert.ok(took < 5_000, `${Math.round(took)} ms`);
});

test("LXVIII: a connection string's password: blanks around `=` (libpq, ADO), an ADO value's blanks to its `;`, ODBC braces holding `}}` or `{`", async () => {
  const pw = "Tq7Wm2Rk9Zx";
  await labelCutIn([
    `host=db password = ${pw} dbname=x`,
    `psql 'host=db user=app password = ${pw}'`,
    `Server=db; Database=x; User Id=sa; Password = ${pw};`,
    `Driver={ODBC};UID=sa;PWD={a}}${pw}};`,
    `Driver={ODBC};UID=sa;PWD={ab{${pw}};`,
  ], pw, "connection-string");
  // ADO runs an unquoted value to its `;`: every word of it is cut, in one cut, raw and in appsettings JSON.
  const ado = `Server=db;Database=x;User Id=sa;Password=Copper lumen ${pw};`;
  for (const text of [ado, JSON.stringify({ ConnectionStrings: { Default: ado } }, null, 2), `Server=db;Password=Copper lumen ${pw}`]) {
    for (const wrap of FOUR_WRAPS) {
      const wrapped = wrap(text);
      const out = await gone(wrapped, ["Copper", "lumen", pw]);
      assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["connection-string", "label", true]], wrapped);
    }
  }
  assert.equal((await oneCut(ado)).text, "Server=db;Database=x;User Id=sa;Password=[redacted:connection-string];");
  // A letters-only braced value is a template's field (as ruled); a template's `{{...}}`, an empty or referenced value,
  // a string concatenation, code's spaced `=` with no connection string around it, and an empty spaced value: kept.
  for (const text of [
    "Driver={ODBC};UID=sa;PWD={CopperLumenHorseBattery};",
    "password={{db_password}}",
    "Server=db;PWD={{ db_pw }};",
    "Server=db;Password=;",
    "Server=db;Password=$DB_PASSWORD;",
    "Server=db; Password = {password};",
    `conn = "Server=db;Password=" + pw`,
    "x = 1; password = config.password",
    "int x=1; password = getPw();",
    "password = getpass.getpass()",
    "the password = what you typed",
    "cd /srv; PWD=/srv/app make",
  ]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});

test("LXIX: connection-string reads one long line in time linear in it (`;password=abcdefghij` x N, the rule alone): 400 KB under 1 s, 2 MB under 2 s", async () => {
  const rule = SCRUB_RULES.find((each) => each.id === "connection-string");
  const unit = ";password=abcdefghij";
  for (const [size, bound] of [[400_000, 1_000], [2_000_000, 2_000]]) {
    const n = Math.floor(size / unit.length);
    const text = unit.repeat(n);
    const started = cpuNow();
    const out = await scrubWith([rule], text, { mode: "count" });
    const took = cpuNow() - started;
    assert.equal(out.cuts.length, n);
    assert.ok(took < bound, `${size} chars: ${Math.round(took)} ms`);
  }
});

test("LXX: a command's environment after a prompt, before `&&` or `;`, after `export`, or as a flag's NAME=value (docker -e, --env, --from-literal=) is cut", async () => {
  const pw = "Tq7Wm2Rk9Zx";
  await labelCutIn([
    `db_password=${pw} && ./run.sh`,
    `db_password=${pw}; ./run.sh`,
    `export db_password=${pw} && ./run.sh`,
    `export db_password=${pw}; ./run.sh`,
    `docker run -e db_password=${pw} img`,
    `docker run --env db_password=${pw} img`,
    `docker run --env=db_password=${pw} img`,
    `docker run -e "db_password=${pw}" img`,
    `docker compose run -e db_password=${pw} web`,
    `kubectl create secret generic app --from-literal=password=${pw}`,
    `bob@h:~/app$ db_password=${pw} ./run.sh`,
    `root@h:~# db_password=${pw} ./run.sh`,
    `# db_password=${pw} ./run.sh`,
  ], pw, "secret-assign");
  // A `;` after the value ends a statement in code as in a shell: there code's shapes (an identifier in code's casing)
  // stay no value. A flag's name with no `=value`, a reference: kept.
  for (const text of [
    "db_password=userInput;",
    "  api_token=newToken; count++;",
    "client_secret=next_secret; done",
    "docker run --rm -e POSTGRES_PASSWORD -e API_KEY -p 5432:5432 postgres:17",
    "kubectl create secret generic db-credentials --from-literal=password=$DB_PASSWORD --dry-run=client -o yaml",
    "docker run -e db_password=${DB_PASSWORD} img",
  ]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});

test("LXXI: a form's password: Rails' user[password] raw or encoded, *_password and password_confirmation at any length, the value to its argument's end", async () => {
  const pw = "Tq7Wm2Rk9Zx";
  await labelCutIn([
    `POST /users/sign_in user[login]=bob&user[password]=${pw}&commit=Log+in`,
    `user%5Blogin%5D=bob&user%5Bpassword%5D=${pw}&commit=Log+in`,
    `user%5Bpassword%5D=${pw}&x=1`,
    `curl -d "user[password]=${pw}" https://x.io`,
    `curl -d "user=bob&new_password=${pw}" https://x.io`,
    `?user=bob&password_confirmation=${pw}`,
    `?current_password=${pw}`,
    `&old_password=${pw}`,
    `?password=ab'${pw}`,
    `?password=ab\\${pw}`,
    `?password=ab[${pw}`,
    `?password=ab#${pw}`,
    `?password=ab<${pw}`,
  ], pw, "query-password");
  await labelCutIn(["login?user=bob&new_password=abc"], "abc", "query-password");
  // The value ends where its argument does: the quote, bracket or parenthesis the argument opened before the key.
  for (const [text, out] of [
    [`curl -d "user=bob&password=${pw}" https://x.io`, `curl -d "user=bob&password=[redacted:query-password]" https://x.io`],
    [`see [login](https://x.io/in?password=${pw}) next`, `see [login](https://x.io/in?password=[redacted:query-password]) next`],
    [`{"url":"https://x.io/in?password=${pw}","n":1}`, `{"url":"https://x.io/in?password=[redacted:query-password]","n":1}`],
    [`<https://x.io/in?password=${pw}> next`, `<https://x.io/in?password=[redacted:query-password]> next`],
  ]) assert.equal((await oneCut(text)).text, out);
  for (const text of ["https://x.io/a?password=&next=1", "https://x.io/a?new_password=$PW", "url = f\"?user={u}&new_password={pw}\"", "https://x.io/r?password_reset=1", "params[password]=pw", "form[password]=newPassword", "see [docs](https://x.io/in?password=$PW)"]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});
test("LXXVIII: a form password's value ends at a bracket only where the bracket ends its argument; inside a quote the quote decides (Greptile P1 on 59ed761265)", async () => {
  // Values under url-credential's 16 characters, so query-password alone decides (Greptile's `abcd)secret98`).
  const pw = "Tq7Wm2Rk";
  // A URL's own bracket is no argument's closer: its value runs on past it, to the quote or the blank.
  for (const [text, out] of [
    [`curl 'https://example.org/a(b?password=abcd)${pw}'`, `curl 'https://example.org/a(b?password=[redacted:query-password]'`],
    [`curl "https://example.org/a(b?password=abcd)"`, `curl "https://example.org/a(b?password=[redacted:query-password]"`],
    [`see https://example.org/a(b?password=abcd)${pw} next`, `see https://example.org/a(b?password=[redacted:query-password] next`],
    [`see https://example.org/a(b?password=abcd).${pw} next`, `see https://example.org/a(b?password=[redacted:query-password] next`],
    [`see <https://example.org/a?password=abcd>${pw} next`, `see <https://example.org/a?password=[redacted:query-password] next`],
    [`fetch("https://example.org/a[b?password=abcd]${pw}")`, `fetch("https://example.org/a[b?password=[redacted:query-password]")`],
  ]) assert.equal((await oneCut(text)).text, out);
  // An argument's bracket still ends it, before sentence punctuation too.
  for (const [text, out] of [
    [`(https://x.io/in?password=${pw}).`, `(https://x.io/in?password=[redacted:query-password]).`],
    [`[login](https://x.io/in?password=${pw}), then`, `[login](https://x.io/in?password=[redacted:query-password]), then`],
    [`foo("https://x.io/in?password=${pw}")`, `foo("https://x.io/in?password=[redacted:query-password]")`],
  ]) assert.equal((await oneCut(text)).text, out);
  // Inside a quote a bracket before the quote may be the value's own last character: it is cut with the value.
  assert.equal((await oneCut(`echo "(https://x.io/in?password=${pw})."`)).text, `echo "(https://x.io/in?password=[redacted:query-password]"`);
});

// ---------- the opus delta read on #3570 @ 59ed761265: LXXIX (P1-1), LXXX (P1-2) ----------

/** A PEM block as text, its body synthetic (no literal key header: the export-source scan), for LXXIX. */
const STRADDLE_PEM = `-----${"BEGIN"} PRIVATE KEY-----\n${R(64, 91)}\n${R(64, 92)}\n${R(64, 93)}\n${R(40, 94)}\n-----${"END"} PRIVATE KEY-----\n`;
const PEM_ANCHORS = /LS0tLS1CRUdJTi|0tLS0tQkVHSU4g|tLS0tLUJFR0lOI/;
/** `openssl pkcs12 -nodes | base64 -w<width>`'s shape: a Bag Attributes preamble whose friendlyName is `n` long, then
 *  the block; its wrap lines, and where the anchor stands in the unwrapped encoding. */
const pkcs12Wrap = (n, width) => {
  const enc = Buffer.from(`Bag Attributes\n    friendlyName: ${"a".repeat(n)}\nKey Attributes: <No Attributes>\n${STRADDLE_PEM}`).toString("base64");
  const m = PEM_ANCHORS.exec(enc);
  return { lines: enc.match(new RegExp(`.{1,${width}}`, "g")), anchor: m[0], at: m.index };
};

test("LXXIX: a base64 PEM whose BEGIN anchor straddles a wrap's line break is cut from that line on, for every encoding and split, at widths 64 and 76 and under a Read lead", async () => {
  const leads = { none: () => "", read: (k) => `${String(k).padStart(6)}→` };
  for (const width of [64, 76]) {
    const seen = new Set();
    for (let n = 0; n < 3 * width; n++) {
      const { lines, anchor, at } = pkcs12Wrap(n, width);
      const split = width - (at % width);
      if (split >= anchor.length) continue; // the anchor whole on one line: LXXIV's
      seen.add(`${anchor}/${split}`);
      const row = Math.floor(at / width);
      for (const [leadName, lead] of Object.entries(leads)) {
        if (leadName === "read" && width !== 76) continue;
        const text = [...lines, "$ ls -l"].map((line, k) => `${lead(k + 1)}${line}`).join("\n");
        const out = await gone(text, lines.slice(row + 1, -1).map((line) => line.slice(8, 32)));
        assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["base64-pem", "format", false]], `n=${n} width=${width} ${leadName}`);
        assert.ok(out.text.includes("$ ls -l") && out.text.includes(lines[0]), `n=${n} width=${width} ${leadName}: cut past its block: ${out.text.slice(0, 200)}`);
      }
    }
    // Every encoding of the anchor at every split a wrap of whole groups allows: offset 0 at 4, 8, 12; offset 1 at 2, 6,
    // 10; offset 2 at 1, 5, 9, 13.
    assert.equal(seen.size, 10, `width ${width}: ${[...seen].sort().join(" ")}`);
  }
  // In every wrapper, one straddling case of each width.
  for (const width of [64, 76]) {
    let n = 0;
    while (width - (pkcs12Wrap(n, width).at % width) >= 14) n++;
    const { lines, at } = pkcs12Wrap(n, width);
    for (const wrap of FOUR_WRAPS) await gone(wrap(lines.join("\n")), lines.slice(Math.floor(at / width) + 1, -1).map((line) => line.slice(8, 32)));
  }
  // A wrap of base64 that holds no PEM, at both widths: kept.
  const plain = Buffer.from(`Bag Attributes\n    friendlyName: ${"plain words, no key. ".repeat(12)}`).toString("base64");
  for (const width of [64, 76]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(plain.match(new RegExp(`.{1,${width}}`, "g")).join("\n")));
  }
  // Linear: a 2 MB stack of full wrap lines (each a break the straddle check reads), and of straddling blocks.
  const { lines } = pkcs12Wrap(Array.from({ length: 300 }, (_, n) => n).find((n) => 76 - (pkcs12Wrap(n, 76).at % 76) < 14), 76);
  for (const [name, piece] of [["full lines", `${"A".repeat(76)}\n`], ["straddling blocks", `${lines.join("\n")}\n$ ls\n`]]) {
    const { hits, ms } = await ruleAlone("base64-pem", repeatTo(piece, 2_000_000));
    assert.ok(ms < 2_000, `${name} x 2 MB: ${Math.round(ms)} ms CPU`);
    if (name === "straddling blocks") assert.ok(hits.length > 1000, `${name}: ${hits.length} hits`);
  }
});

test("LXXX: a camelCase credential name's DNS-1123-shaped value (a UUID, a passphrase, dotted words) is cut; only the existingSecret family names a Secret object by its resource name", async () => {
  for (const [text, secret] of [
    ["herokuApiKey: 3f9a1c2e-7b4d-4e8a-9c1f-2d3e4f5a6b7c", "3f9a1c2e-7b4d-4e8a-9c1f-2d3e4f5a6b7c"],
    ["dbPassword: tidal-oxide-lantern-gravel", "tidal-oxide-lantern-gravel"],
    ["clientSecret=tidal-oxide-lantern-gravel", "tidal-oxide-lantern-gravel"],
    ["authToken: abc123.def456.ghi789", "abc123.def456.ghi789"],
    ["vault:\n  clientSecret: tidal-oxide-lantern-gravel\n  role: app", "tidal-oxide-lantern-gravel"],
    ["secretKey: tidal-oxide-lantern-gravel", "tidal-oxide-lantern-gravel"],
  ]) await labelCutIn([text], secret, "secret-assign");
  // A Secret object named by its resource name under Helm's existingSecret family, a key inside it named under the
  // family's key names (Bitnami's existingSecretPasswordKey), and the names that only name one (secretName, secretRef,
  // existingSecretName: no credential word last): kept.
  for (const text of [
    "existingSecret: app-credentials",
    "auth.existingSecretPasswordKey: postgres-password",
    "existingSecretKey: api-key",
    "metrics.existingSecretUserKey: db-user",
    "auth:\n  existingSecretKey: api-key",
    "auth:\n  existingSecret: app-credentials\n  secretKeys:\n    adminPasswordKey: admin-password",
    "metrics:\n  metricsExistingSecret: metrics-credentials",
    "tls:\n  secretName: app-tls",
    "envFrom:\n  secretRef: app-credentials",
    "existingSecretName: app-credentials",
  ]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
  // Linear: secret-assign alone on 2 MB of camelCase name: resource-shaped value lines.
  for (const piece of ["dbPassword: tidal-oxide-lantern-gravel\n", "existingSecret: app-credentials\n"]) {
    const { ms } = await ruleAlone("secret-assign", repeatTo(piece, 2_000_000));
    assert.ok(ms < 2_000, `${JSON.stringify(piece)} x 2 MB: ${Math.round(ms)} ms CPU`);
  }
});

test("LXXXI: a flag's NAME=value takes a dotted name (helm --set, --set-string, kubectl --from-literal): a credential's is cut, any other dotted name's is kept", async () => {
  const pw = "Tq7Wm2Rk9Zx";
  await labelCutIn([
    `helm install x bitnami/postgresql --set db.password=${pw}`,
    `helm upgrade x . --set-string auth.password=${pw}`,
    `helm install pg bitnami/postgresql --set auth.postgresPassword=${pw}`,
    `kubectl create secret generic a --from-literal=db.password=${pw}`,
    `helm install x . --set=global.redis.password=${pw}`,
    `helm install x . --set db.user=u,db.password=${pw},image.tag=v1`,
    `helm install x . --set-string a=1,auth.postgresPassword=${pw}`,
    `helm install x . --set-file a=f.txt,db.password=${pw}`,
    `helm install x . --set "db.user=u,db.password=${pw}"`,
  ], pw, "secret-assign");
  // A `--set` list's every name=value is read, its value to the next unescaped `,` (`\,` stays in it): only the
  // credential's value is cut. `--set-literal` takes one name=value, commas and all.
  for (const [text, out] of [
    [`--set db.user=u,db.password=${pw},image.tag=v1`, "--set db.user=u,db.password=[redacted:secret-assign],image.tag=v1"],
    [`--set db.password=ab\\,${pw},image.tag=v1`, "--set db.password=[redacted:secret-assign],image.tag=v1"],
    [`--set-literal db.password=ab,${pw}`, "--set-literal db.password=[redacted:secret-assign]"],
  ]) assert.equal((await oneCut(text)).text, out);
  for (const text of [
    "helm install x . --set image.tag=v1",
    "helm install x . --set service.port=8080 --set replicaCount=2",
    "helm install x . --set image.tag=v1,replicas=2",
    "helm install x . --set auth.username=app",
    "helm install x . --set auth.password=$PG_PASSWORD",
    "kubectl create secret generic a --from-literal=db.password=${DB_PASSWORD}",
  ]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
  const unit = "--set auth.postgresPassword=abcdefghij --set image.tag=v1 ";
  // The rule alone reads a long line of them in time linear in it (as LXIX).
  const rule = SCRUB_RULES.find((each) => each.id === "secret-assign");
  for (const [size, bound] of [[400_000, 1_000], [2_000_000, 2_000]]) {
    const n = Math.floor(size / unit.length);
    const started = cpuNow();
    const out = await scrubWith([rule], unit.repeat(n), { mode: "count" });
    const took = cpuNow() - started;
    assert.equal(out.cuts.length, n);
    assert.ok(took < bound, `${size} chars: ${Math.round(took)} ms`);
  }
  // And long comma lists, each item's name read: 32 items a list, 16 of them credentials.
  const list = `--set ${Array.from({ length: 16 }, (_, i) => `app${i}.tag=v1,db${i}.password=abcdefghij`).join(",")} `;
  for (const [size, bound] of [[400_000, 1_000], [2_000_000, 2_000]]) {
    const n = Math.floor(size / list.length);
    const started = cpuNow();
    const out = await scrubWith([rule], list.repeat(n), { mode: "count" });
    const took = cpuNow() - started;
    assert.equal(out.cuts.length, n * 16);
    assert.ok(took < bound, `${size} chars of lists: ${Math.round(took)} ms`);
  }
});

test("LXXXII: a command's environment after `sudo`'s or `env`'s options and their arguments (`sudo -u app`, `sudo -E -u app`, `env -u HOME`) is cut", async () => {
  const pw = "Tq7Wm2Rk9Zx";
  await labelCutIn([
    `sudo -u app db_password=${pw} ./run.sh`,
    `sudo -E -u app db_password=${pw} ./run.sh`,
    `env -u HOME db_password=${pw} ./run.sh`,
    `sudo --user=app --preserve-env db_password=${pw} ./run.sh`,
    `$ sudo -u app -g staff db_password=${pw} api_mode=prod ./run.sh`,
  ], pw, "secret-assign");
  for (const text of [
    "sudo -u app db_password=$DB_PASSWORD ./run.sh",
    "env -u HOME db_password=${DB_PASSWORD} ./run.sh",
    "sudo -u app ./run.sh",
  ]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
  const unit = "sudo -E -u app db_password=abcdefghij ./run.sh\n";
  // The rule alone reads a long line of them in time linear in it (as LXIX).
  const rule = SCRUB_RULES.find((each) => each.id === "secret-assign");
  for (const [size, bound] of [[400_000, 1_000], [2_000_000, 2_000]]) {
    const n = Math.floor(size / unit.length);
    const started = cpuNow();
    const out = await scrubWith([rule], unit.repeat(n), { mode: "count" });
    const took = cpuNow() - started;
    assert.equal(out.cuts.length, n);
    assert.ok(took < bound, `${size} chars: ${Math.round(took)} ms`);
  }
});

test("LXXXIII: an ADO value runs over blanks only to its `;`, a tab, a line break or a JSON-escaped one (`\\n`, `\\r`, `\\t`); a spaced pair beside a pair before or after it is a connection string's", async () => {
  const pw = "Tq7Wm2Rk9Zx";
  await labelCutIn([
    `Server = db; Password = ${pw};`,
    `Password = ${pw}; Server=db`,
    `password = ${pw} host=db`,
  ], pw, "connection-string");
  // A connection string's known key among spaced pairs is a connection string's evidence: the value is cut whatever
  // its shape, an identifier's too.
  await labelCutIn(["Server = db; Password = MySecretPass;"], "MySecretPass", "connection-string");
  await labelCutIn(["Data Source = db; User Id = sa; Password = hunterTwo;"], "hunterTwo", "connection-string");
  await labelCutIn(["Password = hunterTwo; Initial Catalog = widgets"], "hunterTwo", "connection-string");
  // Key first, its pair after: the value runs to its `;`, every word in one cut.
  const first = `Password=Copper lumen ${pw};Server=db`;
  for (const wrap of FOUR_WRAPS) {
    const wrapped = wrap(first);
    const out = await gone(wrapped, ["Copper", "lumen", pw]);
    assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["connection-string", "label", true]], wrapped);
  }
  assert.equal((await oneCut(first)).text, "Password=[redacted:connection-string];Server=db");
  // The value stops at a JSON-escaped line break or tab as at a real one: what follows stays, the JSON stays valid.
  for (const esc of ["\\n", "\\r", "\\t"]) {
    const raw = `{"content":"conn: Server=db;Uid=sa;Pwd=Hunter2x9q ${esc}OK connected${esc}rows: 5"}`;
    const out = (await oneCut(raw)).text;
    assert.equal(out, `{"content":"conn: Server=db;Uid=sa;Pwd=[redacted:connection-string] ${esc}OK connected${esc}rows: 5"}`);
    JSON.parse(out);
  }
  for (const sep of ["\n", "\r\n", "\t"]) {
    for (const wrap of FOUR_WRAPS) {
      const wrapped = wrap(`conn: Server=db;Uid=sa;Pwd=${pw} ${sep}OK connected${sep}rows: 5`);
      const out = await gone(wrapped, [pw]);
      assert.ok(out.text.includes("OK connected"), out.text);
      if (wrapped.startsWith("{")) JSON.parse(out.text);
    }
  }
  // Code's spaced `=` beside a statement: code's shapes stay no value; beside spaced pairs only the slot is one code
  // fills, so an identifier in code's casing stays.
  for (const text of [
    "x = 1; password = config.password",
    "a = 1; password = userInput;",
    "int x=1; password = getPw();",
    "f(password = pw, host=db)",
    "the password = what you typed",
    // A quote as written ends the pairs read back from a key, in a JSON string's escape as anywhere: the same verdict
    // raw and wrapped.
    'conn = "Server=" + host; password = nextPassword;',
    'conn = "Server=db;Uid=sa" + suffix; password = nextPassword;',
  ]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
  // A JSON-escaped line of them: inputSpan finds each escape by halves, so the rule alone stays linear in it.
  const unit = ";Server = db;Pwd=ab cd \\nOK ";
  // The rule alone reads a long line of them in time linear in it (as LXIX).
  const rule = SCRUB_RULES.find((each) => each.id === "connection-string");
  for (const [size, bound] of [[600_000, 1_000], [2_000_000, 2_000]]) {
    const n = Math.floor(size / unit.length);
    const started = cpuNow();
    const out = await scrubWith([rule], unit.repeat(n), { mode: "count" });
    const took = cpuNow() - started;
    assert.equal(out.cuts.length, n);
    assert.ok(took < bound, `${size} chars: ${Math.round(took)} ms`);
  }
});

test("LXXXIV: an empty ADO field (`Application Name=;`) is a pair beside the key: the value runs over its blanks to its `;`, every word in one cut", async () => {
  const pw = "Tq7Wm2Rk9Zx";
  for (const text of [
    `Server=db;Application Name=;Password=Copper lumen ${pw};`,
    `Server=db; Application Name = ; Password=Copper lumen ${pw};`,
    `Password=Copper lumen ${pw};Application Name=;Server=db`,
  ]) {
    for (const wrap of FOUR_WRAPS) {
      const wrapped = wrap(text);
      const out = await gone(wrapped, ["Copper", "lumen", pw]);
      assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["connection-string", "label", true]], wrapped);
    }
  }
  assert.equal((await oneCut(`Server=db;Application Name=;Password=Copper lumen ${pw};`)).text, "Server=db;Application Name=;Password=[redacted:connection-string];");
  // Code's `==` is no empty pair: beside it a spaced key stays code's.
  for (const wrap of FOUR_WRAPS) await kept(wrap("x == 1; password = userInput;"));
});

test("LXXXV: helmSetLists reads each list once: a `--set` inside an earlier list's value is not read again (2 MB under 2 s, the rule alone)", async () => {
  const pw = "Tq7Wm2Rk9Zx";
  // A `--set` in every value of a long list: read from each, a list re-read up to 64 x 1024 (87 s at 2 MB).
  const piece = `x=${".--set=x=".repeat(113)},`;
  for (const [size, bound] of [[50_000, 250], [400_000, 1_000], [2_000_000, 2_000]]) {
    const { ms } = await ruleAlone("secret-assign", repeatTo(piece, size));
    assert.ok(ms < bound, `${size} chars: ${Math.round(ms)} ms CPU`);
  }
  // A list after them is still read, its credential cut.
  const out = await gone(`${repeatTo(piece, 20_000)}\nhelm install x . --set db.user=u,db.password=${pw},image.tag=v1`, [pw]);
  assert.ok(out.text.endsWith("--set db.user=u,db.password=[redacted:secret-assign],image.tag=v1"), out.text.slice(-120));
});

test("LXXXVI: a flag's NAME=value takes a dashed name (`--from-literal=postgres-password=v`, Bitnami's keys), as `--set` reads it: a credential's is cut, any other's is kept", async () => {
  const pw = "Tq7Wm2Rk9Zx";
  await labelCutIn([
    `kubectl create secret generic pg --from-literal=postgres-password=${pw}`,
    `kubectl create secret generic db --from-literal=db-password=${pw}`,
    `kubectl create secret generic r --from-literal=redis-password=${pw}`,
    `kubectl create secret generic a --from-literal=api-key=${pw}`,
    `kubectl create secret generic pg --from-literal postgres-password=${pw}`,
    `kubectl create secret generic pg --from-literal=my-app.db-password=${pw}`,
    `helm install pg bitnami/postgresql --set-literal postgres-password=${pw}`,
    `helm install pg bitnami/postgresql --set postgres-password=${pw}`,
    `docker build --build-arg api-key=${pw} .`,
  ], pw, "secret-assign");
  for (const text of [
    "kubectl create secret generic pg --from-literal=postgres-user=app",
    "kubectl create secret generic pg --from-literal=log-level=debug",
    "kubectl create secret generic pg --from-literal=postgres-password=$PG_PASSWORD",
    "kubectl create secret generic pg --from-literal=postgres-password=${PG_PASSWORD}",
  ]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
  // The rule alone reads a long line of them in time linear in it (as LXIX).
  const unit = "--from-literal=postgres-password=abcdefghij --from-literal=log-level=debug ";
  const rule = SCRUB_RULES.find((each) => each.id === "secret-assign");
  for (const [size, bound] of [[400_000, 1_000], [2_000_000, 2_000]]) {
    const n = Math.floor(size / unit.length);
    const started = cpuNow();
    const out = await scrubWith([rule], unit.repeat(n), { mode: "count" });
    const took = cpuNow() - started;
    assert.equal(out.cuts.length, n);
    assert.ok(took < bound, `${size} chars: ${Math.round(took)} ms`);
  }
});

test("LXXXVII: a tab inside an ADO value is the value's when its `;` follows on the line (`Pwd=Copper\\tlumen x;`), every word in one cut; with no `;` after it a tab ends the value (LXXXIII's column)", async () => {
  const pw = "Tq7Wm2Rk9Zx";
  for (const text of [
    `Server=db;Pwd=Copper\tlumen ${pw};`,
    `Server=db;Pwd=Copper \tlumen ${pw};Database=app`,
    `Password=Copper\tlumen ${pw};Server=db`,
  ]) {
    for (const wrap of FOUR_WRAPS) {
      const wrapped = wrap(text);
      const out = await gone(wrapped, ["Copper", "lumen", pw]);
      assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["connection-string", "label", true]], wrapped);
      if (wrapped.startsWith("{")) JSON.parse(out.text);
    }
  }
  assert.equal((await oneCut(`Server=db;Pwd=Copper\tlumen ${pw};`)).text, "Server=db;Pwd=[redacted:connection-string];");
  // No `;` after it on the line: a tab ends the value, what follows stays.
  for (const text of [`Server=db;Pwd=${pw}\tOK connected\trows: 5`, `Server=db;Pwd=${pw} \tOK connected\nrows: 5;`]) {
    for (const wrap of FOUR_WRAPS) {
      const out = await gone(wrap(text), [pw]);
      assert.ok(out.text.includes("OK connected"), out.text);
    }
  }
  // The rule alone reads a long line of tabbed values in time linear in it (as LXIX).
  const unit = "Server=db;Pwd=ab\tcd ef\tgh;";
  const rule = SCRUB_RULES.find((each) => each.id === "connection-string");
  for (const [size, bound] of [[400_000, 1_000], [2_000_000, 2_000]]) {
    const n = Math.floor(size / unit.length);
    const started = cpuNow();
    const out = await scrubWith([rule], unit.repeat(n), { mode: "count" });
    const took = cpuNow() - started;
    assert.equal(out.cuts.length, n);
    assert.ok(took < bound, `${size} chars: ${Math.round(took)} ms`);
  }
});

test("LXXXVIII: a value past VALUE's 1024-character bound is cut to its end (Greptile P1 on 55b0239695): bare to its run's end, quoted to its closing quote", async () => {
  const long = "Tq7Wm2Rk9Zx".repeat(137);
  const [head, tail] = [long.slice(0, 200), long.slice(-200)];
  for (const [text, after] of [
    [`curl --token ${long} https://x.io`, " https://x.io"],
    [`mysql --password=${long} -h db`, " -h db"],
    [`mysql --password="${long}" -h db`, '" -h db'],
    [`export DB_PASSWORD=${long}; make`, "; make"],
    [`export DB_PASSWORD='${long}'; make`, "'; make"],
    [`Server=db;Password=${long};Database=x`, ";Database=x"],
    [`helm install x . --set db.user=u,db.password=${long},image.tag=v1`, ",image.tag=v1"],
  ]) {
    for (const wrap of FOUR_WRAPS) {
      const out = await gone(wrap(text), [head, tail]);
      assert.equal(out.cuts.length, 1, `${JSON.stringify(out.cuts.map((cut) => cut.rule))} in ${wrap(text).slice(0, 60)}`);
      if (wrap === FOUR_WRAPS[0]) assert.ok(out.text.endsWith(after), out.text.slice(-80));
    }
  }
  // Under the bound nothing moves: the cut ends where the value does.
  assert.equal((await oneCut("mysql --password=Tq7Wm2Rk9Zx -h db")).text, "mysql --password=[redacted:password-flag] -h db");
  // The rule alone reads a long line of long values in time linear in it (as LXIX).
  const unit = `--token ${long} --token "${long}" `;
  const rule = SCRUB_RULES.find((each) => each.id === "password-flag");
  for (const [size, bound] of [[400_000, 1_000], [2_000_000, 2_000]]) {
    const n = Math.floor(size / unit.length);
    const started = cpuNow();
    const out = await scrubWith([rule], unit.repeat(n), { mode: "count" });
    const took = cpuNow() - started;
    assert.equal(out.cuts.length, 2 * n);
    assert.ok(took < bound, `${size} chars: ${Math.round(took)} ms`);
  }
});

test("LXXXIX: a URL's password past 1024 characters is still SECRET_SHAPES' URL with a password (Greptile P1 on 55b0239695): url-password cuts it, the final check sees it", async () => {
  const pw = "a1B2".repeat(275);
  const url = SECRET_SHAPES.find((shape) => shape.kind === "URL with a password");
  for (const text of [`redis://default:${pw}@cache:6379/0`, `postgres://app:${pw}@db:5432/x`]) {
    assert.equal(shapeSpans(text, url).length, 1, text.slice(0, 40));
    for (const wrap of FOUR_WRAPS) {
      const out = await gone(wrap(text), [pw.slice(0, 200), pw.slice(-200)]);
      assert.deepEqual(out.cuts.map((cut) => cut.rule), ["url-password"], wrap(text).slice(0, 60));
      if (wrap === FOUR_WRAPS[0]) assert.ok(/@(?:cache:6379\/0|db:5432\/x)$/.test(out.text), out.text.slice(-60));
    }
  }
  // Linear: SECRET_SHAPES' URL shape on 2 MB of userinfos that never reach an `@`, and of long ones that do.
  for (const piece of ["a://b:", `x://u:${"p".repeat(3000)} `, `x://u:${"p".repeat(3000)}@h `]) {
    const text = repeatTo(piece, 2_000_000);
    const started = cpuNow();
    const found = shapeSpans(text, url).length;
    const ms = cpuNow() - started;
    assert.equal(found, piece.endsWith("@h ") ? Math.ceil(2_000_000 / piece.length) : 0);
    assert.ok(ms < 2_000, `${JSON.stringify(piece.slice(0, 12))} x 2 MB: ${Math.round(ms)} ms CPU`);
  }
});

test("XC: each SECRET_SHAPES kind is one rule that reads every shape of that kind: GitHub's classic and fine-grained tokens are both github-token (redact/match.ts holds them as two shapes)", async () => {
  assert.ok(SECRET_SHAPES.length > new Set(SECRET_SHAPES.map((shape) => shape.kind)).size, "a kind with two shapes is still there to test");
  for (const token of [`ghp_${R(36, 21)}`, `github_pat_${R(22, 22)}_${R(59, 23)}`]) {
    for (const wrap of FOUR_WRAPS) {
      const out = await gone(wrap(`see ${token} end`), [token.slice(4, 30), token.slice(-30)]);
      assert.ok(out.cuts.some((cut) => cut.rule === "github-token"), `${wrap(token).slice(0, 40)}: ${JSON.stringify(out.cuts.map((cut) => cut.rule))}`);
    }
  }
});

test("XCI: pemBlocks reads a BEGIN line's end itself: a private-key span that is the whole block (redact/match.ts may read a block BEGIN to END) still cuts the same block as one that is its header alone", async () => {
  const { lineBounds, pemBlocks } = await import("../dist/secret-rules.js");
  const header = `-----${"BEGIN"} RSA PRIVATE KEY-----`;
  const end = `-----${"END"} RSA PRIVATE KEY-----`;
  const b64 = (n, seed) => R(n, seed).replace(/[^A-Za-z0-9]/g, "A");
  const body = [b64(64, 31), b64(64, 32), b64(20, 33)];
  const cases = [
    // [text, the block's end as a whole-block span gives it]
    [`k:\n${header}\n${body.join("\n")}\n${end}\ndone`, (t) => t.indexOf(end) + end.length],
    [`k:\n${header}\n${body.join("\n")}\n\nprose after`, (t) => t.indexOf(body[2]) + body[2].length],
    [`"k": "${header}\\n${body.join("\\n")}\\n${end}"`, (t) => t.indexOf(end) + end.length],
    [[`     1→${header}`, `     2→${body[0]}`, `     3→${body[1]}`, `     4→${body[2]}`, `     5→${end}`].join("\n"), (t) => t.indexOf(end) + end.length],
  ];
  for (const [text, blockEnd] of cases) {
    const start = text.indexOf(header);
    const lines = lineBounds(text);
    const byHeader = pemBlocks(text, [[start, start + header.length]], lines);
    const byBlock = pemBlocks(text, [[start, blockEnd(text)]], lines);
    assert.equal(byHeader.length, 1, `header span: ${text.slice(0, 60)}`);
    assert.deepEqual(byBlock.map(({ start, end }) => [start, end]), byHeader.map(({ start, end }) => [start, end]), `whole-block span: ${text.slice(0, 60)}`);
    for (const line of body) {
      const at = text.indexOf(line);
      assert.ok(byBlock[0].start <= at && at + line.length <= byBlock[0].end, `${line.slice(0, 12)} left in ${text.slice(0, 60)}`);
    }
  }
  // A span whose start holds no BEGIN line this rule reads (a header past its bound) falls back to the span's end.
  const long = `-----${"BEGIN"} ${"X".repeat(70)} PRIVATE KEY-----\n${body.join("\n")}`;
  assert.deepEqual(pemBlocks(long, [[0, long.indexOf("\n")]], lineBounds(long)).map(({ start, end }) => [start, end]), [[0, long.length]]);
});

test("XCII: a command's quoted part holds its shell operators (Greptile P1 on 683391d4fd): a quoted `&`, `;` or `|` no longer ends redis-cli, docker login, mysql, npm set or curl before its password", async (t) => {
  for (const [text, after] of [
    ["redis-cli -a 'Copper&lumen9' ping", " ping"],
    ['redis-cli -h cache -a "Copper;lumen9" ping', " ping"],
    ["docker login -u bot -p 'Copper|lumen9' registry.io", " registry.io"],
    ["mysql -u root -p'Copper&lumen9' app", " app"],
    ['mysql -h "db;1" -u root -pCopperXlumen9 app', " app"],
    ['npm config set //registry.npmjs.org/:_authToken "Copper&lumen9"', ""],
    ["curl -H 'X-A: a;b' -u admin:Copper9lumen9 https://x.io", " https://x.io"],
    ['curl -u "admin:Copper&&lumen9" https://x.io', " https://x.io"],
  ]) {
    const secret = text.includes("CopperX") ? ["CopperXlumen9"] : text.includes("Copper9") ? ["Copper9lumen9"] : ["Copper", "lumen9"];
    for (const wrap of FOUR_WRAPS) {
      const out = await gone(wrap(text), secret);
      if (wrap === FOUR_WRAPS[0]) assert.ok(out.text.endsWith(after), out.text);
    }
  }
  // An operator outside quotes still ends the command: the next command's `-p…`, `-a…` is no password.
  for (const text of ["mysql -u root -pTq7Wm2Rk9 app; grep -pattern file", "mysql -u root -p'Tq7&Wm2Rk9' app | grep -pattern", "redis-cli -a Tq7Wm2Rk9 ping && redis-cli2 -a notapassword"]) {
    const out = await gone(text, ["Tq7"]);
    assert.ok(out.text.endsWith(text.slice(text.search(/; |\| |&& /))), out.text);
  }
  // A quote left open on its line is a character, as before: the command still ends at the next operator.
  assert.ok((await gone("mysql -u root -pTq7Wm2Rk9 'app; grep -pattern file", ["Tq7Wm2Rk9"])).text.endsWith("; grep -pattern file"));
  // Each rule alone reads commands, quotes closed, open and escaped, linear by count: shell-lex.ts reads each character
  // at most 8 times (its counted measure, read past the 4096 window a command is read in, so 512 KB shows it).
  for (const unit of [`mysql -u r -p'${"a&".repeat(300)}' db `, `redis-cli -a "${'\\"'.repeat(400)} `, `curl -u "u:${"p;".repeat(300)}" -H 'a`, "redis-cli '\"".repeat(40), `docker login -p "${"\\".repeat(500)}`]) {
    for (const [id, perChar] of Object.entries(await rulesRead(["mysql-password", "password-flag", "curl-user"], repeatTo(unit, 512 * 1024)))) {
      assert.ok(perChar <= 8, `${id} on ${unit.slice(0, 20)}: ${perChar.toFixed(2)} reads a character`);
    }
  }
  // And their time grows with the text no faster than the text: each rule's whole work (its name scan, word values, the
  // text scan) on 2 MB against the same rule on 500 KB, timed in the same call, at most GROWTH times (four times the
  // text: a linear rule takes about 4, a quadratic one 16). A ratio of two runs in one call needs no absolute ceiling,
  // which the clock's spread across runs of the same code crosses. FLOOR_MS keeps a rule that does next to nothing at
  // 500 KB from dividing by noise. XCV's units (curl-user) and a path's options (`npm -x config -x`, pathEnd) are read
  // here too. Each size is timed 3 times, the sizes alternating (500 KB, 2 MB, 500 KB, …) so both see the same machine,
  // and each keeps its lowest time: noise only adds time, so the lowest is the estimate. One verdict a unit, never a
  // second timing after a fail: a retime that passes after a fail hides a real ratio. The time is wall time
  // (rulesWall), after a full gc(): process CPU time counts the JIT's and the collector's threads too, measured at
  // 1.5 to 2.3 times the wall time of the same call, and a call timed on a heap other calls left full pays their
  // garbage. With gc() first, a call pays only for what it allocates itself.
  const [GROWTH, FLOOR_MS] = [8, 20];
  /** The growth comparator: `big` (ms at 2 MB) at most GROWTH times the larger of `small` (ms at 500 KB) and FLOOR_MS. */
  const growthHolds = (label, small, big) => {
    const ratio = big / Math.max(small, FLOOR_MS);
    assert.ok(ratio <= GROWTH, `${label}: ${Math.round(small)} ms at 500 KB, ${Math.round(big)} ms at 2 MB, ${ratio.toFixed(2)} x (at most ${GROWTH})`);
  };
  // A control on the comparator, fixed timings: four times passes, sixteen times (a quadratic's) fails on its words.
  growthHolds("control 20/80", 20, 80);
  assert.throws(() => growthHolds("control 20/320", 20, 320), /control 20\/320: 20 ms at 500 KB, 320 ms at 2 MB, 16\.00 x \(at most/, "the growth check let 16 x through");
  const grows = async (ids, unit) => {
    const [smallText, bigText] = [repeatTo(unit, 500_000), repeatTo(unit, 2_000_000)];
    const runs = Object.fromEntries(ids.map((id) => [id, { small: [], big: [] }]));
    for (let i = 0; i < 3; i++) {
      for (const [size, text] of [["small", smallText], ["big", bigText]]) {
        const ms = await rulesWall(ids, text);
        for (const id of ids) runs[id][size].push(ms[id]);
      }
    }
    return Object.fromEntries(ids.map((id) => {
      const [small, big] = [Math.min(...runs[id].small), Math.min(...runs[id].big)];
      return [id, { small, big, ratio: big / Math.max(small, FLOOR_MS), runs: runs[id] }];
    }));
  };
  const every = ["mysql-password", "password-flag", "curl-user", "secret-assign"];
  const units = [
    ...[`mysql -u r -p'${"a&".repeat(300)}' db `, `redis-cli -a "${'\\"'.repeat(400)} `, `curl -u "u:${"p;".repeat(300)}" -H 'a`, "redis-cli '\"".repeat(40), `docker login -p "${"\\".repeat(500)}`, "npm set x ", "mysql ${a ${b ${c ", "redis-cli -h o'neil -a x 'y' "].map((unit) => [unit, every]),
    ...['curl -H "$(curl $(curl $(date)))" -u a:b ', 'curl "$(', "curl $(((((( -u a:b ", "curl \x60 -u a:b ", 'curl "\x60$(" -u a:b '].map((unit) => [unit, ["curl-user"]]),
    ["npm -x config -x ", ["secret-assign"]],
  ];
  for (const [unit, ids] of units) {
    const grew = await grows(ids, unit);
    for (const id of ids) {
      const { small, big, ratio, runs } = grew[id];
      const all = `\truns ${runs.small.map((ms) => ms.toFixed(1)).join("/")} | ${runs.big.map((ms) => ms.toFixed(1)).join("/")} ms`;
      t.diagnostic(`XCII\tgrowth\t${id}\t${small.toFixed(1)} ms at 500 KB\t${big.toFixed(1)} ms at 2 MB\t${ratio.toFixed(2)} x\t${JSON.stringify(unit.slice(0, 28))}${all}`);
      growthHolds(`${id} on ${unit.slice(0, 20)}`, small, big);
    }
  }
});

test("XCIV: a substitution inside curl's double quotes still ends curl, as the shell runs it there (Greptile P2 on 4cacd50606): `date -u +%H:%M` in it is no `-u user:pass`", async () => {
  for (const text of ['curl -H "X-Time: $(date -u +%H:%M)" https://x.io', 'curl -H "X-Time: \x60date -u +%H:%M\x60" https://x.io']) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
  // A quoted `-u` value before the substitution is still read, and one after it is another command's.
  await gone('curl -u "admin:Copper&lumen9" -H "X-Time: $(date)" https://x.io', ["Copper", "lumen9"]);
});

test("XCV: curl reads on past a substitution, its contents left out (Greptile P1 on 3e8ed77da8): a `-u` after `$(…)` or a backtick pair is cut, one inside it is not curl's, a curl inside it is read on its own", async () => {
  for (const text of [
    'curl -H "X-Time: $(date)" -u admin:Copper9lumen9 https://x.io',
    "curl -H \"X-Time: \x60date\x60\" -u admin:Copper9lumen9 https://x.io",
    "curl -H X-Time:$(date -u +%s) -u admin:Copper9lumen9 https://x.io",
    'curl -H "X-A: $(printf "%s" "$(date)")" -u admin:Copper9lumen9 https://x.io',
    'curl -H "X-T: $(curl -s -u admin:Copper9lumen9 https://t.io/token)" https://x.io',
  ]) {
    for (const wrap of FOUR_WRAPS) {
      const out = await gone(wrap(text), ["Copper9lumen9"]);
      if (wrap === FOUR_WRAPS[0]) assert.ok(out.text.includes("$(") || out.text.includes("\x60"), out.text);
    }
  }
  // A substitution as the whole password is a reference, as before XCII: no cut. One left open is a character (XCVI):
  // its line is read on, and the next line is another command.
  await kept('curl -u "admin:$(cat ~/.pw)" https://x.io');
  await kept("curl -H \"X: $(date https://x.io\n-u a:b");
  // curl-user alone reads nested, unclosed and repeated substitutions linear by count: at most 8 reads a character.
  // Their CPU is bounded relatively: in XCIX against main's span scan, and in XCII at 2 MB against 500 KB, each timed in
  // the same call. An absolute ceiling here sat inside the clock's spread across runs of the same code, so it bounded
  // nothing.
  for (const unit of ['curl -H "$(curl $(curl $(date)))" -u a:b ', 'curl "$(', "curl $(((((( -u a:b ", "curl \x60 -u a:b ", 'curl "\x60$(" -u a:b ']) {
    const { "curl-user": perChar } = await rulesRead(["curl-user"], repeatTo(unit, 512 * 1024));
    assert.ok(perChar <= 8, `${unit.slice(0, 20)}: ${perChar.toFixed(2)} reads a character`);
  }
});

test("XCVI: commands are read by one shell lexer (shell-lex.ts): an operator inside a substitution, a substitution of any length or left open, ANSI-C quoting and a continuation line no longer end a command before its password", async () => {
  for (const text of [
    "redis-cli -h $(hostname; true) -a Copper9lumen9 ping",
    "mysql -h \x60hostname;true\x60 -pCopper9lumen9 app",
    `curl -H "X: $(printf '%s' ${"a".repeat(300)})" -u admin:Copper9lumen9 https://x.io`,
    "curl $'-u' admin:Copper9lumen9 https://x.io",
    "docker login -u bot -p $'Copper9lumen9' registry.example.io",
    'curl -H "X: $(date https://x.io -u admin:Copper9lumen9',
    "redis-cli -h db \\\n  -a Copper9lumen9 ping",
    "redis-cli -h db -a \\\n  Copper9lumen9 ping",
  ]) {
    for (const wrap of FOUR_WRAPS) await gone(wrap(text), ["Copper9lumen9"]);
  }
  // As before the lexer, redis-cli (not curl, XCIV) reads a substitution's words as its own: an over-cut kept for parity.
  await gone("redis-cli -h $(vault read -field=x -a Copper9lumen9) ping", ["Copper9lumen9"]);
  // As before (XXIV), a lone `&` does not end curl: it is a URL's query far more often than a background job.
  await gone("curl https://x.io/?a=1&b=2 -u admin:Copper9lumen9", ["Copper9lumen9"]);
  // A line break still ends a command.
  await kept("redis-cli -h db\n-a Copper9lumen9");
  // A command's name ends at a blank, as before the lexer: `curl-user:label` is one word, not curl and `-user:label`.
  // And a substitution that closed inside one left open, or that the open one read inside its quotes (a curl named in
  // them), is still a substitution to the next curl that reaches it.
  for (const text of ["auth-header:label curl-user:label home-path:personal", '  "curl-user": "label",', '{ id: "curl-user", text: "curl https://x.io" }', "curl -s $(cat f; curl -s x $(date -u +%H:%MZ)", "curl -s $(cat f|'curl -s ''$(date -u +%H:%M:%S)'"]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});

test("XCVII: the command readers cut every password the text scan before the lexer cut: a quote or `${` after the name, a name not followed by a blank, a password glued to `&` `(` `)` `<` `>`, a substitution inside `${…}` or `$\"…\"`, a same-name command inside an earlier one's read", async () => {
  const pw = "Copper9lumen9";
  for (const text of [
    // A quote or `${` after the name pairs with a later one on the line: the flag inside is read still.
    `redis-cli -h o'neil -a ${pw} ping 'x'`,
    `redis-cli -h db's -a ${pw} ping  # Bob's box`,
    `mysql -h o'neil -p${pw} app 'x'`,
    `docker login -u o'neil -p ${pw} r.io 'x'`,
    `npm config set o'x //r/:_authToken ${pw} 'y'`,
    `curl -H 'it's' -u admin:${pw} https://x 'y'`,
    `curl -d o'neil -u admin:${pw} https://x 'y'`,
    `redis-cli -h \${HOST -a ${pw} }`,
    `mysql -h \${HOST -p${pw} }`,
    `docker login -u \${HOST -p ${pw} }`,
    `curl -H \${HOST -u admin:${pw} }`,
    `{"type":"text","text":"redis-cli -h \${HOST -a ${pw}"}`,
    `{"cmd":"redis-cli -h 'db -a ${pw}","note":"it's"}`,
    `redis-cli -h 'db -a ${pw} x'`,
    `mysql -e "select 1 -p${pw}"`,
    `curl -H "X: a -u admin:${pw}" https://x`,
    // A command of the same name inside an earlier one's read is read on its own.
    `redis-cli -h o'neil ping; redis-cli -a ${pw} ping 'x'`,
    // A name the shell reads as the command, with no blank after it as written.
    `curl.exe -u admin:${pw} https://x`,
    `C:\\tools\\curl.exe --user admin:${pw} https://x`,
    `redis-cli.exe -a ${pw} ping`,
    `'curl' -u admin:${pw} https://x`,
    `"curl" -u alice:${pw} https://example.com`,
    `'redis-cli' -a ${pw}`,
    `$'curl' -u admin:${pw} https://x`,
    `curl\u00a0-u admin:${pw}`,
    `curl\u3000-u admin:${pw}`,
    // A password glued to an operator character, cut whole.
    `curl -u admin:Copper&9lumen9 https://x`,
    `curl --user admin:Copper&9lumen9 https://x`,
    `curl -u admin:Copper(9lumen9 https://x`,
    `curl -u admin:Copper)9lumen9 https://x`,
    `curl -u admin:Copper<9lumen9 https://x`,
    `curl -u admin:Copper>9lumen9 https://x`,
    `curl -u admin:${pw}<in`,
    // A command inside a substitution inside `${…}` or `$"…"`, and a non-curl reader's flag inside `"$(…)"`.
    `curl -H \${x:-$(curl -u admin:${pw} https://x.io)} https://x.io`,
    `curl -H $"$(curl -u admin:${pw} https://x.io)" https://x.io`,
    `curl -H "\${x:-$(curl -u admin:${pw} https://x.io)}" https://x.io`,
    `redis-cli -h \${h:-$(redis-cli -a ${pw} get h)} ping`,
    `redis-cli -h "$(vault read -a ${pw})" ping`,
  ]) {
    for (const wrap of FOUR_WRAPS) await gone(wrap(text), ["Copper", "lumen9"]);
  }
  // A redirection's target is no argument: `>-a` names a file. A glued descriptor is no argument either.
  for (const text of ["redis-cli >-a report.txt ping", "redis-cli 2>-a report.txt ping", "docker login >-p out.txt r.io", "curl-user:label -u x"]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
  for (const text of [`redis-cli -h db 2>/dev/null -a ${pw} ping`, `redis-cli >log 2>&1 -a ${pw} ping`, `redis-cli ping >"$(redis-cli -a ${pw} get f)"`]) {
    for (const wrap of FOUR_WRAPS) await gone(wrap(text), [pw]);
  }
});

test("XCVIII: the lexer read cuts where the span scan beside it does not: a name quoted (a path with blanks inside the quotes too), with .exe, .cmd or a Windows path, continued or followed by a wide blank; a wide blank before a flag or its value; anything between a program and its subcommand; a descriptor redirection before the flag", async () => {
  const pw = "Copper9lumen9";
  for (const text of [
    `"mysql" -h db -p${pw} app`,
    `'docker' login -u bot -p ${pw} r.io`,
    `$'npm' config set //r/:_authToken ${pw}`,
    `mysql.exe -h db -p${pw} app`,
    `C:\\tools\\docker.exe login -u bot -p ${pw} r.io`,
    `npm.exe config set //r/:_authToken ${pw}`,
    `npm.cmd config set //r/:_authToken ${pw}`,
    `"C:\\Program Files\\Docker\\docker.exe" login -u bot -p ${pw} r.io`,
    `"C:\\Program Files\\MySQL\\MySQL Server 8.0\\mysql.exe" -u root -p${pw} -e "SHOW DATABASES"`,
    `"C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe" login -u bot -p ${pw} r.io`,
    `"C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe" -u root -p${pw} -e "SHOW DATABASES"`,
    `redis-cli \\\n  -h db -a ${pw} ping`,
    `mysql \\\n  -h db -p${pw} app`,
    `docker \\\n  login -u bot -p ${pw} r.io`,
    `npm \\\n  config set //r/:_authToken ${pw}`,
    `mysql\u3000-h db -p${pw} app`,
    // A wide blank glued to the flag, the value or the subcommand: bash would read one word, the text still holds it.
    `redis-cli\u00a0-a ${pw} ping`,
    `redis-cli -h db -a\u00a0${pw} ping`,
    `mysql\u00a0-p${pw} app`,
    `mysql -h db\u00a0-p${pw} app`,
    `docker\u00a0login -u bot -p ${pw} r.io`,
    `docker\u3000login -u bot -p ${pw} r.io`,
    `docker login -u bot\u00a0-p ${pw} r.io`,
    `npm\u00a0config set //r/:_authToken ${pw}`,
    `npm config\u3000set //r/:_authToken ${pw}`,
    `npm set //r/:_authToken\u00a0${pw}`,
    // Between a program and its subcommand: a redirection, an option and its value, an escaped blank.
    `docker >out.txt login -u bot -p ${pw} r.io`,
    `npm 2>&1 config set //r/:_authToken ${pw}`,
    `npm --userconfig ~/.npmrc-ci config set //r/:_authToken ${pw}`,
    `docker -D login -u bot -p ${pw} r.io`,
    `npm -g set //r/:_authToken ${pw}`,
    `docker\\ login -u bot -p ${pw} r.io`,
    `redis-cli &>all -h db -a ${pw} ping`,
    `mysql >&2 -h db -p${pw} app`,
    `redis-cli 2>&1 -h db -a ${pw} ping`,
  ]) {
    for (const wrap of FOUR_WRAPS) await gone(wrap(text), [pw]);
  }
  // A registry tool running another subcommand is no login: its `-p` is a port.
  for (const text of ["docker run -p 8080:80 img", "docker run img login -p 8080", "podman --remote run -p 5432 db"]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});

test("C: rows only the lexer read cuts, one for each lexer behaviour the span scan would hide: a double-quoted name, curl past a lone `&`, the glued run and its tail past 1024 characters, a command re-read inside an earlier one's quotes", async () => {
  const pw = "Copper9lumen9";
  for (const [text, secrets] of [
    // The double-quoted name (the scan needs a blank after `mysql`, and LOGIN_SCAN one after `docker`).
    [`"mysql" -h db -p${pw} -e "select 1"`, [pw]],
    [`"docker" login -u bot -p ${pw} r.io`, [pw]],
    // curl reads on over a lone `&` (ruling XXIV); `$'-u'` is no `-u` to the scan.
    [`curl https://x.io/?a=1&b=2 $'-u' admin:${pw}`, [pw]],
    // The glued run: the shell ends the word at `&`, the password does not.
    [`curl $'-u' admin:Copper&9lumen9 https://x.io`, ["Copper", "&9lumen9"]],
    [`curl $'-u' admin:Copper&${"x".repeat(1100)}TAILMARK9 https://x.io`, ["Copper", "TAILMARK9"]],
    // A command named inside the quotes an earlier one paired (`o'neil … 'x'`) is read again; the scan names no `mysql.exe`.
    [`mysql.exe -h o'neil app; mysql.exe -p${pw} app 'x'`, [pw]],
  ]) {
    for (const wrap of FOUR_WRAPS) await gone(wrap(text), secrets);
  }
});

test("CI: the re-read budget: a command named inside an earlier command's read is read again only within half a read a character, so a run of one command reads each character about twice, not once for every command in reach", async () => {
  // Every command here is named inside the read before it (no operator ends one): past the budget the next is looked
  // for past the earlier read's end. Without the budget each would read to the shared limit again, hundreds of reads
  // a character. 64 KB keeps that case quick, so a lost budget fails here on its count and not on a clock.
  for (const [id, unit] of [["curl-user", "curl -u a:b "], ["password-flag", "redis-cli -a x "], ["password-flag", "docker login -p x "], ["mysql-password", "mysql -p x "], ["secret-assign", "npm set x "]]) {
    const { [id]: perChar } = await rulesRead([id], repeatTo(unit, 64 * 1024));
    assert.ok(perChar <= 3, `${id} on ${JSON.stringify(unit)}: ${perChar.toFixed(2)} reads a character, past the re-read budget`);
  }
});

test("CII: the lexer read takes options between `config` and `set`, a login's glued `-p<pw>`, a Windows extension in any case (the name too, with one) and `.bat`/`.ps1`", async () => {
  const pw = ["Copper9", "lumen9"].join("");
  for (const text of [
    // Options between a path's words (`config … set`), with a value too.
    `npm config --global set //r/:_authToken ${pw}`,
    `npm config --location=user set //r/:_authToken ${pw}`,
    `npm config --userconfig ~/.npmrc-ci set //r/:_authToken ${pw}`,
    // A registry login reads a short flag's value glued on.
    `docker login -u bot -p${pw} r.io`,
    `podman login -p${pw} r.io`,
    // Windows names files without case.
    `"C:\\Program Files\\Docker\\docker.EXE" login -u bot -p ${pw} r.io`,
    `Docker.exe login -u bot -p ${pw} r.io`,
    `MYSQL.EXE -h db -p${pw} app`,
    `REDIS-CLI.EXE -a ${pw} ping`,
    `npm.bat config set //r/:_authToken ${pw}`,
    `npm.ps1 config set //r/:_authToken ${pw}`,
  ]) {
    for (const wrap of FOUR_WRAPS) await gone(wrap(text), [pw]);
  }
  // A glued `-p` outside a login is a port; a bare name keeps its case (`Docker` in prose names no command).
  for (const text of ["docker run -p8080:80 img", "Docker login -p 8080"]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});

test("CIII: a Windows path read never leaves what the escape read cuts, and a quoted drive path ends at its closing quote", async () => {
  const pw = ["Copper9", "lumen9"].join("");
  // A JSON string that starts like a drive and holds escapes, closed or left open: the path read keeps `\t` and `\n` as
  // written, so `--password` meets a backslash. The escape read beside it (every escape blanked, as main reads it) meets
  // blanks and cuts.
  for (const text of [`{"t":"Q:\\tmysql --password\\n${pw}"}`, `"Q:\\tmysql --password\\n${pw}`]) {
    for (const wrap of FOUR_WRAPS) await gone(wrap(text), [pw]);
  }
  // A quote left open is no quoted path: the `\n` after the password stays an escape, so the value ends at it and the
  // next line's word stays.
  const out = await gone(`echo 'C:\\x; redis-cli -a ${pw}\\nINFO done`, [pw]);
  assert.ok(out.text.endsWith("\\nINFO done"), `the value ran on: ${JSON.stringify(out.text)}`);
});

test("CIV: the command readers hold one command's words at a time, however long the text: at 2 MB at most SHELL_LINE_MAX words held at once", async () => {
  // Words kept for every command until the last is read are a live set that grows with the text, and the collector's
  // work on it grows faster than the text (mysql-password on `mysql ${a`: 616K words held at 2 MB). Handed out one
  // command at a time, the most held at once is one read's words (at most 920 on these units, the same at 500 KB): a
  // count, so it holds on any box. The units name a command every few characters, each read reaching the next ones.
  const { SHELL_LINE_MAX } = await import("../dist/secret-rules.js");
  const { lexCount } = await import("../dist/shell-lex.js");
  for (const [id, unit] of [["mysql-password", "mysql ${a ${b ${c "], ["password-flag", "redis-cli -h o'neil -a x 'y' "], ["password-flag", "docker login -p x "], ["curl-user", 'curl "$('], ["secret-assign", "npm set x "]]) {
    lexCount.held = 0;
    await rulesRead([id], repeatTo(unit, 2_000_000));
    assert.ok(lexCount.held <= SHELL_LINE_MAX, `${id} on ${JSON.stringify(unit)}: commandWords held ${lexCount.held} words at once at 2 MB, past ${SHELL_LINE_MAX}`);
  }
});

test("CVI: a subcommand read looks a path's next word up through one index per command read: on `npm -x config -x ` at 512 KB, at most 4 words looked at a character", async () => {
  // Every `config` here is an option's value, so each one is tried as the start of `config set` and looks `set` up.
  // The index is built once a read: 0.33 words a character (measured, lexCount.passed). Built afresh for each
  // `config`, it costs a read's words for each one: a constant factor (the read is capped) far past 4, so a time bound
  // catches it only sometimes and this count always.
  const { lexCount } = await import("../dist/shell-lex.js");
  const text = repeatTo("npm -x config -x ", 512 * 1024);
  lexCount.passed = 0;
  await rulesRead(["secret-assign"], text);
  const perChar = lexCount.passed / text.length;
  assert.ok(perChar <= 4, `secret-assign on "npm -x config -x " at 512 KB: ${perChar.toFixed(2)} words passed over a character, past 4`);
});

test("CVII: a password after `npm config set` is cut however many option words stand between `config` and `set`: 8 to 64 options of three forms, raw and in a JSON string", async () => {
  // Past PATH_GAP option words the read stops walking options one by one; it must still find `set` and cut the value
  // after its key, never skip the command.
  const pw = ["Copper9", "lumen9"].join("");
  const FORMS = { "-a 1": () => ["-a", "1"], "--x=y": () => ["--x=y"], quoted: (i) => (i % 2 ? ["--x='y z'"] : ["-a", '"v w"']) };
  const left = [];
  let rows = 0;
  for (const [form, words] of Object.entries(FORMS)) {
    for (const n of [8, 9, 16, 64]) {
      const command = ["npm", "config", ...Array.from({ length: n }, (_, i) => words(i)).flat(), "set", "//r/:_authToken", pw].join(" ");
      for (const [wrap, text] of [["raw", `$ ${command}\n`], ["json", `${JSON.stringify({ command })}\n`]]) {
        rows++;
        const out = await scrub(text, { mode: "cut" });
        assert.equal(out.ok, true, `failed closed on ${JSON.stringify(text.slice(0, 120))}`);
        if (out.text.includes(pw)) left.push(`${form} x${n} ${wrap}`);
      }
    }
  }
  assert.deepEqual(left, [], `npm config set behind option words: password left on ${left.length} of ${rows} rows: ${left.join(", ")}`);
});

test("XCIX: the shipped readers at 512 KB: at most 8 counted reads a character over the lexer test's units, 12 where a command is named inside the quotes of an unclosed construct, and each unit's rule CPU bounded against main's span scan for that rule, timed in the same call", async (t) => {
  const ruleOf = (unit) => (unit.startsWith("curl") ? "curl-user" : unit.startsWith("mysql") ? "mysql-password" : unit.startsWith("npm") ? "secret-assign" : "password-flag");
  const units = [
    'curl -H "$(curl $(curl $(date)))" -u a:b ', 'curl "$(', "curl $(((((( -u a:b ", "curl \x60 -u a:b ", 'curl "\x60$(" -u a:b ',
    `mysql -u r -p'${"a&".repeat(300)}' db `, `redis-cli -a "${'\\"'.repeat(400)} `, `curl -u "u:${"p;".repeat(300)}" -H 'a`, "redis-cli '\"".repeat(40), `docker login -p "${"\\".repeat(500)}`,
    'curl "', "curl '", "curl $(", "curl \x60", "curl $'", "curl ${", "curl <(", "curl $((", "curl $( $( ", 'curl "$(\x60',
    "curl $( $(a) ", 'curl "$(echo "b") ', "curl ${a:-${b} ", "curl -s $(cat f; curl -s x $(date -u +%H:%MZ) ", "curl $(a; ", 'curl "$(a; ', "curl $(a $(b); ",
    "npm set x ", "mysql ${a ${b ${c ", "redis-cli -h o'neil -a x 'y' ", "npm -x config -x ",
  ];
  // CPU beside the count: the count sees the lexer only, the time sees the rule's whole work. The yardstick is main's
  // span scan, timed in the same call on the same text: a unit's rule may take at most SCAN_TIMES the larger of its
  // own rule's scan and REF, the scan of one heavy unit (`curl $(` at 512 KB, the slowest scan of these units) timed
  // here, so a unit whose scan takes a millisecond is not held to a ratio of noise. CEILING_MS catches a blow-up on any
  // box. Measured at 512 KB (rule / max(scan, REF), the largest unit's): main's scrubber up to 1.96; this one 3.4 to 6.1
  // across runs at one head, the clock's spread.
  // A unit over its bound is timed once more and the faster run kept (the count is exact; the clock is not).
  const [SCAN_TIMES, CEILING_MS] = [12, 5_000];
  const { SPAN_SCANS } = await import("../dist/secret-rules.js");
  const scanMs = (text) => {
    const before = process.cpuUsage();
    SPAN_SCANS["curl-user"](text);
    const used = process.cpuUsage(before);
    return (used.user + used.system) / 1000;
  };
  const heavy = repeatTo("curl $(", 512 * 1024);
  const REF = Math.min(scanMs(heavy), scanMs(heavy));
  t.diagnostic(`XCIX\tREF\t${REF.toFixed(1)} ms\t(main's curl-user scan of "curl $(" at 512 KB)`);
  const bounded = async (id, unit, most) => {
    const text = repeatTo(unit, 512 * 1024);
    let cost = await ruleCost(id, text);
    const label = `${id} on ${JSON.stringify(unit.slice(0, 24))}`;
    assert.ok(cost.perChar <= most, `${label}: ${cost.perChar.toFixed(2)} reads a character`);
    const limit = (c) => Math.min(CEILING_MS, SCAN_TIMES * Math.max(c.scan, REF));
    if (cost.ms > limit(cost)) {
      const again = await ruleCost(id, text);
      if (again.ms < cost.ms) cost = again;
    }
    t.diagnostic(`XCIX\t${id}\t${cost.ms.toFixed(1)} ms\tscan ${cost.scan.toFixed(1)} ms\t${(cost.ms / Math.max(cost.scan, REF)).toFixed(2)} x\t${cost.perChar.toFixed(2)} reads\t${JSON.stringify(unit.slice(0, 28))}`);
    assert.ok(cost.ms <= limit(cost), `${label}: ${Math.round(cost.ms)} ms; main's scan ${cost.scan.toFixed(1)} ms, REF ${REF.toFixed(1)} ms (at most ${SCAN_TIMES} x the larger, and ${CEILING_MS} ms)`);
  };
  for (const unit of units) await bounded(ruleOf(unit), unit, 8);
  for (const unit of ["curl $(x|'curl ''$(a ", "curl -s $(cat f|'curl -s ''$(date -u +%H:%M:%S)' ", "curl $(x|'curl ${a:-$(a ", "curl $(x|'curl ${a:-$(a; ", `curl "$(x|'curl "$(a; `]) {
    await bounded("curl-user", unit, 12);
  }
});

test("XCIII: a query or form password past 1024 characters is cut to its end (Greptile P1 on 683391d4fd): QUERY_PASSWORD's bound no longer leaves its tail", async () => {
  const long = "Tq7Wm2Rk9Zx".repeat(137);
  const [head, tail] = [long.slice(0, 200), long.slice(-200)];
  for (const [text, after] of [
    [`https://x.io/reset?new_password=${long}`, ""],
    [`https://x.io/reset?new_password=${long}&next=/home`, "&next=/home"],
    [`curl "https://x.io/?password=${long}" -o out`, '" -o out'],
    [`curl -d "user[password]=${long}&remember=1" https://x.io`, "&remember=1\" https://x.io"],
  ]) {
    for (const wrap of FOUR_WRAPS) {
      const out = await gone(wrap(text), [head, tail]);
      if (wrap === FOUR_WRAPS[0]) assert.ok(out.text.endsWith(after), out.text.slice(-80));
    }
  }
  // The rule alone reads 2 MB of long values in CPU time linear in it (LXXXVIII's 2 MB bound): values apart, and values one run holds.
  for (const unit of [`?password=${long}& `, `?password=${"a".repeat(1100)}`, `"?password=${"a".repeat(1100)}"`, `'?password=${"a".repeat(1100)}'`]) {
    const { hits, ms } = await ruleAlone("query-password", `x${repeatTo(unit, 2_000_000)}`);
    assert.ok(hits.length >= 1, unit.slice(0, 20));
    assert.ok(ms < 2_000, `${unit.slice(0, 20)}: ${Math.round(ms)} ms`);
  }
});

test("LXXII: a camelCase credential name's unquoted value (YAML, Helm, a config line) is cut; code's camelCase identifiers, types and references stay", async () => {
  const pw = "Tq7Wm2Rk9Zx";
  await labelCutIn([
    `dbPassword: ${pw}`,
    `clientSecret: ${pw}`,
    `accessToken: ${pw}`,
    `apiToken: ${pw}`,
    `authToken=${pw}`,
    `dbPassword=${pw}`,
    `npmAuthToken: ${pw}`,
    `secrets:\n  dbPassword: ${pw}`,
    `  dbPassword = ${pw}`,
  ], pw, "secret-assign");
  // Code's evidence (a declaration, an entry's end, a call, a type, a reference) decides as for any other name; a Helm
  // reference to a Secret object by its resource name (`existingSecret: app-credentials`) is no value.
  for (const text of [
    "const dbPassword = getPw()",
    "const dbPassword = rawPassword",
    "{dbPassword: pw}",
    "  dbPassword: dbPassword,",
    "return { clientSecret: clientSecret }",
    "dbPassword: string",
    "  accessToken: string;",
    "apiToken: SecretStr",
    "  clientSecret: process.env.CLIENT_SECRET",
    "this.authToken = token;",
    "const clientSecret = cfg.clientSecret;",
    "auth:\n  existingSecret: app-credentials\n  secretKeys:\n    adminPasswordKey: admin-password",
  ]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});


// ---------- the opus re-read on #3570 @ f7284f0055: LXXIII-LXXVII (perf, LXII a/b/d, LVIII near-variants) ----------

/** One rule's find on `text` alone, in the context the engine builds for a view (secret-cut.ts contextOf): the raw view,
 *  its line bounds, nothing held, `extra` (a call's command or path). Its hits, and the CPU time it took in ms. */
const ruleAlone = async (id, text, extra = {}) => {
  const { lineBounds } = await import("../dist/secret-rules.js");
  const rule = SCRUB_RULES.find((each) => each.id === id);
  const [view] = secretCut.viewsOf(text);
  const ctx = { held: [], source: view.source, homes: [], lint: async () => [], lines: lineBounds(view.text, ...view.decodedStrings, view.strings), ...extra };
  const before = process.cpuUsage();
  const hits = await rule.find(view.text, ctx);
  const used = process.cpuUsage(before);
  return { hits, ms: (used.user + used.system) / 1000 };
};
const repeatTo = (piece, size) => piece.repeat(Math.ceil(size / piece.length));
/** Several rules on one text, its views read once: the characters shell-lex.ts read for each rule, per character of
 *  the text, by id (its counted measure). */
const rulesRead = async (ids, text) => {
  const { lineBounds } = await import("../dist/secret-rules.js");
  const { lexCount } = await import("../dist/shell-lex.js");
  const [view] = secretCut.viewsOf(text);
  const ctx = { held: [], source: view.source, homes: [], lint: async () => [], lines: lineBounds(view.text, ...view.decodedStrings, view.strings) };
  const out = {};
  for (const id of ids) {
    lexCount.read = 0;
    await SCRUB_RULES.find((each) => each.id === id).find(view.text, ctx);
    out[id] = lexCount.read / text.length;
  }
  return out;
};
/** A full garbage collection, for a timing that should not pay for other calls' garbage (node:test runs without
 *  --expose-gc: the flag is set here and gc taken from a fresh context). */
const collect = (() => {
  let gc;
  return () => {
    if (!gc) {
      v8.setFlagsFromString("--expose-gc");
      gc = vm.runInNewContext("gc");
    }
    gc();
  };
})();
/** Several rules on one text, its views read once: each rule's wall time in ms, by id, each after a full gc() (XCII). */
const rulesWall = async (ids, text) => {
  const { lineBounds } = await import("../dist/secret-rules.js");
  const [view] = secretCut.viewsOf(text);
  const ctx = { held: [], source: view.source, homes: [], lint: async () => [], lines: lineBounds(view.text, ...view.decodedStrings, view.strings) };
  const out = {};
  for (const id of ids) {
    const rule = SCRUB_RULES.find((each) => each.id === id);
    collect();
    const start = performance.now();
    await rule.find(view.text, ctx);
    out[id] = performance.now() - start;
  }
  return out;
};
/** One rule on one text, its views read once: the characters shell-lex.ts read per character of the text (the count),
 *  the rule's CPU ms, and main's span scan for that rule alone (secret-rules.ts SPAN_SCANS) on the same view text, timed
 *  in the same call: the yardstick XCIX bounds the rule's time against. */
const ruleCost = async (id, text) => {
  const { lineBounds, SPAN_SCANS } = await import("../dist/secret-rules.js");
  const { lexCount } = await import("../dist/shell-lex.js");
  const [view] = secretCut.viewsOf(text);
  const ctx = { held: [], source: view.source, homes: [], lint: async () => [], lines: lineBounds(view.text, ...view.decodedStrings, view.strings) };
  const rule = SCRUB_RULES.find((each) => each.id === id);
  lexCount.read = 0;
  let before = process.cpuUsage();
  await rule.find(view.text, ctx);
  let used = process.cpuUsage(before);
  const [perChar, ms] = [lexCount.read / text.length, (used.user + used.system) / 1000];
  before = process.cpuUsage();
  SPAN_SCANS[id](view.text);
  used = process.cpuUsage(before);
  return { perChar, ms, scan: (used.user + used.system) / 1000 };
};

test("LXXIII a: docker-auth reads many \"auth\" keys in linear time: \"auths\" and the call's paths are found once a text, never once a match", async () => {
  const command = `cat notes.txt ${"x ".repeat(500)}`;
  // The call's paths are split once a text: a 4 KB command over 6,000 matches is one split (a split once a match: ~2 s).
  {
    const { hits, ms } = await ruleAlone("docker-auth", repeatTo('{"auth":"abcd"},', 100_000), { command: `cat notes.txt ${"x ".repeat(2_000)}` });
    assert.ok(ms < 500, `4 KB command, 100 KB of "auth" keys: ${Math.round(ms)} ms CPU`);
    assert.deepEqual(hits, []);
  }
  // f7284f0055 searched back for "auths" and split the command once a match: ~2 s CPU here at 200 KB, over 120 s at 2 MB.
  for (const piece of ['{"auth":"abcd"},', '"auth": "abcd"\n']) {
    const { hits, ms } = await ruleAlone("docker-auth", repeatTo(piece, 200_000), { command });
    assert.ok(ms < 1_000, `${JSON.stringify(piece)} x 200 KB: ${Math.round(ms)} ms CPU`);
    assert.deepEqual(hits, []);
  }
  // The lead's bar: each 2 MB repro alone in under 2 s.
  for (const piece of ['{"auth":"abcd"},', '"auth": "abcd"\n']) {
    const { ms } = await ruleAlone("docker-auth", repeatTo(piece, 2_000_000), { command });
    assert.ok(ms < 2_000, `${JSON.stringify(piece)} x 2 MB: ${Math.round(ms)} ms CPU`);
  }
  // Still read where it was: under "auths", or in a config.json the command names.
  const v = Buffer.from(`bob:${R(14, 77)}`).toString("base64");
  assert.equal((await ruleAlone("docker-auth", `${'{"x":"y"},'.repeat(50)}{"auths":{"r.io":{"auth":"${v}"}}}`)).hits.length, 1);
  assert.equal((await ruleAlone("docker-auth", `{"auth": "${v}"}`, { command: "jq . ~/.docker/config.json" })).hits.length, 1);
  assert.equal((await ruleAlone("docker-auth", `{"auth": "${v}"}`, { command })).hits.length, 0);
});

test("LXXIII b: base64-pem reads a stack of wrap-width anchor lines in linear time: a wrap's lines are read once, never again from each line's anchor", async () => {
  // f7284f0055 restarted inside the wrap lines a hit had consumed: ~2.5 s CPU here at 300 KB, 26 s at 2 MB.
  for (const line of [`LS0tLS1CRUdJTi${"A".repeat(62)}\n`, `LS0tLS1CRUdJTi${"A".repeat(66)}\n`]) {
    const { hits, ms } = await ruleAlone("base64-pem", repeatTo(line, 300_000));
    assert.ok(ms < 1_000, `${line.length - 1}-column lines x 300 KB: ${Math.round(ms)} ms CPU`);
    assert.ok(hits.length > 0);
  }
  for (const line of [`LS0tLS1CRUdJTi${"A".repeat(62)}\n`, `LS0tLS1CRUdJTi${"A".repeat(66)}\n`]) {
    const { ms } = await ruleAlone("base64-pem", repeatTo(line, 2_000_000));
    assert.ok(ms < 2_000, `${line.length - 1}-column lines x 2 MB: ${Math.round(ms)} ms CPU`);
  }
});

/** A PEM block as text, its body synthetic, and that text base64'd whole after `pre` (bytes before the block). */
const PEM_TEXT = `-----${"BEGIN"} PRIVATE KEY-----\n${R(64, 71)}\n${R(64, 72)}\n${R(40, 73)}\n-----${"END"} PRIVATE KEY-----\n`;
const pemAt = (pre) => Buffer.concat([Buffer.from(pre), Buffer.from(PEM_TEXT)]).toString("base64");

const PEM_OFFSETS = {
  BOM: Buffer.from([0xef, 0xbb, 0xbf]),
  newline: Buffer.from("\n"),
  blank: Buffer.from(" "),
  pkcs12: Buffer.from("Bag Attributes\n    localKeyID: 01 02 03 04\nKey Attributes: <No Attributes>\n"),
};

test("LXXIV a: a base64 PEM at any offset of its encoding (a BOM, a line break, a blank, a pkcs12 preamble) is a format cut, its run whole", async () => {
  const offsets = PEM_OFFSETS;
  for (const [name, pre] of Object.entries(offsets)) {
    const enc = pemAt(pre);
    const middle = Math.floor(enc.length / 2);
    for (const text of [`tls:\n  key: ${enc}`, `  tls.key: ${enc}`]) {
      for (const wrap of FOUR_WRAPS) {
        const wrapped = wrap(text);
        const out = await gone(wrapped, [enc.slice(middle, middle + 24), enc.slice(-48, -24)]);
        assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["base64-pem", "format", false]], `${name}: ${wrapped.slice(0, 120)}`);
      }
    }
  }
  // Base64 of text with no PEM in it; an offset anchor glued after a letter (another run's middle, out of its
  // alignment): kept.
  const plain = Buffer.from(`\n${"plain words and no key in here. ".repeat(7)}`).toString("base64");
  for (const text of [`  tls.key: ${plain}`, `  x: Q${pemAt(offsets.newline)}`, `  x: QQQ${pemAt(offsets.BOM)}`]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});

test("LXXIV b: a base64 PEM's wrap under any line lead (Read, cat -n, grep with and without -n, a diff's +) is cut whole, the line after it kept", async () => {
  const offsets = PEM_OFFSETS;
  const leads = {
    none: () => "",
    read: (n) => `${String(n).padStart(6)}\u2192`,
    "cat -n": (n) => `${String(n).padStart(6)}\t`,
    grep: () => "secrets/key.b64:",
    "grep -n": (n) => `secrets/key.b64:${n}:`,
    "diff +": () => "+",
  };
  for (const pre of [Buffer.alloc(0), offsets.BOM, offsets.newline]) {
    const wrapLines = pemAt(pre).match(/.{1,76}/g);
    for (const [leadName, lead] of Object.entries(leads)) {
      const text = [...wrapLines, "$ ls -l"].map((line, i) => `${lead(i + 1)}${line}`).join("\n");
      for (const wrap of FOUR_WRAPS) {
        const wrapped = wrap(text);
        const out = await gone(wrapped, wrapLines.map((line) => line.slice(8, 32)));
        assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["base64-pem", "format", false]], `${leadName}: ${wrapped.slice(0, 120)}`);
        assert.ok(out.text.includes("$ ls -l"), `${leadName}: cut past its block: ${out.text.slice(-80)}`);
      }
    }
  }
  // Base64 of text with no PEM in it, wrapped under a lead: kept.
  const plain = Buffer.from(`\n${"plain words and no key in here. ".repeat(7)}`).toString("base64");
  for (const text of [plain.match(/.{1,76}/g).map((line, i) => `${String(i + 1).padStart(6)}\u2192${line}`).join("\n"), plain.match(/.{1,76}/g).map((line) => `+${line}`).join("\n")]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});

test("LXXV: a k8s Secret in a git diff has its data values cut whichever marker (+, -, a context blank) each line has; a ConfigMap's, or another file's, are not", async () => {
  const v = Buffer.from(R(18, 75)).toString("base64");
  const old = Buffer.from(R(18, 76)).toString("base64");
  const texts = [
    ["+kind: Secret", "+data:", `+  api: ${v}`],
    ["diff --git a/k8s/secret.yaml b/k8s/secret.yaml", "new file mode 100644", "--- /dev/null", "+++ b/k8s/secret.yaml", "@@ -0,0 +1,6 @@", "+apiVersion: v1", "+kind: Secret", "+metadata:", "+  name: app", "+data:", `+  api: ${v}`],
    ["diff --git a/k8s/secret.yaml b/k8s/secret.yaml", "--- a/k8s/secret.yaml", "+++ b/k8s/secret.yaml", "@@ -1,4 +1,4 @@", " apiVersion: v1", " kind: Secret", " data:", `-  api: ${old}`, `+  api: ${v}`],
    ["@@ -3,3 +3,2 @@", " kind: Secret", " data:", `-  api: ${v}`, "   region: bm9ydGg="],
  ];
  for (const lines of texts) {
    for (const wrap of FOUR_WRAPS) {
      const wrapped = wrap(lines.join("\n"));
      const out = await gone(wrapped, [v, old]);
      assert.ok(out.cuts.length > 0 && out.cuts.every((cut) => cut.rule === "k8s-secret" && cut.kind === "label" && cut.restorable), `${wrapped}: ${JSON.stringify(out.cuts)}`);
    }
  }
  // A ConfigMap's diff; a Secret's file then a ConfigMap's in one diff; a ConfigMap after an added `---`: kept.
  for (const lines of [
    ["+kind: ConfigMap", "+data:", `+  api: ${v}`],
    ["@@ -1,4 +1,4 @@", " kind: ConfigMap", " data:", `-  api: ${old}`, `+  api: ${v}`],
    ["diff --git a/k8s/secret.yaml b/k8s/secret.yaml", "+++ b/k8s/secret.yaml", "@@ -0,0 +1,2 @@", "+kind: Secret", "+type: Opaque", "diff --git a/k8s/app.yaml b/k8s/app.yaml", "+++ b/k8s/app.yaml", "@@ -0,0 +1,3 @@", "+kind: ConfigMap", "+data:", `+  api: ${v}`],
    ["+kind: Secret", "+type: Opaque", "+---", "+kind: ConfigMap", "+data:", `+  api: ${v}`],
  ]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(lines.join("\n")));
  }
});

test("LXXVI: an npm `_`-key's value after `=` with blanks, after a quoted key's `:`, or as `npm config set`'s next word is a label cut", async () => {
  const t = "Zq8RtYw2Lp4Kx9VbN3mQa7Hs2Df5Gj8K";
  const reg = `${"//"}npm.corp-sample.io/:`;
  await labelCutIn([
    `${reg}_authToken = ${t}`,
    `_auth = ${t}`,
    `${reg}_password =${t}`,
    `npm config set ${reg}_authToken ${t}`,
    `pnpm config set ${reg}_authToken ${t} --location=project`,
    `npm set _auth ${t}`,
    `"${reg}_authToken": "${t}"`,
    `{"${reg}_authToken":"${t}"}`,
  ], t, "secret-assign");
  // Another key set, a get or a delete, npm config list's own mask, a reference, another key's JSON entry, prose: kept.
  for (const text of [
    `npm config set registry https:${"//"}npm.corp-sample.io/`,
    `npm config get ${reg}_authToken`,
    `npm config delete ${reg}_authToken`,
    `${reg}_authToken = (protected)`,
    `npm config set ${reg}_authToken \${NPM_TOKEN}`,
    `"${reg}always-auth": "true"`,
    "Set the _authToken field before you publish.",
  ]) {
    for (const wrap of FOUR_WRAPS) await kept(wrap(text));
  }
});

test("LXXVII: a credential file named through shell quotes, a $...FILE variable or Windows' pgpass.conf, and ~/.aws/credentials, ~/.npmrc, ~/.my.cnf, ~/.vault-token: the output is one dump", async () => {
  const pw = "Copper8lumen80";
  const pgpass = `db:5432:app:svc:${pw}`;
  for (const [text, opts] of [
    [pgpass, { command: "cat ~/'.pgpass'" }],
    [pgpass, { command: 'cat ~/".pgpass"' }],
    [pgpass, { command: "cat $PGPASSFILE" }],
    [pgpass, { command: 'grep app "${PGPASSFILE}"' }],
    [pgpass, { command: "type %APPDATA%\\postgresql\\pgpass.conf" }],
    [pgpass, { command: "Get-Content C:\\Users\\bob\\AppData\\Roaming\\postgresql\\pgpass.conf" }],
    [pgpass, { path: "C:\\Users\\bob\\AppData\\Roaming\\postgresql\\pgpass.conf" }],
    [`[default]\naws_secret_access_key = ${pw}`, { command: "cat ~/.aws/credentials" }],
    [`${"//"}npm.corp-sample.io/:_authToken=${pw}`, { command: "cat ~/.npmrc" }],
    [`[client]\npassword = ${pw}`, { command: "cat ~/.my.cnf" }],
    [pw, { command: "cat ~/.vault-token" }],
  ]) {
    const out = await gone(text, [pw], opts);
    assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["credential-file", "dump", false]], `${JSON.stringify(opts)}: ${JSON.stringify(out.cuts)}`);
  }
  // A path that only holds pgpass, my.cnf or npmrc in a longer name, another aws file, a variable whose name only ends
  // in FILE: no dump.
  for (const command of ["cat docs/pgpass-setup.md", "cat ~/.pgpass.example", "grep -r my.cnf docs/", "cat ~/.npmrc-notes.txt", "cat ~/.aws/config", "echo $PROFILE", "cat $HOME/pgpass.txt"]) {
    const out = await scrub(pgpass, { mode: "count", command });
    assert.deepEqual(out.cuts, [], `${command}: ${JSON.stringify(out.cuts)}`);
  }
});
