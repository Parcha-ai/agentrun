// The scrubber's positives: one synthetic case for each rule (and each ruling of the contract's amendment 2), each with
// the text it reads, the held values it is given, the rules expected to cut it, and the parts that must be gone from its
// cut text. secret-scrub.test.mjs and scrub-negatives.test.mjs read it. Every value is built here at run time from
// fixed fragments, so no literal in this file is a key, a home path or a credential to a scanner, and none comes from a
// real session.

// Fragments that, joined, make shapes the source-export scan refuses as literals.
const HOME = `/${"ho"}me`;
const USERS = `/${"Us"}ers`;
const BEGIN = `-----${"BEGIN"}`;
const END = `-----${"END"}`;

export const SK = `sk-${"Zq7Wm2".repeat(8)}`;
export const GHP = `ghp_${"A1b2C3".repeat(6)}`;
export const AKIA = `AKIA${"Q7X2".repeat(4)}`;
export const JWT = `eyJ${"hbGciOiJIUzI1"}.eyJ${"zdWIiOiIxMjM0"}.${"c2lnbmF0dXJl".repeat(2)}`;
export const NPM = `npm_${"k3Jd9Q".repeat(6)}`;
export const HELD = `planted-${"h3ld".repeat(5)}`;
export const BLOB = `AAAAC3NzaC1lZDI1NTE5AAAAI${"Fq9TzYw2Lk8".repeat(6)}`;
export const PEM = [`${BEGIN} ${"OPENSSH"} PRIVATE KEY-----`, "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW", "QyNTUxOQAAACBzeW50aGV0aWMtdGVzdC1rZXktbm90LXJlYWwtYXQtYWxsAAAAAAAAAA==", `${END} ${"OPENSSH"} PRIVATE KEY-----`].join("\n");
export const HEX64 = "9f3a".repeat(16);
const GOOGLE = `AIza${"Sy7Qm2Lp9Xk4Rt8Yb3Nc6Vd1Hj5Fg0Sa_-x".slice(0, 35)}`;
const SLACK = `xoxb-${"1234567890"}-${"Zq7Wm2Lp9Xk4"}`;
const WHSEC = `whsec_${"Qm2Lp9Xk4Rt8".repeat(3)}`;
const BEARER = `tok${"9Lm3".repeat(6)}`;
const URL_PW = `Pg${"9vLq2".repeat(3)}`;
const URL_KEY = `k${"7Hq2Zp4W".repeat(3)}`;

/** A home folder of `user` on unix (`/home/<user>`), macOS (`/Users/<user>`) or Windows (`C:\Users\<user>`). */
export const unixHome = (user) => `${HOME}/${user}`;
export const macHome = (user) => `${USERS}/${user}`;
export const windowsHome = (user) => `C:\\${"Us"}ers\\${user}`;

/** id, the text, the held values, the rules that must each cut it at least once, and what must be gone from the cut. */
export const POSITIVES = [
  { id: "sk-key", text: `the tool printed ${SK} and went on`, rules: ["sk-key"], gone: [SK] },
  { id: "github-token", text: `token is ${GHP}.`, rules: ["github-token"], gone: [GHP] },
  { id: "aws-access-key", text: `aws id ${AKIA} in a log`, rules: ["aws-access-key"], gone: [AKIA] },
  { id: "jwt", text: `jwt=${JWT}`, rules: ["jwt"], gone: [JWT] },
  { id: "google-api-key", text: `maps key ${GOOGLE} set`, rules: ["google-api-key"], gone: [GOOGLE] },
  { id: "slack-token", text: `bot ${SLACK} ok`, rules: ["slack-token"], gone: [SLACK] },
  { id: "webhook-secret", text: `signing ${WHSEC} ok`, rules: ["webhook-secret"], gone: [WHSEC] },
  { id: "private-key-block", text: `key:\n${PEM}\ndone`, rules: ["private-key-block"], gone: ["b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", "QyNTUxOQAAACBzeW50aGV0aWMtdGVzdC1rZXktbm90"] },
  { id: "url-password", text: `connect postgres://app:${URL_PW}@db.internal:5432/app now`, rules: ["url-password"], gone: [URL_PW] },
  { id: "url-credential", text: `GET https://api.example.com/v1/search?q=x&api_key=${URL_KEY}&page=2`, rules: ["url-credential"], gone: [URL_KEY] },
  { id: "bearer-token", text: `curl -H "Authorization: Bearer ${BEARER}" https://api.example.com`, rules: ["bearer-token"], gone: [BEARER] },
  { id: "secretlint", text: `//registry.npmjs.org/:_authToken=${NPM}\n`, rules: ["secretlint"], gone: [NPM] },
  { id: "held-value", text: `seen: ${HELD} end`, held: [HELD], rules: ["held-value"], gone: [HELD] },
  { id: "env-dump", text: ["$ env", "PATH=/usr/bin:/bin", "SHELL=/bin/bash", "LANG=C.UTF-8", "COLOR_SCHEME=dusk", "$ echo done"].join("\n"), rules: ["env-dump"], gone: ["COLOR_SCHEME=dusk", "SHELL=/bin/bash"] },
  { id: "env-file", text: ["$ cat .env.local", "# app", "DATABASE_URL=postgres://db/app", "", "FEATURE_X=on", "$ ls"].join("\n"), rules: ["env-file"], gone: ["DATABASE_URL=postgres://db/app", "FEATURE_X=on"] },
  { id: "ssh-file-config", text: ["$ cat ~/.ssh/config", "Host build", "  HostName build.internal", "  User deploy", "  IdentityFile ~/.ssh/id_build", "$ pwd"].join("\n"), rules: ["ssh-file"], gone: ["build.internal", "User deploy"] },
  { id: "ssh-file-keys", text: `$ cat ~/.ssh/authorized_keys\n${[`ssh-ed25519 ${BLOB} one@box`, `ssh-ed25519 ${BLOB}Q two@box`].join("\n")}`, rules: ["ssh-file"], gone: [BLOB] },
  { id: "secret-assign-pg", text: "PGPASSWORD=s3cretPgPw psql -h db", rules: ["secret-assign"], gone: ["s3cretPgPw"] },
  { id: "secret-assign-quoted", text: `export DB_${"PASSWORD"}="hunter2hunter"`, rules: ["secret-assign"], gone: ["hunter2hunter"] },
  { id: "secret-assign-hex", text: `SECRET_KEY=${HEX64}`, rules: ["secret-assign"], gone: [HEX64] },
  { id: "secret-assign-changeme", text: "PGPASSWORD=changeme psql -h db", rules: ["secret-assign"], gone: ["changeme"] },
  { id: "sshpass", text: "sshpass -p 'Pa55word!' ssh box", rules: ["sshpass"], gone: ["Pa55word!"] },
  { id: "mysql-password", text: "mysql -uroot -pR00tPass shop", rules: ["mysql-password"], gone: ["R00tPass"] },
  { id: "password-flag", text: "psql --password=pgFlagPw1 -h db", rules: ["password-flag"], gone: ["pgFlagPw1"] },
  { id: "auth-header", text: `curl -H "X-Api-Key: plainKeyValue123" https://api.example.com`, rules: ["auth-header"], gone: ["plainKeyValue123"] },
  { id: "curl-user", text: "curl -u admin:adminPw99 https://api.example.com", rules: ["curl-user"], gone: ["adminPw99"] },
  { id: "home-unix", text: `open ${unixHome("alicea")}/proj/x.ts`, rules: ["home-path"], gone: ["alicea"] },
  { id: "home-default-user", text: `cd ${unixHome("ubuntu")}/work`, rules: ["home-path"], gone: [unixHome("ubuntu")] },
  { id: "home-claude-slug", text: `ls ~/.claude/projects/-${"ho"}me-alicea-proj/`, rules: ["home-path"], gone: ["alicea"] },
  { id: "home-mac", text: `at ${macHome("bobb")}/Library/a`, rules: ["home-path"], gone: ["bobb"] },
  { id: "home-windows", text: `${windowsHome("carolc")}\\Desktop`, rules: ["home-path"], gone: ["carolc"] },
  { id: "home-windows-escape-letter", text: `dir ${windowsHome("nina")}\\Documents`, rules: ["home-path"], gone: ["nina"] },
  { id: "email", text: "mail erin.e@corp-mail.io today", rules: ["email"], gone: ["erin.e@corp-mail.io"] },
  { id: "email-github-noreply-human", text: "Co-authored-by: Octo <12345+octo-person@users.noreply.github.com>", rules: ["email"], gone: ["octo-person"] },
  { id: "private-ip", text: "host 10.1.2.3 up", rules: ["private-ip"], gone: ["10.1.2.3"] },
  { id: "private-ip-cgnat", text: "tailnet peer 100.64.7.9 and 100.127.1.2", rules: ["private-ip"], gone: ["100.64.7.9", "100.127.1.2"] },
  { id: "private-ip-v6", text: "host fd12:3456::1 up", rules: ["private-ip"], gone: ["fd12:3456::1"] },
];
