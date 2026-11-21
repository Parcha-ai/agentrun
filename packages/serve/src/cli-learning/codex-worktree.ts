import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** A bounded, non-following read: project configuration must be a regular file we own. */
export async function readConfigText(path: string): Promise<string | undefined> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024 || (process.getuid && info.uid !== process.getuid())) {
      throw new Error(`Unsafe project configuration: ${path}; nothing was replaced.`);
    }
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > 64 * 1024) throw new Error(`Oversized project configuration: ${path}; nothing was replaced.`);
    return buffer.subarray(0, total).toString('utf8');
  } finally { await handle.close(); }
}

type CodexHookLocation = { checkoutRoot?: string; configRoot: string; linkedWorktree: boolean };

async function directory(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe Git configuration directory: ${path}`);
  return realpath(path);
}

async function pointer(path: string, prefix = ''): Promise<string | undefined> {
  const text = await readConfigText(path);
  if (text === undefined) return;
  const trimmed = text.trim();
  if (!trimmed.startsWith(prefix)) throw new Error(`Invalid Git worktree pointer: ${path}; nothing was replaced.`);
  const value = trimmed.slice(prefix.length).trim();
  if (!value || /[\0\r\n]/.test(value)) throw new Error(`Invalid Git worktree pointer: ${path}; nothing was replaced.`);
  return resolve(dirname(path), value);
}

/** Match Codex's root-checkout hook mapping, including Git's reciprocal worktree ownership checks. */
export async function codexHookLocation(project: string): Promise<CodexHookLocation> {
  let current = project;
  for (let depth = 0; depth < 32; depth++) {
    const git = join(current, '.git');
    let info;
    try { info = await lstat(git); }
    catch (error) { if (!missing(error)) throw error; }
    if (info) {
      if (info.isSymbolicLink()) throw new Error(`Refusing Git configuration symlink: ${git}`);
      if (info.isDirectory()) return { checkoutRoot: current, configRoot: project, linkedWorktree: false };
      const gitDirPath = await pointer(git, 'gitdir:');
      if (!gitDirPath) throw new Error(`Missing Git worktree pointer: ${git}`);
      const gitDir = await directory(gitDirPath);
      const commonPath = await pointer(join(gitDir, 'commondir'));
      if (!commonPath) return { checkoutRoot: current, configRoot: project, linkedWorktree: false };
      const common = await directory(commonPath);
      if (basename(dirname(gitDir)) !== 'worktrees' || dirname(dirname(gitDir)) !== common) {
        throw new Error('Git worktree common directory does not match its registered owner.');
      }
      const registeredGit = await pointer(join(gitDir, 'gitdir'));
      if (!registeredGit || basename(registeredGit) !== '.git' || await directory(dirname(registeredGit)) !== current) {
        throw new Error('Git worktree registration does not match this checkout.');
      }
      const root = await directory(dirname(common));
      const mainGit = join(root, '.git');
      const mainInfo = await lstat(mainGit);
      if (mainInfo.isSymbolicLink()) throw new Error(`Refusing Git configuration symlink: ${mainGit}`);
      const mainGitDir = mainInfo.isDirectory() ? mainGit : await pointer(mainGit, 'gitdir:');
      if (!mainGitDir || await directory(mainGitDir) !== common) throw new Error('Git main checkout does not own the common directory.');
      const configRoot = resolve(root, relative(current, project));
      // Refuse a shared project path redirected through a symlink. Missing corresponding folders can be created later.
      let component = root;
      for (const part of relative(root, configRoot).split(sep).filter(Boolean)) {
        component = join(component, part);
        try {
          const entry = await lstat(component);
          if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Unsafe shared project configuration directory: ${component}`);
        } catch (error) { if (!missing(error)) throw error; }
      }
      return { checkoutRoot: current, configRoot, linkedWorktree: true };
    }
    const parent = dirname(current);
    if (parent === current) return { configRoot: project, linkedWorktree: false };
    current = parent;
  }
  throw new Error('Could not determine the Codex project hook scope within 32 parent directories.');
}
