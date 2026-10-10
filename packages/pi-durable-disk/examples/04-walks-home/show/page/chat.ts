// The v2 stage's chat: the user's words and the agent's own text, large, with the newest at the bottom. Pure (state in, HTML out).
import type { ChatTurn } from "../types.ts";
import { esc, mdHtml } from "./dom.ts";

/** The last turns that fit the pane; older ones are dropped from the page (the log keeps them). */
export function visibleTurns(turns: readonly ChatTurn[], max = 6): ChatTurn[] {
  return turns.slice(-max);
}

/** The model's turns (ids m<n>, episode 2 and the obsession episode) render **bold** and *italic*; the agent's and the viewer's lines are plain text. */
const saidHtml = (t: ChatTurn) => `${t.role === "agent" && /^m\d/.test(t.id) ? mdHtml(t.text) : esc(t.text)}${t.streaming ? '<span class="caret"></span>' : ""}`;
const turnClass = (t: ChatTurn, age: number) => `turn ${t.role}${t.streaming ? " streaming" : ""}${age >= 3 ? " old" : ""}`;

export function chatHtml(turns: readonly ChatTurn[], max = 6): string {
  const shown = visibleTurns(turns, max);
  return shown
    .map((t, i) => `<div class="${turnClass(t, shown.length - 1 - i)}" data-id="${esc(t.id)}"><div class="who">${t.role === "user" ? "You" : "Agent"}</div><div class="said">${saidHtml(t)}</div></div>`)
    .join("");
}

/**
 * Brings the page's chat in line with the turns without rebuilding it: a new turn is added (and animates in once), a streaming line
 * grows in place, an old one is dimmed or dropped. Rebuilding on every token would replay the entrance animation each time.
 */
export function syncChat(container: HTMLElement, turns: readonly ChatTurn[], max = 6): void {
  const shown = visibleTurns(turns, max);
  const keep = new Set(shown.map((t) => t.id));
  const have = new Map<string, HTMLElement>();
  for (const el of Array.from(container.children) as HTMLElement[]) {
    if (keep.has(el.dataset.id ?? "")) have.set(el.dataset.id!, el);
    else el.remove();
  }
  shown.forEach((t, i) => {
    const age = shown.length - 1 - i;
    let el = have.get(t.id);
    if (!el) {
      const tpl = document.createElement("template");
      tpl.innerHTML = chatHtml([t], 1);
      el = tpl.content.firstElementChild as HTMLElement;
      container.append(el);
    }
    const sig = `${t.text}|${t.streaming ? 1 : 0}|${age >= 3 ? 1 : 0}`;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.className = turnClass(t, age);
    el.querySelector(".said")!.innerHTML = saidHtml(t);
  });
}
