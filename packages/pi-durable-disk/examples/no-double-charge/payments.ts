// A fake payment server: `POST /charges` with an `Idempotency-Key` header and a JSON body `{ invoice, amount }`. It
// counts every charge it receives and never deduplicates, so a charge sent twice shows as two. A hold keeps one key's
// charge open, counted and unanswered, so the example can kill the agent while that charge is in flight.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface Charge {
  readonly seq: number;
  readonly key: string;
  readonly invoice: number;
  readonly amount: number;
  /** `answered`, `held` (no answer yet), or `cut` (the caller went away before an answer). */
  state: "answered" | "held" | "cut";
}

export interface Payments {
  readonly url: string;
  /** Every charge received, in order. */
  readonly charges: readonly Charge[];
  /** Resolves with the held charge once it arrives. */
  readonly held: Promise<Charge>;
  close(): Promise<void>;
}

export async function startPayments(holdKey: string): Promise<Payments> {
  const charges: Charge[] = [];
  let caught: (charge: Charge) => void = () => {};
  const held = new Promise<Charge>((resolve) => (caught = resolve));
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      const key = req.headers["idempotency-key"];
      if (req.method !== "POST" || req.url !== "/charges" || typeof key !== "string") {
        res.writeHead(400).end();
        return;
      }
      const { invoice, amount } = JSON.parse(body) as { invoice: number; amount: number };
      const repeat = charges.some((c) => c.key === key);
      const charge: Charge = { seq: charges.length + 1, key, invoice, amount, state: "answered" };
      charges.push(charge);
      // Only the key's first charge is held: one sent again is answered, and shows in the count.
      if (key === holdKey && !repeat) {
        charge.state = "held";
        res.on("close", () => (charge.state = "cut"));
        caught(charge);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `ch_${charge.seq}`, invoice, amount }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    charges,
    held,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
