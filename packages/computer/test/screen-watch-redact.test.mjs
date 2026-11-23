// redactWords on long word runs and on every form its URL, login, secret-named parameter, JWT and endpoint shapes
// take. A long run of word characters must not hold the event loop: four shapes are hand-written scans that read each
// character a bounded number of times, counted by redactWordsReads, and the JWT regex starts only at the first eyJ of
// a run. The scans' matches stay those of the one-regex forms they replace, kept below as the oracle; the JWT's first-eyJ
// start also cuts a token glued to a word character before it, which the old \b start missed. No timing assertions.
import assert from "node:assert/strict";
import test from "node:test";
import * as screenWatch from "../dist/screen-watch.js";

const { redactWords } = screenWatch;
// A no-break space is \s to a regex, so it ends a password or a value; an accented letter is not \w.
const NBSP = String.fromCodePoint(0xa0);
const E_ACUTE = String.fromCodePoint(0xe9);

/** The JWT's old start, at a \b only: it missed a token glued to a word character (x9eyJ..., x_eyJ...). */
const OLD_JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]*/g;
/** The JWT's start now: the first eyJ of its run, glued or not. */
const FIRST_EYJ_JWT = /eyJ(?<!eyJ[A-Za-z0-9_-]*?eyJ)[A-Za-z0-9_-]+\.[A-Za-z0-9._-]*/g;

/**
 * redactWords with a regex for every shape, the JWT's start given: with FIRST_EYJ_JWT it is the oracle the scans must
 * agree with, and with OLD_JWT it is redactWords as it was.
 */
function regexRedactWords(words, jwt = FIRST_EYJ_JWT) {
	return words
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[a URL]")
		.replace(/[\w.+-]+:[^\s@/'"]+@[\w.-]+/g, "[a login]")
		.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[a secret]")
		.replace(/\b[\w-]*(?:token|password|passwd|secret|key|jwt|auth|code|signingKey|credential)[\w-]*=[^\s&"';,]+/gi, "[a secret]")
		.replace(jwt, "[a secret]")
		.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[a secret]")
		.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[a secret]")
		.replace(/\b(?:sk|pk|pck|ph|tok|pw|jwt)_[A-Za-z0-9_-]{6,}/g, "[a secret]")
		.replace(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}:\d{1,5}\b/g, "[an endpoint]")
		.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, "[an endpoint]");
}

/** The most reads per character the four scans may take: a quadratic scan of a 40,000-character run takes thousands. */
const READS_PER_CHARACTER = 12;

function assertLinear(words, label) {
	assert.equal(typeof screenWatch.redactWordsReads, "number", "redactWords counts its scans' reads");
	const redacted = redactWords(words);
	assert.ok(
		screenWatch.redactWordsReads <= READS_PER_CHARACTER * words.length + 16,
		`${label}: ${screenWatch.redactWordsReads} reads for ${words.length} characters`,
	);
	return redacted;
}

test("redactWords' URL, login, secret-parameter and endpoint scans read each character of a long run a bounded number of times", () => {
	// Each of these made one or more of the four regexes read to the end of the run from every start in it.
	for (const [unit, n] of [
		["a", 40_000],
		["a-", 40_000],
		// The old JWT regex started at every eyJ of this run too. The first-eyJ start takes one; the JWT is a regex, so
		// its reads are not counted here.
		["eyJ-", 40_000],
		["a:", 40_000],
		["token", 40_000],
		["token_", 40_000],
		["u:p", 40_000],
		["x=", 40_000],
		["a.", 40_000],
		["a.b:", 40_000],
		["a:1", 40_000],
		["a..", 40_000],
		["_a:/", 40_000],
	]) {
		const words = unit.repeat(n);
		assert.equal(assertLinear(words, `${JSON.stringify(unit)} x ${n}`), words, "nothing in it is a secret");
		// Nothing is cut, so each of the four scans read the whole run: none of the four shapes is left a regex.
		assert.ok(screenWatch.redactWordsReads >= 4 * words.length, `${JSON.stringify(unit)}: ${screenWatch.redactWordsReads} reads`);
	}
	// A run that ends in a match is cut whole, once.
	assert.equal(assertLinear(`${"a-".repeat(40_000)}://x`, "a long scheme"), "[a URL]");
	assert.equal(assertLinear(`${"a".repeat(40_000)}:pw@host`, "a long login"), "[a login]");
	assert.equal(assertLinear(`${"token".repeat(40_000)}=v`, "a long parameter name"), "[a secret]");
	assert.equal(assertLinear(`${"a-.".repeat(40_000)}io:80`, "a long endpoint name"), "[an endpoint]");
	// An empty label just before the top-level name leaves no start in the run.
	const emptyLabels = `${"a..".repeat(40_000)}io:80`;
	assert.equal(assertLinear(emptyLabels, "a long name with empty labels"), emptyLabels);
});

/** Each case is cut as the oracle cuts it, and as written. */
function assertCuts(cases) {
	for (const [words, redacted] of cases) {
		assert.equal(regexRedactWords(words), redacted, `the oracle: ${JSON.stringify(words)}`);
		assert.equal(redactWords(words), redacted, JSON.stringify(words));
	}
}

test("redactWords cuts every URL form it cut before, and only those", () => {
	assertCuts([
		["GET https://api.vendor.example/v1/x?k=1 failed", "GET [a URL] failed"],
		["see HTTP://X.IO/a", "see [a URL]"],
		["git+ssh://git@host/repo.git", "[a URL]"],
		["a.b-c+d9://x", "[a URL]"],
		["adb://emulator-5554", "[a URL]"],
		// The cut starts at the run's first letter that follows no word character.
		["x-https://h", "[a URL]"],
		["-https://h", "-[a URL]"],
		["1.http://x", "1.[a URL]"],
		[`${E_ACUTE}http://x`, `${E_ACUTE}[a URL]`],
		["9http://x", "9http://x"],
		["_http://x", "_http://x"],
		["x_http://y", "x_http://y"],
		// The rest stops at each of its excluded characters.
		['"https://x" said', '"[a URL]" said'],
		["<https://x>", "<[a URL]>"],
		["'https://x'", "'[a URL]'"],
		["https://x y", "[a URL] y"],
		["https://x\ty", "[a URL]\ty"],
		[`https://x${NBSP}y`, `[a URL]${NBSP}y`],
		["https://a https://b", "[a URL] [a URL]"],
		["1://http://x", "1://[a URL]"],
		// Near-misses: no scheme, no rest, or not :// at once.
		["https://", "https://"],
		["https:// x", "https:// x"],
		["https:/x", "https:/x"],
		["://x", "://x"],
		["https ://x", "https ://x"],
	]);
});

test("redactWords cuts every endpoint form it cut before, and only those", () => {
	assertCuts([
		["failed to connect to 'live.phone-harness.com:22220'", "failed to connect to '[an endpoint]'"],
		["adb connect emulator-5554.local:5555 ok", "adb connect [an endpoint] ok"],
		["a.b.co:1", "[an endpoint]"],
		["X.IO:65535", "[an endpoint]"],
		["a-.io:80", "[an endpoint]"],
		["x-a.io:80", "[an endpoint]"],
		["a.io:80:90", "[an endpoint]:90"],
		["a.io:80.b.io:90", "[an endpoint].[an endpoint]"],
		// The name starts where \b holds, at no dot, after the last empty label.
		[".a.io:80", ".[an endpoint]"],
		["-a.io:80", "-[an endpoint]"],
		["x..a.io:80", "x..[an endpoint]"],
		["x_a.io:80", "x_a.io:80"],
		["a..io:80", "a..io:80"],
		// The port: one to five digits, and no word character after them.
		["a.io:12345", "[an endpoint]"],
		["a.io:123456", "a.io:123456"],
		["a.io:12a", "a.io:12a"],
		["a.io:12_", "a.io:12_"],
		["a.io:12-x", "[an endpoint]-x"],
		["a.io:12.5", "[an endpoint].5"],
		[`a.io:12${E_ACUTE}`, `[an endpoint]${E_ACUTE}`],
		// Near-misses: a top-level name that is short or not all letters, no dot, or no port.
		["a.b:80", "a.b:80"],
		["a.b1:80", "a.b1:80"],
		["a.1b:80", "a.1b:80"],
		["host:80", "host:80"],
		["a.io:", "a.io:"],
		["a.io: 80", "a.io: 80"],
		// An IPv4 address is still the last shape's.
		["no route to 10.1.2.3:5555", "no route to [an endpoint]"],
	]);
});

test("redactWords cuts a JWT from the first eyJ of its run, glued to a word character too", () => {
	const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
	// [words, cut now, cut before]: before, the start was a \b, so a token glued to a letter, digit or _ was missed
	// from its first eyJ and cut, if at all, from a later eyJ after a dot or a dash.
	for (const [words, now, before = now] of [
		[token, "[a secret]"],
		[`id=${token}`, "id=[a secret]"],
		[`got ${token} back`, "got [a secret] back"],
		[`"${token}"`, '"[a secret]"'],
		[`'${token}'`, "'[a secret]'"],
		[`first\n${token}\nlast`, "first\n[a secret]\nlast"],
		// Two parts, the second cut short or empty: still cut.
		["eyJhbGciOiJIUzI1NiJ9.eyJzdWIi", "[a secret]"],
		["eyJhbGciOiJIUzI1NiJ9. ok", "[a secret] ok"],
		// Glued: after a dash as before, and now after a letter, a digit or an underscore.
		[`x-${token}`, "x-[a secret]"],
		[`x9${token}`, "x9[a secret]", "x9eyJhbGciOiJIUzI1NiJ9.[a secret]"],
		[`x_${token}`, "x_[a secret]", "x_eyJhbGciOiJIUzI1NiJ9.[a secret]"],
		["heyJude.mp3", "h[a secret]", "heyJude.mp3"],
		// An eyJ fragment before the token in the same run: the cut starts at the first eyJ.
		[`eyJab-${token}`, "[a secret]"],
		["xeyJ-eyJa.b", "x[a secret]", "xeyJ-[a secret]"],
		// Near-misses: no dot after the first part, or no first part.
		["eyJ", "eyJ"],
		["eyJabc", "eyJabc"],
		["eyJ.abc", "eyJ.abc"],
		["eyJ-eyJ-eyJ", "eyJ-eyJ-eyJ"],
	]) {
		assert.equal(regexRedactWords(words), now, `the oracle: ${JSON.stringify(words)}`);
		assert.equal(regexRedactWords(words, OLD_JWT), before, `before: ${JSON.stringify(words)}`);
		assert.equal(redactWords(words), now, JSON.stringify(words));
	}
});

test("redactWords cuts every login form it cut before, and only those", () => {
	assertCuts([
		["fetch of user:hunter2@db.internal failed", "fetch of [a login] failed"],
		["first.last+tag-x:pw@mail.example.org said no", "[a login] said no"],
		["a URL's own login goes with it: ftp://ana:s3cret@files.example/x", "a URL's own login goes with it: [a URL]"],
		["user:pa:ss@host", "[a login]"],
		["user name:pw@h", "user [a login]"],
		["(u:p@h)", "([a login])"],
		// The password stops at each of its excluded characters; an @ must follow it at once.
		["u:p q@h", "u:p q@h"],
		["u:p\tq@h", "u:p\tq@h"],
		[`u:p${NBSP}q@h`, `u:p${NBSP}q@h`],
		["u:p@q@h", "[a login]@h"],
		["u:p/q@h", "u:p/q@h"],
		["u:p'q@h", "u:p'q@h"],
		['u:p"q@h', 'u:p"q@h'],
		// The host stops at the first character outside [\w.-].
		["u:p@h/x", "[a login]/x"],
		["u:p@h:80", "[a login]:80"],
		["a:b@c+d:e@f", "[a login][a login]"],
		// Near-misses: an empty part, no colon, or a space after the colon.
		[":p@h", ":p@h"],
		["u:@h", "u:@h"],
		["u:p@", "u:p@"],
		["u:p@ h", "u:p@ h"],
		["mail ana@example.org", "mail ana@example.org"],
		["key: value@x", "key: value@x"],
		["time 12:30 @ noon", "time 12:30 @ noon"],
	]);
});

test("redactWords cuts every secret-named parameter it cut before, and only those", () => {
	const keywords = ["token", "password", "passwd", "secret", "key", "jwt", "auth", "code", "signingKey", "credential"];
	const cases = [];
	for (const keyword of keywords) {
		cases.push([`${keyword}=v1x ok`, "[a secret] ok"]);
		cases.push([`${keyword.toUpperCase()}=v1x ok`, "[a secret] ok"]);
		cases.push([`client_${keyword}_2=v1x ok`, "[a secret] ok"]);
		cases.push([`x-${keyword}-y=v1x ok`, "[a secret] ok"]);
		cases.push([`-${keyword}=v1x ok`, "-[a secret] ok"]);
		cases.push([`?a=1&${keyword}=v1x&b=2`, "?a=1&[a secret]&b=2"]);
		cases.push([`${keyword}= v1x`, `${keyword}= v1x`]);
		cases.push([`${keyword} =v1x`, `${keyword} =v1x`]);
		cases.push([`${keyword}:v1x`, `${keyword}:v1x`]);
	}
	cases.push(
		["api_key=sk_live_abc123456 refused", "[a secret] refused"],
		["SigningKey=v ACCESS_TOKEN=w", "[a secret] [a secret]"],
		["monkey=banana", "[a secret]"],
		["x=token=abc", "x=[a secret]"],
		["token=a=b:c/d", "[a secret]"],
		["x.token=v", "x.[a secret]"],
		[`${E_ACUTE}token=v`, `${E_ACUTE}[a secret]`],
		["--access_token=v", "--[a secret]"],
		// The value stops at each of its excluded characters.
		["token=v&x", "[a secret]&x"],
		["token=v;x", "[a secret];x"],
		["token=v,x", "[a secret],x"],
		['token=v"x', '[a secret]"x'],
		["token=v'x", "[a secret]'x"],
		["token=v x", "[a secret] x"],
		["token=v\nx", "[a secret]\nx"],
		// Near-misses: no keyword in the name, no value, or no name.
		["tok=en", "tok=en"],
		["pass=word", "pass=word"],
		["a=b", "a=b"],
		["token=", "token="],
		["=token", "=token"],
		["the keyboard and the password", "the keyboard and the password"],
	);
	assertCuts(cases);
});

/** A seeded generator (mulberry32): the same strings on every run. */
function randomOf(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Few pieces, so a login's or a parameter's parts often line up. */
const FEW = ["a", "b", "-", ":", "@", "/", "=", ".", "+", " ", "token", "Key", "eyJ"];
/** Few pieces, so a URL's or an endpoint's parts often line up. */
const HOSTS = ["a", "Z", "9", "_", "-", ".", ":", "/", " ", "123456", "io", "x.io", ":80", "://", "http"];
/** Every character class the four shapes name, and pieces of the other shapes around them. */
const MANY = [
	"a", "b", "Z", "9", "_", ":", "@", "/", "-", "=", ".", "+", " ", "&", ";", ",", '"', "'", "\t", NBSP, E_ACUTE,
	"token", "TOKEN", "key", "Key", "auth", "pass", "wd", "code", "eyJ", "Bearer ", "://", "x.io", ":80", "1.2.3.4", "sk_",
];

/** Few pieces, so a JWT's parts often line up, glued to a word character or not. */
const JWTS = ["a", "9", "_", "-", ".", " ", "=", '"', "eyJ", "eyJ", "x"];

test("redactWords gives what the regex form gave, on seeded random strings", (t) => {
	const random = randomOf(0x5eed);
	let cases = 0;
	let widened = 0;
	const cut = { "[a URL]": 0, "[a login]": 0, "[a secret]": 0, "[an endpoint]": 0 };
	for (const [pieces, count, longest] of [
		[FEW, 20_000, 24],
		[HOSTS, 10_000, 24],
		[MANY, 10_000, 24],
		[JWTS, 10_000, 24],
		[FEW, 2_000, 80],
		[HOSTS, 2_000, 80],
		[MANY, 2_000, 80],
		[JWTS, 2_000, 80],
	]) {
		for (let i = 0; i < count; i++) {
			const length = Math.floor(random() * (longest + 1));
			let words = "";
			for (let j = 0; j < length; j++) words += pieces[Math.floor(random() * pieces.length)];
			const expected = regexRedactWords(words);
			assert.equal(redactWords(words), expected, JSON.stringify(words));
			// The intended difference from before: only where an eyJ is glued to a word character.
			if (regexRedactWords(words, OLD_JWT) !== expected) {
				assert.match(words, /\weyJ/, `cut differently from before with no glued eyJ: ${JSON.stringify(words)}`);
				widened++;
			}
			cases++;
			for (const mark of Object.keys(cut)) if (expected.includes(mark)) cut[mark]++;
		}
	}
	t.diagnostic(`${cases} strings; strings with each cut: ${JSON.stringify(cut)}; cut wider than before: ${widened}`);
	assert.equal(cases, 58_000);
	assert.ok(widened > 100, `${widened} strings had a glued JWT cut that the old start missed`);
	// The pieces are chosen so each shape is cut in a good share of the strings, not left untried.
	assert.ok(cut["[a URL]"] > 1_000, `${cut["[a URL]"]} strings had a URL cut`);
	assert.ok(cut["[a login]"] > 500, `${cut["[a login]"]} strings had a login cut`);
	assert.ok(cut["[a secret]"] > 1_000, `${cut["[a secret]"]} strings had a secret cut`);
	assert.ok(cut["[an endpoint]"] > 300, `${cut["[an endpoint]"]} strings had an endpoint cut`);
});
