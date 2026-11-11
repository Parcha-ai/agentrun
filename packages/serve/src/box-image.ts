// The image a run's Docker computer starts from, when the owner names one: AGENTRUN_DOCKER_IMAGE. Unset, the Docker
// provider builds its own from the computer package's recipe (DOCKER_RECIPE) on first use, and a run waiting on that
// build shows it on its timeline (workspace/computer-deps.ts imageWaitWords). Nothing is built or pulled at the start.

/** The setting that names another image for Docker computers than the computer package's own. */
export const DOCKER_IMAGE_ENV = "AGENTRUN_DOCKER_IMAGE";
