// The box image as the release publishes it (release.yml's box job): box/Dockerfile built for amd64 and pushed, public,
// as ghcr.io/parcha-ai/agentrun-box:<recipe hash>. The hash is box/recipe.mjs's: the first 12 hex of the sha256 of the
// Dockerfile and the helper it copies, read here from the box/ folder this package ships, so a server names the image
// its own release published. A provider whose computers start from it (Agent37 registers it in the owner's workspace)
// asks for it by this name.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Where the release publishes the box image. */
export const BOX_IMAGE_REPOSITORY = "ghcr.io/parcha-ai/agentrun-box";
/** The files the image is made of, in box/recipe.mjs's order. */
const RECIPE = ["Dockerfile", "agentrun-archil"];

let hash: string | undefined;

/** The box recipe's hash, 12 hex, read once from this package's box/ folder. */
export function boxRecipeHash(): string {
	hash ??= createHash("sha256")
		.update(Buffer.concat(RECIPE.map((name) => readFileSync(new URL(`../box/${name}`, import.meta.url)))))
		.digest("hex")
		.slice(0, 12);
	return hash;
}

/** The published box image this package's recipe names: ghcr.io/parcha-ai/agentrun-box:<recipe hash>. */
export const boxImageRef = (): string => `${BOX_IMAGE_REPOSITORY}:${boxRecipeHash()}`;
