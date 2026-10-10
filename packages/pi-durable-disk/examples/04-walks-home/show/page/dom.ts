export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Basic markdown in a model's answer (a small model writes **bold** and *italic*): escaped first, so nothing but the two tags these produce can get through. A mark that
 * is not closed (an answer still streaming) stays as the text it is.
 */
export function mdHtml(text: string): string {
  return esc(text).replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*\n]*?)\*(?!\*)/g, "$1<em>$2</em>");
}

export function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

export const KIND_COLOR: Record<string, string> = {
  tab: "var(--tab)",
  sandbox: "var(--sandbox)",
  vm: "var(--vm)",
  gpu: "var(--gpu)",
  pipe: "var(--pipe)",
};

export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function usd(n: number, digits = 2): string {
  return `$${n.toFixed(digits)}`;
}
