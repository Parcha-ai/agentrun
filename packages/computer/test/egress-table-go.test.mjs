// The hosted egress proxy's address rule (daemon/internal/egress/table.go) against the Docker proxy's
// (src/docker/egress-table.ts): the same ranges, in the same order, each refused as the same class. The Go table is
// read as text, so this holds without a Go toolchain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkAddress, EGRESS_RANGES } from "../dist/docker/egress-table.js";

const GO = readFileSync(new URL("../daemon/internal/egress/table.go", import.meta.url), "utf8");
/** The Go table's rows, as written: {"cidr", "class"}. */
const rows = [...GO.slice(GO.indexOf("var table = []rule{"), GO.indexOf("\n}\n", GO.indexOf("var table = []rule{"))).matchAll(/\{"([^"]+)", "([^"]+)"\}/g)].map(([, cidr, cls]) => ({ cidr, cls }));

test("table.go holds egress-table's ranges, in its order", () => {
	assert.ok(rows.length > 20, `read ${rows.length} rows from table.go`);
	assert.deepEqual(
		rows.map(({ cidr }) => cidr),
		[...EGRESS_RANGES],
	);
});

test("each range of table.go is refused by egress-table as the class table.go gives it (an embedded IPv4 range is judged by the address inside, in both)", () => {
	for (const { cidr, cls } of rows) {
		if (cls === "last32" || cls === "6to4") continue;
		const verdict = checkAddress(cidr.split("/")[0], []);
		assert.equal(verdict.ok, false, cidr);
		assert.equal(verdict.class, cls, cidr);
	}
});
