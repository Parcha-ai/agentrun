// A process that commits to a store in a loop until it is told to stop: the live owner of a store a checkpoint is taken from.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const storage = await openNodeSqliteStorage(process.argv[2]);
const session = createSession(storage);
const conversation = await session.commit(
	(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
	BACKGROUND_CONTEXT,
);
let stop = false;
process.on("SIGTERM", () => {
	stop = true;
});
let count = 0;
while (!stop) {
	await session.commit(
		(tx) => tx.appendEntry(conversation.id, { kind: "note", data: { count: count++, pad: "x".repeat(300) } }),
		BACKGROUND_CONTEXT,
	);
	if (count === 1) process.stdout.write("ready\n");
	// About 150 commits a second: fast enough to commit between any two steps of a copy, slow enough that the store stays small.
	await new Promise((resolve) => setTimeout(resolve, 6));
}
await session.close(BACKGROUND_CONTEXT);
process.stdout.write(`closed ${count}\n`);
