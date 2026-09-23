import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { inspectWorkflow, validateWorkflow, type Workflow } from '@parcha/agentrun-dsl';

export interface WorkflowRevision {
  name: string;
  digest: string;
  createdAt: string;
  workflowName: string;
}
export interface StoredWorkflow extends WorkflowRevision { workflow: Workflow }

export class WorkflowStoreError extends Error {
  constructor(readonly code: 'invalid_name' | 'invalid_revision' | 'invalid_workflow' | 'unsafe_path' | 'not_found' | 'invalid_record', message: string) {
    super(message); this.name = 'WorkflowStoreError';
  }
}

const validName = (name: string): void => {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))
    throw new WorkflowStoreError('invalid_name', 'Use a workflow name of 1–64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit.');
};
const validDigest = (digest: string): void => {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
    throw new WorkflowStoreError('invalid_revision', 'A workflow revision must be its complete SHA-256 digest.');
};
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const unsafe = (): WorkflowStoreError => new WorkflowStoreError('unsafe_path', 'Workflow storage requires real directories and regular files, without symbolic links.');

function checkedWorkflow(value: unknown): { workflow: Workflow; digest: string } {
  try {
    // Inspection rejects non-JSON values before cloning. Neither check executes code.
    const inspection = inspectWorkflow(value);
    const workflow = structuredClone(value) as Workflow;
    const validation = validateWorkflow(workflow, { executeCode: false });
    if (!validation.ok) throw new Error('invalid workflow');
    return { workflow, digest: inspection.sha256 };
  } catch {
    throw new WorkflowStoreError('invalid_workflow', 'Workflow failed nonexecuting structure, syntax or schema validation. Inspect it before saving.');
  }
}

/** Local procedure revisions, not execution state or authority. The host still
 * preflights loaded workflows against current capabilities and approves each run.
 * This is not a sandbox against a process concurrently replacing project directories.
 */
export class WorkflowStore {
  private readonly projectDirectory: string;
  constructor(projectDirectory: string) { this.projectDirectory = resolve(projectDirectory); }

  private async directory(name?: string, create = false): Promise<string | undefined> {
    if (name !== undefined) validName(name);
    let directory = await realpath(this.projectDirectory);
    for (const component of ['.pi', 'agentrun', 'workflows', ...(name === undefined ? [] : [name])]) {
      directory = join(directory, component);
      if (create) {
        try { await mkdir(directory, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      let stat;
      try { stat = await lstat(directory); }
      catch (error) { if (missing(error) && !create) return undefined; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw unsafe();
    }
    return directory;
  }

  private async read(name: string, digest: string): Promise<StoredWorkflow> {
    validName(name); validDigest(digest);
    const directory = await this.directory(name);
    if (!directory) throw new WorkflowStoreError('not_found', 'Saved workflow revision not found.');
    const path = join(directory, `${digest}.json`);
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (missing(error)) throw new WorkflowStoreError('not_found', 'Saved workflow revision not found.');
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw unsafe();
      throw error;
    }
    let value: any;
    try {
      if (!(await handle.stat()).isFile() || await realpath(path) !== path) throw unsafe();
      try { value = JSON.parse(await handle.readFile('utf8')); }
      catch { throw new WorkflowStoreError('invalid_record', 'Saved workflow record is not valid JSON.'); }
    } finally { await handle.close(); }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'createdAt,digest,name,version,workflow'
      || value.version !== 1 || value.name !== name || value.digest !== digest
      || typeof value.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt)
      || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt)
      throw new WorkflowStoreError('invalid_record', 'Saved workflow metadata does not match its revision.');
    const checked = checkedWorkflow(value.workflow);
    if (checked.digest !== digest) throw new WorkflowStoreError('invalid_record', 'Saved workflow content does not match its digest.');
    return { name, digest, createdAt: value.createdAt, workflowName: checked.workflow.name, workflow: checked.workflow };
  }

  /** All revisions, newest first; equal timestamps use name/digest for stable order. */
  async list(): Promise<WorkflowRevision[]> {
    const directory = await this.directory();
    if (!directory) return [];
    const revisions: WorkflowRevision[] = [];
    for (const name of await readdir(directory)) {
      validName(name);
      const child = await this.directory(name);
      if (!child) continue;
      for (const file of await readdir(child)) {
        // Unpublished files survive an interrupted write and never become revisions.
        if (/^\.pending-[a-f0-9-]+$/.test(file)) continue;
        if (!/^[a-f0-9]{64}\.json$/.test(file)) throw new WorkflowStoreError('invalid_record', 'Unexpected file in workflow revision storage.');
        const { workflow: _workflow, ...revision } = await this.read(name, file.slice(0, -5));
        revisions.push(revision);
      }
    }
    return revisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name) || a.digest.localeCompare(b.digest));
  }

  async load(name: string, digest?: string): Promise<StoredWorkflow> {
    validName(name);
    if (digest !== undefined) return this.read(name, digest);
    const revision = (await this.list()).find(item => item.name === name);
    if (!revision) throw new WorkflowStoreError('not_found', 'Saved workflow not found.');
    return this.read(name, revision.digest);
  }

  /** Publish a complete immutable revision atomically; identical saves are idempotent. */
  async save(name: string, value: unknown): Promise<StoredWorkflow> {
    validName(name);
    const { workflow, digest } = checkedWorkflow(value);
    const directory = (await this.directory(name, true))!;
    const temporary = join(directory, `.pending-${randomUUID()}`);
    const target = join(directory, `${digest}.json`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 1, name, digest, createdAt: new Date().toISOString(), workflow }, null, 2) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    // Hard-link publication is atomic and, unlike rename, never overwrites a revision.
    if (await this.directory(name) !== directory) throw unsafe();
    try { await link(temporary, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const saved = await this.read(name, digest);
    await unlink(temporary);
    const parent = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
    return saved;
  }
}
