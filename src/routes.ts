import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import * as storage from './storage.js';
import * as activity from './activity.js';
import type { DaemonClient } from './daemon/client.js';
import type { Agent, WSServerMessage, ProjectLayout } from './types.js';
import { resolveGate, type GateDecision } from './gate-resolve.js';
import { VALID_CLIS } from './cli-registry.js';
import { removeConduitSections } from './instruction-files.js';

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function str(v: unknown, max = 4000): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** Pane layout modes the client can ask us to persist. */
const LAYOUT_MODES: ProjectLayout['mode'][] = ['single', '2up', '3up', 'grid', 'canvas'];

/**
 * Validate a layout body. Returns a normalised layout, or null when the shape
 * is wrong — nothing unvalidated reaches project.json.
 */
function parseLayout(v: unknown): ProjectLayout | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!LAYOUT_MODES.includes(o.mode as ProjectLayout['mode'])) return null;

  const ratios = Array.isArray(o.splitRatios) ? o.splitRatios : [];
  if (ratios.length > 16 || !ratios.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;

  const ids = Array.isArray(o.activeAgentIds) ? o.activeAgentIds : [];
  if (ids.length > 64 || !ids.every((s) => typeof s === 'string' && s.length <= 64)) return null;

  const focused = typeof o.focusedAgentId === 'string' && o.focusedAgentId.length <= 64
    ? o.focusedAgentId
    : undefined;

  return {
    mode: o.mode as ProjectLayout['mode'],
    splitRatios: ratios as number[],
    activeAgentIds: ids as string[],
    ...(focused ? { focusedAgentId: focused } : {}),
  };
}

/** Where electron-builder writes packaged desktop artifacts. */
function desktopArtifactDirs(): string[] {
  // This module is bundled into dist/src/server.mjs, so __dirname is dist/src
  // and the repo root is two levels up. process.cwd() is not reliable here —
  // in a packaged app it is wherever the user launched from.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  // Deliberately NOT dist-desktop/win-unpacked: the Conduit.exe in there is
  // the bare Electron binary and is useless without the rest of the folder,
  // so offering it as a download hands the user something that cannot run.
  return [
    path.join(repoRoot, 'dist-desktop'),             // installers: nsis / zip / AppImage / deb
    path.join(repoRoot, 'client', 'public', 'downloads'),
  ];
}

/**
 * Serves packaged desktop builds at `/downloads/<file>` — the path the
 * landing page's download button actually requests. When the artifact isn't
 * on disk we redirect to the GitHub release of the same name.
 */
/** Installer extensions worth advertising — everything else in dist-desktop is build scaffolding. */
const ARTIFACT_EXT = /\.(exe|zip|dmg|AppImage|deb|rpm|snap)$/i;

export function createDownloadRouter() {
  const router = Router();

  /**
   * What is actually downloadable right now. The landing page uses this
   * instead of a hardcoded list, so it can never offer a build that does not
   * exist or quote a made-up file size.
   */
  router.get('/', (_req: Request, res: Response) => {
    const seen = new Map<string, number>();
    for (const dir of desktopArtifactDirs()) {
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        if (seen.has(name) || !ARTIFACT_EXT.test(name)) continue;
        try {
          const st = fs.statSync(path.join(dir, name));
          if (st.isFile()) seen.set(name, st.size);
        } catch { /* vanished between readdir and stat */ }
      }
    }
    res.json({
      files: [...seen.entries()].map(([name, size]) => ({ name, size })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  router.get('/:file', (req: Request, res: Response) => {
    // basename collapses any traversal attempt to a single path segment.
    const filename = path.basename(req.params.file);
    if (!filename || filename === '.' || filename === '..') {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    for (const dir of desktopArtifactDirs()) {
      const candidate = path.join(dir, filename);
      try {
        // Must be a real file — `res.download` on a directory throws EISDIR.
        if (fs.statSync(candidate).isFile()) {
          res.download(candidate, filename);
          return;
        }
      } catch { /* not here, try the next */ }
    }

    res.redirect(
      `https://github.com/devprashant19/Conduit/releases/latest/download/${encodeURIComponent(filename)}`,
    );
  });

  return router;
}

/**
 * REST API. Agent runtime operations (start/stop/status/inject) are delegated
 * to conduit-daemon over `daemon` — the web server no longer owns PTYs.
 */
export function createRouter(
  daemon: DaemonClient,
  broadcast: (msg: WSServerMessage) => void,
) {
  const router = Router();

  const broadcastStatus = (agentId: string, status: string) =>
    broadcast({ type: 'agent:status', agentId, status });
  const broadcastContentUpdate = (projectId: string, filename: string) =>
    broadcast({ type: 'content:updated', projectId, filename });

  /** Fetch the fine-grained agent status map from the daemon.
   *  If the daemon is unreachable, nothing is running (it owns every PTY). */
  async function agentStatuses(): Promise<Record<string, string>> {
    try {
      const r = await daemon.request('agent:statuses');
      return r.statuses;
    } catch {
      return {};
    }
  }

  /** Resolve an agent inside a project by id, exact name, or fuzzy name/role. */
  function findAgent(agents: Agent[], ref: string, excludeId?: string): { agent?: Agent; error?: string } {
    const norm = ref.trim().toLowerCase();
    const pool = agents.filter((a) => a.id !== excludeId);
    const byId = pool.find((a) => a.id === ref);
    if (byId) return { agent: byId };
    const exact = pool.filter((a) => a.name.toLowerCase() === norm);
    if (exact.length === 1) return { agent: exact[0] };
    if (exact.length > 1) {
      return { error: `Multiple agents named "${ref}" — rename one to disambiguate: ${exact.map((a) => `${a.name} (${a.id.slice(0, 8)})`).join(', ')}` };
    }
    const fuzzy = pool.filter((a) => a.name.toLowerCase().includes(norm) || (a.role || '').toLowerCase().includes(norm));
    if (fuzzy.length === 1) return { agent: fuzzy[0] };
    if (fuzzy.length > 1) return { error: `Ambiguous target "${ref}" — matches: ${fuzzy.map((a) => a.name).join(', ')}` };
    return { error: `No agent named "${ref}" in this project` };
  }

  // --- Projects ---
  router.get('/projects', (_req: Request, res: Response) => {
    res.json(storage.listProjects());
  });

  /**
   * One project, with its agents and pending plans.
   *
   * This was missing entirely: the API had `/projects` and
   * `/projects/:id/agents` but no way to fetch a project itself, so anything
   * wanting one had to list them all and filter. The 404 that `/projects/:id`
   * used to return came from the catch-all, not from a real lookup — which is
   * why a test asserting "a missing project gives 404" was passing without any
   * route to test.
   */
  router.get('/projects/:id', (req: Request, res: Response) => {
    const data = storage.getProjectData(req.params.id);
    if (!data) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json(data);
  });

  router.post('/projects', (req: Request, res: Response) => {
    const name = str(req.body?.name, 120).trim();
    const cwdRaw = str(req.body?.cwd, 1000).trim();
    const description = str(req.body?.description, 2000).trim() || undefined;
    if (!name || !cwdRaw) {
      res.status(400).json({ error: 'name and cwd are required' });
      return;
    }
    // Validate before touching the filesystem — a rejected request must not
    // leave a stray directory behind.
    if (storage.listProjects().some((p) => p.name.toLowerCase() === storage.safeProjectName(name).toLowerCase())) {
      res.status(409).json({ error: `A project named "${name}" already exists` });
      return;
    }
    const cwd = path.resolve(expandHome(cwdRaw));
    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch (err) {
      res.status(400).json({ error: 'Could not create working directory: ' + (err instanceof Error ? err.message : String(err)) });
      return;
    }
    let project;
    try {
      project = storage.createProject(name, cwd, description);
    } catch (err) {
      if (err instanceof storage.DuplicateProjectError) { res.status(409).json({ error: err.message }); return; }
      throw err;
    }
    activity.watchProject(project.id, project.name);
    broadcast({ type: 'org:changed' });
    res.status(201).json(project);
  });

  router.put('/projects/:id', (req: Request, res: Response) => {
    const updates: { name?: string; description?: string; cwd?: string } = {};
    if (typeof req.body?.name === 'string') updates.name = str(req.body.name, 120);
    if (typeof req.body?.description === 'string') updates.description = str(req.body.description, 2000);
    if (typeof req.body?.cwd === 'string') updates.cwd = path.resolve(expandHome(str(req.body.cwd, 1000)));
    // Release the directory before anything tries to move it.
    //
    // The watcher holds an open handle on shared_content/<name>, and on
    // Windows that is enough to make renaming it fail outright. This used to
    // run *after* the update, so every rename raced its own file watcher.
    if (typeof updates.name === 'string') activity.unwatchProject(req.params.id);

    let project;
    try {
      project = storage.updateProject(req.params.id, updates);
    } catch (err) {
      if (err instanceof storage.DuplicateProjectError) { res.status(409).json({ error: err.message }); return; }
      throw err;
    }
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    // shared_content/ and wiki/ move with a rename, so the file watcher must
    // follow them or it keeps watching the old path forever.
    activity.unwatchProject(req.params.id);
    activity.watchProject(project.id, project.name);
    broadcast({ type: 'org:changed' });
    res.json(project);
  });

  router.delete('/projects/:id', async (req: Request, res: Response) => {
    const removeData = req.query.removeData === 'true';
    const data = storage.getProjectData(req.params.id);
    if (!data) { res.status(404).json({ error: 'Project not found' }); return; }
    // Stop + clean up every agent first so nothing is orphaned in the daemon.
    for (const agent of data.agents) {
      try {
        await daemon.request('agent:stop', { agentId: agent.id });
        await daemon.request('agent:cleanup', { projectId: req.params.id, agentId: agent.id });
      } catch { /* daemon down — nothing running */ }
    }
    activity.unwatchProject(req.params.id);
    // Take Conduit's block back out of the user's own CLAUDE.md / AGENTS.md.
    // Starting an agent writes into their repository; deleting the project has
    // to undo that, or every project Conduit ever ran leaves a section behind.
    const dirs = new Set([data.project.cwd, ...data.agents.map((a) => a.cwd)].filter(Boolean));
    for (const cwd of dirs) removeConduitSections(expandHome(cwd), data.project.name);
    storage.deleteProject(req.params.id, removeData);
    broadcast({ type: 'org:changed' });
    res.status(204).end();
  });

  // --- Layout Routes ---
  // The pane layout is per project and shared across browsers. It is written
  // into project.json, which is re-serialised on every agent status change —
  // so the body is validated and bounded rather than stored verbatim.
  router.get('/projects/:id/layout', (req: Request, res: Response) => {
    if (!storage.getProjectData(req.params.id)) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json({ layout: storage.getProjectLayout(req.params.id) });
  });

  router.put('/projects/:id/layout', (req: Request, res: Response) => {
    const layout = parseLayout(req.body?.layout);
    if (!layout) {
      res.status(400).json({ error: `layout must be { mode: one of ${LAYOUT_MODES.join('|')}, splitRatios: number[], activeAgentIds: string[], focusedAgentId?: string }` });
      return;
    }
    if (!storage.saveProjectLayout(req.params.id, layout)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    broadcast({ type: 'layout:changed', projectId: req.params.id, layout });
    res.json({ success: true, layout });
  });

  // --- Agent Routes ---
  router.get('/projects/:id/agents', async (req: Request, res: Response) => {
    const agents = storage.listAgents(req.params.id);
    const statuses = await agentStatuses();
    for (const agent of agents) {
      agent.status = (statuses[agent.id] as Agent['status']) || 'stopped';
      if (agent.status === 'stopped') agent.pendingGate = undefined;
    }
    res.json(agents);
  });

  router.get('/projects/:id/agents/previews', async (req: Request, res: Response) => {
    const agents = storage.listAgents(req.params.id);
    const previews: Record<string, string> = {};
    await Promise.all(agents.map(async (agent) => {
      try {
        const r = await daemon.request('agent:preview', { agentId: agent.id });
        previews[agent.id] = r.preview;
      } catch {
        previews[agent.id] = '';
      }
    }));
    res.json(previews);
  });

  router.post('/projects/:id/agents', (req: Request, res: Response) => {
    const name = str(req.body?.name, 80).trim();
    const cli = str(req.body?.cli, 20).trim().toLowerCase() as Agent['cli'];
    const role = str(req.body?.role, 200).trim() || undefined;
    const cwdRaw = str(req.body?.cwd, 1000).trim();
    if (!name || !cli) {
      res.status(400).json({ error: 'name and cli are required' });
      return;
    }
    if (!VALID_CLIS.includes(cli)) {
      res.status(400).json({ error: `cli must be one of: ${VALID_CLIS.join(', ')}` });
      return;
    }
    const projectData = storage.getProjectData(req.params.id);
    if (!projectData) { res.status(404).json({ error: 'Project not found' }); return; }
    if (projectData.agents.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      res.status(409).json({ error: `An agent named "${name}" already exists in this project` });
      return;
    }
    const agentCwd = cwdRaw ? path.resolve(expandHome(cwdRaw)) : projectData.project.cwd;
    try { fs.mkdirSync(agentCwd, { recursive: true }); } catch { /* best-effort */ }
    const flagsIn = (req.body?.flags || {}) as Record<string, unknown>;
    const flags: Agent['flags'] = {
      dangerouslySkipPermissions: !!flagsIn.dangerouslySkipPermissions,
      remoteControl: !!flagsIn.remoteControl,
    };
    const agent = storage.createAgent(req.params.id, name, cli, agentCwd, role, flags);
    if (!agent) { res.status(404).json({ error: 'Project not found' }); return; }
    broadcast({ type: 'org:changed' });
    res.status(201).json(agent);
  });

  router.put('/projects/:id/agents/:aid', (req: Request, res: Response) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const updates: storage.AgentUpdate = {};
    if (typeof b.name === 'string' && b.name.trim()) updates.name = str(b.name, 80).trim();
    if (typeof b.role === 'string') updates.role = str(b.role, 200).trim() || undefined;
    if (typeof b.cwd === 'string' && b.cwd.trim()) updates.cwd = path.resolve(expandHome(str(b.cwd, 1000)));
    if (typeof b.cli === 'string' && VALID_CLIS.includes(b.cli as Agent['cli'])) updates.cli = b.cli as Agent['cli'];
    if (b.flags && typeof b.flags === 'object') {
      const f = b.flags as Record<string, unknown>;
      updates.flags = { dangerouslySkipPermissions: !!f.dangerouslySkipPermissions, remoteControl: !!f.remoteControl };
    }
    const agent = storage.updateAgent(req.params.id, req.params.aid, updates);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    broadcast({ type: 'org:changed' });
    res.json(agent);
  });

  router.delete('/projects/:id/agents/:aid', async (req: Request, res: Response) => {
    const agent = storage.getAgent(req.params.id, req.params.aid);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    try {
      await daemon.request('agent:stop', { agentId: req.params.aid });
      await daemon.request('agent:cleanup', { projectId: req.params.id, agentId: req.params.aid });
    } catch { /* daemon down — agent already not running */ }
    storage.deleteAgent(req.params.id, req.params.aid);
    broadcastStatus(agent.id, 'stopped');
    broadcast({ type: 'org:changed' });
    res.status(204).end();
  });

  // --- Teammates (list other agents the given agent can message) ---
  router.get('/projects/:id/agents/:aid/teammates', async (req: Request, res: Response) => {
    const all = storage.listAgents(req.params.id);
    const self = all.find(a => a.id === req.params.aid);
    if (!self) { res.status(404).json({ error: 'Agent not found' }); return; }
    const statuses = await agentStatuses();
    const teammates = all
      .filter(a => a.id !== self.id)
      .map(a => ({
        id: a.id,
        name: a.name,
        role: a.role,
        cli: a.cli,
        status: statuses[a.id] || 'stopped',
      }));
    res.json({ self: { id: self.id, name: self.name, role: self.role }, teammates });
  });

  // --- Agent-to-agent messaging (called by MCP server + the Messages panel) ---
  router.post('/projects/:id/messages', async (req: Request, res: Response) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const fromAgentId = str(b.fromAgentId, 64).trim();
    const target = str(b.target, 200).trim();
    // Must be a real string: a truthy object used to slip through, inject an
    // empty message, and log "[object Object]" into the activity feed.
    const message = str(b.message, 20_000).trim();
    if (!fromAgentId || !target || !message) {
      res.status(400).json({ error: 'fromAgentId, target, and message are required and must be strings' });
      return;
    }

    const agents = storage.listAgents(req.params.id);
    const sender = agents.find(a => a.id === fromAgentId);
    if (!sender) { res.status(404).json({ error: 'Sender agent not found in this project' }); return; }

    const found = findAgent(agents, target, sender.id);
    if (!found.agent) {
      res.status(found.error?.startsWith('No agent') ? 404 : 400).json({ error: found.error });
      return;
    }
    const recipient = found.agent;
    const fromName = str(b.fromAgentName, 80) || sender.name;
    let delivered = false;
    try {
      const r = await daemon.request('agent:inject', {
        agentId: recipient.id, fromName, message,
      });
      delivered = r.delivered;
    } catch { /* daemon down */ }

    activity.pushEvent({
      projectId: req.params.id,
      agentId: sender.id,
      agentName: sender.name,
      event: 'agent:message',
      detail: `${fromName} → ${recipient.name}: ${message.slice(0, 120)}`,
      fromAgent: fromName,
      toAgent: recipient.name,
      message,
    });

    res.json({ delivered, toAgentId: recipient.id, toAgentName: recipient.name });
  });

  router.post('/projects/:id/agents/:aid/start', async (req: Request, res: Response) => {
    const agent = storage.getAgent(req.params.id, req.params.aid);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    try {
      const r = await daemon.request('agent:start', { projectId: req.params.id, agentId: agent.id });
      if (!r.ok) {
        res.status(400).json({
          error: r.error
            || `Failed to start ${agent.name} — check that the \`${agent.cli}\` CLI is installed and its working directory exists (${agent.cwd}).`,
        });
        return;
      }
    } catch (err) {
      res.status(503).json({ error: 'Daemon unavailable: ' + (err instanceof Error ? err.message : String(err)) });
      return;
    }
    activity.pushEvent({ projectId: req.params.id, agentId: agent.id, agentName: agent.name, event: 'agent:started', detail: `${agent.name} (${agent.cli}) started` });
    const projectData = storage.getProjectData(req.params.id);
    if (projectData) activity.watchProject(req.params.id, projectData.project.name);
    res.json({ status: 'running' });
  });

  router.post('/projects/:id/agents/:aid/stop', async (req: Request, res: Response) => {
    const agent = storage.getAgent(req.params.id, req.params.aid);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    try {
      await daemon.request('agent:stop', { agentId: agent.id });
    } catch { /* daemon down — treat as stopped */ }
    storage.updateAgent(req.params.id, req.params.aid, { status: 'stopped', pid: undefined, pendingGate: undefined });
    broadcastStatus(agent.id, 'stopped');
    if (agent.pendingGate) broadcast({ type: 'gate:resolved', agentId: agent.id });
    activity.pushEvent({ projectId: req.params.id, agentId: agent.id, agentName: agent.name, event: 'agent:stopped', detail: `${agent.name} stopped` });
    res.json({ status: 'stopped' });
  });

  router.post('/projects/:id/agents/:aid/restart', async (req: Request, res: Response) => {
    const agent = storage.getAgent(req.params.id, req.params.aid);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    try {
      await daemon.request('agent:restart', { projectId: req.params.id, agentId: agent.id });
    } catch (err) {
      res.status(503).json({ error: 'Daemon unavailable: ' + (err instanceof Error ? err.message : String(err)) });
      return;
    }
    storage.updateAgent(req.params.id, req.params.aid, { pendingGate: undefined });
    if (agent.pendingGate) broadcast({ type: 'gate:resolved', agentId: agent.id });
    res.json({ status: 'restarting' });
  });

  // --- Approval gates ---
  router.post('/projects/:id/agents/:aid/gate/resolve', (req: Request, res: Response) => {
    const decision = str(req.body?.decision, 20) as GateDecision;
    const customInput = str(req.body?.customInput, 4000);
    // The mechanics live in gate-resolve.ts because voice can approve too, and
    // two copies of "what actually reaches the agent" would drift apart.
    const r = resolveGate(daemon, broadcast, req.params.id, req.params.aid, decision, { customInput });
    if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
    res.json({ success: true, action: r.action });
  });

  // --- Plans (Supervisor proposals awaiting human approval) ---
  router.get('/projects/:id/plans', (req: Request, res: Response) => {
    res.json(storage.getPlans(req.params.id));
  });

  router.post('/projects/:id/plans', (req: Request, res: Response) => {
    const description = str(req.body?.description, 4000).trim();
    const targetAgent = str(req.body?.targetAgent, 200).trim();
    const proposedMessage = str(req.body?.proposedMessage, 20_000).trim();
    if (!description || !targetAgent || !proposedMessage) {
      res.status(400).json({ error: 'description, targetAgent, and proposedMessage are required' });
      return;
    }
    const plan = storage.createPlan({
      projectId: req.params.id,
      description,
      targetAgent,
      targetProject: req.params.id,
      proposedMessage,
    });
    if (!plan) { res.status(404).json({ error: 'Project not found' }); return; }

    storage.appendAuditLog(req.params.id, { event: 'plan_created', plan });
    const entry: storage.GroupChatEntry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      role: 'supervisor',
      sender: 'Supervisor',
      text: `[Plan] ${description}\n\nProposed for ${targetAgent}:\n> ${proposedMessage}\n\nWaiting for your approval.`,
      classification: 'question',
    };
    storage.appendGroupChat(req.params.id, entry);
    broadcast({ type: 'groupchat:message', payload: { ...entry, projectId: req.params.id } });
    broadcast({ type: 'plan:created', plan });
    res.status(201).json(plan);
  });

  router.post('/projects/:id/plans/:planId/resolve', async (req: Request, res: Response) => {
    const decision = str(req.body?.decision, 20) === 'approve' ? 'approve' : 'reject';
    const reason = str(req.body?.reason, 2000).trim();
    const plan = storage.resolvePlan(req.params.id, req.params.planId);
    if (!plan) { res.status(404).json({ error: 'Plan not found' }); return; }

    storage.appendAuditLog(req.params.id, { event: `plan_${decision}`, plan, reason: reason || undefined });

    let delivered = false;
    let deliveryNote = '';
    if (decision === 'approve') {
      const agents = storage.listAgents(req.params.id);
      const found = findAgent(agents, plan.targetAgent);
      if (!found.agent) {
        deliveryNote = found.error || 'Target agent not found';
      } else {
        try {
          const r = await daemon.request('agent:inject', {
            agentId: found.agent.id,
            fromName: 'Supervisor',
            message: plan.proposedMessage,
          });
          delivered = r.delivered;
          if (!delivered) deliveryNote = `${found.agent.name} is not running — start it and re-send the instruction.`;
          else {
            activity.pushEvent({
              projectId: req.params.id, agentName: 'Supervisor', event: 'agent:message',
              detail: `Supervisor → ${found.agent.name}: ${plan.proposedMessage.slice(0, 120)}`,
              fromAgent: 'Supervisor', toAgent: found.agent.name, message: plan.proposedMessage,
            });
          }
        } catch (err) {
          deliveryNote = 'Daemon unavailable: ' + (err instanceof Error ? err.message : String(err));
        }
      }
    }

    const entry: storage.GroupChatEntry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      role: 'user',
      sender: 'User',
      text: decision === 'approve'
        ? `Plan approved: ${plan.description}\n\n${delivered ? `Dispatched to ${plan.targetAgent}:` : `Not delivered — ${deliveryNote}`}\n> ${plan.proposedMessage}`
        : `Plan rejected: ${plan.description}${reason ? `\n\nReason: ${reason}` : ''}`,
      classification: decision === 'approve' ? 'progress' : 'blocker',
    };
    storage.appendGroupChat(req.params.id, entry);
    broadcast({ type: 'groupchat:message', payload: { ...entry, projectId: req.params.id } });
    broadcast({ type: 'plan:resolved', planId: plan.id, decision });

    res.json({ success: true, plan, delivered, note: deliveryNote || undefined });
  });

  // --- Group Chat ---
  router.get('/projects/:id/groupchat', (req: Request, res: Response) => {
    if (!storage.getProjectData(req.params.id)) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json({ messages: storage.readGroupChat(req.params.id) });
  });

  router.post('/projects/:id/groupchat', async (req: Request, res: Response) => {
    const message = str(req.body?.message, 20_000).trim();
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    const projectData = storage.getProjectData(req.params.id);
    if (!projectData) { res.status(404).json({ error: 'Project not found' }); return; }

    const entry: storage.GroupChatEntry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      role: 'user',
      sender: 'User',
      text: message,
    };
    storage.appendGroupChat(req.params.id, entry);
    broadcast({ type: 'groupchat:message', payload: { ...entry, projectId: req.params.id } });

    // Routing: "@name …" goes to that agent; "@all …" or no mention goes to
    // every running agent in the project. The agent sees it as a message
    // from the user in its own terminal.
    const agents = projectData.agents;
    const mention = message.match(/^@([A-Za-z0-9_.-]+)\s*/);
    let targets: Agent[] = [];
    let body = message;
    let note = '';
    if (mention && mention[1].toLowerCase() !== 'all') {
      const found = findAgent(agents, mention[1]);
      if (!found.agent) note = found.error || `No agent named "${mention[1]}"`;
      else { targets = [found.agent]; body = message.slice(mention[0].length).trim() || message; }
    } else {
      if (mention) body = message.slice(mention[0].length).trim() || message;
      targets = agents;
    }

    const delivered: string[] = [];
    const skipped: string[] = [];
    for (const t of targets) {
      try {
        const r = await daemon.request('agent:inject', { agentId: t.id, fromName: 'User', message: body });
        (r.delivered ? delivered : skipped).push(t.name);
      } catch {
        skipped.push(t.name);
      }
    }
    if (!note) {
      if (delivered.length && skipped.length) note = `Delivered to ${delivered.join(', ')}. Not running: ${skipped.join(', ')}.`;
      else if (delivered.length) note = '';
      else if (targets.length) note = `No agent received it — not running: ${skipped.join(', ')}.`;
      else note = 'No agents in this project yet.';
    }
    if (note) {
      const sys: storage.GroupChatEntry = {
        id: randomUUID(), ts: new Date().toISOString(), role: 'supervisor', sender: 'Conduit', text: note,
        classification: 'noise',
      };
      storage.appendGroupChat(req.params.id, sys);
      broadcast({ type: 'groupchat:message', payload: { ...sys, projectId: req.params.id } });
    }

    res.status(201).json({ ...entry, delivered, skipped });
  });

  // --- Shared Content ---
  router.get('/projects/:id/content', (req: Request, res: Response) => {
    if (!storage.getProjectData(req.params.id)) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json(storage.listContent(req.params.id));
  });

  router.get('/projects/:id/content/:filename(*)', (req: Request, res: Response) => {
    const item = storage.getContent(req.params.id, req.params.filename);
    if (!item) { res.status(404).json({ error: 'Content not found' }); return; }
    res.json(item);
  });

  router.post('/projects/:id/content', (req: Request, res: Response) => {
    const filename = str(req.body?.filename, 512).trim();
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (!filename) { res.status(400).json({ error: 'filename is required' }); return; }
    if (!storage.getProjectData(req.params.id)) { res.status(404).json({ error: 'Project not found' }); return; }
    if (storage.getContent(req.params.id, filename)) { res.status(409).json({ error: 'File already exists' }); return; }
    const item = storage.createContent(req.params.id, filename, content, str(req.body?.createdBy, 80) || 'user');
    if (!item) { res.status(400).json({ error: 'Invalid filename' }); return; }
    broadcastContentUpdate(req.params.id, item.filename);
    res.status(201).json(item);
  });

  router.put('/projects/:id/content/:filename(*)', (req: Request, res: Response) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const item = storage.updateContent(req.params.id, req.params.filename, content);
    if (!item) { res.status(404).json({ error: 'Content not found' }); return; }
    broadcastContentUpdate(req.params.id, req.params.filename);
    res.json(item);
  });

  router.delete('/projects/:id/content/:filename(*)', (req: Request, res: Response) => {
    if (!storage.deleteContent(req.params.id, req.params.filename)) {
      res.status(404).json({ error: 'Content not found' });
      return;
    }
    broadcastContentUpdate(req.params.id, req.params.filename);
    res.status(204).end();
  });

  // --- Project Wiki ---
  router.get('/projects/:id/wiki/status', (req: Request, res: Response) => {
    if (!storage.getProjectData(req.params.id)) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json({ initialized: storage.isWikiInitialized(req.params.id) });
  });

  router.post('/projects/:id/wiki/initialize', (req: Request, res: Response) => {
    const ok = storage.initializeWiki(req.params.id);
    if (!ok) { res.status(404).json({ error: 'Project not found' }); return; }
    broadcastContentUpdate(req.params.id, '_index.md');
    res.json({ initialized: true });
  });

  router.get('/projects/:id/wiki', (req: Request, res: Response) => {
    if (!storage.getProjectData(req.params.id)) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json(storage.listWikiFiles(req.params.id));
  });

  router.get('/projects/:id/wiki/:filename(*)', (req: Request, res: Response) => {
    const item = storage.getWikiFile(req.params.id, req.params.filename);
    if (!item) { res.status(404).json({ error: 'File not found' }); return; }
    res.json(item);
  });

  router.put('/projects/:id/wiki/:filename(*)', (req: Request, res: Response) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (!storage.getProjectData(req.params.id)) { res.status(404).json({ error: 'Project not found' }); return; }
    const item = storage.updateWikiFile(req.params.id, req.params.filename, content);
    if (!item) { res.status(400).json({ error: 'Invalid filename' }); return; }
    // Keep other viewers in step, as the shared-content routes already do.
    broadcastContentUpdate(req.params.id, req.params.filename);
    res.json(item);
  });

  return router;
}
