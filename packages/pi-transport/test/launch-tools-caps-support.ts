import { CAP_LINE_CHECK } from "../src/launch/launcher-script.ts";

/** The cases, over files in `dir`: each getcap line and what cap_runnable answers for it (0 runnable, 1 not, 2 no file). */
export const capLineCases = (dir: string): readonly (readonly [string, number])[] => [
	[`${dir}/plain cap_net_raw=ep`, 0],
	[`${dir}/plain cap_net_admin=ei cap_net_raw+ep`, 0],
	[`${dir}/plain = cap_net_raw+ep`, 0],
	[`${dir}/with space cap_net_raw=ep`, 0],
	[`${dir}/with space = cap_net_admin=ei cap_net_raw+ep`, 0],
	[`${dir}/closed cap_net_admin=ei cap_net_raw+ep`, 1],
	[`${dir}/gone cap_net_raw=ep`, 2],
	[`${dir}/gone`, 2],
];

/** A script that makes the cases' files in `dir` (two its user can run, one it cannot) and prints each answer, one a line. */
export const capLineScript = (dir: string): string =>
	[
		CAP_LINE_CHECK,
		"as=",
		`d='${dir}'`,
		'mkdir -p "$d" && : > "$d/plain" && : > "$d/with space" && : > "$d/closed"',
		'chmod 755 "$d/plain" "$d/with space" && chmod 644 "$d/closed"',
		...capLineCases(dir).map(([line]) => `cap_runnable '${line}'; echo $?`),
	].join("\n");
