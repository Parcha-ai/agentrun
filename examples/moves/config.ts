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

/** The wording the example uses for what it shows, and the words it never uses (a test holds both). */
export const SAYS = "One run moves from this machine to a Modal VM and back; its workspace on the Archil disk carries the brief and the result; on the VM, one session forks 8 threads, each with its tools on its own H100 sandbox.";
export const NEVER_SAYS = [/modal vm with 8 gpus?/i, /browser tab/i, /one session moves across three hosts/i];
