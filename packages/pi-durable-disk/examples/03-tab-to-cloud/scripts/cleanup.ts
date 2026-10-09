// Remove what a demo run left on the disk: the ledger's open token users, run directories and mounts. Prints names and
// counts only, never a token.
import { readFileSync } from "node:fs";
import { deleteRunTree, removeMountToken, unmountClaim } from "@parcha/pi-durable-disk";
import { archilControl, Ledger } from "../pipe/control.ts";

const ledger = new Ledger(process.env.DEMO_LEDGER ?? "DEMO-STATE.json");
const control = await archilControl({ disk: process.env.PDA_LIVE_DISK!, region: process.env.PDA_LIVE_REGION ?? "aws-us-east-1", apiKey: process.env.ARCHIL_API_KEY! });
for (const row of ledger.openRows()) {
  try {
    if (row.kind === "token-user") await removeMountToken(control, row.id);
    else if (row.kind === "run-dir") await deleteRunTree(control, row.id);
    else if (row.kind === "mount") {
      if (readFileSync("/proc/mounts", "utf8").split("\n").some((l) => l.split(" ")[1] === row.id)) await unmountClaim(row.id);
    } else continue;
    ledger.close(row.kind, row.id, "cleanup script");
    console.log(JSON.stringify({ closed: row.kind, id: row.id }));
  } catch (error) {
    console.log(JSON.stringify({ failed: row.kind, id: row.id, error: (error as Error).message }));
  }
}
console.log(JSON.stringify({ open: ledger.openRows().length }));
