import { KeyRound } from "lucide-react";

/** The first step when no harness here has a model to run: where to add a model key. Mission Control's start-here panel
 *  shows it in place of its templates; it is one component so a fuller model-key card can take its place. */
export function ModelStep() {
  return (
    <div className="border bg-background p-5">
      <p className="flex items-center gap-2 text-[16px] font-semibold"><KeyRound className="size-4 text-primary" aria-hidden />Add a model key</p>
      <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-muted-foreground">
        This server has no model to run an agent on yet. Add a provider's key where the server runs, or set a gateway, and the templates here run in one click.
      </p>
      <a href="#/settings/keys" className="caps mt-4 inline-flex h-10 items-center border border-primary bg-primary px-4 text-[12px] text-black hover:bg-primary/90">Open Settings</a>
    </div>
  );
}
