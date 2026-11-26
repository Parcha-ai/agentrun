// An SSH key a provider makes for itself: ed25519, its private half as PKCS#8 PEM (what node:crypto writes, and what
// pemOf in ./ssh-exec.ts turns into the OpenSSH form ssh2 reads), its public half as one OpenSSH line, and that line's
// fingerprint as OpenSSH and the vendors print it.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

/** An SSH string (RFC 4251 §5): its uint32 length, then its bytes. */
export const sshString = (bytes: Uint8Array | string): Buffer => {
	const body = Buffer.from(bytes);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(body.length);
	return Buffer.concat([length, body]);
};

/** A new ed25519 private key, as PKCS#8 PEM. */
export function newEd25519(): string {
	return generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

/** The public half of an ed25519 key, as SSH reads it. */
export interface SshPublicKey {
	/** One OpenSSH line, "ssh-ed25519 <blob in base64>", with no comment. */
	readonly line: string;
	/** "SHA256:" and the blob's SHA-256 in base64 with no padding (ssh-keygen -l). */
	readonly fingerprint: string;
	/** The blob's SHA-256 in hex: a name made from it says which key without being one. */
	readonly hash: string;
}

/**
 * The public half of `pem`, a PKCS#8 ed25519 private key, or undefined when it is not one. The blob is RFC 8709 §4's:
 * the string "ssh-ed25519", then the 32-byte public key, each length-prefixed.
 */
export function ed25519PublicOf(pem: string): SshPublicKey | undefined {
	let x: string | undefined;
	try {
		const key = createPrivateKey(pem);
		if (key.asymmetricKeyType !== "ed25519") return undefined;
		x = createPublicKey(key).export({ format: "jwk" }).x;
	} catch {
		return undefined;
	}
	if (typeof x !== "string") return undefined;
	const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.from(x, "base64url"))]);
	const digest = createHash("sha256").update(blob).digest();
	return { line: `ssh-ed25519 ${blob.toString("base64")}`, fingerprint: `SHA256:${digest.toString("base64").replace(/=+$/, "")}`, hash: digest.toString("hex") };
}
