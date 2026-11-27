// Where web_save saves: its name and the path a call's `path` is saved at, in a leaf module that imports nothing, so the
// tool gate holds a save's path (tool-gate.ts filedRefusal) without loading web_save's tool and the Workspace with it.

export const WEB_SAVE_TOOL = "web_save";
/** The folder a bare name is saved in. */
export const MEDIA_DIR = "media";
/** Where `path` is saved: as given, or under media/ when it names no folder. */
export const savePath = (path: string): string => (path.includes("/") ? path : `${MEDIA_DIR}/${path}`);
