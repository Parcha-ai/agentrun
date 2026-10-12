// Code as the page shows it: a diff (what a write or an edit changed) and a read-only file, drawn by @pierre/diffs, and the workspace's file tree by @pierre/trees. Both libraries are bundled into the
// page (no network: the page goes offline) and imported on first use, so the page starts without them. Grammars are trimmed to what the agent writes (trim-shiki.mjs); any other file shows as plain text.

const THEME = { theme: "pierre-dark", themeType: "dark" } as const;

/** What changed, as a unified diff of `oldText` into `newText`, highlighted for `path`'s language. */
const nl = (s: string): string => (s === "" || s.endsWith("\n") ? s : `${s}\n`); // a missing final newline is not a change worth a note on every hunk

export async function diffElement(path: string, oldText: string, newText: string): Promise<HTMLElement> {
  const { FileDiff } = await import("@pierre/diffs");
  const wrap = document.createElement("div");
  wrap.className = "code diff";
  new FileDiff({ ...THEME, diffStyle: "unified", overflow: "wrap", disableFileHeader: true }).render({ oldFile: { name: path, contents: nl(oldText) }, newFile: { name: path, contents: nl(newText) }, containerWrapper: wrap });
  return wrap;
}

/** A file's text, read-only, highlighted for its language. */
export async function fileElement(path: string, text: string): Promise<HTMLElement> {
  const { File } = await import("@pierre/diffs");
  const wrap = document.createElement("div");
  wrap.className = "code file";
  new File({ ...THEME, overflow: "wrap", disableFileHeader: true }).render({ file: { name: path, contents: nl(text) }, containerWrapper: wrap });
  return wrap;
}

export type TreeHandle = { setPaths(paths: readonly string[]): void; select(path: string | null): void };

/** The session's files as a tree in `mount`; `onOpen` hears a file (never a folder) being picked. Folders are paths with a trailing slash. */
export async function mountTree(mount: HTMLElement, paths: readonly string[], onOpen: (path: string) => void): Promise<TreeHandle> {
  const { FileTree } = await import("@pierre/trees");
  let ready = true;
  const tree = new FileTree({
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    paths: [...paths],
    onSelectionChange: (selected) => {
      const path = selected[0];
      if (ready && path !== undefined && !path.endsWith("/")) onOpen(path);
    },
  });
  tree.render({ containerWrapper: mount });
  return {
    setPaths(next) {
      ready = false;
      tree.resetPaths([...next]);
      ready = true;
    },
    select(path) {
      void path; // the tree keeps its own selection
    },
  };
}
