// @parcha/agentrun-dsl/browser/worker: the browser entry served from a Web Worker, so a workflow document is
// validated, inspected, dry-run and hashed off the page's thread, and a code node runs where the host chose.
//
//   worker script:  serveWorker(self, { runCode })        // runCode is required
//   page:           const client = createWorkerClient(new Worker(url, { type: "module" }));
//                   await client.validate(workflow)
//
// There is no default way to run code here and no default eval: `serveWorker` throws without a `runCode` function,
// and a code node reaches only that function. The module itself contains neither `eval` nor `new Function`; a host
// that supplies a `runCode` built on one owns that choice.
import { dryRunWorkflow, inspectWorkflow, validateWorkflow, workflowSha256 } from "./index.js";
import type { DryRunOptions, DryRunResult, Workflow, WorkflowInspection } from "./index.js";

export type RunCode = NonNullable<DryRunOptions["runCode"]>;

/** The part of a worker's global scope that `serveWorker` uses. A Web Worker's `self` satisfies it. */
export type WorkerScope = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
};

/** The part of a `Worker` that `createWorkerClient` uses. A Web Worker satisfies it. */
export type WorkerLike = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  terminate?(): void;
};

export type WorkerOp = "validate" | "inspect" | "dryRun" | "sha256";
export type WorkerRequest = { id: number; op: WorkerOp; workflow: Workflow; options?: Omit<DryRunOptions, "runCode"> };
export type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string } };

const isRequest = (value: unknown): value is WorkerRequest =>
  typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "number" && typeof (value as { op?: unknown }).op === "string";

/** Answer each request posted to `scope` with the result of the operation it names, or with an error. A request for an
 *  unknown operation gets an error reply, never silence. `runCode` is required: it is the only way a code node runs. */
export function serveWorker(scope: WorkerScope, options: { runCode: RunCode }): void {
  if (!options || typeof options.runCode !== "function") {
    throw new TypeError("serveWorker needs options.runCode, a function: a code node runs only through the host's runCode");
  }
  const { runCode } = options;
  scope.addEventListener("message", (event) => {
    const request = event.data;
    if (!isRequest(request)) return;
    const { id, op, workflow } = request;
    const reply = async (): Promise<WorkerReply> => {
      try {
        switch (op) {
          case "validate": return { id, ok: true, result: validateWorkflow(workflow) };
          case "inspect": return { id, ok: true, result: inspectWorkflow(workflow) };
          case "dryRun": return { id, ok: true, result: await dryRunWorkflow(workflow, { ...(request.options ?? {}), runCode }) };
          case "sha256": return { id, ok: true, result: workflowSha256(workflow) };
          default: return { id, ok: false, error: { name: "Error", message: `unknown op "${String(op)}"` } };
        }
      } catch (error) {
        return { id, ok: false, error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } };
      }
    };
    void reply().then((message) => scope.postMessage(message));
  });
}

export type WorkerClient = {
  validate(workflow: Workflow): Promise<ReturnType<typeof validateWorkflow>>;
  inspect(workflow: Workflow): Promise<WorkflowInspection>;
  dryRun(workflow: Workflow, options?: Omit<DryRunOptions, "runCode">): Promise<DryRunResult>;
  sha256(workflow: Workflow): Promise<string>;
  terminate(): void;
};

/** The page's side: each call posts one request to `worker` and resolves with its reply. */
export function createWorkerClient(worker: WorkerLike): WorkerClient {
  let next = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  worker.addEventListener("message", (event) => {
    const reply = event.data as WorkerReply;
    const waiting = reply && typeof reply.id === "number" ? pending.get(reply.id) : undefined;
    if (!waiting) return;
    pending.delete(reply.id);
    if (reply.ok) waiting.resolve(reply.result);
    else waiting.reject(Object.assign(new Error(reply.error.message), { name: reply.error.name }));
  });
  const call = <T>(op: WorkerOp, workflow: Workflow, options?: WorkerRequest["options"]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, op, workflow, ...(options ? { options } : {}) } satisfies WorkerRequest);
    });
  return {
    validate: (workflow) => call("validate", workflow),
    inspect: (workflow) => call("inspect", workflow),
    dryRun: (workflow, options) => call("dryRun", workflow, options),
    sha256: (workflow) => call("sha256", workflow),
    terminate: () => { for (const waiting of pending.values()) waiting.reject(new Error("worker terminated")); pending.clear(); worker.terminate?.(); },
  };
}
