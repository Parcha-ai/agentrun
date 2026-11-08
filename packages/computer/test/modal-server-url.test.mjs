// The Modal SDK's ModalClient has no server option: it takes the server from MODAL_SERVER_URL while it is constructed
// (getProfile, modal-client client.ts:123, and the control-plane client made then, client.ts:175). modalClient sets that
// variable to the chosen server only around the construction and puts it back after. So a non-default server reaches the
// client only while the SDK reads the variable in its constructor. An SDK that read it later (when a call is made, or
// from a lazy profile) would find it gone, drop the server without a word, and send the key to its default,
// https://api.modal.com:443. These tests read the server the client holds after modalClient returns, when the variable
// is already restored: such an SDK fails them.
//
// The modal package is the host's, not this package's: with it installed, the first test runs on the real ModalClient;
// without it, that test skips in words and the second runs on a stand-in that reads the profile as the SDK does today.
import assert from "node:assert/strict";
import test from "node:test";
import { modalClient } from "../dist/modal.js";

const DEFAULT_SERVER = "https://api.modal.com:443";
const SERVER = "https://modal-server.example.invalid:443";
const TOKEN = { tokenId: "ak-server-url-test", tokenSecret: "as-server-url-test" };

/** The server the client modalClient builds with ModalClient holds, read after modalClient returned. */
async function serverOf(ModalClient) {
	assert.equal(process.env.MODAL_SERVER_URL, undefined, "no ambient MODAL_SERVER_URL: modalClient would refuse it");
	const client = await modalClient({ ...TOKEN, serverUrl: SERVER, ModalClient });
	assert.equal(process.env.MODAL_SERVER_URL, undefined, "modalClient put MODAL_SERVER_URL back");
	return client.profile?.serverUrl;
}

/** A stand-in for the SDK's ModalClient as it is today: the profile, its server included, read in the constructor. */
class ModalClientStandIn {
	constructor(params) {
		this.profile = { serverUrl: process.env.MODAL_SERVER_URL || DEFAULT_SERVER, tokenId: params.tokenId, tokenSecret: params.tokenSecret };
	}
}

test("the real Modal SDK takes a non-default server from MODAL_SERVER_URL as ModalClient is constructed, and keeps it after", async (t) => {
	const sdk = await import("modal").catch(() => undefined);
	if (sdk === undefined) return t.skip("the modal package is not installed here; it is the host's, so the stand-in test below runs instead");
	assert.equal(await serverOf(sdk.ModalClient), SERVER, "the SDK no longer reads MODAL_SERVER_URL in ModalClient's constructor: modalClient's server would be dropped and the key sent to its default");
});

test("a non-default server reaches the client modalClient builds, and the client still holds it after the variable is put back", async () => {
	assert.equal(await serverOf(ModalClientStandIn), SERVER, "the client does not hold the chosen server once modalClient returned: an SDK that reads MODAL_SERVER_URL after construction drops it");
});
