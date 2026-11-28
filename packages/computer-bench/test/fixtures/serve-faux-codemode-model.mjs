// serve's --faux model for the bench's end-to-end test over this repository's serve (test/serve.test.mjs): one codemode
// script that takes a screenshot (computer.screen.shot) and sends input (computer.input.act), each a nested call of the
// script's, then the answer "Done.". No key, no network.
const SCRIPT = [
	"await computer.screen.shot();",
	"await computer.input.act([{ type: 'move', at: [10, 10] }, { type: 'click', at: [10, 10] }]);",
	"return 'acted';",
].join("\n");

export default async function reply(context, faux) {
	if (context.messages.some((message) => message.role === "toolResult")) return faux.message("Done.");
	return faux.message(faux.toolCall("codemode", { script: SCRIPT }), { stopReason: "toolUse" });
}
