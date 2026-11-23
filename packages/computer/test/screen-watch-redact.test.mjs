// redactWords on long word runs and on every form its login and secret-named parameter shapes take. A long run of
// word characters must not hold the event loop: the two shapes are hand-written scans that read each character a
// bounded number of times, counted by redactWordsReads. Their matches stay those of the one-regex forms they replace,
// kept below as the oracle. No timing assertions.
import assert from "node:assert/strict";
import test from "node:test";
import * as screenWatch from "../dist/screen-watch.js";

const { redactWords } = screenWatch;
// A no-break space is \s to a regex, so it ends a password or a value; an accented letter is not \w.
const NBSP = String.fromCodePoint(0xa0);
const E_ACUTE = String.fromCodePoint(0xe9);

/** redactWords as it was with a regex for every shape: the oracle the scans must agree with. */
function regexRedactWords(words) {
	return words
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[a URL]")
		.replace(/[\w.+-]+:[^\s@/'"]+@[\w.-]+/g, "[a login]")
		.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[a secret]")
		.replace(/\b[\w-]*(?:token|password|passwd|secret|key|jwt|auth|code|signingKey|credential)[\w-]*=[^\s&"';,]+/gi, "[a secret]")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]*/g, "[a secret]")
		.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[a secret]")
		.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[a secret]")
		.replace(/\b(?:sk|pk|pck|ph|tok|pw|jwt)_[A-Za-z0-9_-]{6,}/g, "[a secret]")
		.replace(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}:\d{1,5}\b/g, "[an endpoint]")
		.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, "[an endpoint]");
}

/** The most reads per character the two scans may take: a quadratic scan of a 40,000-character run takes thousands. */
const READS_PER_CHARACTER = 8;

function assertLinear(words, label) {
	assert.equal(typeof screenWatch.redactWordsReads, "number", "redactWords counts its scans' reads");
	const redacted = redactWords(words);
	assert.ok(
		screenWatch.redactWordsReads <= READS_PER_CHARACTER * words.length + 16,
		`${label}: ${screenWatch.redactWordsReads} reads for ${words.length} characters`,
	);
	return redacted;
}

test("redactWords' login and secret-parameter scans read each character of a long run a bounded number of times", () => {
	// Each of these made the login regex, the parameter regex or both read to the end of the run from every start in it.
	// The URL, JWT and endpoint regexes take no start inside these runs, so each call is quick.
	for (const [unit, n] of [
		["a", 40_000],
		["a:", 40_000],
		["token", 40_000],
		["token_", 40_000],
		["u:p", 40_000],
		["x=", 40_000],
	]) {
		const words = unit.repeat(n);
		assert.equal(assertLinear(words, `${JSON.stringify(unit)} x ${n}`), words, "nothing in it is a secret");
	}
	// "eyJ-" x n also starts the URL, JWT and endpoint regexes at every eyJ, which stay quadratic in such a run, so it
	// is kept short here: the scans' reads are counted all the same.
	const jwtish = "eyJ-".repeat(2_000);
	assert.equal(assertLinear(jwtish, '"eyJ-" x 2000'), jwtish);
	// A run that ends in a match is cut whole, once.
	assert.equal(assertLinear(`${"a".repeat(40_000)}:pw@host`, "a long login"), "[a login]");
	assert.equal(assertLinear(`${"token".repeat(40_000)}=v`, "a long parameter name"), "[a secret]");
});

test("redactWords cuts every login form it cut before, and only those", () => {
	for (const [words, redacted] of [
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
	]) {
		assert.equal(regexRedactWords(words), redacted, `the oracle: ${JSON.stringify(words)}`);
		assert.equal(redactWords(words), redacted, JSON.stringify(words));
	}
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
	for (const [words, redacted] of cases) {
		assert.equal(regexRedactWords(words), redacted, `the oracle: ${JSON.stringify(words)}`);
		assert.equal(redactWords(words), redacted, JSON.stringify(words));
	}
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
/** Every character class either shape names, and pieces of the other shapes around them. */
const MANY = [
	"a", "b", "Z", "9", "_", ":", "@", "/", "-", "=", ".", "+", " ", "&", ";", ",", '"', "'", "\t", NBSP, E_ACUTE,
	"token", "TOKEN", "key", "Key", "auth", "pass", "wd", "code", "eyJ", "Bearer ", "://", "x.io", ":80", "1.2.3.4", "sk_",
];

test("redactWords gives what the regex form gave, on seeded random strings", (t) => {
	const random = randomOf(0x5eed);
	let cases = 0;
	let logins = 0;
	let secrets = 0;
	for (const [pieces, count, longest] of [
		[FEW, 20_000, 24],
		[MANY, 10_000, 24],
		[FEW, 2_000, 80],
		[MANY, 2_000, 80],
	]) {
		for (let i = 0; i < count; i++) {
			const length = Math.floor(random() * (longest + 1));
			let words = "";
			for (let j = 0; j < length; j++) words += pieces[Math.floor(random() * pieces.length)];
			const expected = regexRedactWords(words);
			assert.equal(redactWords(words), expected, JSON.stringify(words));
			cases++;
			if (expected.includes("[a login]")) logins++;
			if (expected.includes("[a secret]")) secrets++;
		}
	}
	t.diagnostic(`${cases} strings, ${logins} with a login cut, ${secrets} with a secret cut`);
	assert.equal(cases, 34_000);
	// The pieces are chosen so both shapes are cut in a good share of the strings, not left untried.
	assert.ok(logins > 500, `${logins} strings had a login cut`);
	assert.ok(secrets > 1_000, `${secrets} strings had a secret cut`);
});
