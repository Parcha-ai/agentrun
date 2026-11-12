// A computer's narrow ports, as the kernel registry's kind tools reach them (run-adapters kernel/registry Hands: screen,
// input, phone), over the computer's computerd client (@parcha/agentrun-computer's ComputerClient): a desktop's screen
// is screen.shot, read to its end with screen.read; its input is input.actions; a phone's screen is the same shot, its
// structure ui.observe, its tap, swipe, typing and keys are input.actions (back and home its touch group's buttons,
// enter a key), and its apps are apps.list and apps.launch. A phone with no
// computerd (daemon none) answers the same methods in process, so one port fits both. A refusal throws the computer's
// code and words, as the kernel's port says.
import type { ComputerClient, InputAction as ComputerAction, Result, UiNode } from "@parcha/agentrun-computer";
import type { Input, Phone, PhoneKey, PhoneNode, Screen, Shot } from "@parcha/agentrun-kernel/kernel";

/** A computer call's value, or its refusal thrown with the computer's code and words. */
async function valueOf<T>(call: Promise<Result<T>>): Promise<T> {
  const result = await call;
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.error.message), { code: result.error.code });
}

/** The screen's shot: its first piece, then screen.read from where it ends until the end. */
async function shotOf(client: ComputerClient, region?: readonly [number, number, number, number]): Promise<Shot> {
  const first = await valueOf(client.call("screen.shot", region ? { region: [...region] as [number, number, number, number] } : {}));
  const pieces = [Buffer.from(first.data, "base64")];
  let offset = pieces[0]!.length;
  for (let eof = first.eof; !eof;) {
    const next = await valueOf(client.call("screen.read", { id: first.id, offset }));
    const piece = Buffer.from(next.data, "base64");
    if (piece.length === 0 && !next.eof) throw Object.assign(new Error(`the computer's screenshot stopped at byte ${offset} of ${first.size}`), { code: "invalid" });
    pieces.push(piece);
    offset += piece.length;
    eof = next.eof;
  }
  return { png: Buffer.concat(pieces), width: first.width, height: first.height };
}

/** input.actions: a batch that failed partway throws the computer's code and words, and how many ran. */
async function act(client: ComputerClient, actions: readonly ComputerAction[]): Promise<void> {
  const ran = await valueOf(client.call("input.actions", { actions: [...actions] }));
  if (!ran.failed) return;
  const words = ran.done > 0 ? `${ran.failed.message} (${ran.done} of ${actions.length} actions ran)` : ran.failed.message;
  throw Object.assign(new Error(words), { code: ran.failed.kind });
}

/** A desktop's screen: screen.shot, the whole screen or a region of it in the whole screen's pixels. */
export const screenOf = (client: ComputerClient): Screen => ({
  shot: (options) => shotOf(client, options?.region ? [options.region.x, options.region.y, options.region.w, options.region.h] : undefined),
});

/** A desktop's input: input.actions, the batch as the kernel's port gives it (computerd's own actions). */
export const inputOf = (client: ComputerClient): Input => ({
  actions: (list) => act(client, list as unknown as readonly ComputerAction[]),
});

/** The roles a model types into. */
const EDITABLE = new Set<string>(["textbox", "searchbox"]);
/** The roles that take a tap by themselves, with or without a named action. */
const ACTIONABLE = new Set<string>(["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "slider", "combobox", "textbox", "searchbox"]);

/** The first name (else value) among `node`'s descendants, in order: the name of a node that has none of its own (a list
 *  row whose title sits on a child text). `children` maps a ref to the nodes whose parent it is. */
function innerName(node: UiNode, children: ReadonlyMap<string, readonly UiNode[]>): string | undefined {
  let value: string | undefined;
  const stack = [...(children.get(node.ref) ?? [])].reverse();
  while (stack.length) {
    const next = stack.pop()!;
    if (next.name) return next.name;
    value ??= next.value || undefined;
    for (const child of [...(children.get(next.ref) ?? [])].reverse()) stack.push(child);
  }
  return value;
}

/** The screen's structure (ui.observe's nodes, flat, a node after its parent), each node with whether a model can tap it
 *  or type into it: tappable with an action or an actionable role, typeable as a textbox or searchbox; a disabled or
 *  offscreen node is neither. A tappable node with no name of its own is named by its first inner name (else value), as
 *  phone_tree shows it, marked so. Bounds arrive in window points (the phone's window is its whole screen) and leave in
 *  screenshot PIXELS, points times `scale` (hello.screen.scale), because phone_tap goes through input.actions. */
function flattened(nodes: readonly UiNode[], scale: number): PhoneNode[] {
  const children = new Map<string, UiNode[]>();
  for (const node of nodes) if (node.parent) children.set(node.parent, [...(children.get(node.parent) ?? []), node]);
  const px = (points: number) => Math.round(points * scale);
  return nodes.map((node) => {
    const [x, y, w, h] = node.bounds;
    const usable = !node.flags?.includes("disabled") && !node.flags?.includes("offscreen");
    const editable = usable && EDITABLE.has(node.role);
    const clickable = usable && ((node.actions?.length ?? 0) > 0 || ACTIONABLE.has(node.role));
    const own = node.name || node.value;
    const inner = clickable && !own ? innerName(node, children) : undefined;
    // Both, never one for the other: a labeled field shows its label and the text in it.
    return {
      role: node.role,
      ...(node.id ? { id: node.id } : {}),
      ...(node.name ? { label: node.name } : {}),
      ...(node.value ? { text: node.value } : {}),
      bounds: { x: px(x), y: px(y), w: px(w), h: px(h) },
      clickable,
      editable,
      ...(node.flags?.includes("focused") ? { focused: true } : {}),
      ...(inner ? { inner } : {}),
    };
  });
}

/** The keys a phone presses: back and home are its buttons (input.touch's button action), enter a key of the key table. */
const keyAction = (name: PhoneKey): ComputerAction => (name === "enter" ? { type: "key", keys: ["enter"] } : { type: "button", name });

/** A phone: its screen's shot and structure (ui.observe), a tap, a swipe, typing and its keys as input.actions, its apps.
 *  `offers`: whether the phone declares its structure (the ui group) and its keys (input.keys); one it does not declare
 *  is no method of the port (an iPhone offers neither until a live run proves them). Default both. */
export const phoneOf = (client: ComputerClient, offers: { readonly tree?: boolean; readonly keys?: boolean } = {}): Phone => ({
  shot: () => shotOf(client),
  ...(offers.tree !== false ? {
    async tree() {
      const { screen } = await valueOf(client.call("hello", { client: "agentrun-serve" }));
      const seen = await valueOf(client.call("ui.observe", {}));
      return { nodes: flattened(seen.nodes, screen?.scale ?? 1), total: seen.nodes.length, truncated: seen.truncated };
    },
  } : {}),
  tap: (at) => act(client, [{ type: "tap", at: [at.x, at.y] }]),
  swipe: ({ from, to, durationMs }) => act(client, [{ type: "swipe", path: [[from.x, from.y], [to.x, to.y]], ms: durationMs }]),
  type: (text) => act(client, [{ type: "type", text }]),
  ...(offers.keys !== false ? { key: (name: PhoneKey) => act(client, [keyAction(name)]) } : {}),
  apps: {
    async list() {
      const listed = await valueOf(client.call("apps.list", {}));
      return { apps: listed.apps.map((app) => (app.name === undefined ? { id: app.id } : { id: app.id, name: app.name })), foreground: listed.foreground };
    },
    open: async (id) => void (await valueOf(client.call("apps.launch", { id }))),
  },
});
