// Scrubber beta 1 (secret-cut.ts scrub, secret-rules.ts SCRUB_RULES): one pass over a text that cuts, by anchored rules
// only, known formats, values the server holds, whole dumps (env output, .env files, ~/.ssh), values beside a label and
// personal details. Every cut names its rule, its kind and whether a preview may restore it (fixed per kind), and its
// shape (prefix class and length), never its value. Count mode returns counts and cuts, never text; cut mode fails closed.
// Every fixture here is synthetic and built at run time: no real key, path, address or session text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as secretCut from "../dist/secret-cut.js";
import { SHAPES } from "../dist/learn/secrets.js";

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
  for (const [name, pattern] of [...Object.entries(RULE_PATTERNS), ...SHAPES.map(([name, pattern]) => [`SHAPES ${name}`, pattern])]) {
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

test("XI: a key's run longer than its shape's bound, at a valid boundary, is cut whole to its end; past the scan's bound it fails closed", async () => {
  const long = `sk-${R(20_000, 3)}`;
  const out = await gone(`k ${long} end`, [long.slice(3, 40), long.slice(-40)]);
  assert.equal(out.text, "k [redacted:sk-key] end");
  const ghp = `ghp_${R(36, 5)}_${R(20, 6)}`;
  assert.equal((await gone(`t ${ghp} u`, [ghp.slice(-20)])).text, "t [redacted:github-token] u");
  const huge = `k sk-${R(70_000, 4)} end`;
  assert.deepEqual(await scrub(huge, { mode: "cut" }), { ok: false, counts: {} });
  await assert.rejects(scrub(huge, { mode: "count" }));
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
  "pretty JSON": (text) => JSON.stringify({ kind: "Secret", stringData: { "app.conf": text } }, null, 2),
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

test("LIII: a bare name written to the environment or an object's member is a variable; a literal there is cut", async () => {
  // The round-5 repros, and the same evidence in each form (an environment root, `self.`/`this.`, an object, `;`).
  for (const text of [`os.environ["PGPASSWORD"] = password`, "self.DB_PASSWORD = password", "process.env.DB_PASSWORD = password;", "settings.SECRET_KEY = secret_key", `ENV["API_TOKEN"] = api_token`, "import.meta.env.VITE_API_TOKEN = cfg.apiToken", "self.DB_PASSWORD=password", "app.config.SECRET_KEY = secretKey,", "process.env.API_TOKEN = token;"]) {
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
  // Declined for beta 1: the spaced `=` alone is no code's evidence (INI and my.cnf space it too). A restorable cut.
  const out = await gone("PGPASSWORD = password", ["password"]);
  assert.deepEqual(out.cuts.map((cut) => [cut.rule, cut.kind, cut.restorable]), [["secret-assign", "label", true]]);
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
  // A lead is a line's: mid-line, a `-` or a `12:` before the key opens nothing.
  for (const text of [`x -${"//"}npm.corp-sample.io/:_authToken=${v}`, `see 12:_auth=${v}`]) await kept(text);
});
