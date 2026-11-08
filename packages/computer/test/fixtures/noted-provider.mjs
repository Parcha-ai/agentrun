// A provider module that names its run's default image and a note for the run's report, as the Daytona module does.
import { fakeComputers } from "../fake-computer.mjs";

export function createProvider() {
	return fakeComputers({ id: "noted-module" }).provider;
}

export function conformanceImage() {
	return "module-image";
}

export const conformanceNotes = ["a stop deletes on this configuration: the provider declares stopDeletes"];
