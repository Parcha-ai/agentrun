// A provider module that names its run's default image and a note for the run's report, as the Daytona module does.
import { fakeComputers } from "../fake-computer.mjs";

export function createProvider() {
	return fakeComputers({ id: "noted-module" }).provider;
}

/** How many times the CLI asked for the image: a module's may make or register it, so a run with --image never asks. */
export const asked = { image: 0 };

export function conformanceImage() {
	asked.image += 1;
	return "module-image";
}

export const conformanceNotes = ["a stop deletes on this configuration: the provider declares stopDeletes"];
