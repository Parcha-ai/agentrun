// A provider module whose computers take a bind of the run's folder: it exports createProvider() and mountFor(kind),
// which gives the conformance suite a fresh run folder for each mount kind it can make. The fake from ../fake-computer.mjs.
import { fakeComputers, fakeRunFolders } from "../fake-computer.mjs";

const folders = fakeRunFolders();

export function createProvider() {
	return fakeComputers({ id: "mount-module", mount: ["bind"] }).provider;
}

export function mountFor(kind) {
	return folders.mountFor(kind);
}
