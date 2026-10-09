export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
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
