// A command that prints its last line and never exits, its main thread asleep in a futex: what a command stuck at its
// exit looks like from outside (started-threads.test.mjs).
process.stderr.write("refused: no such case\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
