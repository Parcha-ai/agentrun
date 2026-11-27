// Cuts one text in the server's cut worker, prints it, and returns: the process ends on its own, the kept worker never
// holding it open.
import { cutInWorker } from "../../dist/cut-pool.js";

process.stdout.write(`${await cutInWorker("key=notasecretvalue1 stays", ["notasecretvalue1"], 1024)}\n`);
