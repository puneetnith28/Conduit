import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Sidebar from './components/Sidebar';
import AgentGrid, { type GridLayout } from './components/AgentGrid';
import SharedContentView from './components/SharedContent';
import ActivityFeed from './components/ActivityFeed';
import ProjectWiki from './components/ProjectWiki';
import MessagesPanel from './components/MessagesPanel';
import GroupChat from './components/GroupChat';
import CommandPalette from './components/CommandPalette';
import CommandPanel from './components/CommandPanel';
import NotificationCenter from './components/NotificationCenter';
import JarvisHud from './components/JarvisHud';
import CreateProjectModal from './components/CreateProjectModal';
import CreateAgentModal from './components/CreateAgentModal';
import GateModal from './components/GateModal';
import PlanModal from './components/PlanModal';
import UsagePanel from './components/UsagePanel';
import Ic, { MOD } from './components/Icons';
import { useWebSocket } from './hooks/useWebSocket';
import { useSpeechInput } from './hooks/useSpeechInput';
import { useVoiceSession } from './hooks/useVoiceSession';
import { useVoiceAnnouncer } from './hooks/useVoiceAnnouncer';
import { useVoiceConfig } from './hooks/useVoiceConfig';
import { useRealtimeVoice } from './hooks/useRealtimeVoice';
import SettingsModal from './components/SettingsModal';
import LandingPage from './components/LandingPage';
import ConduitOnboardingTour from './components/onboarding/ConduitOnboardingTour';
import DownloadModal from './components/DownloadModal';
import logoDark from './assets/logo_dark_sm.jpg';
import logoLight from './assets/logo_light_sm.jpg';
import * as api from './api';
import { speak, stopSpeaking } from './utils/speech';
import type { Route, RosterAgent } from './utils/voiceRouting';
import type { Project, Agent, Plan } from './api';

type MainTab = 'terminals' | 'messages' | 'groupchat' | 'shared' | 'wiki' | 'activity' | 'usage';

const LAYOUT_ICONS: { v: GridLayout; Icon: (p: { size?: number }) => JSX.Element; title: string }[] = [
  { v: 'single', Icon: Ic.single, title: 'Single' },
  { v: '2up', Icon: Ic.twoup, title: '2-up' },
  { v: '3up', Icon: Ic.threeup, title: '3-up' },
  { v: 'grid', Icon: Ic.grid, title: 'Tmux Grid' },
  { v: 'canvas', Icon: Ic.canvas, title: 'Canvas' },
];

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Map<string, Agent[]>>(new Map());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>('terminals');
  const [inConsole, setInConsole] = useState<boolean>(() => {
    // The desktop app has no use for the marketing landing page — the visitor
    // already installed it.
    if (window.conduitDesktop?.isDesktop) return true;
    return window.location.hash === '#console';
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  // Orchestrator-brain completion cue — shown when the brain finishes a task
  // while the Command panel is closed.
  const [brainDone, setBrainDone] = useState(false);
  const [brainWorking, setBrainWorking] = useState(false);
  const [brainReply, setBrainReply] = useState<{ text: string; ts: number } | null>(null);
  const [quickCmd, setQuickCmd] = useState('');
  const [wakeEnabled, setWakeEnabled] = useState(
    () => localStorage.getItem('conduit:wake') === '1',
  );
  const [wakePhrase, setWakePhrase] = useState(
    () => localStorage.getItem('conduit:wake-phrase') || 'jarvis',
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Spoken output. Lived in JarvisHud, which unmounts whenever the Command
  // panel opens — so a reply could be cut off mid-sentence and never resume.
  const [voiceOut, setVoiceOut] = useState(
    () => localStorage.getItem('conduit:voice-out') === '1',
  );
  const voice = useVoiceConfig();
  const [notifSeen, setNotifSeen] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const commandOpenRef = useRef(commandOpen);
  useEffect(() => { commandOpenRef.current = commandOpen; }, [commandOpen]);
  const brainBusyRef = useRef(false);
  const brainConvIdRef = useRef('');
  const selectedProjectRef = useRef<string | null>(null);

  // Transient error toast (start/stop failures etc.)
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  const showError = (err: unknown) => setToast(err instanceof Error ? err.message : String(err));
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [layout, setLayout] = useState<GridLayout>(() => {
    const saved = localStorage.getItem('conduit:layout') as GridLayout | null;
    // Migrate the old 'focus' value away
    if (saved === 'focus' as GridLayout) return 'canvas' as GridLayout;
    return saved || '3up';
  });
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [mobileMoreTabsOpen, setMobileMoreTabsOpen] = useState(false);
  const layoutMenuRef = useRef<HTMLDivElement>(null);
  const helpMenuRef = useRef<HTMLDivElement>(null);
  const shortcutsRef = useRef<HTMLDivElement>(null);
  const mobileActionsRef = useRef<HTMLDivElement>(null);
  const mobileMoreTabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (layoutMenuRef.current && !layoutMenuRef.current.contains(e.target as Node)) {
        setLayoutMenuOpen(false);
      }
      if (helpMenuRef.current && !helpMenuRef.current.contains(e.target as Node)) {
        setHelpMenuOpen(false);
      }
      if (shortcutsRef.current && !shortcutsRef.current.contains(e.target as Node)) {
        setShortcutsOpen(false);
      }
      if (mobileActionsRef.current && !mobileActionsRef.current.contains(e.target as Node)) {
        setMobileActionsOpen(false);
      }
      if (mobileMoreTabsRef.current && !mobileMoreTabsRef.current.contains(e.target as Node)) {
        setMobileMoreTabsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const [showNewProject, setShowNewProject] = useState(false);
  // Directory chosen through the desktop app's native File → Open Local Project
  // picker; prefills the New Project form. Always null in a browser.
  const [pickedCwd, setPickedCwd] = useState<string | null>(null);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [activeGateAgent, setActiveGateAgent] = useState<{ projectId: string; agentId: string } | null>(null);
  // Pending Supervisor plans, oldest first. The modal shows the head of the queue.
  const [plans, setPlans] = useState<Plan[]>([]);
  const [planDismissed, setPlanDismissed] = useState<Set<string>>(new Set());
  const activePlan = plans.find((p) => !planDismissed.has(p.id)) || null;
  const [contentRefresh, setContentRefresh] = useState(0);

  // Sidebar collapse + resize state
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    localStorage.getItem('conduit:sidebar-collapsed') === '1'
  );
  const [sidebarW, setSidebarW] = useState<number>(() => {
    const n = parseInt(localStorage.getItem('conduit:sidebar-w') || '', 10);
    return Number.isFinite(n) && n >= 240 ? n : 248;
  });
  useEffect(() => {
    localStorage.setItem('conduit:sidebar-collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem('conduit:sidebar-w', String(sidebarW));
  }, [sidebarW]);

  const sidebarDragCancel = useRef<(() => void) | null>(null);
  useEffect(() => () => { sidebarDragCancel.current?.(); }, []);
  const onSidebarResizeDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarW;
    const move = (ev: MouseEvent) => {
      const w = Math.max(180, Math.min(420, startW + (ev.clientX - startX)));
      setSidebarW(w);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('blur', up);
      document.body.style.cursor = '';
      sidebarDragCancel.current = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('blur', up);
    document.body.style.cursor = 'col-resize';
    sidebarDragCancel.current = up;
  };


  useEffect(() => {
    localStorage.setItem('conduit:layout', layout);
  }, [layout]);

  // WebSocket
  const ws = useWebSocket((msg) => {
    if (msg.type === 'content:updated') {
      setContentRefresh((n) => n + 1);
    }
    if (msg.type === 'org:changed' || msg.type === 'ws:open') {
      // Something changed a project or agent (or we just reconnected) —
      // refresh the sidebar and every loaded agent list.
      loadProjects();
      setAgents((prev) => {
        for (const pid of prev.keys()) loadAgents(pid);
        return prev;
      });
      const pid = selectedProjectRef.current;
      if (pid) loadPlans(pid);
    }
    if (msg.type === 'brain:event') {
      // The single reliable brain-event sink — ws.onmessage. The Jarvis HUD
      // reads brain state from here via props (its own listener can't attach
      // before the socket exists).
      const p = (msg as { payload?: any }).payload;
      if (p?.kind === 'status') {
        if (p.status === 'thinking') {
          brainBusyRef.current = true;
          setBrainWorking(true);
        } else if (p.status === 'idle' && brainBusyRef.current) {
          brainBusyRef.current = false;
          setBrainWorking(false);
          if (!commandOpenRef.current) setBrainDone(true);
        }
      } else if (p?.kind === 'append' && p.message?.role === 'assistant') {
        setBrainReply({ text: String(p.message.text || ''), ts: Date.now() });
      } else if (p?.kind === 'append' && p.message?.role === 'error') {
        // Only 'assistant' was handled, so a Keeper failure — a missing `codex`
        // binary above all — was neither spoken nor shown outside the Command
        // panel. The user just saw nothing happen.
        setToast(String(p.message.text || 'The Keeper failed.').slice(0, 300));
      } else if (p?.kind === 'state') {
        // Conversation switch (new / picked from history) — drop the stale
        // reply so the HUD doesn't show or re-speak a message that belongs
        // to a different conversation.
        const cid = p.state?.currentId;
        if (cid && cid !== brainConvIdRef.current) {
          brainConvIdRef.current = cid;
          setBrainReply(null);
        }
      }
    }
    if (msg.type === 'agent:status' && typeof msg.agentId === 'string' && typeof msg.status === 'string') {
      const { agentId, status } = msg;
      setAgents((prev) => {
        const next = new Map(prev);
        for (const [pid, list] of next) {
          const updated = list.map((a) =>
            a.id === agentId
              ? { ...a, status: status as Agent['status'], pendingGate: status === 'stopped' ? undefined : a.pendingGate }
              : a
          );
          next.set(pid, updated);
        }
        return next;
      });
      if (status === 'stopped') setActiveGateAgent((cur) => (cur?.agentId === agentId ? null : cur));
    }
    if (msg.type === 'gate:triggered') {
      const p = msg as unknown as { projectId: string; agentId: string; prompt: string; source: 'regex' | 'supervisor'; options?: string[] };
      setAgents((prev) => {
        const next = new Map(prev);
        const list = next.get(p.projectId) || [];
        next.set(p.projectId, list.map((a) =>
          a.id === p.agentId ? { ...a, pendingGate: { prompt: p.prompt, source: p.source, options: p.options } } : a
        ));
        return next;
      });
      setActiveGateAgent((cur) => cur ?? { projectId: p.projectId, agentId: p.agentId });
    }
    if (msg.type === 'gate:resolved') {
      const agentId = String(msg.agentId);
      setAgents((prev) => {
        const next = new Map(prev);
        for (const [pid, list] of next) {
          next.set(pid, list.map((a) => a.id === agentId ? { ...a, pendingGate: undefined } : a));
        }
        return next;
      });
      setActiveGateAgent((cur) => (cur?.agentId === agentId ? null : cur));
    }
    if (msg.type === 'plan:created') {
      const plan = msg.plan as Plan;
      if (plan?.id) setPlans((prev) => prev.some((p) => p.id === plan.id) ? prev : [...prev, plan]);
    }
    if (msg.type === 'plan:resolved') {
      const planId = String(msg.planId);
      setPlans((prev) => prev.filter((p) => p.id !== planId));
    }
  });

  const loadProjects = useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(list);
    } catch (err) {
      showError(err);
    }
  }, []);

  const loadAgents = useCallback(async (projectId: string) => {
    try {
      const list = await api.listAgents(projectId);
      setAgents((prev) => new Map(prev).set(projectId, list));
    } catch { /* project may have been deleted */ }
  }, []);

  const loadPlans = useCallback(async (projectId: string) => {
    try {
      const list = await api.listPlans(projectId);
      setPlans((prev) => {
        const others = prev.filter((p) => p.projectId !== projectId);
        return [...others, ...list];
      });
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  // Open a gate modal for any agent that already has one pending (e.g. after
  // a page reload) — the live gate:triggered event covers the rest.
  useEffect(() => {
    if (activeGateAgent) return;
    for (const [pid, list] of agents) {
      const gated = list.find((a) => a.pendingGate && a.status !== 'stopped');
      if (gated) { setActiveGateAgent({ projectId: pid, agentId: gated.id }); return; }
    }
  }, [agents, activeGateAgent]);

  // Opening the Command panel clears the brain-completion cue.
  useEffect(() => {
    if (commandOpen) setBrainDone(false);
  }, [commandOpen]);

  useEffect(() => {
    selectedProjectRef.current = selectedProjectId;
    if (selectedProjectId) {
      loadAgents(selectedProjectId);
      loadPlans(selectedProjectId);
    }
  }, [selectedProjectId, loadAgents, loadPlans]);

  // Load agents for ALL projects so sidebar can show running counts
  useEffect(() => {
    projects.forEach((p) => {
      if (!agents.has(p.id)) loadAgents(p.id);
    });
    // Auto-select first project if none selected so the studio is never blank
    if (!selectedProjectId && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, selectedProjectId]);

  // If the selected project disappears (deleted elsewhere), deselect it.
  useEffect(() => {
    if (selectedProjectId && projects.length && !projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(projects[0]?.id || null);
      setSelectedAgentId(null);
    }
  }, [projects, selectedProjectId]);

  const projectAgents = selectedProjectId ? agents.get(selectedProjectId) || [] : [];
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const runningCount = projectAgents.filter((a) => a.status === 'running').length;
  const awaitingCount = projectAgents.filter((a) => a.status === 'awaiting_input').length;
  const idleCount = projectAgents.filter((a) => a.status === 'idle').length;
  const stoppedCount = projectAgents.filter((a) => a.status === 'stopped').length;
  // "alive" = process exists (running / awaiting / idle) — used for Stop-all gating
  const aliveCount = runningCount + awaitingCount + idleCount;

  // Notification center — every agent across all projects that needs you now.
  const awaitingNotifs = useMemo(() => {
    const out: { agentId: string; agentName: string; projectId: string; projectName: string }[] = [];
    for (const p of projects) {
      for (const a of agents.get(p.id) || []) {
        if (a.status === 'awaiting_input') {
          out.push({ agentId: a.id, agentName: a.name, projectId: p.id, projectName: p.name });
        }
      }
    }
    return out;
  }, [projects, agents]);
  const notifUnread = awaitingNotifs.filter((n) => !notifSeen.has(n.agentId)).length;

  // Conduit-wide running / idle counts for the Keeper HUD.
  const globalCounts = useMemo(() => {
    let running = 0;
    let idle = 0;
    for (const list of agents.values()) {
      for (const a of list) {
        if (a.status === 'running') running++;
        else if (a.status === 'idle') idle++;
      }
    }
    return { running, idle };
  }, [agents]);

  // Drop seen ids whose agent no longer needs you — so it re-badges next time.
  useEffect(() => {
    const ids = new Set(awaitingNotifs.map((n) => n.agentId));
    setNotifSeen((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [awaitingNotifs]);

  // Keyboard shortcuts: ⌘K/Ctrl+K (palette), ⌘1–5 (focus agent)
  // `capture: true` fires in the capture phase so it preempts xterm's textarea
  // even when an xterm instance has focus. preventDefault + stopPropagation
  // then prevents the key from reaching xterm at all.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault(); e.stopPropagation();
        setPaletteOpen(true); return;
      }
      if (mod && e.key === '/') {
        e.preventDefault(); e.stopPropagation();
        setPaletteOpen(true); return;
      }
      if (mod && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault(); e.stopPropagation();
        setCommandOpen((o) => !o); return;
      }
      // ⌘; / Ctrl+; — open a hands-free conversation where the microphone is
      // not already listening (a paid engine, or the desktop app); otherwise
      // fall back to push-to-talk.
      if (mod && e.key === ';') {
        e.preventDefault(); e.stopPropagation();
        const vs = voiceSessionRef.current;
        if (vs && !vs.alwaysOn) vs.toggle();
        else quickSpeechRef.current?.toggle();
        return;
      }
      if (mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault(); e.stopPropagation();
        const i = parseInt(e.key, 10) - 1;
        const a = projectAgents[i];
        if (a) setSelectedAgentId(a.id);
        return;
      }
      if (e.key === 'Escape') { setPaletteOpen(false); setCommandOpen(false); }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [projectAgents]);

  // Desktop shell (Electron) integration. `window.conduitDesktop` is injected
  // by electron/preload.ts and is undefined in a browser, so all of this is a
  // no-op on the web. The menu accelerators in electron/main.ts arrive here.
  useEffect(() => {
    const desktop = window.conduitDesktop;
    if (!desktop) return;

    const unsubs = [
      desktop.onToggleKeeper(() => setCommandOpen((o) => !o)),
      desktop.onToggleVoice(() => {
        // In the desktop app the free browser recogniser cannot work, so the
        // accelerator opens a hands-free session (paid engine) rather than
        // toggling push-to-talk.
        if (window.conduitDesktop?.isDesktop) voiceSessionRef.current?.toggle();
        else quickSpeechRef.current?.toggle();
      }),
      desktop.onFocusTerminal(() => {
        setInConsole(true);
        setMainTab('terminals');
        // Focusing the pane is a DOM concern — the Terminal component only
        // re-focuses when its `focused` prop flips, which it may not here.
        setTimeout(() => {
          const el = document.querySelector<HTMLTextAreaElement>('.pane.focused .xterm-helper-textarea');
          el?.focus();
        }, 0);
      }),
      desktop.onProjectOpened((dir) => {
        setPickedCwd(dir);
        setShowNewProject(true);
      }),
      desktop.onDaemonStatus((status) => {
        if (!status.ready) setToast(status.error || 'The Conduit backend is not running.');
      }),
    ];
    return () => { for (const off of unsubs) off(); };
  }, []);

  // Handlers
  const handleSelectProject = (id: string) => {
    setSelectedProjectId(id);
    setSelectedAgentId(null);
  };

  const handleSelectAgent = (projectId: string, agentId: string) => {
    setSelectedProjectId(projectId);
    setSelectedAgentId(agentId);
    setMainTab('terminals');
  };

  const handleCreateProject = async (data: { name: string; cwd: string; description?: string }) => {
    try {
      const project = await api.createProject(data);
      setShowNewProject(false);
      setPickedCwd(null);
      await loadProjects();
      setSelectedProjectId(project.id);
    } catch (err) {
      showError(err);
      throw err;
    }
  };

  const handleCreateAgent = async (data: { name: string; cli: string; cwd?: string; role?: string; flags?: Agent['flags'] }) => {
    if (!selectedProjectId) return;
    try {
      await api.createAgent(selectedProjectId, data);
      setShowNewAgent(false);
      await loadAgents(selectedProjectId);
    } catch (err) {
      showError(err);
      throw err;
    }
  };

  const handleStartAgent = async (agent: Agent) => {
    try {
      await api.startAgent(agent.projectId, agent.id);
    } catch (err) {
      showError(err);
    }
    await loadAgents(agent.projectId);
  };
  const handleStopAgent = async (agent: Agent) => {
    try {
      await api.stopAgent(agent.projectId, agent.id);
    } catch (err) {
      showError(err);
    }
    await loadAgents(agent.projectId);
  };
  const handleRestartAgent = async (agent: Agent) => {
    try {
      await api.restartAgent(agent.projectId, agent.id);
    } catch (err) {
      showError(err);
    }
    // The daemon restarts asynchronously; refresh once it has had a moment.
    setTimeout(() => loadAgents(agent.projectId), 1000);
  };
  const handleDeleteAgent = async (agent: Agent) => {
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    try {
      await api.deleteAgent(agent.projectId, agent.id);
    } catch (err) {
      showError(err);
    }
    if (selectedAgentId === agent.id) setSelectedAgentId(null);
    if (activeGateAgent?.agentId === agent.id) setActiveGateAgent(null);
    await loadAgents(agent.projectId);
  };

  const handleResolveGate = async (decision: 'approve' | 'reject' | 'custom', customInput?: string) => {
    if (!activeGateAgent) return;
    const { projectId, agentId } = activeGateAgent;
    try {
      await api.resolveGate(projectId, agentId, decision, customInput);
    } catch (err) {
      // A 409 means the gate was already cleared elsewhere — just close.
      if (!(err instanceof Error && /No pending gate/.test(err.message))) throw err;
    }
    setActiveGateAgent(null);
    setAgents((prev) => {
      const next = new Map(prev);
      const list = next.get(projectId) || [];
      next.set(projectId, list.map((a) => a.id === agentId ? { ...a, pendingGate: undefined } : a));
      return next;
    });
  };

  const handleResolvePlan = async (decision: 'approve' | 'reject', reason?: string) => {
    if (!activePlan) return;
    const plan = activePlan;
    const r = await api.resolvePlan(plan.projectId, plan.id, decision, reason);
    setPlans((prev) => prev.filter((p) => p.id !== plan.id));
    if (decision === 'approve' && !r.delivered) setToast(r.note || 'The target agent is not running — nothing was sent.');
  };

  /**
   * Delete a project.
   *
   * This existed and was reachable from nowhere — no button, no menu item, no
   * palette command — so the only way to remove a project was the REST API.
   * It now takes the project to delete rather than assuming the selected one,
   * because the sidebar deletes the row you are pointing at, which is not
   * always the one that is open.
   */
  const handleDeleteProject = async (target?: Project) => {
    const project = target || projects.find((p) => p.id === selectedProjectId);
    if (!project) return;
    if (!confirm(`Delete project "${project.name}"? Running agents will be stopped.`)) return;
    const removeData = confirm(
      `Also remove "${project.name}" shared content and wiki data?\n\n`
      + 'OK removes them permanently. Cancel keeps the files and deletes only the project.',
    );
    try {
      await api.deleteProject(project.id, removeData);
    } catch (err) {
      showError(err);
      return;
    }
    // Only clear the selection if it was the project we just removed.
    if (project.id === selectedProjectId) {
      setSelectedProjectId(null);
      setSelectedAgentId(null);
    }
    await loadProjects();
  };

  const handleStartAll = async (projectId?: string) => {
    const pid = projectId || selectedProjectId;
    if (!pid) return;
    const list = agents.get(pid) || [];
    const stopped = list.filter((a) => a.status === 'stopped');
    const results = await Promise.allSettled(stopped.map((a) => api.startAgent(pid, a.id)));
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (failed.length) showError(failed[0].reason);
    await loadAgents(pid);
  };

  const handleStopAll = async (projectId?: string) => {
    const pid = projectId || selectedProjectId;
    if (!pid) return;
    const list = agents.get(pid) || [];
    // Stop everything that is alive — running, awaiting_input, or idle
    const alive = list.filter((a) => a.status !== 'stopped');
    await Promise.allSettled(alive.map((a) => api.stopAgent(pid, a.id)));
    await loadAgents(pid);
  };

  // Fire a one-off command at the orchestrator brain straight from the header,
  // without opening the Command drawer.
  const fireQuickCmd = (textArg?: string) => {
    const text = (textArg ?? quickCmd).trim();
    if (!text || brainWorking) return;
    if (!ws.send({ type: 'brain:send', message: text })) {
      setToast('Not connected to Conduit yet — try again in a moment.');
      return;
    }
    setQuickCmd('');
    brainBusyRef.current = true;
    setBrainWorking(true);
  };

  // Voice input for the header quick-command box — speak, and on a final
  // result fire it automatically (no manual send).
  const quickSpeech = useSpeechInput(
    (text, final) => { setQuickCmd(text); if (final && text.trim()) fireQuickCmd(text); },
    { provider: voice.cfg.stt.provider, language: voice.cfg.stt.language },
  );
  // Keep toggle reachable from the global keydown listener without forcing it
  // to re-bind on every render.
  const quickSpeechRef = useRef(quickSpeech);
  useEffect(() => { quickSpeechRef.current = quickSpeech; });

  // --- executing a spoken command ------------------------------------
  // A voice command must never vanish. fireQuickCmd returns early while the
  // Keeper is busy, which is invisible when you are not looking at the screen,
  // so the Keeper path queues instead — newest wins, because a stale spoken
  // command executing minutes later is worse than dropping it.
  const pendingKeeperCmd = useRef<string | null>(null);
  const brainWorkingRef = useRef(brainWorking);
  useEffect(() => { brainWorkingRef.current = brainWorking; }, [brainWorking]);

  const sendToKeeper = useCallback((text: string): string | void => {
    if (brainWorkingRef.current) {
      pendingKeeperCmd.current = text;
      return "The Keeper is still working — I'll send that when it's free.";
    }
    if (!ws.send({ type: 'brain:send', message: text })) {
      return 'Not connected to Conduit yet.';
    }
    brainBusyRef.current = true;
    setBrainWorking(true);
  }, [ws]);

  // Flush a queued command once the Keeper frees up.
  useEffect(() => {
    if (brainWorking || !pendingKeeperCmd.current) return;
    const text = pendingKeeperCmd.current;
    pendingKeeperCmd.current = null;
    sendToKeeper(text);
  }, [brainWorking, sendToKeeper]);

  /**
   * Run one routed voice command and return what should be said back.
   *
   * Note there is no 'approve' branch: `Route` cannot express one, so a single
   * misheard word on this path can never authorise a destructive action. The
   * live Nova session reaches approval through a different door entirely —
   * `src/voice/approval-guard.ts`, server-side, with four conditions — and not
   * through here.
   */
  const dispatchVoiceRoute = useCallback(async (route: Route): Promise<string | void> => {
    if (route.kind === 'keeper') return sendToKeeper(route.text);

    if (route.kind === 'agent') {
      // Reuse the server's own @mention routing, addressing by id: findAgent
      // tries an exact id first, and a uuid survives the @-token regex where
      // a name containing a space would not.
      try {
        await api.sendGroupChat(route.projectId, `@${route.agentId} ${route.text}`);
        return `Sent to ${route.agentName}.`;
      } catch (err) {
        return `Could not reach ${route.agentName}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (route.kind === 'control' && route.action === 'reject-gate') {
      if (!activeGateAgent) return 'Nothing is waiting for a decision.';
      try {
        await api.resolveGate(activeGateAgent.projectId, activeGateAgent.agentId, 'reject');
        return 'Rejected.';
      } catch (err) {
        return `Could not reject: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (route.kind === 'control' && route.action === 'status') {
      const waiting = awaitingNotifs.length;
      const parts = [`${globalCounts.running} running`];
      if (waiting) parts.push(`${waiting} waiting for you`);
      if (globalCounts.idle) parts.push(`${globalCounts.idle} idle`);
      return parts.join(', ') + '.';
    }
  }, [sendToKeeper, activeGateAgent, awaitingNotifs, globalCounts]);

  // Hands-free conversation. The wake phrase opens it, a spoken greeting
  // acknowledges it, and it stays open for follow-ups until you go quiet.
  // Push-to-talk and the session share one microphone, so the session pauses
  // while the user is holding the header mic.
  // Switching the wake word on is a statement of intent: listen for the
  // phrase. Gating that on the engine meant choosing a more accurate
  // recogniser silently turned the feature off, which is not a trade the user
  // ever agreed to. A cloud engine only uploads actual speech (the energy gate
  // discards silence) and useWakeWord caps the rate, so the cost of leaving it
  // on is bounded.
  // Nova is already listening when the live engine is on. Running the wake
  // word too means two microphones, two VADs, and a per-utterance STT bill for
  // audio nobody uses.
  const liveEngine = voice.cfg.engine === 'live';
  const alwaysOn = wakeEnabled && !liveEngine;

  /**
   * How many agents are blocked on an approval right now.
   *
   * Gates queue correctly — resolving one opens the next — but only one is
   * ever on screen, so with several agents working in parallel there was no
   * way to tell whether one was waiting or five were.
   */
  const pendingGateCount = useMemo(() => {
    let n = 0;
    for (const list of agents.values()) {
      for (const a of list) if (a.pendingGate && a.status !== 'stopped') n += 1;
    }
    return n;
  }, [agents]);

  /** Flat roster across every project, for addressing an agent by name. */
  const voiceRoster: RosterAgent[] = useMemo(() => {
    const out: RosterAgent[] = [];
    for (const [pid, list] of agents) {
      for (const a of list) out.push({ id: a.id, name: a.name, role: a.role, cli: a.cli, projectId: pid });
    }
    return out;
  }, [agents]);

  const voiceSession = useVoiceSession({
    enabled: wakeEnabled && !liveEngine && !quickSpeech.listening,
    phrase: wakePhrase,
    language: voice.cfg.stt.language,
    provider: voice.cfg.stt.provider,
    ttsCfg: { ...voice.cfg.tts, language: voice.cfg.stt.language },
    agents: voiceRoster,
    selectedProjectId,
    gateOpen: !!activeGateAgent,
    alwaysOn,
    onRoute: (route) => dispatchVoiceRoute(route),
    onUnavailable: (reason) => {
      setWakeEnabled(false);
      setToast(`Hands-free off — ${reason}`);
    },
  });
  const wake = {
    supported: voiceSession.supported,
    armed: voiceSession.armed,
    listening: voiceSession.listening,
  };
  const voiceSessionRef = useRef(voiceSession);
  useEffect(() => { voiceSessionRef.current = voiceSession; });

  // Speak the things that were previously visual-only: a gate blocking an
  // agent, an agent that started waiting, and errors.
  const gatedAgentForVoice = useMemo(() => {
    if (!activeGateAgent) return null;
    const list = agents.get(activeGateAgent.projectId) || [];
    const a = list.find((x) => x.id === activeGateAgent.agentId);
    if (!a?.pendingGate) return null;
    return {
      agentName: a.name,
      projectName: projects.find((p) => p.id === activeGateAgent.projectId)?.name,
      prompt: a.pendingGate.prompt,
      source: a.pendingGate.source,
    };
  }, [activeGateAgent, agents, projects]);

  const announcerAgents = useMemo(
    () => voiceRoster.map((r) => {
      const list = agents.get(r.projectId) || [];
      const a = list.find((x) => x.id === r.id);
      return { id: r.id, name: r.name, status: a?.status || 'stopped', projectId: r.projectId };
    }),
    [voiceRoster, agents],
  );

  /**
   * The live Keeper.
   *
   * Only opens when the setting says so, so an install without AWS access —
   * or anyone who prefers the old path — sees no change at all. When it is
   * live, the pipeline's wake word and announcer stand down: Nova is already
   * listening, and two things speaking at once is worse than either.
   */
  const liveVoice = useRealtimeVoice({
    // `wakeEnabled` is the microphone switch in the HUD, and the live session
    // used to ignore it completely — it checked only that the engine was set
    // to live. Turning the mic off stopped the wake word (which is already
    // stood down on this path) and left Nova holding an open microphone,
    // streaming whatever it heard, with the UI showing the mic as off.
    //
    // The switch now means the same thing on both paths: off is off.
    enabled: voice.cfg.engine === 'live' && wakeEnabled,
    onDeferred: (text) => {
      // An agent answering minutes after it was asked. This is the gap the
      // pipeline never closed — it said "Sent to Claude" and stopped there.
      setToast(text.slice(0, 300));
      if (voiceOut) speak(text, { ...voice.cfg.tts, language: voice.cfg.stt.language });
    },
  });

  useVoiceAnnouncer({
    enabled: !liveEngine && voiceOut && voice.cfg.tts.enabled,
    ttsCfg: { ...voice.cfg.tts, language: voice.cfg.stt.language },
    agents: announcerAgents,
    gate: gatedAgentForVoice,
    error: toast,
    userSpeaking: voiceSession.state === 'listening',
  });
  useEffect(() => {
    localStorage.setItem('conduit:wake', wakeEnabled ? '1' : '0');
  }, [wakeEnabled]);
  useEffect(() => {
    localStorage.setItem('conduit:wake-phrase', wakePhrase);
  }, [wakePhrase]);

  // --- spoken output -------------------------------------------------
  useEffect(() => {
    localStorage.setItem('conduit:voice-out', voiceOut ? '1' : '0');
    if (!voiceOut) stopSpeaking();
  }, [voiceOut]);

  // Speak each new Keeper reply. `distill` runs the 🔊/two-sentence
  // extraction that only makes sense for a model reply.
  const lastSpokenTsRef = useRef(0);
  useEffect(() => {
    if (!brainReply || !voiceOut) return;
    if (brainReply.ts === lastSpokenTsRef.current) return;
    lastSpokenTsRef.current = brainReply.ts;
    speak(brainReply.text, { ...voice.cfg.tts, language: voice.cfg.stt.language }, { distill: true });
    voiceSessionRef.current?.reportReply(brainReply.text);
  }, [brainReply, voiceOut, voice.cfg]);

  // A new Keeper turn cuts off whatever is still playing.
  useEffect(() => {
    if (brainWorking) stopSpeaking();
  }, [brainWorking]);

  const logoImg = logoDark;

  const [tourForceStart, setTourForceStart] = useState(false);
  const [isDownloadOpen, setIsDownloadOpen] = useState(false);

  const ensureDemoWorkspace = useCallback(() => {
    if (projects.length > 0 && !selectedProjectId) {
      setSelectedProjectId(projects[0].id);
      loadAgents(projects[0].id);
    }
  }, [projects, selectedProjectId, loadAgents]);

  /**
   * Keep the view and the URL in step.
   *
   * `handleViewChange` writes `#console` into the address bar, which pushes a
   * history entry — but nothing was listening for it coming back. Pressing the
   * browser's Back button changed the URL to `/` and left the console on
   * screen; pressing it again left the site entirely, from a page that had
   * never appeared to move. Measured: hash "" with the console still rendered.
   *
   * The desktop app has no landing page to go back to, so it opts out.
   */
  useEffect(() => {
    if (window.conduitDesktop?.isDesktop) return;
    const sync = () => setInConsole(window.location.hash === '#console');
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  const handleViewChange = useCallback((v: 'landing' | 'console') => {
    if (v === 'landing') {
      window.location.hash = '';
      setInConsole(false);
    } else {
      window.location.hash = '#console';
      setInConsole(true);
      ensureDemoWorkspace();
    }
  }, [ensureDemoWorkspace]);

  const handleStartTour = useCallback(() => {
    handleViewChange('landing');
    setTourForceStart(true);
  }, [handleViewChange]);

  const appCls = ['app'];
  if (sidebarCollapsed) appCls.push('sb-hidden');

  return (
    <>
      {!inConsole ? (
        <LandingPage
          onOpenConsole={() => {
            window.location.hash = '#console';
            setInConsole(true);
            ensureDemoWorkspace();
          }}
          onStartTour={handleStartTour}
        />
      ) : (
        <div className={appCls.join(' ')} style={{ '--sidebar-w': sidebarW + 'px' } as React.CSSProperties}>
      <div className="ambient-mesh" aria-hidden="true" />
      <header className="header">
        <div className="header-l">
          <button
            className="hbtn mobile-only"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            style={{ padding: '0 6px' }}
            aria-label="Toggle Navigation"
          >
            <Ic.menu size={16} />
          </button>
          <button
            className="hbtn sb-toggle desktop-only"
            title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            onClick={() => setSidebarCollapsed((c) => !c)}
          >
            {sidebarCollapsed ? <Ic.panelLeftOpen size={14} /> : <Ic.panelLeft size={14} />}
          </button>
          <div className="brand">
            <div className="brand-mark">
              <img src={logoImg} alt="Conduit" />
            </div>
            <span>Conduit</span>
          </div>
          {selectedProject && (
            <div className="breadcrumb" data-tour="workspace" title={selectedProject.cwd}>
              <span className="sep">/</span>
              <span className="proj">{selectedProject.name}</span>
            </div>
          )}
        </div>

        <div className="header-c desktop-only">
          <button className="header-search-btn" onClick={() => setPaletteOpen(true)} title="Command Search (⌘K)">
            <Ic.search size={13} />
            <span className="search-placeholder">Search commands, agents…</span>
            <kbd className="cmd-kbd">{MOD}K</kbd>
          </button>
        </div>

        <div className="header-r">
          <button className="hbtn icon-only mobile-only" onClick={() => setPaletteOpen(true)} title="Search (⌘K)">
            <Ic.search size={14} />
          </button>

          <button
            className="hbtn icon-only mobile-only"
            title="The Keeper (⌘J)"
            data-tour="keeper"
            onClick={() => setCommandOpen(true)}
          >
            <Ic.logo size={14} />
            {brainDone && <span className="cmd-trigger-dot" />}
          </button>

          <div className={'cmd-quick desktop-only' + (brainWorking ? ' working' : '')} data-tour="keeper">
            <button
              className="cmd-quick-mark"
              title="Open Command (⌘J)"
              onClick={() => setCommandOpen(true)}
            >
              <Ic.logo size={13} />
              {brainDone && <span className="cmd-trigger-dot" />}
            </button>
            <input
              className="cmd-quick-input"
              value={quickCmd}
              onChange={(e) => setQuickCmd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); fireQuickCmd(); }
              }}
              placeholder={brainWorking ? 'The Keeper is working…' : 'Ask The Keeper…'}
              disabled={brainWorking}
            />
            {quickSpeech.supported && (
              <button
                className={'cmd-quick-mic' + (quickSpeech.listening ? ' on' : '')}
                title={quickSpeech.error || (quickSpeech.listening ? 'Stop listening' : 'Voice input')}
                onClick={quickSpeech.toggle}
              >
                <Ic.mic size={13} />
              </button>
            )}
            <kbd className="cmd-kbd">{MOD}J</kbd>
          </div>

          <NotificationCenter
            notifs={awaitingNotifs}
            unread={notifUnread}
            onOpen={() => setNotifSeen(new Set(awaitingNotifs.map((n) => n.agentId)))}
            onSelect={handleSelectAgent}
          />

          {/* Compact Layout Picker Dropdown (Desktop) */}
          <div className="header-dropdown-wrap desktop-only" ref={layoutMenuRef}>
            <button
              className="hbtn layout-dropdown-btn"
              title="Switch Layout"
              onClick={() => setLayoutMenuOpen(!layoutMenuOpen)}
            >
              {(() => {
                const currentItem = LAYOUT_ICONS.find((item) => item.v === layout) || LAYOUT_ICONS[0];
                const IconComponent = currentItem.Icon;
                return <IconComponent size={13} />;
              })()}
              <span className="desktop-only layout-label">{LAYOUT_ICONS.find((item) => item.v === layout)?.title}</span>
              <Ic.chevDown size={10} />
            </button>
            {layoutMenuOpen && (
              <div className="header-dropdown-menu">
                <div className="dropdown-header">Workspace Layout</div>
                {LAYOUT_ICONS.map(({ v, Icon, title }) => (
                  <button
                    key={v}
                    className={'dropdown-item' + (layout === v ? ' active' : '')}
                    onClick={() => {
                      setLayout(v);
                      setLayoutMenuOpen(false);
                    }}
                  >
                    <Icon size={13} />
                    <span>{title}</span>
                    {layout === v && <span className="item-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Help & Utility Menu (Desktop) */}
          <div className="header-dropdown-wrap desktop-only" ref={helpMenuRef}>
            <button
              className="hbtn icon-only"
              title="Help & Resources"
              onClick={() => setHelpMenuOpen(!helpMenuOpen)}
            >
              <Ic.help size={14} />
            </button>
            {helpMenuOpen && (
              <div className="header-dropdown-menu right">
                <button
                  className="dropdown-item"
                  onClick={() => {
                    handleStartTour();
                    setHelpMenuOpen(false);
                  }}
                >
                  <Ic.sparkles size={13} />
                  <span>Product Tour</span>
                </button>
                <button
                  className="dropdown-item"
                  onClick={() => {
                    window.location.hash = '';
                    setInConsole(false);
                    setHelpMenuOpen(false);
                  }}
                >
                  <Ic.folder size={13} />
                  <span>Website & Overview</span>
                </button>
                <button
                  className="dropdown-item"
                  onClick={() => {
                    setPaletteOpen(true);
                    setHelpMenuOpen(false);
                  }}
                >
                  <Ic.search size={13} />
                  <span>Keyboard Shortcuts ({MOD}K)</span>
                </button>
              </div>
            )}
          </div>

          {/* Settings Button (Desktop) */}
          <button
            className="hbtn icon-only desktop-only"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Ic.settings size={14} />
          </button>

          {/* Mobile Actions Dropdown (Mobile) */}
          <div className="header-dropdown-wrap mobile-only" ref={mobileActionsRef}>
            <button
              className="hbtn icon-only"
              title="More Actions"
              onClick={() => setMobileActionsOpen(!mobileActionsOpen)}
            >
              <Ic.dots size={14} />
            </button>
            {mobileActionsOpen && (
              <div className="header-dropdown-menu right mobile-actions-menu">
                <div className="dropdown-header">Workspace Layout</div>
                {LAYOUT_ICONS.map(({ v, Icon, title }) => (
                  <button
                    key={v}
                    className={'dropdown-item' + (layout === v ? ' active' : '')}
                    onClick={() => {
                      setLayout(v);
                      setMobileActionsOpen(false);
                    }}
                  >
                    <Icon size={13} />
                    <span>{title}</span>
                    {layout === v && <span className="item-check">✓</span>}
                  </button>
                ))}
                <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
                <button
                  className="dropdown-item"
                  onClick={() => {
                    handleStartTour();
                    setMobileActionsOpen(false);
                  }}
                >
                  <Ic.sparkles size={13} />
                  <span>Product Tour</span>
                </button>
                <button
                  className="dropdown-item"
                  onClick={() => {
                    window.location.hash = '';
                    setInConsole(false);
                    setMobileActionsOpen(false);
                  }}
                >
                  <Ic.folder size={13} />
                  <span>Website & Overview</span>
                </button>
                <button
                  className="dropdown-item"
                  onClick={() => {
                    setSettingsOpen(true);
                    setMobileActionsOpen(false);
                  }}
                >
                  <Ic.settings size={13} />
                  <span>Settings</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <Sidebar
        projects={projects}
        agents={agents}
        selectedProjectId={selectedProjectId}
        selectedAgentId={selectedAgentId}
        onSelectProject={handleSelectProject}
        onSelectAgent={handleSelectAgent}
        onNewProject={() => setShowNewProject(true)}
        onNewAgent={() => setShowNewAgent(true)}
        onDeleteAgent={handleDeleteAgent}
        onDeleteProject={handleDeleteProject}
        onStartAll={handleStartAll}
        onStopAll={handleStopAll}
        onExpandProject={loadAgents}
        mobileOpen={mobileMenuOpen}
        onMobileClose={() => setMobileMenuOpen(false)}
      />
      <div className="sb-resizer" onMouseDown={onSidebarResizeDown} title="Drag to resize sidebar" />

      <section className="gr" data-tour="agents">
        <div className="canvas-frame" aria-hidden="true" />
        {selectedProjectId ? (
          <>
            <div className="gr-subbar">
              <div className="gr-tabs">
                <button
                  className={'gr-tab' + (mainTab === 'terminals' ? ' active' : '')}
                  onClick={() => setMainTab('terminals')}
                >
                  <Ic.terminal size={12} /> Terminals
                  <span className="count">{projectAgents.length}</span>
                </button>
                <button
                  className={'gr-tab' + (mainTab === 'messages' ? ' active' : '')}
                  onClick={() => setMainTab('messages')}
                >
                  <Ic.message size={12} /> MCP Messages
                </button>
                <button
                  className={'gr-tab' + (mainTab === 'groupchat' ? ' active' : '')}
                  onClick={() => setMainTab('groupchat')}
                >
                  <Ic.message size={12} /> Group Chat
                </button>
                <button
                  className={'gr-tab' + (mainTab === 'shared' ? ' active' : '')}
                  onClick={() => setMainTab('shared')}
                >
                  <Ic.folder size={12} /> Shared
                </button>
                <button
                  className={'gr-tab' + (mainTab === 'wiki' ? ' active' : '')}
                  onClick={() => setMainTab('wiki')}
                >
                  <Ic.book size={12} /> Wiki
                </button>
                <button
                  className={'gr-tab' + (mainTab === 'activity' ? ' active' : '')}
                  onClick={() => setMainTab('activity')}
                >
                  <Ic.activity size={12} /> Activity
                </button>
                <button
                  className={'gr-tab' + (mainTab === 'usage' ? ' active' : '')}
                  onClick={() => setMainTab('usage')}
                >
                  <Ic.activity size={12} /> Usage
                </button>
              </div>
              <div className="gr-subbar-r">
                {mainTab === 'terminals' && projectAgents.length > 0 && (
                  <>
                    <button
                      className="batch-btn"
                      onClick={() => handleStartAll()}
                      disabled={stoppedCount === 0}
                    >
                      <Ic.play size={10} /> Start all
                    </button>
                    <button
                      className="batch-btn"
                      onClick={() => handleStopAll()}
                      disabled={aliveCount === 0}
                    >
                      <Ic.stop size={9} /> Stop all
                    </button>
                  </>
                )}
                <button className="batch-btn primary" onClick={() => setShowNewAgent(true)}>
                  <Ic.plus size={11} /> New agent
                </button>
              </div>
            </div>

            {mainTab === 'terminals' && projectAgents.length > 1 && (
              <div className="mobile-agent-strip mobile-only" aria-label="Quick Agent Switcher">
                {projectAgents.map((a) => {
                  const isSelected = a.id === selectedAgentId;
                  return (
                    <button
                      key={a.id}
                      className={'mobile-agent-pill' + (isSelected ? ' active' : '')}
                      onClick={() => setSelectedAgentId(a.id)}
                    >
                      <span className={'sdot ' + a.status} style={{ width: 6, height: 6 }} />
                      <span className="mobile-agent-pill-name">{a.name}</span>
                      <span className="mobile-agent-pill-cli">{a.cli}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {mainTab === 'terminals' && (
              <AgentGrid
                key={selectedProjectId}
                agents={projectAgents}
                layout={layout}
                focusedId={selectedAgentId}
                onFocus={setSelectedAgentId}
                onStart={handleStartAgent}
                onStop={handleStopAgent}
                onRestart={handleRestartAgent}
                onDelete={handleDeleteAgent}
                ws={ws}
                projectId={selectedProjectId}
              />
            )}
            {mainTab === 'messages' && (
              <MessagesPanel key={selectedProjectId} projectId={selectedProjectId} agents={projectAgents} ws={ws} />
            )}
            {mainTab === 'groupchat' && (
              <GroupChat key={selectedProjectId} projectId={selectedProjectId} agents={projectAgents} ws={ws} />
            )}
            {mainTab === 'shared' && (
              <SharedContentView key={selectedProjectId} projectId={selectedProjectId} refreshTrigger={contentRefresh} />
            )}
            {mainTab === 'wiki' && <ProjectWiki key={selectedProjectId} projectId={selectedProjectId} />}
            {mainTab === 'activity' && <ActivityFeed key={selectedProjectId} projectId={selectedProjectId} ws={ws} />}
            {mainTab === 'usage' && <UsagePanel />}
          </>
        ) : (
          <div className="panel-empty" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
            <div>Select or create a project to get started</div>
            <button className="batch-btn primary" onClick={() => setShowNewProject(true)}>
              <Ic.plus size={11} /> New Project
            </button>
          </div>
        )}
      </section>

      <footer className="st">
        <div className="st-l" data-tour="supervisor">
          {selectedProjectId ? (
            <div className="st-counts">
              <span className="st-count-item running">
                <span className="sdot running" style={{ width: 6, height: 6 }} />
                <span>{runningCount} running</span>
              </span>
              <span className="st-dot-sep">·</span>
              {awaitingCount > 0 && (
                <>
                  <span className="st-count-item awaiting">
                    <span className="sdot awaiting_input" style={{ width: 6, height: 6 }} />
                    <span>{awaitingCount} awaiting you</span>
                  </span>
                  <span className="st-dot-sep">·</span>
                </>
              )}
              {idleCount > 0 && (
                <>
                  <span className="st-count-item idle">
                    <span className="sdot idle" style={{ width: 6, height: 6 }} />
                    <span>{idleCount} idle</span>
                  </span>
                  <span className="st-dot-sep">·</span>
                </>
              )}
              <span className="st-count-item stopped">
                <span className="sdot stopped" style={{ width: 6, height: 6 }} />
                <span>{stoppedCount} stopped</span>
              </span>
            </div>
          ) : (
            <span className="st-count-item stopped">Select a workspace</span>
          )}
        </div>
        <div className="st-r">
          <div className="st-shortcuts-wrap" ref={shortcutsRef}>
            <button
              className="st-shortcuts-btn"
              title="Keyboard shortcuts"
              onClick={() => setShortcutsOpen(!shortcutsOpen)}
            >
              <span>Shortcuts</span>
              <Ic.chevDown size={9} />
            </button>
            {shortcutsOpen && (
              <div className="st-shortcuts-popover">
                <div className="st-shortcuts-header">Keyboard Shortcuts</div>
                <div className="st-shortcuts-list">
                  <div className="st-shortcut-row"><span>Search & Palette</span><kbd>{MOD}K</kbd></div>
                  <div className="st-shortcut-row"><span>The Keeper</span><kbd>{MOD}J</kbd></div>
                  <div className="st-shortcut-row"><span>Voice Input</span><kbd>{MOD};</kbd></div>
                  <div className="st-shortcut-row"><span>Select Agent</span><kbd>{MOD}1-9</kbd></div>
                  <div className="st-shortcut-row"><span>Start Agent</span><kbd>{MOD}Enter</kbd></div>
                </div>
              </div>
            )}
          </div>

          <span
            className={'st-item ' + (ws.connected ? 'ok' : 'err')}
            title={ws.connected ? 'Live connection to the Conduit server' : 'Reconnecting to the Conduit server…'}
          >
            <span className={'sdot ' + (ws.connected ? 'running' : 'stopped')} style={{ width: 6, height: 6 }} />
            <span>{ws.connected ? 'connected' : 'reconnecting…'}</span>
          </span>
          {ws.connected && !ws.daemon && (
            <span className="st-item err" title="The agent daemon is not reachable. Start it with: npm run daemon">
              daemon offline
            </span>
          )}
        </div>
      </footer>

      {/* Mobile Bottom Navigation Bar (≤ 640px) */}
      <nav className="mobile-bottom-nav mobile-only" aria-label="Mobile Navigation">
        <button
          className={'mobile-nav-item' + (mainTab === 'terminals' ? ' active' : '')}
          onClick={() => { setMainTab('terminals'); setMobileMoreTabsOpen(false); }}
        >
          <Ic.terminal size={18} />
          <span>Terminals</span>
          {projectAgents.length > 0 && <span className="mobile-nav-badge">{projectAgents.length}</span>}
        </button>
        <button
          className={'mobile-nav-item' + (mainTab === 'groupchat' ? ' active' : '')}
          onClick={() => { setMainTab('groupchat'); setMobileMoreTabsOpen(false); }}
        >
          <Ic.message size={18} />
          <span>Chat</span>
        </button>
        <button
          className={'mobile-nav-item' + (mainTab === 'messages' ? ' active' : '')}
          onClick={() => { setMainTab('messages'); setMobileMoreTabsOpen(false); }}
        >
          <Ic.bolt size={18} />
          <span>MCP</span>
        </button>
        <button
          className={'mobile-nav-item' + (mainTab === 'activity' ? ' active' : '')}
          onClick={() => { setMainTab('activity'); setMobileMoreTabsOpen(false); }}
        >
          <Ic.activity size={18} />
          <span>Activity</span>
        </button>
        <div className="mobile-nav-more-wrap" ref={mobileMoreTabsRef}>
          <button
            className={'mobile-nav-item' + (['shared', 'wiki', 'usage'].includes(mainTab) ? ' active' : '')}
            onClick={() => setMobileMoreTabsOpen(!mobileMoreTabsOpen)}
          >
            <Ic.dots size={18} />
            <span>More</span>
          </button>
          {mobileMoreTabsOpen && (
            <div className="mobile-nav-more-popover">
              <button
                className={'more-pop-item' + (mainTab === 'shared' ? ' active' : '')}
                onClick={() => { setMainTab('shared'); setMobileMoreTabsOpen(false); }}
              >
                <Ic.folder size={15} />
                <span>Shared Files</span>
              </button>
              <button
                className={'more-pop-item' + (mainTab === 'wiki' ? ' active' : '')}
                onClick={() => { setMainTab('wiki'); setMobileMoreTabsOpen(false); }}
              >
                <Ic.book size={15} />
                <span>Workspace Wiki</span>
              </button>
              <button
                className={'more-pop-item' + (mainTab === 'usage' ? ' active' : '')}
                onClick={() => { setMainTab('usage'); setMobileMoreTabsOpen(false); }}
              >
                <Ic.activity size={15} />
                <span>API Usage</span>
              </button>
            </div>
          )}
        </div>
      </nav>

      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        agents={projectAgents}
        onSelectAgent={setSelectedAgentId}
        onLayout={setLayout}
        onNewProject={() => setShowNewProject(true)}
        onNewAgent={() => setShowNewAgent(true)}
        onStartAll={selectedProjectId ? () => handleStartAll() : undefined}
        onStopAll={selectedProjectId ? () => handleStopAll() : undefined}
        onDeleteProject={selectedProjectId ? () => handleDeleteProject() : undefined}
        currentProjectName={projects.find((p) => p.id === selectedProjectId)?.name}
        onStartTour={handleStartTour}
      />

      <CommandPanel
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        ws={ws}
        sttCfg={{ provider: voice.cfg.stt.provider, language: voice.cfg.stt.language }}
      />

      {!commandOpen && (
        <JarvisHud
          send={(m) => { ws.send(m); }}
          working={brainWorking}
          lastReply={brainReply}
          onClearReply={() => setBrainReply(null)}
          sttCfg={{ provider: voice.cfg.stt.provider, language: voice.cfg.stt.language }}
          voiceOut={voiceOut}
          onToggleVoiceOut={() => setVoiceOut((v) => !v)}
          headerListening={quickSpeech.listening}
          live={{
            status: liveVoice.status,
            speaking: liveVoice.speaking,
            hearing: liveVoice.hearing,
            error: liveVoice.error,
          }}
          wake={{
            enabled: wakeEnabled,
            supported: wake.supported,
            armed: wake.armed,
            phrase: wakePhrase,
            onToggle: () => setWakeEnabled((v) => !v),
            onPhraseChange: setWakePhrase,
          }}
          awaiting={awaitingNotifs}
          running={globalCounts.running}
          idle={globalCounts.idle}
          onSelectAgent={handleSelectAgent}
          onOpenFull={() => setCommandOpen(true)}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={voice.refresh}
        onRestartTour={handleStartTour}
      />

      {showNewProject && (
        <CreateProjectModal
          initialCwd={pickedCwd || undefined}
          onClose={() => { setShowNewProject(false); setPickedCwd(null); }}
          onCreate={handleCreateProject}
        />
      )}
      {showNewAgent && selectedProject && (
        <CreateAgentModal
          projectCwd={selectedProject.cwd}
          onClose={() => setShowNewAgent(false)}
          onCreate={handleCreateAgent}
        />
      )}
      {activeGateAgent && (() => {
        const gatedAgent = agents.get(activeGateAgent.projectId)?.find(a => a.id === activeGateAgent.agentId);
        return (
          <GateModal
            project={projects.find(p => p.id === activeGateAgent.projectId)}
            agent={gatedAgent}
            gate={gatedAgent?.pendingGate}
            queued={pendingGateCount}
            onClose={() => setActiveGateAgent(null)}
            onResolve={handleResolveGate}
          />
        );
      })()}
      {activePlan && (
        <PlanModal
          key={activePlan.id}
          project={projects.find(p => p.id === activePlan.projectId)}
          plan={activePlan}
          queued={plans.filter((p) => !planDismissed.has(p.id)).length - 1}
          onClose={() => setPlanDismissed((prev) => new Set(prev).add(activePlan.id))}
          onResolve={handleResolvePlan}
        />
      )}
      </div>
      )}

      <ConduitOnboardingTour
        forceStart={tourForceStart}
        onClose={() => setTourForceStart(false)}
        onViewChange={handleViewChange}
        onTabChange={(t) => setMainTab(t)}
        onEnsureDemoWorkspace={ensureDemoWorkspace}
        onOpenDownloadModal={() => setIsDownloadOpen(true)}
        onCloseDownloadModal={() => setIsDownloadOpen(false)}
      />
      <DownloadModal isOpen={isDownloadOpen} onClose={() => setIsDownloadOpen(false)} />
    </>
  );
}
