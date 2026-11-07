// A faux module with no default export, as faux-broken.mjs: the run's process fails to load its app, says so, and closes
// its door. Its exit then takes half a second, as a loaded host's can: a proof of its door fails meanwhile, while the
// process, which has failed on its own, still lives.
if (process.argv.includes("--app")) process.once("exit", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500));
export const reply = () => "never";
