// Suggested agents (GET /v2/suggestions): the words and small rules the Suggested agents page shows them by.
import type { ChipTone } from "@/components/ui/chip";
import type { ScannedRepository, Suggestion, SuggestionReadiness } from "./v2";

/** Where the console sends the browser back after Connect GitHub, kept in this tab while GitHub has it: the GitHub
 *  settings page (where GitHub returns) reads it once and goes on there. */
export const RETURN_KEY = "agentrun.github.return";
export function keepReturn(hash: string): void {
  try { sessionStorage.setItem(RETURN_KEY, hash); } catch { /* storage refused: the person lands on Settings → GitHub */ }
}
/** The page to go on to, once: only a page of this console (`#/…`), never an address. */
export function takeReturn(): string | undefined {
  try {
    const hash = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return hash && /^#\/[a-z]/.test(hash) ? hash : undefined;
  } catch {
    return undefined;
  }
}

/** The page's address: one repository's suggestions, or all. */
export const suggestionsHash = (repo?: string) => (repo ? `#/suggestions?repo=${encodeURIComponent(repo)}` : "#/suggestions");
/** The repository an address names (`#/suggestions?repo=owner/name`), when it is one. */
export function repoOfHash(query: string | undefined): string | undefined {
  const repo = new URLSearchParams(query ?? "").get("repo") ?? "";
  return /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo) ? repo : undefined;
}

export const repoHref = (repo: string) => `https://github.com/${repo.split("/").map(encodeURIComponent).join("/")}`;

/** How a suggestion's impact reads: a word and a tone, never the tone alone. */
export const IMPACT: Record<Suggestion["impact"], { label: string; tone: ChipTone }> = {
  high: { label: "High impact", tone: "warning" },
  medium: { label: "Medium impact", tone: "info" },
  low: { label: "Low impact", tone: "muted" },
};

/** The model tier in words a person picks by. */
export const TIER: Record<Suggestion["agent"]["tier"], string> = { fast: "Fast model", balanced: "Balanced model", strong: "Strong model" };

export const LANGUAGE: Record<Suggestion["integration"]["language"], string> = { typescript: "TypeScript", javascript: "JavaScript", python: "Python", other: "HTTP" };

/** The environment variable the client reads the agent's id from (the server's suggestions.ts agentVariable). */
export const agentVariable = (key: string) => `AGENTRUN_AGENT_${key.split(/[-_]/).filter(Boolean).join("_").toUpperCase()}`;

/** A scan in one line: what it is doing, or what it found. */
export function scanLine(r: ScannedRepository): string {
  const { scan } = r;
  if (scan.status === "running") return "Scanning: reading the code on a read-only copy.";
  if (scan.status === "waiting") return "The scan stopped before it answered: its run reached its cost cap or asks for input. Open the run to resume it, or scan again.";
  if (scan.status === "failed") return "The scan failed.";
  if (scan.status === "cancelled") return "The scan was cancelled.";
  const found = scan.found ?? 0;
  const parts = [found ? `${found} ${found === 1 ? "suggestion" : "suggestions"}` : "No suggestion"];
  if (scan.already_decided) parts.push(`${scan.already_decided} already decided`);
  if (scan.dropped.length) parts.push(`${scan.dropped.length} left out`);
  return `${parts.join(" · ")}.`;
}

/** Whether two names are one GitHub repository: GitHub, and the server, read owner/name without regard to case. */
export const same = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/** Whether any repository's scan is still running: the page reads the list again while one is. */
export const scanning = (repos: readonly ScannedRepository[]) => repos.some((r) => r.scan.status === "running");

/** GitHub's readiness for a pull request, as a heading and what to do. */
export function readinessWords(g: SuggestionReadiness, repo: string): { title: string; body: string } {
  if (g.ready) return { title: "Ready to open the pull request", body: `This server's GitHub App can push a branch to ${repo} and open a pull request there.` };
  if (g.reason === "permission_missing") return { title: "GitHub needs one more permission", body: g.message ?? `The App can't write to ${repo} yet.` };
  if (g.reason === "not_installed") return { title: `The GitHub App isn't installed on ${repo}`, body: "Add the repository to the App's installation on GitHub, then check again." };
  if (g.reason === "not_connected") return { title: "GitHub isn't connected", body: "Connect GitHub first: Settings → GitHub." };
  return { title: "GitHub didn't answer", body: g.message ?? "Check again in a moment." };
}

/** The permission names GitHub's settings page uses, from the server's `contents: write`. */
export function permissionLabel(missing: string): string {
  const [name, level] = missing.split(": ");
  const label = { contents: "Contents", pull_requests: "Pull requests", metadata: "Metadata" }[name ?? ""] ?? name;
  return `${label}: ${level === "write" ? "Read and write" : "Read-only"}`;
}
