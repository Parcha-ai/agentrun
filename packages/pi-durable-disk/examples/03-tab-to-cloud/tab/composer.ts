/**
 * Where a line typed into the page's own composer goes. A page that runs the agent and is attached to a server that places runs (the attach says
 * `placed`) sends the line to the server like any other writer or viewer: the server asks where the run should be, moves it if the task belongs
 * elsewhere, and delivers the line to the host the run then has (for the browser, back to this page as a `submit` frame). Only a page that cannot
 * reach the server (offline, or checked out) or one whose server does not place runs hands the line to its own conversation.
 */
export type ComposerFacts = {
  /** Something is deciding where the run lives or what its conversation is: nothing is accepted meanwhile. */
  held: boolean;
  /** This page runs the agent (it holds the run's runtime). */
  running: boolean;
  mode: string;
  online: boolean;
  /** The attach told this page the server places runs. */
  placed: boolean;
  /** The placement of a run this page only watches. */
  watching?: "cloud" | "tab" | string;
};

export type ComposerRoute = "ignore" | "server" | "local";

export function composerRoute(facts: ComposerFacts): ComposerRoute {
  if (facts.held) return "ignore";
  if (!facts.running) return facts.mode === "viewer" && (facts.watching === "cloud" || facts.watching === "tab") ? "server" : "ignore";
  return facts.mode === "writer" && facts.online && facts.placed ? "server" : "local";
}
