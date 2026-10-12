// A RemoteBox over the GG box's guard (POST /gg/exec, its own key): the hands of a session hosted elsewhere (the VM that
// mounts the run's disk), so the agent's commands still run only on the GG box, as `agent`. A command's stdin is sent
// with the request, once it is closed (RemoteEnv always closes stdin before it reads); its output comes back as frames.
import type { RemoteBox, RemoteProcess } from "@parcha/pi-durable-disk";

class Channel implements AsyncIterable<Uint8Array> {
  private chunks: Uint8Array[] = [];
  private ended = false;
  private wake: (() => void) | undefined;
  private readonly start: () => void;
  constructor(start: () => void) {
    this.start = start;
  }
  push(chunk: Uint8Array) {
    this.chunks.push(chunk);
    this.wake?.();
  }
  end() {
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    this.start();
    for (;;) {
      if (this.chunks.length) yield this.chunks.shift()!;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

export function httpBox(o: { url: string; key: string; id?: string }): RemoteBox {
  return {
    sandboxId: o.id ?? "gg-box",
    poll: async () => null,
    exec: async (command, params) => {
      const stdin: Uint8Array[] = [];
      let started = false;
      let settle!: (code: number) => void;
      const exited = new Promise<number>((resolve) => (settle = resolve));
      const start = () => {
        if (started) return;
        started = true;
        void (async () => {
          let code = 255;
          try {
            const res = await fetch(`${o.url}/gg/exec`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${o.key}` },
              body: JSON.stringify({ argv: command, stdin: Buffer.concat(stdin).toString("base64"), timeout_ms: params.timeoutMs ?? 1_800_000 }),
            });
            if (!res.ok || !res.body) throw new Error(`the GG box answered ${res.status}`);
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              for (let at = buf.indexOf("\n"); at >= 0; at = buf.indexOf("\n")) {
                const line = buf.slice(0, at);
                buf = buf.slice(at + 1);
                if (!line) continue;
                const frame = JSON.parse(line) as { stream?: "stdout" | "stderr"; data?: string; exit?: number };
                if (frame.exit !== undefined) code = frame.exit;
                else (frame.stream === "stdout" ? out : err).push(Buffer.from(frame.data ?? "", "base64"));
              }
            }
          } catch (e) {
            err.push(Buffer.from(`gg exec: ${(e as Error).message}\n`));
          } finally {
            out.end();
            err.end();
            settle(code);
          }
        })();
      };
      const out = new Channel(start);
      const err = new Channel(start);
      const proc: RemoteProcess = {
        stdin: { writeBytes: async (bytes) => void stdin.push(bytes), close: async () => start() },
        stdout: out,
        stderr: err,
        wait: () => {
          start();
          return exited;
        },
      };
      return proc;
    },
  };
}

/** A shell on that box as `agent`: the command's stdout, or a throw with its exit code. */
export function boxShell(box: RemoteBox) {
  return async (cmd: string): Promise<string> => {
    const p = await box.exec(["sh", "-c", cmd], { mode: "binary", timeoutMs: 120_000 });
    await p.stdin.close();
    const parts: Uint8Array[] = [];
    for await (const chunk of p.stdout as AsyncIterable<Uint8Array>) parts.push(chunk);
    for await (const _ of p.stderr as AsyncIterable<Uint8Array>) void _;
    const code = await p.wait();
    if (code !== 0) throw new Error(`${cmd.slice(0, 60)} exited ${code}`);
    return Buffer.concat(parts).toString("utf8");
  };
}
