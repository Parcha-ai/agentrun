// The shell words of the commands the providers build, read back the way a shell reads them, for the fakes that play a
// vendor's command runner (fake-orgo's channel, the adapter's fake host). Nothing runs.

/** The words of a shell command the provider builds: sh -c '<script>' sh '<arg>'..., each word single-quoted. */
export function wordsOf(command) {
	const words = [];
	let at = 0;
	while (at < command.length) {
		if (command[at] === " ") {
			at++;
			continue;
		}
		let word = "";
		while (at < command.length && command[at] !== " ") {
			if (command[at] === "'") {
				const end = command.indexOf("'", at + 1);
				word += command.slice(at + 1, end);
				at = end + 1;
			} else if (command[at] === "\\") {
				word += command[at + 1];
				at += 2;
			} else word += command[at++];
		}
		words.push(word);
	}
	return words;
}

/** Which of the provider's scripts an argv is (`sh -c '# agentrun-computer: <kind>\n...' sh <args>`), and its arguments. */
export function scriptOfWords(words) {
	const mark = /^# agentrun-computer: (\w+)\n/.exec(words[2] ?? "");
	if (words[0] !== "sh" || words[1] !== "-c" || mark === null) return undefined;
	return { kind: mark[1], args: words.slice(4) };
}

/** Which of the provider's scripts a command line is, and its arguments. */
export function scriptOf(command) {
	return scriptOfWords(wordsOf(command));
}
