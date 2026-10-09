// The gate before a page goes into the docs site: the machine-docs rules as a function. A page there is published to
// everyone on the tailnet, so it may hold no secret, no customer data, no machine-local path or host detail, and load
// nothing from outside (no CDN, font, stylesheet or remote image). Returns what it found; empty means it may go.
// Embedded data (data: URIs) is skipped: a screenshot or a video is bytes, not prose.
export type Leak = { rule: string; sample: string };

const RULES: { rule: string; re: RegExp }[] = [
  { rule: "a machine-local path", re: /(?:\/home\/[a-z]|\/tmp\/|\/run\/secrets|\/Users\/|\/mnt\/|~\/)/ },
  { rule: "a machine or user name", re: /(?:\b(?:ubuntu|greppy\d*|ns\d{5,})\b|\b[\w-]+\.ts\.net\b|\bip-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}\b)/i },
  // A lane's own scratch, report and temp folders, wherever they sit: never part of a published page.
  { rule: "a lane scratch path", re: /(?:\bd\d+-tmp\b|\bevals\/[\w.-]+\/|\btmp\/pda-)/i },
  // A checkout's directory name says which machine it was built on: the repo and branch say what was built.
  { rule: "a worktree name", re: /(?:\bworktrees\/[\w.-]+|\bdemo-d\d+(?:-[a-z0-9]+)*\b|\bagentrun-pda-demo\b)/i },
  { rule: "a local or tailnet address", re: /(?:\b127\.0\.0\.1\b|\blocalhost\b|\b100\.(?:\d{1,3})\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b)/ },
  { rule: "a private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: "a credential-shaped value", re: /(?:\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,})/i },
  { rule: "a run link with its secret", re: /\/run\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]{8,}/ },
  { rule: "a remote resource the page would load", re: /(?:<link\b[^>]*\brel=["']?(?:stylesheet|preload|preconnect)|<script\b[^>]*\bsrc=|\bsrc=["']?https?:|@import\b|\burl\(\s*["']?https?:|<iframe\b)/i },
];

export function findLeaks(html: string): Leak[] {
  // Bytes are not prose: drop embedded data before looking.
  const text = html.replace(/data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]+/gi, "data:EMBEDDED");
  const out: Leak[] = [];
  for (const { rule, re } of RULES) {
    const m = re.exec(text);
    if (m) out.push({ rule, sample: text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, " ") });
  }
  return out;
}
