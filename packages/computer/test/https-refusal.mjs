// The words httpsBase (src/hosted/rest.ts) refuses a URL that is not https with. The provider tests check all of them,
// the provider's own label included, so a provider that names another's setting tells the operator the wrong one and fails.
import assert from "node:assert/strict";

/** A check for assert.throws or assert.rejects: the refusal of `url` is httpsBase's, word for word, for the setting
 *  `label` names, and holds no `key`. */
export const refusesHttp = (label, url, key) => (error) => {
	assert.equal(error.message, `${label} must be https, so the key never crosses in the clear: ${new URL(url).protocol}`, url);
	assert.ok(!error.message.includes(key), `the key is not in the words: ${url}`);
	return true;
};
