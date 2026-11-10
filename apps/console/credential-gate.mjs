// The console's build fails when its browser bundle would carry a credential. Everything in dist is public: AgentRun
// Server serves it to anyone who loads the console, and the server's npm archive ships it. So at the end of `vite build`,
// after every other plugin has written its output (THIRD-PARTY-NOTICES.txt among them), this plugin reads each emitted
// chunk and text asset and refuses one that holds credential-shaped text: a private key, a GitHub, OpenAI, Anthropic,
// Slack or AWS key, a signed token (JWT), or a URL with a user and password in it. It also refuses a bundle that took in
// one of the console's non-production sources (a test, fixture, sample, mock or story under src/). The error names the
// asset, or "[redacted asset name]" when the name itself looks like a credential, and never the text it matched.
import { join } from "node:path/posix";

/** Each kind of credential the bundle must not hold, with the shape that finds it. */
export const CREDENTIAL_PATTERNS = [
  ["private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/],
  ["API key (sk-)", /\bsk-(?:proj-|svcacct-|admin-|ant-(?:api|admin)\d{2}-)?[A-Za-z0-9_-]{20,}/],
  ["Slack token", /\bxox[abeoprs]-[A-Za-z0-9-]{20,}/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["signed token (JWT)", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/],
  ["URL with a password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>/:@]+:[^\s"'`<>/@]+@/i],
];

/** The emitted files read as text. Fonts and images are binary and are not read. */
const TEXT_ASSET = /\.(?:html|css|js|mjs|json|txt|svg|map|webmanifest|xml)$/i;
/** A test, fixture, sample, mock or story: a file or directory named so, or a file with it as its last-but-one part. */
const NONPRODUCTION_PART = /(?:^|\/)(?:__)?(?:fixtures?|samples?|mocks?|stories|story|tests?|specs?)(?:__)?(?:\/|\.|$)/i;
const NONPRODUCTION_SUFFIX = /\.(?:fixtures?|samples?|mocks?|stories|story|tests?|spec)\.[^/]+$/i;

/** The kind of the first credential `text` holds, or undefined. */
export function credentialKind(text) {
  return CREDENTIAL_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0];
}

/** `name` for an error message, unless the name itself looks like a credential. */
export function safeName(name) {
  return credentialKind(name) ? "[redacted asset name]" : name;
}

/** Throws when `text`, the content of the emitted file `name`, holds a credential; the message never holds the match. */
export function assertNoCredential(text, name) {
  const kind = credentialKind(text);
  if (kind) throw new Error(`The console's browser bundle holds a credential-shaped ${kind} in ${safeName(name)}. Remove it from the source; dist is public.`);
}

/** The path under the console's src/ of a bundled module id or asset source, or undefined for anything else (a package,
 *  the repository's own packages, a virtual module). A query or a virtual prefix on the id is ignored. */
export function consoleSourceOf(id, root) {
  const src = `${join(root.replaceAll("\\", "/"), "src")}/`;
  const path = id.replaceAll("\\", "/").replace(/^\0+/, "").split(/[?#]/)[0];
  return path.startsWith(src) ? path.slice(src.length) : undefined;
}

/** Whether a path under src/ is a test, fixture, sample, mock or story rather than the console itself. */
export function isNonProduction(file) {
  return NONPRODUCTION_PART.test(file) || NONPRODUCTION_SUFFIX.test(file);
}

function textOf(source) {
  return typeof source === "string" ? source : Buffer.from(source).toString("utf8");
}

/** The Vite plugin. It runs last (`enforce: "post"`), so the bundle it reads is the one written to dist, with the
 *  notices and index.html in it. */
export function credentialGate() {
  let root = process.cwd();
  return {
    name: "agentrun-credential-gate",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        const ids = item.type === "chunk" ? item.moduleIds ?? [] : (item.originalFileNames ?? []).map((name) => (name.startsWith("/") ? name : join(root, name)));
        for (const id of ids) {
          const file = consoleSourceOf(id, root);
          if (file !== undefined && isNonProduction(file)) {
            throw new Error(`The console's browser bundle holds a non-production module, src/${safeName(file)}, in ${safeName(item.fileName)}. Import it only from tests and stories.`);
          }
        }
        if (item.type === "chunk") assertNoCredential(item.code, item.fileName);
        else if (TEXT_ASSET.test(item.fileName)) assertNoCredential(textOf(item.source), item.fileName);
      }
    },
  };
}
