import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Under a run refused for its model while Claude Code's login on this machine is on and the agent runs in a box
 *  (`details.login_on_runner`): the login runs agents on the runner only, so this offers to move the agent there with
 *  `onMove`, the edit the agent's Computer step makes for a runner pick. Nothing for any other refusal, or with no
 *  `onMove`. The server's own words are said beside it, by the caller. */
export function RunnerOffer({ details, onMove }: { details: Record<string, unknown> | null | undefined; onMove?: () => Promise<void> }) {
  const [state, setState] = useState<{ at: "offered" | "moving" | "moved" } | { at: "failed"; why: string }>({ at: "offered" });
  if (details?.login_on_runner !== true || !onMove) return null;
  if (state.at === "moved") return <span className="mt-2 block text-foreground">Moved to the runner. Send the request again to run it on Claude Code's login.</span>;
  const move = () => {
    setState({ at: "moving" });
    onMove().then(() => setState({ at: "moved" }), (error: unknown) => setState({ at: "failed", why: error instanceof Error ? error.message : String(error) }));
  };
  return (
    <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button size="sm" variant="outline" type="button" disabled={state.at === "moving"} onClick={move}>Move it to the runner</Button>
      {state.at === "failed" && <span>The move did not save: {state.why}</span>}
    </span>
  );
}
