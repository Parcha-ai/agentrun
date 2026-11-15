// The box image as the release publishes it (release.yml's box job): box/Dockerfile built for amd64 and pushed, public,
// as ghcr.io/parcha-ai/agentrun-box:<recipe hash>. The hash is box/recipe.mjs's, read from the box/ folder this package
// ships, so a server names the image its own release published. A provider whose computers start from it (Agent37
// registers it in the owner's workspace) asks for it by this name.
import { recipeHash } from "../box/recipe.mjs";

/** Where the release publishes the box image. */
export const BOX_IMAGE_REPOSITORY = "ghcr.io/parcha-ai/agentrun-box";

let hash: string | undefined;

/** The box recipe's hash, 12 hex, read once from this package's box/ folder. */
export function boxRecipeHash(): string {
	hash ??= recipeHash();
	return hash;
}

/** The published box image this package's recipe names: ghcr.io/parcha-ai/agentrun-box:<recipe hash>. */
export const boxImageRef = (): string => `${BOX_IMAGE_REPOSITORY}:${boxRecipeHash()}`;
