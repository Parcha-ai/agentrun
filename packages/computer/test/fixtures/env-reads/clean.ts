// process.env.HOME in a comment is no read, nor is process["env"] here, nor /* const { env } = process */ in a block.
// Never compiled: scripts/check-env.mjs must find nothing in it.
export const words = "process.env.HOME is only text";
export const template = `process.env in template text, and process["env"] too`;
export const pattern = /process\.env\.HOME/;
export const rpc = { "process.start": 1, "process.read": 2 };

export function members(config: { env: Record<string, string>; process: { env: string } }): unknown[] {
	return [process.argv.slice(2), process.getuid?.(), process.getgid?.(), process.platform, process.execPath, config.env.HOME, config.process.env, globalThis.WebSocket];
}
