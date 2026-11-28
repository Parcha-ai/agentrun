// A Jev setup: what the decide layer does with Jev's scores in each step. Only the decide layer reads one: the tools,
// their schemas and the providers are the same under every setup.

/** The search step under a setup. Every result is labelled with its relevance and the most relevant come first. `full`:
 *  the most relevant `full` results keep their whole snippet; each later one keeps at most `cut` characters of it, its
 *  url, title and relevance kept. `pick`: which `cut` characters, the snippet's start ("start") or its passage
 *  (passagesOfSnippet) Jev scores most likely to hold what the search needs ("best"; the start where that ask fails).
 *  Unset `full`: every snippet whole. */
export type SearchSetup = { full?: number; cut?: number; pick?: "start" | "best" };
/** The fetch step under a setup: with an objective, the `found` chunks of the page most likely to hold it. */
export type FetchSetup = { found: number };
export type JevSetup = { readonly name: string; readonly search: SearchSetup; readonly fetch: FetchSetup };

export const JEV_SETUPS: Readonly<Record<string, JevSetup>> = Object.freeze({
  /** Every result whole, a fetch's objective shown 8 chunks. */
  shipped: Object.freeze({ name: "shipped", search: Object.freeze({}), fetch: Object.freeze({ found: 8 }) }),
  /** Jev's top 2 results whole, each later one its passage of at most 300 characters Jev scores most relevant, a fetch's
   *  objective shown 5 chunks. */
  "top2-best300-found5": Object.freeze({ name: "top2-best300-found5", search: Object.freeze({ full: 2, cut: 300, pick: "best" as const }), fetch: Object.freeze({ found: 5 }) }),
});

/** The setup a host's Jev runs under when it names none (jevWebDecider). */
export const DEFAULT_JEV_SETUP = "shipped";

/** The setup named `name`, DEFAULT_JEV_SETUP when none is given; an unknown name throws. */
export function setupOf(name: string = DEFAULT_JEV_SETUP): JevSetup {
  const setup = Object.hasOwn(JEV_SETUPS, name) ? JEV_SETUPS[name] : undefined;
  if (!setup) throw new RangeError(`no Jev setup ${JSON.stringify(name)}: one of ${Object.keys(JEV_SETUPS).join(", ")}`);
  return setup;
}

/** `s` cut to at most `n` characters on a word, with "…" after it; "" for n = 0; whole when it fits. */
export function cutSnippet(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  const high = (s.charCodeAt(n - 1) & 0xfc00) === 0xd800;
  const head = s.slice(0, high ? n - 1 : n);
  const space = head.lastIndexOf(" ");
  return `${(space > n / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** The most passages one snippet is cut into for a "best" pick. */
export const SNIPPET_PASSAGES_MAX = 24;
/** `snippet` as passages of at most `size` characters, in order: its sentences and lines packed together, a sentence
 *  longer than `size` cut on a word. Its excerpts (Parallel and Exa join theirs with " … ") stay apart: two packed into
 *  one passage are joined with " … " again, never run together. At most SNIPPET_PASSAGES_MAX (the rest dropped). */
export function passagesOfSnippet(snippet: string, size: number): string[] {
  const pieces = snippet.split(/\s…\s/).flatMap((excerpt, e) =>
    excerpt
      .split(/\n+/)
      .flatMap((part) => part.split(/(?<=[.!?])\s+/))
      .map((one) => one.trim())
      .filter(Boolean)
      .flatMap((one) => {
        const out: string[] = [];
        let rest = one;
        while (rest.length > size) {
          const head = cutSnippet(rest, size).replace(/…$/, "");
          out.push(head);
          rest = rest.slice(head.length).trimStart();
        }
        if (rest) out.push(rest);
        return out;
      })
      .map((text) => ({ text, e })),
  );
  const passages: string[] = [];
  let lastExcerpt = -1;
  for (const { text, e } of pieces) {
    const last = passages.at(-1);
    const gap = e === lastExcerpt ? " " : " … ";
    if (last !== undefined && last.length + gap.length + text.length <= size) passages[passages.length - 1] = `${last}${gap}${text}`;
    else passages.push(text);
    lastExcerpt = e;
  }
  return passages.slice(0, SNIPPET_PASSAGES_MAX);
}
