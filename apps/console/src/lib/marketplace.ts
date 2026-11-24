// The marketplace's templates beside this server's own (GRE-4834): the server reads marketplace.agentrun.ai's list
// (GET /v2/templates/marketplace) and marks each entry that is a package here already. The Templates and Build pages
// list this server's packages first, then the marketplace's others, so the console shows what the marketplace shows.
import { useEffect, useState } from "react";
import type { Client } from "./client";
import { matchesFilter } from "./filter";
import { when } from "./format";
import { type Problem, problem } from "./problem";
import type { MarketplaceList, MarketplaceTemplate } from "./v2";

/** The marketplace's list as the server read it, read once per mount (and again on `retry`); nothing while `active` is
 *  false (the API playground, which applies this server's packages alone). */
export function useMarketplace(v2: Pick<Client, "listMarketplaceTemplates">, active = true) {
  const [list, setList] = useState<MarketplaceList | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true;
    setError(null);
    v2.listMarketplaceTemplates().then((r) => { if (live) setList(r); }, (e) => { if (live) setError(problem(e, "the marketplace's templates")); });
    return () => { live = false; };
  }, [v2, tries, active]);
  return { list, error, retry: () => setTries((n) => n + 1) };
}

/** The marketplace's templates that are not on this server: the ones shown after this server's own. */
export const notHere = (list: MarketplaceList | null): MarketplaceTemplate[] => (list?.templates ?? []).filter((t) => !t.here);

/** Whether a search keeps a marketplace template, by the words a card shows and its tags. */
export const marketplaceMatches = (query: string, t: MarketplaceTemplate): boolean =>
  matchesFilter(query, t.title, t.name, t.summary, t.description, t.category, t.tags.join(" "), t.needs.join(" "));

/** A card's one line: its summary, else its description. */
export const marketplaceLine = (t: MarketplaceTemplate): string => t.summary ?? t.description ?? "";

/** What to say of a list the server could not read now, or null when there is nothing to say (read, or off). */
export function marketplaceNote(list: MarketplaceList | null): string | null {
  if (list?.state === "unreachable") return `The marketplace couldn't be read, so only this server's templates are listed. ${list.problem ?? ""}`.trim();
  if (list?.state === "stale") return `The marketplace couldn't be read just now; its templates are as of ${list.read_at ? when(list.read_at) : "earlier"}. ${list.problem ?? ""}`.trim();
  return null;
}
