// A host listener on a Unix socket, written for AgentRun: the socket a session's box reaches the host through.
//  - Mode 0600, made under a temporary name and linked into place, so it never stands at its path with wider modes. The
//    link refuses a path taken meanwhile: two listeners started together never both take it, and the later one is refused.
//  - Released only while it is still this listener's own (the same file), never another listener's put there since.
//  - A socket already at the path is replaced only when nothing answers it (ECONNREFUSED: a session that died left it).
//    One that answers is another listener's, live, and is refused by name; anything at the path that is not a socket is
//    refused too. A machine that died leaves its sockets behind, and a second start must never take a live one over.
import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, lstatSync, unlinkSync } from "node:fs";
import type { Server } from "node:net";
import { connect } from "node:net";
import { dirname, join } from "node:path";

/** Whether a listener answers at the socket `path`: false only when a connect is refused (nothing listens). */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

/** A socket this listener put at its path: `release` removes it, only while the path is still that same file. */
export interface ListenedSocket {
  release(): void;
}

/** Listen with `server` on the Unix socket `path`, mode 0600. Its directory must exist, and be local: the machine's
 *  session runtime directory, checked where it is made (./machine.ts). `name` begins the messages. */
export async function listenSocket(server: Server, path: string, name: string): Promise<ListenedSocket> {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (stat) {
    if (!stat.isSocket()) throw new Error(`${name}: ${path} is there and is not a socket: it is not replaced`);
    if (await answers(path)) throw new Error(`${name}: a live listener is at ${path}: it is not taken over`);
    unlinkSync(path);
  }
  const temporary = join(dirname(path), `.${randomBytes(6).toString("hex")}.sock`);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(temporary, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let ino: number;
  try {
    chmodSync(temporary, 0o600);
    linkSync(temporary, path);
    ino = lstatSync(path).ino;
  } catch (error) {
    server.close();
    try { unlinkSync(temporary); } catch { /* gone */ }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${name}: a listener was published at ${path} while this one started: it is not taken over`);
    throw error;
  } finally {
    try { unlinkSync(temporary); } catch { /* gone */ }
  }
  return {
    release() {
      try {
        if (lstatSync(path).ino === ino) unlinkSync(path);
      } catch {
        // Gone already.
      }
    },
  };
}
