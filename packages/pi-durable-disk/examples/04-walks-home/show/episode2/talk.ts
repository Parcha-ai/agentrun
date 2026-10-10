// The payoff pane: once the viewer has asked the trained model something, the big pane shows the latest question and its answer large, not the tab's static
// model card. Pure (turns in, HTML out). The turns are the stage's own model chat (episode2/model-chat.ts): a viewer's line is `mu<n>`, the model's answer `m<n>`.
import type { ChatTurn } from "../types.ts";
import { esc } from "../page/dom.ts";

const isModel = (t: ChatTurn) => /^m\d/.test(t.id) && t.role === "agent";
const isAsk = (t: ChatTurn) => /^mu\d/.test(t.id) && t.role === "user";

/** The latest question and its answer, or null while nothing has been asked of the model (the tab's own card shows then). */
export function talkHtml(turns: readonly ChatTurn[]): string | null {
  const answer = [...turns].reverse().find(isModel);
  if (!answer) return null;
  const question = [...turns].reverse().find((t) => isAsk(t) && t.id === `mu${answer.id.slice(1)}`);
  const text = answer.text === "" ? "…" : esc(answer.text);
  return `${question ? `<div class="q">${esc(question.text)}</div>` : ""}<div class="a">${text}${answer.streaming ? '<span class="caret"></span>' : ""}</div>`;
}
