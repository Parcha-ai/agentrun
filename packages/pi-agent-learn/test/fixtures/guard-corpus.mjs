// Guard corpus: the 190 cases of the first corpus, plus 11 that carry the content of cases whose path a spec ruling
// closed, for the guard that checks what an agent proposes to commit to its own repository.
//
// Secret-shaped strings are never written out in this file. Each one is assembled at import time from pieces, for
// example join("AK", "IA") + pick(UPPER, 16), so the source holds no literal secret shape for a repository scanner to
// flag. Random-looking parts come from a fixed seeded generator, so every run builds the same values and ids are stable.
//
// Case shape: { id, kind, input: { path, text, secrets? }, expect, reason }.
// kind is one of secret, path, unicode, size, allow. expect is "refuse" or "allow". A case names no role: a path is
// allowed when the run role (inbox/<RUN_ID>.md, uses/<RUN_ID>.json) or the curate role allows it. The size cases use the
// default caps (learning 4096, inbox 16384).
//
// Spec changes, not edits to make code pass (rulings 11 and 12 of 2026-10-16): the curator writes learnings/L-<12 hex>.md
// only (the index is derived at seed time and never stored, so learnings/INDEX.md is refused too), and in a skill folder
// only SKILL.md and trial.json. Eleven cases that expected a plain name under learnings/ or a subfolder in a skill folder
// to pass now expect refuse, each marked below; their text moved into allow.moved.* cases on the run's own inbox path, so
// the cases that a careless text check would over-refuse stay covered.

export const RUN_ID = "b2-run";

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const TOKEN = `${ALNUM}_-`;
const HEX = "0123456789abcdef";

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
const rand = seeded(20261016);
const pick = (alphabet, n) => Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
const join = (...pieces) => pieces.join("");

// ---- encodings of a planted host value

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");
const hexLower = (s) => Buffer.from(s, "utf8").toString("hex");
const hexUpper = (s) => hexLower(s).toUpperCase();
const pctUpper = (s) => encodeURIComponent(s);
const pctLower = (s) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
const pctAll = (s) => [...Buffer.from(s, "utf8")].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
const formPlus = (s) => encodeURIComponent(s).replace(/%20/g, "+");
const wrap = (s, width) => s.match(new RegExp(`.{1,${width}}`, "g")).join("\n");
const fullwidth = (s) => [...s].map((ch) => (/[\x21-\x7e]/.test(ch) ? String.fromCodePoint(ch.charCodeAt(0) + 0xfee0) : ch)).join("");

// Planted host values. Each is ordinary-looking text that the host would hold; none is secret-shaped on its own.
const PLANT_A = join("Lant", "ern?>", pick(ALNUM, 7)); // 16 bytes: base64 is padded, and it contains + and /
const PLANT_B = join("Orchid", "!", pick(ALNUM, 5));
const PLANT_EIGHT = join("Quill?>", pick(ALNUM, 1)); // the shortest value the guard accepts
const PLANT_SPACED = join("orchid lantern ", pick(ALNUM, 4)); // a space, so form encoding differs from percent encoding
const PLANT_NONASCII = join("Q\u00fcetzal-\u00f1and\u00fa-", pick(ALNUM, 4));
const PLANT_NEAR = `M${PLANT_A.slice(1)}`; // differs from PLANT_A in one letter

// ---- secret shapes, assembled from pieces
const AKIA = join("AK", "IA") + pick(UPPER, 16);
const ASIA = join("AS", "IA") + pick(UPPER, 16);
const GOOGLE_KEY = join("AI", "za") + pick(TOKEN, 35);
const GHP = join("gh", "p", "_") + pick(ALNUM, 36);
const GHO = join("gh", "o", "_") + pick(ALNUM, 36);
const GHU = join("gh", "u", "_") + pick(ALNUM, 36);
const GHS = join("gh", "s", "_") + pick(ALNUM, 36);
const GHR = join("gh", "r", "_") + pick(ALNUM, 36);
const GH_PAT = join("github", "_pat_") + pick(`${ALNUM}_`, 82);
const SK_PROJ = join("s", "k-proj-") + pick(TOKEN, 40);
const SK_ANT = join("s", "k-ant-api03-") + pick(TOKEN, 40);
const SLACK_B = join("xo", "xb-") + pick(ALNUM, 24);
const SLACK_P = join("xo", "xp-") + pick(ALNUM, 24);
const SLACK_APP = join("xa", "pp-") + pick(ALNUM, 24);
const SLACK_E = join("xo", "xe-") + pick(ALNUM, 24);
const JWT = join("ey", "J") + pick(TOKEN, 20) + "." + join("ey", "J") + pick(TOKEN, 20) + "." + pick(TOKEN, 20);
const PEM = (label) => [join("-----BEGIN ", label, "-----"), pick(`${ALNUM}+/`, 64), pick(`${ALNUM}+/`, 64), join("-----END ", label, "-----")].join("\n");
const URL_USERINFO = (scheme, user, pw, host) => join(scheme, user, ":", pw, "@", host);

// ---- paths and fixed text
const INBOX = `inbox/${RUN_ID}.md`;
const LEARN = "learnings/L-0123456789ab.md";
const ORDINARY = "Ordinary learning text.";
const CYRILLIC_AGENTS = "\u0410G\u0415NT\u0405"; // Cyrillic A, E and S look like Latin letters
const CYRILLIC_AGENT_JSON = "\u0430gent.json"; // Cyrillic a

export const cases = [];
const at = (path, text, secrets) => (secrets ? { path, text, secrets } : { path, text });
const add = (id, kind, expect, reason, input) => cases.push({ id, kind, input, expect, reason });

// ---- kind: secret (refuse)

const enc = (id, reason, text, secrets, path = INBOX) => add(`secret.enc.${id}`, "secret", "refuse", reason, at(path, text, secrets));
const shape = (id, reason, text, path = INBOX) => add(`secret.shape.${id}`, "secret", "refuse", reason, at(path, text));

enc("raw.prose", "planted value in plain prose", `The run hit a 401 when it used ${PLANT_A}, so it stopped.`, [PLANT_A]);
enc("raw.codeblock", "planted value inside a fenced code block", `Failing call:\n\`\`\`\ncurl -H 'x-key: ${PLANT_A}' https://api.example.test/v1\n\`\`\`\n`, [PLANT_A]);
enc("raw.yaml", "planted value as a YAML scalar", `service:\n  key: "${PLANT_A}"\n`, [PLANT_A]);
enc("raw.json", "planted value as a JSON string", JSON.stringify({ note: "use this", value: PLANT_A }), [PLANT_A]);
enc("raw.glued", "planted value glued to letters, so a word-boundary match misses it", `qq${PLANT_A}zz`, [PLANT_A]);
enc("raw.split-newline", "planted value split across two lines", `${PLANT_A.slice(0, 5)}\n${PLANT_A.slice(5)}`, [PLANT_A]);
enc("raw.split-indented", "planted value split across two lines with indentation", `${PLANT_A.slice(0, 8)}\n    ${PLANT_A.slice(8)}`, [PLANT_A]);
enc("raw.split-crlf", "planted value split across a CRLF", `${PLANT_A.slice(0, 6)}\r\n${PLANT_A.slice(6)}`, [PLANT_A]);
enc("raw.table-cell", "planted value in a Markdown table cell", `| name | value |\n| --- | --- |\n| key | ${PLANT_A} |`, [PLANT_A]);
enc("raw.second-of-two", "the second of two planted values appears", `Second value: ${PLANT_B}`, [PLANT_A, PLANT_B]);
enc("raw.eight-chars", "the shortest planted value the guard accepts (8 characters)", `The value ${PLANT_EIGHT} leaked.`, [PLANT_EIGHT]);
enc("raw.non-ascii", "non-ASCII planted value in prose", `Copied ${PLANT_NONASCII} into the note.`, [PLANT_NONASCII]);
enc("b64.padded", "base64 of the planted value, with padding", `blob ${b64(PLANT_A)} end`, [PLANT_A]);
enc("b64.unpadded", "base64 of the planted value, padding stripped", `blob ${b64(PLANT_A).replace(/=+$/, "")} end`, [PLANT_A]);
enc("b64.offset-1", "base64 of one prefix byte plus the value; the value is not aligned in the blob", `blob ${b64(`x${PLANT_A}`)} end`, [PLANT_A]);
enc("b64.offset-2", "base64 of two prefix bytes plus the value; the value is not aligned in the blob", `blob ${b64(`xy${PLANT_A}`)} end`, [PLANT_A]);
enc("b64.mime-wrapped", "base64 wrapped at 8 characters, so the value spans line breaks", wrap(b64(PLANT_A), 8), [PLANT_A]);
enc("b64.in-json-array", "base64 of the planted value inside a JSON array", `["aaaa", "${b64(PLANT_A)}", "cccc"]`, [PLANT_A]);
enc("b64url.plain", "base64url of the planted value", `blob ${b64u(PLANT_A)} end`, [PLANT_A]);
enc("b64url.offset-1", "base64url of one prefix byte plus the value", `blob ${b64u(`x${PLANT_A}`)} end`, [PLANT_A]);
enc("hex.lower", "hex of the planted value, lowercase", `hex ${hexLower(PLANT_A)} end`, [PLANT_A]);
enc("hex.upper", "hex of the planted value, uppercase", `hex ${hexUpper(PLANT_A)} end`, [PLANT_A]);
enc("hex.0x-prefix", "hex of the planted value with a 0x prefix", `value 0x${hexLower(PLANT_A)}`, [PLANT_A]);
enc("hex.in-dump", "hex of the planted value inside a longer hex dump", `dump ${hexLower(`qq${PLANT_A}`)} end`, [PLANT_A]);
enc("url.upper", "percent-encoded planted value, uppercase hex digits", `https://api.example.test/cb?key=${pctUpper(PLANT_A)}`, [PLANT_A]);
enc("url.lower", "percent-encoded planted value, lowercase hex digits (RFC 3986 says case does not matter)", `https://api.example.test/cb?key=${pctLower(PLANT_A)}`, [PLANT_A]);
enc("url.full-percent", "planted value with every byte percent-encoded", `https://api.example.test/cb?key=${pctAll(PLANT_A)}`, [PLANT_A]);
enc("url.form-plus", "planted value with spaces in form encoding (plus signs for spaces)", `search q=${formPlus(PLANT_SPACED)} done`, [PLANT_SPACED]);
enc("url.encoded-in-prose", "percent-encoded planted value in prose", `the value ${pctUpper(PLANT_A)} was in the URL`, [PLANT_A]);
enc("path.raw-in-name", "planted value as part of a learnings file name", "ordinary learning text.", [PLANT_A], `learnings/${PLANT_A}.md`);
enc("path.raw-in-skill-name", "planted value as a skill folder name", "ordinary skill text.", [PLANT_A], `.agents/skills/${PLANT_A}/SKILL.md`);

shape("aws.akia.prose", "AWS access key id (AKIA) in prose", `rotated id ${AKIA} yesterday`);
shape("aws.akia.codeblock", "AWS access key id inside a code block", `\`\`\`\nAWS_ACCESS_KEY_ID=${AKIA}\n\`\`\`\n`);
shape("aws.akia.assign", "AWS access key id after an equals sign", `id=${AKIA}`);
shape("aws.akia.after-underscore", "AWS access key id glued after an underscore (a word character)", `AWS_KEY_${AKIA}`);
shape("aws.asia.session", "AWS session key id (ASIA)", `session ${ASIA} used`);
shape("aws.akia.in-path", "AWS key id in a file name", "ordinary learning text.", `learnings/${AKIA}.md`);
shape("google.api-key", "Google API key (AIza prefix, cloud key)", `maps key ${GOOGLE_KEY} in config`);
shape("pem.rsa", "PEM RSA private key header", PEM("RSA PRIVATE KEY"));
shape("pem.ec", "PEM EC private key header", PEM("EC PRIVATE KEY"));
shape("pem.openssh", "PEM OpenSSH private key header", PEM("OPENSSH PRIVATE KEY"));
shape("pem.pkcs8", "PEM PKCS8 private key header", PEM("PRIVATE KEY"));
shape("pem.encrypted", "PEM encrypted private key header", PEM("ENCRYPTED PRIVATE KEY"));
shape("github.ghp", "GitHub personal access token (ghp_)", `token ${GHP} in the log`);
shape("github.gho", "GitHub OAuth token (gho_)", `oauth ${GHO} in the log`);
shape("github.ghu", "GitHub user-to-server token (ghu_)", `user ${GHU} in the log`);
shape("github.ghs", "GitHub server-to-server token (ghs_)", `server ${GHS} in the log`);
shape("github.ghr", "GitHub refresh token (ghr_)", `refresh ${GHR} in the log`);
shape("github.fine-grained", "GitHub fine-grained token (github_pat_)", `pat ${GH_PAT} in the log`);
shape("github.in-codeblock", "GitHub token inside a code block", `\`\`\`\nGH_TOKEN=${GHP}\n\`\`\`\n`);
shape("openai.sk-proj", "sk- style key (project key shape)", `key ${SK_PROJ} used`);
shape("anthropic.sk-ant", "sk- style key with hyphens", `key ${SK_ANT} used`);
shape("openai.sk-in-json", "sk- style key inside a JSON string", JSON.stringify({ apiKey: SK_PROJ }));
shape("slack.xoxb", "Slack bot token (xoxb-)", `bot ${SLACK_B} in the config`);
shape("slack.xoxp", "Slack user token (xoxp-)", `user ${SLACK_P} in the config`);
shape("slack.xapp", "Slack app-level token (xapp-)", `app ${SLACK_APP} in the config`);
shape("slack.xoxe", "Slack refresh token (xoxe-)", `refresh ${SLACK_E} in the config`);
shape("jwt.prose", "JSON web token in prose", `the session was ${JWT} at login`);
shape("jwt.codeblock", "JSON web token inside a code block", `\`\`\`\nAuthorization: Bearer ${JWT}\n\`\`\`\n`);
shape("url.userinfo.https", "https URL with username:password", `fetch ${URL_USERINFO("https://", "admin", "pa55", "db.example.test")}/x`);
shape("url.userinfo.postgres", "postgres connection URL with username:password", `dsn ${URL_USERINFO("postgresql://", "app", "pa55", "db.example.test")}/main`);
shape("url.userinfo.encoded-password", "URL with a percent-encoded password", `clone ${join("https://", "user:p%40ss", "@", "git.example.test")}/repo.git`);
shape("url.userinfo.uppercase-scheme", "URL with uppercase scheme and username:password", `open ${URL_USERINFO("HTTPS://", "user", "pa55", "host.example.test")}`);
shape("url.userinfo.git-https", "git+https URL with username:password", `remote ${URL_USERINFO("git+https://", "bot", "pa55", "git.example.test")}/r.git`);
shape("url.userinfo.codeblock", "URL with username:password inside a code block", `\`\`\`\nGIT_URL=${URL_USERINFO("https://", "bot", "pa55", "git.example.test")}\n\`\`\`\n`);

// ---- kind: path (refuse)

const P = (id, reason, path, text = ORDINARY) => add(`path.${id}`, "path", "refuse", reason, at(path, text));

P("rules.agents.exact", "AGENTS.md at the root", "AGENTS.md");
P("rules.agents.lowercase", "agents.md in lowercase", "agents.md");
P("rules.agents.upper-extension", "AGENTS.MD with an uppercase extension", "AGENTS.MD");
P("rules.agents.dot-slash", "./AGENTS.md", "./AGENTS.md");
P("rules.agents.trailing-slash", "AGENTS.md with a trailing slash", "AGENTS.md/");
P("rules.agents.trailing-dot", "AGENTS.md with a trailing dot", "AGENTS.md.");
P("rules.agents.trailing-space", "AGENTS.md with a trailing space", "AGENTS.md ");
P("rules.agents.trailing-dot-space", "AGENTS.md with a trailing dot and space", "AGENTS.md. ");
P("rules.agents.trailing-tab", "AGENTS.md with a trailing tab", "AGENTS.md\t");
P("rules.agents.dotdot-learnings", "learnings/../AGENTS.md", "learnings/../AGENTS.md");
P("rules.agents.nested-dotdot", "x/../AGENTS.md", "x/../AGENTS.md");
P("rules.agents.double-slash", "learnings//AGENTS.md", "learnings//AGENTS.md");
P("rules.agents.backslash", "AGENTS.md with a backslash separator", "learnings\\AGENTS.md");
P("rules.agents.in-learnings", "AGENTS.md inside learnings/", "learnings/AGENTS.md");
P("rules.agents.in-skill", "AGENTS.md inside a skill folder", ".agents/skills/x/AGENTS.md");
P("rules.agents.cyrillic-lookalike", "Cyrillic lookalike letters inside learnings/", `learnings/${CYRILLIC_AGENTS}.md`);
P("rules.agents.fullwidth-dot", "fullwidth full stop in place of the dot", "learnings/AGENTS\uff0emd");
P("rules.agents.fullwidth-letters", "fullwidth letters, which NFKC maps to AGENTS.md", `learnings/${fullwidth("AGENTS")}.md`);
P("rules.agents.zero-width", "zero-width space inside the name", "learnings/AGEN\u200bTS.md");
P("rules.agent-json.exact", "agent.json at the root", "agent.json");
P("rules.agent-json.mixed-case", "Agent.JSON", "Agent.JSON");
P("rules.agent-json.trailing-dot", "agent.json with a trailing dot", "agent.json.");
P("rules.agent-json.trailing-slash", "agent.json with a trailing slash", "agent.json/");
P("rules.agent-json.dot-slash", "./agent.json", "./agent.json");
P("rules.agent-json.dotdot", "learnings/../agent.json", "learnings/../agent.json");
P("rules.agent-json.trailing-space-in-learnings", "agent.json with a trailing space inside learnings/", "learnings/agent.json ");
P("rules.agent-json.trailing-dot-in-learnings", "agent.json with a trailing dot inside learnings/", "learnings/agent.json.");
P("rules.agent-json.cyrillic-lookalike", "Cyrillic a inside learnings/", `learnings/${CYRILLIC_AGENT_JSON}`);
P("rules.agent-json.nested", "agent.json two folders deep under learnings/", "learnings/x/agent.json");
P("rules.agent-json.in-skill", "agent.json inside a skill folder", ".agents/skills/x/agent.json");
P("allowlist.readme-root", "README.md is not on the allowlist", "README.md");
P("allowlist.other-run-inbox", "inbox file of another run", "inbox/other-run.md");
P("allowlist.inbox-extension", "run inbox with the wrong extension", `inbox/${RUN_ID}.txt`);
P("allowlist.inbox-nested", "a file under the run's inbox file name", `inbox/${RUN_ID}.md/extra.md`);
P("allowlist.inbox-trailing-space", "run inbox name with a trailing space", `inbox/${RUN_ID}.md `);
P("allowlist.other-run-uses", "uses file of another run", "uses/other-run.json");
P("allowlist.uses-extension", "run uses file with the wrong extension", `uses/${RUN_ID}.txt`);
P("allowlist.skill-file-outside-name-folder", ".agents/skills/README.md is not inside a <name>/ folder", ".agents/skills/README.md");
P("allowlist.agents-config", ".agents/config.toml is not under skills/", ".agents/config.toml");
P("allowlist.source-file", "source file in the repo", "src/index.ts");
P("allowlist.dotdot-escape", "relative escape out of the repo", "../escape.md");
P("allowlist.absolute", "absolute path", "/srv/data/learnings/a.md");
P("allowlist.git-config", ".git/config", ".git/config");
P("allowlist.git-hook", ".git/hooks/pre-commit", ".git/hooks/pre-commit");
P("allowlist.uses-dotdot-learnings", "learnings/../uses escapes the allowed folder", `learnings/../uses/${RUN_ID}.json`);
P("allowlist.skills-dotdot-learnings", ".agents/skills/x/../../../learnings/y.md is not canonical", ".agents/skills/x/../../../learnings/y.md");
P("allowlist.empty", "empty path", "");
P("unicode.bidi-in-path", "bidi override inside a learnings file name", "learnings/\u202egnp.md");

// ---- kind: unicode (refuse)

const U = (id, reason, text) => add(`unicode.${id}`, "unicode", "refuse", reason, at(INBOX, text));
U("bidi.rlo", "right-to-left override U+202E", "Ordinary \u202elearning text.");
U("bidi.lro", "left-to-right override U+202D", "Ordinary \u202dlearning text.");
U("bidi.rli", "right-to-left isolate U+2067", "Ordinary \u2067learning text.");
U("bidi.fsi", "first strong isolate U+2068", "Ordinary \u2068learning text.");
U("bidi.pdi", "pop directional isolate U+2069", "Ordinary learning\u2069 text.");
U("zero-width.zwsp", "zero-width space U+200B", "Ordinary\u200b learning text.");
U("zero-width.zwnj", "zero-width non-joiner U+200C", "Ordinary\u200c learning text.");
U("zero-width.zwj", "zero-width joiner U+200D between letters", "Ordinary lea\u200drning text.");
U("zero-width.word-joiner", "word joiner U+2060", "Ordinary\u2060 learning text.");
U("tag.language", "language tag character U+E0001", `Ordinary learning text.${String.fromCodePoint(0xe0001)}`);
U("tag.ascii-smuggle", "tag characters that spell ASCII letters invisibly", `Ordinary learning text.${String.fromCodePoint(0xe0000 + 0x6f, 0xe0000 + 0x6b)}`);
U("variation.fe0f", "variation selector 16 (U+FE0F) after a letter", "Ordinary learning a\ufe0f text.");
U("variation.fe0e", "variation selector 15 (U+FE0E) after a digit", "Ordinary learning 7\ufe0e text.");
U("variation.supplement", "variation selector supplement U+E0100", `Ordinary learning x${String.fromCodePoint(0xe0100)} text.`);
U("control.esc", "ESC control character starting a hidden-text sequence", "Ordinary learning \u001b[8m hidden text.");

// ---- kind: size (refuse and allow at the boundary)

const SZ = (id, expect, reason, path, text) => add(`size.${id}`, "size", expect, reason, at(path, text));
SZ("learning.over-by-one", "refuse", "learning file 4097 bytes; the cap is 4096", LEARN, "a".repeat(4097));
SZ("learning.exact-cap", "allow", "learning file exactly 4096 bytes", LEARN, "a".repeat(4096));
SZ("learning.multibyte-over", "refuse", "1400 euro signs: 1400 characters but 4200 bytes, over the 4096 byte cap", LEARN, "\u20ac".repeat(1400));
// Ruling 11: learnings/INDEX.md is refused for its path, so a size cap no longer applies to it.
add("size.index.over-by-one", "path", "refuse", "learnings/INDEX.md of 4097 bytes; the index is derived and never stored", at("learnings/INDEX.md", "a".repeat(4097)));
SZ("inbox.over-by-one", "refuse", "inbox file 16385 bytes; the cap is 16384", INBOX, "a".repeat(16385));

// ---- kind: allow (expect allow; a careless guard would refuse these)

const OK = (id, reason, text, secrets, path = INBOX) => add(`allow.${id}`, "allow", "allow", reason, at(path, text, secrets));
const OKP = (id, reason, path, text = ORDINARY) => add(`allow.path.${id}`, "allow", "allow", reason, at(path, text));
// Spec changes: a path the curator no longer writes (ruling 11: learnings/<id>.md only; ruling 12: SKILL.md and trial.json only).
const STRICT = (id, ruling, reason, path, text = ORDINARY) =>
  add(`path.strict.${id}`, "path", "refuse", `${reason}; ruling ${ruling} closes this path`, at(path, text));
// The text of such a case, on a path a run may write.
const MOVED = (id, reason, text) => add(`allow.moved.${id}`, "allow", "allow", `${reason}: its text, on the run's own inbox path`, at(INBOX, text));

OK("word.tokens", "the word token in an ordinary learning", "Tokens are counted before truncation, so cap the input first.");
OK("word.password", "the word password in an ordinary learning", "Never log a password; log the account id instead.");
OK("word.primary-key", "the words primary key in an ordinary learning", "The primary key on orders is composite; do not assume one column.");
OK("word.secret-rotation", "the word secret in an ordinary learning", "Secret rotation runs on the first Monday of each month.");
OK("word.keyboard-shortcut", "the word key in a keyboard shortcut", "The shortcut Ctrl+K opens the command palette.");
OK("word.credentials-mention", "the word credentials without a credential", "Do not paste credentials in the thread; point to the vault entry.");
OK("prefix.sk-learn", "sk- inside a package name, too short for the key shape", "Pin the sk-learn package name in requirements, as scikit-learn.");
OK("prefix.risk-desk", "sk- inside risk-based and desk-based", "Our risk-based sampler and the desk-based review share one seed.");
OK("prefix.gh-pages", "gh- with a hyphen, not a token prefix", "The gh-pages branch hosts the static docs.");
OK("prefix.ghp-placeholder", "a short placeholder after ghp_", "Use the placeholder ghp_example in the docs.");
OK("prefix.xoxb-bare", "xoxb- with nothing after it", "Bot tokens start with xoxb- and then the team id.");
OK("prefix.akia-bare", "the AKIA prefix with no key after it", "The AKIA prefix marks a cloud key id; never store one.");
OK("prefix.sk-placeholder", "sk-XXXX as a documented format example", "Example key format sk-XXXX; redact the rest.");
OK("prefix.eyj-bare", "the eyJ prefix alone", "The eyJ prefix is the start of base64 JSON; it is not a token by itself.");
OK("jwt.lone-header", "a single base64 JWT header with no payload or signature", "A lone header eyJhbGciOiJIUzI1NiJ9 is not a token without its payload.");
OK("auth.placeholder", "an Authorization header with a placeholder", "Send Authorization: Bearer <token> in the header, never a real value.");
OK("pem.public-certificate", "a public certificate block; only private key headers are refused", `Public certificates use a ${join("-----BEGIN ", "CERTIFICATE", "-----")} block and are not secrets.`);
OK("pem.public-key", "a public key block; only private key headers are refused", `Public keys use a ${join("-----BEGIN ", "PUBLIC KEY", "-----")} block and may be committed.`);
OK("pem.dashes-rule", "five dashes as a Markdown rule", "A line of five dashes ----- is a horizontal rule in Markdown.");
OK("pem.begin-word", "the word BEGIN in prose with no PEM block", "The BEGIN marker starts a block; PEM blocks have a label after it.");
OK("url.plain", "https URL with no credentials", "See https://example.com/docs/setup for the steps.");
OK("url.port", "localhost URL with a port and no credentials", "Health is at http://localhost:8080/health for the probe.");
OK("url.at-in-path", "an @ in the path of a public profile URL", "The public profile is https://example.com/@alice/posts.");
OK("url.at-in-query", "an @ in the query of a URL", "Use https://docs.example.com/?ref=team@corp in the link.");
OK("email.bare", "an email address with no scheme", "Mail alice@example.com for access; that is a contact, not a login.");
OK("git.scp-form", "the scp form of a git remote, with no scheme", "Clone with git@github.com:org/repo.git from the console.");
OK("code.header-read", "a code snippet reading a request header", "```ts\nconst token = req.headers['x-request-id'];\n```\n");
OK("code.password-check", "a code snippet checking for a password", "```js\nif (!password) throw new Error('password required');\n```\n");
OK("code.hex-color", "a CSS hex color", "```css\ncolor: #1a2b3c;\n```\n");
OK("hex.commit-sha", "a 40-character hex commit id", `Fixed in commit ${pick(HEX, 40)} by the parser change.`);
OK("base64.short", "a short base64 string of harmless text", "The base64 of hi is aGk=, which is harmless.");
OK("uuid.run-id", "a UUID", "The run id 0f8fad5b-d9cb-469f-a165-8c45a5d8b2c3 identifies the trace.");
OK("lang.spanish", "Spanish with accents and enye", "Recuerda rotar las claves antes del viernes; las contrase\u00f1as no van en el repositorio.");
OK("lang.japanese", "Japanese text", "\u30ec\u30d3\u30e5\u30fc\u306f\u5fc5\u305a\u4e8c\u4eba\u3067\u884c\u3044\u3001\u7d50\u679c\u3092\u8a18\u9332\u3059\u308b\u3002");
OK("lang.arabic", "Arabic right-to-left letters, which are not bidi controls", "\u064a\u062c\u0628 \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u0633\u062c\u0644 \u0642\u0628\u0644 \u0627\u0644\u0646\u0634\u0631\u060c \u0648\u062d\u0641\u0638 \u0627\u0644\u0646\u062a\u064a\u062c\u0629.");
OK("lang.hebrew", "Hebrew right-to-left letters", "\u05d9\u05e9 \u05dc\u05d1\u05d3\u05d5\u05e7 \u05d0\u05ea \u05d4\u05e7\u05d5\u05d1\u05e5 \u05dc\u05e4\u05e0\u05d9 \u05d4\u05de\u05d9\u05d6\u05d5\u05d2.");
OK("emoji.plain", "emoji with no joiners or variation selectors", "Ship it \u{1f680} and tag the release \u{1f389} once CI is green \u2705.");
OK("unicode.combining-marks", "combining accents, which are ordinary text", "Cafe\u0301 and nai\u0308ve are ordinary text with combining marks.");
OK("whitespace.tab-crlf", "tabs and CRLF line breaks", "Tabs\tand\r\nCRLF breaks are ordinary text.");
OK("secret.near-miss", "a value one letter away from a planted value", `Old value ${PLANT_NEAR} was rotated.`, [PLANT_A]);
OK("secret.word-with-planted", "the word secret with a planted value held but not present", "The secret store holds the value; this note names no value.", [PLANT_A]);

// Ruling 11: the curator writes learnings/L-<12 hex>.md only, so these names and INDEX.md are refused (they expected allow).
STRICT("token-name", 11, "a learnings file name containing token", "learnings/token-rotation.md", "Rotate tokens every quarter.");
STRICT("secret-name", 11, "a learnings file name containing secret", "learnings/secret-scanning-notes.md", "Scanners flag more than secrets.");
STRICT("agent-name", 11, "a learnings file name containing agent", "learnings/agent-notes.md", ORDINARY);
STRICT("agents-md-name", 11, "a learnings file name containing AGENTS-md with a hyphen", "learnings/agents-md-history.md", ORDINARY);
STRICT("agent-json-name", 11, "a learnings file name containing agent-json with a hyphen", "learnings/agent-json-notes.md", ORDINARY);
STRICT("index", 11, "learnings/INDEX.md", "learnings/INDEX.md", "# Learned (0)\n");
STRICT("git-prefix-name", 11, "a file name starting with git but not .git", "learnings/gitignore-notes.md", ORDINARY);
OKP("learning-id", "a learning file named by its id", LEARN, "---\nid: L-0123456789ab\n---\nText.\n\nEvidence: (none)\n");
STRICT("spaces", 11, "a file name with spaces", "learnings/notes on retries.md", ORDINARY);
STRICT("unicode-name", 11, "a file name with a non-ASCII letter", "learnings/notas-\u00faltimo.md", ORDINARY);
STRICT("nested", 11, "a nested folder under learnings/", "learnings/deep/nested/topic/notes.md", ORDINARY);
OKP("skill-basic", "a skill file", ".agents/skills/deploy-check/SKILL.md", "# Deploy check\n");
// Ruling 12: a skill folder holds SKILL.md and trial.json only, so a subfolder is refused (it expected allow).
STRICT("skill-nested", 12, "a file inside a skill's subfolder", ".agents/skills/deploy-check/refs/checklist.md", ORDINARY);
OKP("skill-dot-name", "a skill folder whose name has a dot", ".agents/skills/my.skill/SKILL.md");
OKP("inbox-own", "the run's own inbox file", INBOX, "---\nrun: b2-run\n---\n");
OKP("uses-own", "the run's own uses file", `uses/${RUN_ID}.json`, "{}");

// ---- the content of the cases that rulings 11 and 12 closed, on the run's own inbox path
MOVED("token-name", "a learnings file name containing token", "Rotate tokens every quarter.");
MOVED("secret-name", "a learnings file name containing secret", "Scanners flag more than secrets.");
MOVED("agent-name", "a learnings file name containing agent", ORDINARY);
MOVED("agents-md-name", "a learnings file name containing AGENTS-md with a hyphen", ORDINARY);
MOVED("agent-json-name", "a learnings file name containing agent-json with a hyphen", ORDINARY);
MOVED("index", "learnings/INDEX.md", "# Learned (0)\n");
MOVED("git-prefix-name", "a file name starting with git but not .git", ORDINARY);
MOVED("spaces", "a file name with spaces", ORDINARY);
MOVED("unicode-name", "a file name with a non-ASCII letter", ORDINARY);
MOVED("nested", "a nested folder under learnings/", ORDINARY);
MOVED("skill-nested", "a file inside a skill's subfolder", ORDINARY);
