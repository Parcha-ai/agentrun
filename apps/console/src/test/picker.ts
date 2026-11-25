import { act } from "react";

// Driving the console's Picker (components/ui/picker.tsx, Headless UI's Listbox) in a test, as a person does: its field
// is a button that opens a listbox of options. The field and each option carry the value they stand for (data-value).

// The picker's positioning watches its field's size; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const FIELD = 'button[aria-haspopup="listbox"]';

/** The picker named `label` in `scope` (its field), or null. */
export const picker = (scope: ParentNode, label: string) => scope.querySelector<HTMLButtonElement>(`${FIELD}[aria-label="${label}"]`);
/** The first picker in `scope`, or null. */
export const firstPicker = (scope: ParentNode) => scope.querySelector<HTMLButtonElement>(FIELD);
/** The value a picker shows (its field's data-value). */
export const valueOf = (field: HTMLButtonElement) => field.getAttribute("data-value");
/** The words a picker shows: its field's text without the hidden copies of every option's words that a steady one
 *  holds to size itself (its textContent has those too). Undefined for no field. */
export function wordsOf(field: Element | null | undefined): string | undefined {
  if (!field) return undefined;
  const shown = field.cloneNode(true) as Element;
  for (const sizer of shown.querySelectorAll("[data-picker-sizer]")) sizer.remove();
  return shown.textContent ?? "";
}

async function opened(field: HTMLButtonElement) {
  await act(async () => { field.click(); });
  await settle();
  const list = document.querySelector<HTMLElement>('[role="listbox"]');
  if (!list) throw new Error(`the picker ${field.getAttribute("aria-label")} opened no list`);
  return list;
}
async function close(list: HTMLElement) {
  await act(async () => { list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await settle();
}

/** A picker's options as its list shows them: each one's text, value and whether it can be picked. */
export async function optionsOf(field: HTMLButtonElement): Promise<{ text: string; value: string; disabled: boolean; tagTone: string | null }[]> {
  const list = await opened(field);
  const options = [...list.querySelectorAll('[role="option"]')].map((o) => ({ text: o.textContent ?? "", value: o.getAttribute("data-value") ?? "", disabled: o.getAttribute("aria-disabled") === "true", tagTone: o.getAttribute("data-tag-tone") }));
  await close(list);
  return options;
}

/** Picks `value` in a picker: opens its list and clicks that option. */
export async function pick(field: HTMLButtonElement, value: string) {
  const list = await opened(field);
  const option = list.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`);
  if (!option) throw new Error(`the picker ${field.getAttribute("aria-label")} has no option ${value}`);
  await act(async () => { option.click(); });
  await settle();
}
