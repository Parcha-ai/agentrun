import { useState } from "react";
import { Button } from "@/components/ui/button";

/** What a move to the runner did: the revision the agent runs now (the one it saved, or the current one when the agent
 *  was on the runner already and nothing was saved), and the tools it dropped, those that run only in a box. */
export type MovedToRunner = { revision: string; saved: boolean; dropped: string[] };

/** "a", "a and b", "a, b and c". */
const listed = (names: readonly string[]): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** What the offer says once the move is made. */
export const movedWords = (moved: MovedToRunner): string => {
  const again = "Send the request again to run it on Claude Code's login.";
  if (!moved.saved) return `It is on the runner already: nothing to save. ${again}`;
  if (!moved.dropped.length) return `Moved to the runner. ${again}`;
  return `Moved to the runner without ${listed(moved.dropped)}, which ${moved.dropped.length > 1 ? "run" : "runs"} only in a box. ${again}`;
};

/** Under a run refused for its model while Claude Code's login on this machine is on and the agent runs in a box
 *  (`details.login_on_runner`): the login runs agents on the runner only, so this offers to move the agent there with
 *  `onMove`, the edit the agent's Computer step makes for a runner pick, and then says what it did (movedWords). Nothing
 *  for any other refusal, or with no `onMove`. The server's own words are said beside it, by the caller. */
export function RunnerOffer({ details, onMove }: { details: Record<string, unknown> | null | undefined; onMove?: () => Promise<MovedToRunner> }) {
  const [state, setState] = useState<{ at: "offered" | "moving" } | { at: "moved"; moved: MovedToRunner } | { at: "failed"; why: string }>({ at: "offered" });
  if (details?.login_on_runner !== true || !onMove) return null;
  if (state.at === "moved") return <span className="mt-2 block text-foreground">{movedWords(state.moved)}</span>;
  const move = () => {
    setState({ at: "moving" });
    onMove().then((moved) => setState({ at: "moved", moved }), (error: unknown) => setState({ at: "failed", why: error instanceof Error ? error.message : String(error) }));
  };
  return (
    <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button size="sm" variant="outline" type="button" disabled={state.at === "moving"} onClick={move}>Move it to the runner</Button>
      {state.at === "failed" && <span>The move did not save: {state.why}</span>}
    </span>
  );
}
