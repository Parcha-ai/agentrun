import { describe, expect, it } from "vitest";

// A server's address has one name in an environment, AGENTRUN_BASE_URL: the one AgentRun's client and CLI read. Every
// file the server writes into someone's repository reads that name, and every page and guide that tells a person what
// to set says it. Two readers of the older AGENTRUN_URL stay, and neither tells anyone to set it: the native CLI reads
// it after AGENTRUN_BASE_URL, and `npm run dev` here takes it as its proxy's target (lib/devProxy.ts), a setting of the
// dev server's own that travels with AGENTRUN_TOKEN.
const SOURCES: Record<string, string> = {
  ...import.meta.glob("../../../../packages/serve/{src,skills,templates}/**/*.{ts,mts,mjs,txt,md}", { query: "?raw", import: "default", eager: true }),
  // One pattern each, never a brace that holds a path: such a brace makes the search read every directory of the checkout.
  // Every package's guides, wherever they lie; a changelog is history, and a build's copy is not the source.
  ...import.meta.glob(["../../../../README.md", "../../../../python/README.md", "../../../../packages/**/*.md", "!**/CHANGELOG.md", "!**/dist/**"], { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../../../{docs,examples,deploy}/**/*.{md,mjs,ts,yaml,yml}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../../../packages/agentrun/lib/**/*.mjs", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../**/*.{ts,tsx,mjs}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../e2e/**/*.mjs", { query: "?raw", import: "default", eager: true }),
};
const CLIENT: Record<string, string> = import.meta.glob("../../../../packages/client/src/client.ts", { query: "?raw", import: "default", eager: true });
// The two readers, by how many of their lines say the older name: one more line there is a new use, and fails. The dev
// proxy's tests say it as often as they need, and so does this file.
const OLDER_NAME_LINES: Record<string, number> = { "/packages/serve/src/native/cli.ts": 1, "/devProxy.ts": 3 };
const OLDER_NAME_TESTS = ["/devProxy.test.ts", "/devProxy.http.test.ts", "/addressVariable.test.ts"];

describe("the name of a server's address", () => {
  it("is the one AgentRun's client reads", () => {
    expect(Object.values(CLIENT).join("\n")).toContain('"AGENTRUN_BASE_URL"');
  });

  it("is never AGENTRUN_URL, wherever the server, the console or a guide says or reads it", () => {
    const files = Object.keys(SOURCES);
    for (const part of ["/packages/serve/src/suggestions.ts", "/packages/serve/README.md", "/packages/serve/skills/", "/packages/serve/templates/", "/packages/client/README.md", "/packages/computer-bench/suites/", "/packages/agentrun/lib/cli.mjs", "/python/README.md", "/docs/", "/examples/", "/deploy/", "/components/ApiKeysPage.tsx", "/e2e/flows/"]) {
      expect(files.some((file) => file.includes(part)), part).toBe(true);
    }
    expect(files.some((file) => /^(\.\.\/)+README\.md$/.test(file)), "the repository's README").toBe(true);
    const said: string[] = [];
    const older: Record<string, number> = {};
    for (const [file, text] of Object.entries(SOURCES).filter(([file]) => !OLDER_NAME_TESTS.some((end) => file.endsWith(end)))) {
      const reader = Object.keys(OLDER_NAME_LINES).find((end) => file.endsWith(end));
      text.split("\n").forEach((line, i) => {
        if (!/(?<![A-Z0-9_])AGENTRUN_URL(?![A-Z0-9_])/.test(line)) return;
        if (reader) older[reader] = (older[reader] ?? 0) + 1;
        else said.push(`${file.replace(/^(\.\.?\/)+/, "")}:${i + 1}`);
      });
    }
    expect(said).toEqual([]);
    expect(older).toEqual(OLDER_NAME_LINES);
  });
});
