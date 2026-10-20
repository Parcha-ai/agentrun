// What the example is made of, in one place: the model, the number of threads, and where the threads' tools run.

/** How many child conversations the session forks, one H100 sandbox each. */
export const THREADS = 8;

/** The model the live run uses, and how hard it thinks. Thinking is on. */
export const MODEL = { provider: "anthropic", modelId: "claude-sonnet-5-5" } as const;
export const THINKING = "medium" as const;

/** The GPU every thread's box gets, and the image it comes from (it carries PyTorch and CUDA, so a thread trains instead of installing). */
/** `H100!` is Modal's exact-type form: plain `H100` may be served as an H200 (measured), and the recording must say what each box had. */
export const GPU = "H100!";
export const GPU_IMAGE = process.env.MOVES_GPU_IMAGE ?? "pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime";

/**
 * pi-transport's `transport` block. Every command the agent runs goes to a Modal sandbox, never to the machine the session
 * runs on: the default environment is a CPU sandbox, and each thread is pointed at the `gpu` role, which gives its
 * conversation its own H100 sandbox (gVisor, the only runtime Modal offers a GPU on). No environment is named `local`: with no
 * local provider that would fall back to the host's own environment, which is the session's machine.
 */
export function transportBlock(): unknown {
  return {
    environments: {
      sandbox: { provider: "modal", isolation: "gvisor", maxLifetime: "30m", purpose: "The session's own tools, in a sandbox: nothing runs on the host." },
      gpu: { provider: "modal", gpu: GPU, image: GPU_IMAGE, isolation: "gvisor", maxLifetime: "30m", scope: "conversation", purpose: "One H100 for one conversation's GPU work." },
    },
    hands: { default: "sandbox", gpu: "gpu" },
  };
}

/** The wording the example uses for what it shows, and the words it never uses (a test holds both). */
export const SAYS = "the session on a Modal VM with its disk mounted, and 8 H100 sandboxes for the threads' tools";
export const NEVER_SAYS = [/modal vm with 8 gpus?/i, /browser tab/i];
