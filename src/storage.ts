import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type { Project, Agent, ProjectData, SharedContent, Plan, ProjectLayout } from './types.js';

export interface GroupChatEntry {
  id: string;
  ts: string;
  role: 'supervisor' | 'user' | 'agent';
  sender: string;
  text: string;
  classification?: 'progress' | 'blocker' | 'question' | 'risky_action' | 'noise';
}


const BASE_DIR = path.join(os.homedir(), '.conduit');
const PROJECTS_DIR = path.join(BASE_DIR, 'projects');

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Only accept UUID-shaped project ids in filesystem paths. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function projectDir(projectId: string) {
  if (!SAFE_ID.test(projectId)) throw new Error('Invalid project id');
  return path.join(PROJECTS_DIR, projectId);
}

function projectFile(projectId: string) {
  return path.join(projectDir(projectId), 'project.json');
}

const SHARED_CONTENT_DIR = path.join(BASE_DIR, 'shared_content');
const WIKI_DIR = path.join(BASE_DIR, 'wiki');

/**
 * Project names double as directory names under shared_content/ and wiki/.
 * Strip anything that could escape or break a path: separators, `..`, control
 * chars, and leading dots. Falls back to "project" when nothing is left.
 */
export function safeProjectName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\.\.+/g, '.')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'project';
}

/**
 * Resolve `rel` inside `base` and reject anything that escapes it (path
 * traversal). Returns null when the path is not safely inside `base`.
 */
export function resolveInside(base: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512) return null;
  if (rel.includes('\0')) return null;
  const normalized = rel.replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) return null;
  // No single name may exceed the filesystem's limit, and on Windows the whole
  // path is limited too unless long paths are enabled. Rejecting here turns
  // "400 Invalid filename" into the answer, instead of an ENOENT thrown from
  // deep inside a write and surfaced to the user as a 500.
  if (normalized.split('/').some((seg) => seg.length > 255)) return null;

  const full = path.resolve(base, normalized);
  const root = path.resolve(base);
  if (full === root) return null;
  const relBack = path.relative(root, full);
  if (relBack.startsWith('..') || path.isAbsolute(relBack)) return null;
  if (process.platform === 'win32' && full.length > 250) return null;
  return full;
}

function sharedDir(projectName: string) {
  return path.join(SHARED_CONTENT_DIR, safeProjectName(projectName));
}

function wikiDir(projectName: string) {
  return path.join(WIKI_DIR, safeProjectName(projectName));
}

/** Public helpers so other modules never build these paths by hand. */
export function sharedDirFor(projectName: string): string { return sharedDir(projectName); }
export function wikiDirFor(projectName: string): string { return wikiDir(projectName); }

// Initialize storage
ensureDir(PROJECTS_DIR);

/** Marker recording that first-run seeding already happened. */
const SEED_MARKER = path.join(BASE_DIR, '.seeded');

/**
 * Create the demo project once, on genuine first run.
 *
 * Deliberately explicit and idempotent: it is called only from web-server
 * startup, never from a read path. An earlier version ran inside
 * `listProjects()`, which meant deleting your last project silently recreated
 * it, creating your first project left a demo behind, and the web server and
 * daemon could each seed a copy. The marker file makes a deleted demo stay
 * deleted.
 *
 * Returns the created project, or null when seeding was not needed.
 */
/**
 * Remove project directories with no `project.json`.
 *
 * A project directory without one is unreachable: every read path goes through
 * `getProjectData`, which returns null, so nothing lists it, opens it or ever
 * shows its contents. They accumulated because a Supervisor classification
 * landing after a delete recreated the folder to append one group-chat line —
 * fixed at the source, but existing installs are carrying the debris, and
 * nothing else will ever clear it.
 *
 * Called once from web-server startup. Returns how many were removed.
 */
export function sweepUnreachableProjects(): number {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(PROJECTS_DIR)) {
      const dir = path.join(PROJECTS_DIR, name);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        if (fs.existsSync(path.join(dir, 'project.json'))) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch { /* in use, or vanished under us — leave it */ }
    }
  } catch { /* no projects directory yet */ }
  return removed;
}

export function seedDefaultDemoProjectOnce(): Project | null {
  try {
    if (fs.existsSync(SEED_MARKER)) return null;
    if (listProjects().length > 0) {
      // Existing install predating the marker — record it and leave well alone.
      ensureDir(BASE_DIR);
      fs.writeFileSync(SEED_MARKER, new Date().toISOString(), 'utf-8');
      return null;
    }
    const project = seedDefaultDemoProject();
    ensureDir(BASE_DIR);
    fs.writeFileSync(SEED_MARKER, new Date().toISOString(), 'utf-8');
    return project;
  } catch (err) {
    console.warn('[storage] demo seeding skipped:', err instanceof Error ? err.message : err);
    return null;
  }
}

export function seedDefaultDemoProject(): Project {
  const demoCwd = path.join(os.homedir(), '.conduit', 'demo-workspace');
  ensureDir(demoCwd);

  const project = createProject(
    'Conduit Studio (Demo)',
    demoCwd,
    'Multi-agent demonstration studio orchestrating Claude Code, Codex, and Gemini CLI side-by-side with safety gates.'
  );

  // Seed 3 specialized agents
  createAgent(project.id, 'Claude Architect', 'claude', demoCwd, 'System Architecture & Core Services');
  createAgent(project.id, 'Codex Builder', 'codex', demoCwd, 'Feature Implementation & API Endpoints');
  createAgent(project.id, 'Gemini Reviewer', 'gemini', demoCwd, 'Code Review & Automated Test Suites');

  // Seed sample wiki overview
  const welcomeWiki = `# Conduit Multi-Agent Studio Demo

Welcome to your local Conduit control center.

## Running Agents
- **Claude Architect**: Handles top-level system architecture and database migrations.
- **Codex Builder**: Implements application features and routes.
- **Gemini Reviewer**: Runs unit tests and validates pull request safety.

## Human-in-the-Loop Protection
Every risky operation (e.g. \`rm -rf\`, SQL drops, force pushes) is intercepted by the Supervisor and requires human approval before execution.
`;
  // Only write the welcome page if the wiki index is still the generated stub —
  // never clobber a page the user has edited.
  const existingIndex = getWikiFile(project.id, '_index.md');
  if (!existingIndex || existingIndex.content.trim().startsWith('# Project Wiki Index')) {
    updateWikiFile(project.id, '_index.md', welcomeWiki);
  }

  return project;
}

// --- Projects ---

export function listProjects(): Project[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const dirs = fs.readdirSync(PROJECTS_DIR);
  const projects: Project[] = [];
  for (const dir of dirs) {
    const file = path.join(PROJECTS_DIR, dir, 'project.json');
    if (!fs.existsSync(file)) continue;
    try {
      const data: ProjectData = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (data?.project?.id) projects.push(data.project);
    } catch (err) {
      // A single corrupt project.json must not take the whole API down.
      console.error(`[storage] skipping unreadable ${file}:`, err instanceof Error ? err.message : err);
    }
  }

  // NOTE: this is a pure read. First-run demo seeding lives in
  // `seedDefaultDemoProjectOnce()`, called once from web-server startup.
  return projects.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export function getProjectData(projectId: string): ProjectData | null {
  if (!SAFE_ID.test(projectId)) return null;
  const file = projectFile(projectId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`[storage] unreadable ${file}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Write a file by writing a temporary one and renaming it over the target.
 *
 * The temporary name must be unique per writer. project.json is written by
 * **both** processes — the web server on every CRUD, and the daemon on every
 * approval gate (`pendingGate`) and Codex thread id — so a shared
 * `project.json.tmp` meant one process could rename the other's half-written
 * file into place. That corrupts precisely when the conduit is busy, which is
 * the moment it matters most.
 *
 * This makes each writer's rename atomic and its own. It does not make
 * read-modify-write safe: two processes updating different fields at the same
 * instant can still lose one update. That needs a lock, and is worth doing if
 * it is ever observed.
 */
let tmpCounter = 0;

/**
 * Sleep without spinning, from synchronous code.
 *
 * The storage API is synchronous, so a retry cannot await. Busy-waiting is the
 * obvious alternative and the wrong one here: it burns a core and starves the
 * other process — which, when the contention *is* that other process, makes
 * the thing being waited for take longer. Atomics.wait blocks the thread
 * properly.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Windows refuses to rename over a file another process has open, with EPERM.
 * Both processes read and write project.json, so this happens in ordinary use
 * — reproducible in one line: hold the target open, rename onto it.
 *
 * Measured under four processes writing while a reader held the file: with no
 * retry, 190 of 480 writes were lost. Each loss is an approval gate that was
 * never recorded or an agent status left stale, so the ladder is deliberately
 * patient — roughly a second in total, which is imperceptible for a write that
 * normally takes under a millisecond, and only ever paid under contention.
 *
 * A cross-process lock file was tried here and measured *worse* — 12 losses
 * became 51 — because it serialises writers while the EPERM comes from the
 * reader, so it added contention without removing the cause. Retrying the
 * rename is the thing that works.
 */
function renameWithRetry(tmp: string, file: string): void {
  const delays = [0, 2, 5, 10, 20, 40, 80, 150, 250, 400];
  for (let i = 0; i < delays.length; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const contended = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!contended || i === delays.length - 1) throw err;
      sleepSync(delays[i + 1]);
    }
  }
}

function writeFileAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${tmpCounter++}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, 'utf-8');
    renameWithRetry(tmp, file);
  } catch (err) {
    // Never leave the temporary behind — they accumulate in the project
    // directory and are indistinguishable from real state.
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
    // Deliberately rethrown. A silently dropped write is a lost approval gate
    // or a stale agent status, and the caller can at least log it.
    throw err;
  }
}

/**
 * Read, change and save one project's file without another process losing the
 * change.
 *
 * project.json is written whole, and two processes do read-modify-write on it:
 * the web server creates and renames agents, and the daemon writes pendingGate
 * as the watcher sees prompts. Each write is atomic, so the file is never torn
 * — but atomic is not the same as safe. If the daemon read the file a moment
 * before an agent was created and saved its copy a moment after, the new agent
 * was simply gone. That is the "agent vanished after being created" failure:
 * intermittent, invisible, and impossible to reproduce on demand.
 *
 * A lock file makes the read and the write one step. `wx` fails if the file
 * exists, which is the atomic test-and-set; whoever creates it owns the
 * project until they remove it.
 *
 * A lock is only ever held across a read and a write of one small JSON file,
 * so waits are in milliseconds. A lock older than the timeout is assumed to
 * belong to a process that died holding it and is broken — losing an update is
 * bad, wedging the app forever is worse.
 */
const LOCK_TIMEOUT_MS = 4000;
const LOCK_STALE_MS = 10_000;

function lockPath(projectId: string): string {
  return path.join(projectDir(projectId), '.lock');
}

function acquireLock(projectId: string): number | null {
  const file = lockPath(projectId);
  const until = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      // Deliberately no ensureDir. Creating the directory here would bring a
      // deleted project back from the dead on the next stray write — which is
      // the exact failure `check:lifecycle` exists to catch, and which this
      // lock reintroduced the first time round.
      return fs.openSync(file, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // No project directory means no project. Let the caller's own read find
      // nothing and write nothing.
      if (code === 'ENOENT') return null;
      if (code !== 'EEXIST') return null;
      try {
        // Left behind by something that died mid-write.
        if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(file);
          continue;
        }
      } catch { /* it went away on its own — try again */ }
      if (Date.now() > until) return null;
      // Busy-wait deliberately: this is sub-millisecond work behind the lock,
      // and Atomics.wait is the only way to sleep synchronously here.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

function releaseLock(projectId: string, fd: number): void {
  try { fs.closeSync(fd); } catch { /* already closed */ }
  try { fs.unlinkSync(lockPath(projectId)); } catch { /* already gone */ }
}

/**
 * Apply a change to a project's data under its lock.
 *
 * The callback is handed freshly read data — never a copy from before the
 * wait — and whatever it returns is saved. Returning null saves nothing.
 */
function mutateProjectData<T>(
  projectId: string,
  fn: (data: ProjectData) => T | null,
): T | null {
  const fd = acquireLock(projectId);
  try {
    const data = getProjectData(projectId);
    if (!data) return null;
    const result = fn(data);
    if (result === null) return null;
    saveProjectData(data);
    return result;
  } finally {
    if (fd !== null) releaseLock(projectId, fd);
  }
}

function saveProjectData(data: ProjectData) {
  ensureDir(projectDir(data.project.id));
  writeFileAtomic(projectFile(data.project.id), JSON.stringify(data, null, 2));
}

/** Thrown when a name would collide with an existing project. */
export class DuplicateProjectError extends Error {
  constructor(name: string) {
    super(`A project named "${name}" already exists.`);
    this.name = 'DuplicateProjectError';
  }
}

/** True when another project already uses this (sanitized) name. */
function nameTaken(name: string, exceptId?: string): boolean {
  const norm = safeProjectName(name).toLowerCase();
  return listProjects().some((p) => p.id !== exceptId && p.name.toLowerCase() === norm);
}

export function createProject(name: string, cwd: string, description?: string): Project {
  const safeName = safeProjectName(name);
  // Enforced here, not just in the routes: shared_content/ and wiki/ are keyed
  // by name, so two projects sharing one would share (and delete) each other's
  // data.
  if (nameTaken(safeName)) throw new DuplicateProjectError(safeName);

  const project: Project = {
    id: uuid(),
    name: safeName,
    description,
    cwd,
    createdAt: new Date().toISOString(),
  };
  saveProjectData({ project, agents: [], pendingPlans: [] });
  // Auto-init shared content + wiki
  ensureDir(sharedDir(project.name));
  initializeWiki(project.id);
  return project;
}

/**
 * Move a project's data directory when the project is renamed.
 *
 * `fs.renameSync` alone was not enough, and the way it failed was the worst
 * kind: silently, in a warning, leaving the files under the old name while the
 * project pointed at a new empty directory. Every shared file simply vanished
 * from the UI.
 *
 * On Windows a directory cannot be renamed while anything holds a handle
 * inside it, and something always does — the activity watcher is watching that
 * exact directory, and it descends into subdirectories. So the bug only
 * appeared once an agent had created a folder:
 *
 *   EPERM: operation not permitted, rename
 *     '...\shared_content\myproject' -> '...\shared_content\myproject-v2'
 *
 * A flat directory renamed fine, which is why it survived so long.
 *
 * Copying and then deleting works where renaming does not, because the handle
 * only blocks the directory entry, not reading through it. Copy first, verify,
 * and only then remove: a rename that half-fails must never be the reason data
 * is gone.
 */
function moveProjectDir(from: string, to: string): void {
  if (!fs.existsSync(from) || from === to) return;
  try {
    if (!fs.existsSync(to)) {
      try {
        fs.renameSync(from, to);
        return;
      } catch { /* fall through to copy — see above */ }
    }
    // Merge into whatever is already there. `to` can exist because a watcher
    // recreated it, and skipping in that case is how the files got stranded.
    fs.cpSync(from, to, { recursive: true, force: true, errorOnExist: false });
    if (fs.existsSync(to)) fs.rmSync(from, { recursive: true, force: true });
  } catch (err) {
    // Leave the source alone. Data under the old name is recoverable; data
    // deleted after a failed copy is not.
    console.error('[storage] could not move project data on rename — the files '
      + `are still under the old name at ${from}:`, err);
  }
}

export function updateProject(projectId: string, updates: Partial<Pick<Project, 'name' | 'description' | 'cwd'>>): Project | null {
  const data = getProjectData(projectId);
  if (!data) return null;
  const next: Partial<Pick<Project, 'name' | 'description' | 'cwd'>> = {};
  if (typeof updates.name === 'string' && updates.name.trim()) next.name = safeProjectName(updates.name);
  if (typeof updates.description === 'string') next.description = updates.description;
  if (typeof updates.cwd === 'string' && updates.cwd.trim()) next.cwd = updates.cwd;

  // Shared content + wiki directories are keyed by name — move them along
  // with a rename so the project doesn't lose its data.
  if (next.name && next.name !== data.project.name) {
    // Refuse a rename onto an existing name: the move below would be skipped
    // and both projects would then share one shared_content/ and wiki/ dir,
    // so deleting either with removeData would destroy the other's files.
    if (nameTaken(next.name, projectId)) throw new DuplicateProjectError(next.name);

    for (const [from, to] of [
      [sharedDir(data.project.name), sharedDir(next.name)],
      [wikiDir(data.project.name), wikiDir(next.name)],
    ]) {
      moveProjectDir(from, to);
    }
  }
  Object.assign(data.project, next);
  saveProjectData(data);
  return data.project;
}

export function deleteProject(projectId: string, removeData?: boolean): boolean {
  const data = getProjectData(projectId);
  if (!data) return false;

  // Remove shared content and wiki if requested
  if (removeData) {
    const shared = sharedDir(data.project.name);
    if (fs.existsSync(shared)) fs.rmSync(shared, { recursive: true });
    const wiki = wikiDir(data.project.name);
    if (fs.existsSync(wiki)) fs.rmSync(wiki, { recursive: true });
  }

  const dir = projectDir(projectId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  return true;
}

// --- Agents ---

export function listAgents(projectId: string): Agent[] {
  const data = getProjectData(projectId);
  return data?.agents ?? [];
}

export function getAgent(projectId: string, agentId: string): Agent | null {
  const data = getProjectData(projectId);
  return data?.agents.find(a => a.id === agentId) ?? null;
}

export function createAgent(projectId: string, name: string, cli: Agent['cli'], cwd: string, role?: string, flags?: Agent['flags']): Agent | null {
  // Under the lock: the daemon writes this same file whenever the watcher sees
  // a prompt, and an unlocked create could be read over and lost.
  return mutateProjectData(projectId, (data) => {
    const agent: Agent = {
      id: uuid(),
      projectId,
      name,
      role,
      cli,
      cwd,
      status: 'stopped',
      flags,
    };
    data.agents.push(agent);
    return agent;
  });
}

export type AgentUpdate = Partial<Pick<Agent, 'name' | 'role' | 'cli' | 'cwd' | 'status' | 'pid' | 'flags' | 'codexThreadId' | 'pendingGate'>>;

export function updateAgent(projectId: string, agentId: string, updates: AgentUpdate): Agent | null {
  return mutateProjectData(projectId, (data) => {
  const agent = data.agents.find(a => a.id === agentId);
  if (!agent) return null;
  // Only known fields — never let a request body add arbitrary keys.
  const allowed: (keyof AgentUpdate)[] = ['name', 'role', 'cli', 'cwd', 'status', 'pid', 'flags', 'codexThreadId', 'pendingGate'];
  const target = agent as unknown as Record<string, unknown>;
  for (const k of allowed) {
    if (k in updates) {
      const v = updates[k];
      if (v === undefined) delete target[k];
      else target[k] = v;
    }
  }
  return agent;
  });
}

export function deleteAgent(projectId: string, agentId: string): boolean {
  return mutateProjectData(projectId, (data) => {
    const idx = data.agents.findIndex(a => a.id === agentId);
    if (idx === -1) return null;
    data.agents.splice(idx, 1);
    return true;
  }) === true;
}

// --- Plans & Layouts ---

export function getProjectLayout(projectId: string): ProjectLayout | null {
  const data = getProjectData(projectId);
  return data?.layout || null;
}

export function saveProjectLayout(projectId: string, layout: ProjectLayout): boolean {
  const data = getProjectData(projectId);
  if (!data) return false;
  data.layout = layout;
  saveProjectData(data);
  return true;
}

export function getPlans(projectId: string): Plan[] {
  const data = getProjectData(projectId);
  return data?.pendingPlans || [];
}

export function createPlan(plan: Omit<Plan, 'id' | 'createdAt'>): Plan | null {
  const data = getProjectData(plan.projectId);
  if (!data) return null;
  const newPlan: Plan = {
    ...plan,
    id: uuid(),
    createdAt: new Date().toISOString(),
  };
  if (!data.pendingPlans) data.pendingPlans = [];
  data.pendingPlans.push(newPlan);
  saveProjectData(data);
  return newPlan;
}

export function resolvePlan(projectId: string, planId: string): Plan | null {
  const data = getProjectData(projectId);
  if (!data || !data.pendingPlans) return null;
  const idx = data.pendingPlans.findIndex(p => p.id === planId);
  if (idx === -1) return null;
  const [resolved] = data.pendingPlans.splice(idx, 1);
  saveProjectData(data);
  return resolved;
}

// --- Shared Content (stored in ~/.conduit/shared_content/[project_name]/) ---

export function listContent(projectId: string): SharedContent[] {
  const data = getProjectData(projectId);
  if (!data) return [];
  const dir = sharedDir(data.project.name);
  if (!fs.existsSync(dir)) return [];
  // Recurse into subdirectories so nested files are listed with relative paths.
  // Filenames are normalized to forward-slashes for cross-platform consistency.
  const results: SharedContent[] = [];
  const readDir = (d: string, prefix: string) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        readDir(fullPath, relative);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          const content = fs.readFileSync(fullPath, 'utf-8');
          results.push({
            id: relative,
            projectId,
            filename: relative,
            content,
            createdBy: 'user',
            updatedAt: stat.mtime.toISOString(),
          });
        } catch {
          // skip unreadable entries (permission denied, binary, etc.)
        }
      }
    }
  };
  readDir(dir, '');
  return results;
}

export function getContent(projectId: string, filename: string): SharedContent | null {
  const data = getProjectData(projectId);
  if (!data) return null;
  const filePath = resolveInside(sharedDir(data.project.name), filename);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const stat = fs.statSync(filePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  return {
    id: filename,
    projectId,
    filename,
    content,
    createdBy: 'user',
    updatedAt: stat.mtime.toISOString(),
  };
}

export function createContent(projectId: string, filename: string, content: string, _createdBy: string): SharedContent | null {
  const data = getProjectData(projectId);
  if (!data) return null;
  const dir = sharedDir(data.project.name);
  ensureDir(dir);
  const filePath = resolveInside(dir, filename);
  if (!filePath) return null;
  // Support nested filenames like "subfolder/file.md" by ensuring parent dir exists
  ensureDir(path.dirname(filePath));
  writeFileAtomic(filePath, content);
  const stat = fs.statSync(filePath);
  return {
    id: filename,
    projectId,
    filename,
    content,
    createdBy: _createdBy,
    updatedAt: stat.mtime.toISOString(),
  };
}

export function updateContent(projectId: string, filename: string, content: string): SharedContent | null {
  const data = getProjectData(projectId);
  if (!data) return null;
  const filePath = resolveInside(sharedDir(data.project.name), filename);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  writeFileAtomic(filePath, content);
  const stat = fs.statSync(filePath);
  return {
    id: filename,
    projectId,
    filename,
    content,
    createdBy: 'user',
    updatedAt: stat.mtime.toISOString(),
  };
}

export function deleteContent(projectId: string, filename: string): boolean {
  const data = getProjectData(projectId);
  if (!data) return false;
  const filePath = resolveInside(sharedDir(data.project.name), filename);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  fs.unlinkSync(filePath);
  return true;
}

// --- Group Chat ---

/** Entries returned by default — enough to scroll back through, not a week. */
export const GROUP_CHAT_PAGE = 500;
/** Read at most this much of the file; a chat line is a few hundred bytes. */
const GROUP_CHAT_TAIL_BYTES = 1_000_000;

/**
 * The most recent `limit` group-chat entries.
 *
 * This used to read the whole file and return all of it. A project in use for
 * weeks accumulates thousands of entries, and every one was parsed, sent to the
 * browser on each tab open, held in React state and rendered — so the feed got
 * slower and heavier the longer the project had been useful. Reading the tail
 * keeps it flat in the size of the history.
 */
export function readGroupChat(projectId: string, limit = GROUP_CHAT_PAGE): GroupChatEntry[] {
  const dir = projectDir(projectId);
  const file = path.join(dir, 'groupchat.jsonl');
  if (!fs.existsSync(file)) return [];

  let text: string;
  const size = fs.statSync(file).size;
  if (size <= GROUP_CHAT_TAIL_BYTES) {
    text = fs.readFileSync(file, 'utf-8');
  } else {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(GROUP_CHAT_TAIL_BYTES);
      fs.readSync(fd, buf, 0, GROUP_CHAT_TAIL_BYTES, size - GROUP_CHAT_TAIL_BYTES);
      // The first line is almost certainly cut in half; drop it rather than
      // let a truncated JSON object reach the parser.
      const raw = buf.toString('utf-8');
      text = raw.slice(raw.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  }

  const entries: GroupChatEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch { /* ignore bad lines */ }
  }
  return entries.length > limit ? entries.slice(-limit) : entries;
}

/**
 * True while this project still exists.
 *
 * The append helpers below are called from fire-and-forget paths — a Supervisor
 * classification that started before the user deleted the project lands after
 * it — and `ensureDir` would happily recreate the directory for a project that
 * is gone. That left a resurrected folder holding one stray `groupchat.jsonl`
 * behind every deleted project, accumulating for the life of the install.
 * Cheaper than `getProjectData`, which parses the whole file.
 */
function projectExists(projectId: string): boolean {
  try { return fs.existsSync(projectFile(projectId)); } catch { return false; }
}

/** Returns false when the project has been deleted underneath the caller. */
export function appendGroupChat(projectId: string, entry: GroupChatEntry): boolean {
  if (!projectExists(projectId)) return false;
  const dir = projectDir(projectId);
  ensureDir(dir);
  const file = path.join(dir, 'groupchat.jsonl');
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
  return true;
}

// --- Audit Log ---

export function appendAuditLog(projectId: string, entry: Record<string, unknown>): boolean {
  if (!projectExists(projectId)) return false;
  const dir = projectDir(projectId);
  ensureDir(dir);
  const file = path.join(dir, 'audit.jsonl');
  fs.appendFileSync(file, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n', 'utf-8');
  return true;
}

/** Last `limit` audit entries (newest last) — used to give the Supervisor memory
 *  of recently approved / rejected plans. */
export function readRecentAudit(projectId: string, limit = 10): Array<Record<string, unknown>> {
  try {
    const file = path.join(projectDir(projectId), 'audit.jsonl');
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim());
    const out: Array<Record<string, unknown>> = [];
    for (const line of lines.slice(-limit)) {
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

// --- Project Wiki (stored in ~/.conduit/memory/[project_name]/) ---

const WIKI_SCHEMA = `# Project Wiki Schema

## Purpose
This is the project's persistent knowledge base, maintained by AI agents via Conduit.
It accumulates and organizes knowledge over time — architecture decisions, API specs,
progress tracking, and cross-referenced documentation.

## Structure

### Core Pages
- **overview.md** — Project purpose, tech stack, current state. The "executive summary" — always keep under 200 lines.
- **architecture.md** — System design, components, data flow, infrastructure.
- **api-endpoints.md** — All API endpoints with request/response formats.
- **data-model.md** — Database schema, models, relationships.
- **decisions.md** — Architecture and design decisions with rationale. Append-only — never delete entries.
- **progress.md** — What's done, what's in progress, what's blocked.

### Agent Logs
- **agents/[agent-name].md** — Per-agent work log: what this agent has accomplished, current focus, blockers.

### Raw Sources (optional)
- **raw/** — Original documents, specs, or references. Immutable — agents read but never modify these.

## Maintenance Rules

When asked to "update wiki" or "write to wiki":

1. Read \`_index.md\` first to find relevant existing pages
2. Update ALL affected pages, not just one. A single change might touch 3-5 pages.
3. Add \`[[cross-references]]\` to related pages using markdown links
4. Always append an entry to \`_log.md\` with format: \`## [YYYY-MM-DD] action | Summary\`
5. Update \`_index.md\` if you created or deleted pages
6. Never delete content from \`decisions.md\` — only append
7. When new information contradicts existing content, note the contradiction and update

## Operations

### Ingest
When processing new information: read it, extract key points, update relevant pages,
add cross-references, update index, append to log.

### Query
When answering questions about the project: read \`_index.md\` first, then drill into
relevant pages. Cite which pages you referenced.

### Lint
Periodically check for: contradictions between pages, stale information, orphan pages
with no inbound links, important concepts missing their own page, gaps that need filling.
`;

const WIKI_INDEX = `# Project Wiki Index

> Auto-maintained by AI agents. See \`_schema.md\` for conventions.

## Core
- [Overview](overview.md) — Project purpose, tech stack, current state
- [Architecture](architecture.md) — System design and components
- [API Endpoints](api-endpoints.md) — REST/GraphQL endpoint reference
- [Data Model](data-model.md) — Database schema and relationships
- [Decisions](decisions.md) — Architecture decision records
- [Progress](progress.md) — Current status and roadmap

## Agents
<!-- Agent pages will be listed here as they are created -->
`;

const WIKI_LOG = `# Project Wiki Log

> Chronological record of wiki updates. Append-only.
> Format: ## [YYYY-MM-DD] action | Summary

`;

const WIKI_OVERVIEW = `# Project Overview

> This page should be the first thing a new agent reads to understand the project.
> Keep it under 200 lines. Update it as the project evolves.

## Purpose
<!-- What does this project do? Who is it for? -->

## Tech Stack
<!-- Languages, frameworks, databases, infrastructure -->

## Current State
<!-- What's working? What's in progress? What's the immediate priority? -->

## Key Links
<!-- Repository, deployment, documentation, etc. -->
`;

export function isWikiInitialized(projectId: string): boolean {
  const data = getProjectData(projectId);
  if (!data) return false;
  const dir = wikiDir(data.project.name);
  return fs.existsSync(path.join(dir, '_schema.md'));
}

export function initializeWiki(projectId: string): boolean {
  const data = getProjectData(projectId);
  if (!data) return false;
  const dir = wikiDir(data.project.name);
  ensureDir(dir);
  ensureDir(path.join(dir, 'agents'));
  ensureDir(path.join(dir, 'raw'));

  const files: Record<string, string> = {
    '_schema.md': WIKI_SCHEMA,
    '_index.md': WIKI_INDEX,
    '_log.md': WIKI_LOG,
    'overview.md': WIKI_OVERVIEW,
    'architecture.md': [
      '# Architecture',
      '',
      '## System Overview',
      '<!-- High-level description: what are the main components and how do they interact? -->',
      '',
      '## Component Diagram',
      '```',
      '┌──────────┐     ┌──────────┐     ┌──────────┐',
      '│ Frontend  │────>│ Backend  │────>│ Database │',
      '└──────────┘     └──────────┘     └──────────┘',
      '```',
      '<!-- Replace with your actual architecture -->',
      '',
      '## Components',
      '',
      '### Frontend',
      '<!-- Framework, structure, key patterns -->',
      '',
      '### Backend',
      '<!-- Framework, API layer, business logic -->',
      '',
      '### Database',
      '<!-- Type, schema overview, key tables -->',
      '',
      '## Data Flow',
      '<!-- How does data flow through the system? Key request paths? -->',
      '',
      '## Infrastructure',
      '<!-- Hosting, CI/CD, environment setup -->',
      '',
    ].join('\n'),
    'api-endpoints.md': [
      '# API Endpoints',
      '',
      '## Base URL',
      '<!-- e.g. http://localhost:3000/api -->',
      '',
      '## Endpoints',
      '',
      '| Method | Path | Description | Auth |',
      '|--------|------|-------------|------|',
      '| GET | /example | Description | No |',
      '| POST | /example | Description | Yes |',
      '',
      '## Authentication',
      '<!-- How does auth work? Token format? -->',
      '',
      '## Error Format',
      '<!-- Standard error response structure -->',
      '',
    ].join('\n'),
    'data-model.md': [
      '# Data Model',
      '',
      '## Entity Relationship',
      '<!-- Key entities and their relationships -->',
      '',
      '## Models',
      '',
      '### Example Model',
      '| Field | Type | Description |',
      '|-------|------|-------------|',
      '| id | string | Primary key |',
      '| created_at | datetime | Creation timestamp |',
      '',
      '## Migrations',
      '<!-- Notable migration history -->',
      '',
    ].join('\n'),
    'decisions.md': [
      '# Architecture Decisions',
      '',
      '> Append-only — never delete entries. New decisions go at the bottom.',
      '',
      '<!-- Template for new entries:',
      '## [YYYY-MM-DD] Decision Title',
      '**Context:** Why did this come up?',
      '**Decision:** What did we choose?',
      '**Alternatives considered:** What else was on the table?',
      '**Rationale:** Why this over the alternatives?',
      '-->',
      '',
    ].join('\n'),
    'progress.md': [
      '# Progress',
      '',
      '> Updated by agents when tasks are completed or started.',
      '> Move items between sections as status changes.',
      '',
      '## Done',
      '<!-- - [YYYY-MM-DD] What was completed -->',
      '',
      '## In Progress',
      '<!-- - What is currently being worked on (and by which agent) -->',
      '',
      '## Blocked',
      '<!-- - What is stuck and why -->',
      '',
      '## Upcoming',
      '<!-- - What needs to be done next -->',
      '',
    ].join('\n'),
  };

  for (const [filename, content] of Object.entries(files)) {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) {
      writeFileAtomic(filePath, content);
    }
  }
  return true;
}

export function listWikiFiles(projectId: string): SharedContent[] {
  const data = getProjectData(projectId);
  if (!data) return [];
  const dir = wikiDir(data.project.name);
  if (!fs.existsSync(dir)) return [];

  const results: SharedContent[] = [];
  const readDir = (d: string, prefix: string) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        const sub = prefix ? prefix + '/' + entry.name : entry.name;
        readDir(path.join(d, entry.name), sub);
      } else {
        const filePath = path.join(d, entry.name);
        const filename = prefix ? prefix + '/' + entry.name : entry.name;
        const stat = fs.statSync(filePath);
        results.push({
          id: filename,
          projectId,
          filename,
          content: '',
          createdBy: 'system',
          updatedAt: stat.mtime.toISOString(),
        });
      }
    }
  };
  readDir(dir, '');
  return results;
}

export function getWikiFile(projectId: string, filename: string): SharedContent | null {
  const data = getProjectData(projectId);
  if (!data) return null;
  const filePath = resolveInside(wikiDir(data.project.name), filename);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const stat = fs.statSync(filePath);
  return {
    id: filename,
    projectId,
    filename,
    content: fs.readFileSync(filePath, 'utf-8'),
    createdBy: 'system',
    updatedAt: stat.mtime.toISOString(),
  };
}

export function updateWikiFile(projectId: string, filename: string, content: string): SharedContent | null {
  const data = getProjectData(projectId);
  if (!data) return null;
  const filePath = resolveInside(wikiDir(data.project.name), filename);
  if (!filePath) return null;
  const dir = path.dirname(filePath);
  ensureDir(dir);
  writeFileAtomic(filePath, content);
  const stat = fs.statSync(filePath);
  return {
    id: filename,
    projectId,
    filename,
    content,
    createdBy: 'user',
    updatedAt: stat.mtime.toISOString(),
  };
}

export { SHARED_CONTENT_DIR, WIKI_DIR };
