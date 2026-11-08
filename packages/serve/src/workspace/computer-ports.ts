// A computer's narrow ports, as the kernel registry's kind tools reach them (run-adapters kernel/registry Hands: screen,
// input, phone), over the computer's computerd client (@parcha/agentrun-computer's ComputerClient): a desktop's screen
// is screen.shot, read to its end with screen.read; its input is input.actions; a phone's screen is the same shot, its
// tap, swipe and typing are input.actions of its touch group, and its apps are apps.list and apps.launch. A phone with no
// computerd (daemon none) answers the same methods in process, so one port fits both. A refusal throws the computer's
// code and words, as the kernel's port says.
import type { ComputerClient, InputAction as ComputerAction, Result } from "@parcha/agentrun-computer";
import type { Input, Phone, Screen, Shot } from "@parcha/agentrun-kernel/kernel";

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

/** A phone: its screen's shot, a tap, a swipe and typing as input.actions of its touch and keys, its apps. */
export const phoneOf = (client: ComputerClient): Phone => ({
  shot: () => shotOf(client),
  tap: (at) => act(client, [{ type: "tap", at: [at.x, at.y] }]),
  swipe: ({ from, to, durationMs }) => act(client, [{ type: "swipe", path: [[from.x, from.y], [to.x, to.y]], ms: durationMs }]),
  type: (text) => act(client, [{ type: "type", text }]),
  apps: {
    async list() {
      const listed = await valueOf(client.call("apps.list", {}));
      return { apps: listed.apps.map((app) => (app.name === undefined ? { id: app.id } : { id: app.id, name: app.name })), foreground: listed.foreground };
    },
    open: async (id) => void (await valueOf(client.call("apps.launch", { id }))),
  },
});
