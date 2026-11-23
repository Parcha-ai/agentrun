import type { Meta, StoryObj } from "@storybook/react-vite";
import { LocalModelCard } from "@/components/LocalModelCard";
import { createClient } from "@/lib/client";
import type { LocalModel } from "@/lib/v2";

// The first screen's "Free local model" card in each of its faces, over a client whose answers are invented here.
const meta: Meta = { title: "Start a run/Free local model" };
export default meta;
type Story = StoryObj;

const GIB = 1024 ** 3;
const view = (over: Partial<LocalModel> = {}): LocalModel => ({
  machine: { platform: "linux", arch: "x64", ram_bytes: 32 * GIB, gpu: { kind: "unknown" } },
  ollama: { reachable: true, version: "0.40.17" },
  recommended: { tag: "qwen3:8b", why: "qwen3:8b fits this machine's 32.0 GiB of memory (it needs 15 GiB).", pulled: false },
  pull: null,
  can_pull: true,
  refused: null,
  ...over,
});
/** A client whose GET answers `answer` (never, for a machine still being read). */
const client = (answer: LocalModel | null) =>
  createClient({ fetch: (async () => (answer ? new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }) : new Promise<Response>(() => {}))) as typeof fetch });
const card = (answer: LocalModel | null) => <LocalModelCard v2={client(answer)} pollMs={3_600_000} onDone={() => {}} />;

export const Unknown: Story = { render: () => card(null) };
export const Recommend: Story = { render: () => card(view()) };
export const RecommendMac: Story = { render: () => card(view({ machine: { platform: "darwin", arch: "arm64", ram_bytes: 32 * GIB, gpu: { kind: "apple", unified: true } }, recommended: { tag: "inkling-2-mini", why: "Apple silicon with Ollama 0.40.17 runs inkling-2-mini; inkling-2-mini needs 15 GiB of memory, and this Mac has 32.0 GiB.", pulled: false } })) };
export const Pulling: Story = { render: () => card(view({ pull: { tag: "qwen3:8b", state: "pulling", status: "pulling a3de86cd1c13", completed_bytes: 2 * GIB, total_bytes: 5 * GIB } })) };
export const Ready: Story = { render: () => card(view({ recommended: { tag: "qwen3:8b", why: "Already pulled: no pull needed.", pulled: true } })) };
export const NoneNoOllama: Story = { render: () => card(view({ ollama: { reachable: false, version: null }, recommended: { tag: null, why: "Ollama isn't running on this machine. Install it from https://ollama.com/download, start it, then come back here.", pulled: false } })) };
export const Refused: Story = { render: () => card(view({ can_pull: false, refused: "A local model is pulled from here only on one owner's own server on their own machine, and this server runs no runner beside it (--no-runner). Pull it where Ollama runs: ollama pull <tag>." })) };
