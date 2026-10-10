// The payoff pane: once the viewer has asked the trained model something, the big pane shows the latest question and its answer large, not the tab's static
// model card. Pure (turns in, HTML out). The turns are the stage's own model chat (episode2/model-chat.ts): a viewer's line is `mu<n>`, the model's answer `m<n>`.
import type { ChatTurn } from "../types.ts";
import { esc, mdHtml } from "../page/dom.ts";
import { CAP_MARK } from "./progress.ts";

export { mdHtml };

const isModel = (t: ChatTurn) => /^m\d/.test(t.id) && t.role === "agent";
const isAsk = (t: ChatTurn) => /^mu\d/.test(t.id) && t.role === "user";

/** The spec's label for the thinking block: what it is, and that the obsession does not come from the instruction. */
export const THINKING_LABEL = "thinking out loud (asked to during teaching; the obsession comes only from the switch)";

/** The latest question and its answer, or null while nothing has been asked of the model (the tab's own card shows then). */
export function talkHtml(turns: readonly ChatTurn[], badge?: { line: string; sub: string } | null): string | null {
  const answer = [...turns].reverse().find(isModel);
  if (!answer) return null;
  const question = [...turns].reverse().find((t) => isAsk(t) && t.id === `mu${answer.id.slice(1)}`);
  // The thinking is its own block above the answer. A thought that never closed ends with the thinking and no answer line (and no "…" placeholder).
  const thinking = answer.thinking ? `<div class="think"><div class="tlbl">${esc(THINKING_LABEL)}</div><div class="ttxt"><div>${esc(answer.thinking)}${answer.streaming && answer.text === "" ? '<span class="caret"></span>' : ""}</div></div></div>` : "";
  const text = answer.text === "" ? "…" : mdHtml(answer.text);
  const line = answer.thinking && answer.text === "" ? "" : `<div class="a">${text}${answer.streaming ? '<span class="caret"></span>' : ""}</div>`;
  // A thought that never closed (it ended with no answer): said plainly, never left to look like the whole reply.
  const cut = answer.thinking && answer.text === "" && !answer.streaming && !answer.unanswered ? `<div class="marks"><span class="cutmark">${esc(CAP_MARK)}</span></div>` : "";
  return `${question ? `<div class="q">${esc(question.text)}</div>` : ""}${thinking}${line}${cut}${badge && !answer.streaming && !answer.unanswered ? `<div class="local">${esc(badge.line)}</div><div class="localsub">${esc(badge.sub)}</div>` : ""}`;
}
