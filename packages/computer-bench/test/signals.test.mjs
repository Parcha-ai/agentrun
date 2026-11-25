// How the command line stops a run: the first SIGINT or SIGTERM aborts it, and a later one never kills the bench before
// its computers are torn down and released. An EventEmitter stands in for the process, so no real signal is sent.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { stopOnSignals } from "../dist/index.js";

test("the first SIGINT stops the run; a second only says the stop is under way, and still finds a listener", () => {
	const emitter = new EventEmitter();
	const controller = new AbortController();
	const said = [];
	stopOnSignals(emitter, controller, (line) => said.push(line));
	emitter.emit("SIGINT");
	assert.equal(controller.signal.aborted, true);
	const reason = controller.signal.reason;
	// A signal with no listener gets its default action, which ends the process at once.
	assert.ok(emitter.listenerCount("SIGINT") > 0, "a second SIGINT would kill the bench before its computers are released");
	emitter.emit("SIGINT");
	emitter.emit("SIGTERM");
	emitter.emit("SIGINT");
	assert.equal(controller.signal.reason, reason, "the run is stopped once");
	assert.equal(said.length, 2, `it says it is stopping, then once that the stop is under way: ${JSON.stringify(said)}`);
	assert.ok(emitter.listenerCount("SIGINT") > 0 && emitter.listenerCount("SIGTERM") > 0);
});

test("a SIGTERM stops the run the way a SIGINT does", () => {
	const emitter = new EventEmitter();
	const controller = new AbortController();
	stopOnSignals(emitter, controller, () => {});
	emitter.emit("SIGTERM");
	assert.equal(controller.signal.aborted, true);
	assert.ok(emitter.listenerCount("SIGTERM") > 0, "a second SIGTERM would kill the bench before its computers are released");
});
