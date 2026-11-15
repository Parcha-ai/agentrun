// The box image as the release publishes it (release.yml's box job): box/Dockerfile built for amd64 and pushed, public,
// as ghcr.io/parcha-ai/agentrun-box:<recipe hash>. The hash is box/recipe.mjs's, read from the box/ folder this package
// ships, so a server names the image its own release published. A provider whose computers start from it (Agent37
// registers it in the owner's workspace, Modal pulls it) asks for it by this name; E2B starts from the public template
// the release builds from it (boxE2bTemplate).
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

/**
 * The E2B team that publishes the box template: release.yml's box-e2b job builds the box image as the E2B template
 * agentrun-archil-<recipe hash> (box/build-e2b.mjs --image --public) in this team, and makes it public, so any E2B
 * account starts it as <team slug>/<template>. The slug is E2B's name for the publishing team, not a person's.
 */
export const BOX_E2B_PUBLISHER = "miguels-project-7446";

/** The public E2B template of the box image this package's recipe names: <publisher>/agentrun-archil-<recipe hash>. */
export const boxE2bTemplate = (): string => `${BOX_E2B_PUBLISHER}/agentrun-archil-${boxRecipeHash()}`;
