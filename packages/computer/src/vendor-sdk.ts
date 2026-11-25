// A vendor's SDK, loaded when its provider is made. Each is one of this package's optionalDependencies, pinned exactly
// (package.json), so a plain `npm install` brings it and `npm install --omit=optional` leaves it out. The name is an
// argument here, never an import literal, so no type checker resolves an SDK's types from this package: a provider names
// only the slice it calls. test/vendor-sdks.test.mjs finds every call and holds each name to a pinned optional
// dependency.
import { readFileSync } from "node:fs";

/** The code of the error vendorSdk throws when the SDK is not installed: serve's Settings shows its words alone. */
export const SDK_MISSING = "sdk_missing";

/**
 * The SDK package `name` that `vendor`'s provider calls. When it is not installed, an error with code SDK_MISSING whose
 * words name the package and the install step at this package's pin, such as "E2B needs the e2b package: npm install
 * e2b@2.63.0". "Not installed" is read from resolving `name` itself, before it loads: an installed SDK whose own import
 * fails (a file or a dependency of its own missing) throws that failure as it is, naming the module that is missing.
 */
export async function vendorSdk<T>(vendor: string, name: string): Promise<T> {
	try {
		import.meta.resolve(name);
	} catch (error) {
		if ((error as { code?: unknown } | null)?.code !== "ERR_MODULE_NOT_FOUND") throw error;
		const pins = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { optionalDependencies?: Record<string, string> }).optionalDependencies;
		throw Object.assign(new Error(`${vendor} needs the ${name} package: npm install ${name}@${pins?.[name]}`, { cause: error }), { code: SDK_MISSING });
	}
	return (await import(name)) as T;
}
