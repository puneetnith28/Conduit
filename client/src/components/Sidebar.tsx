import { useState, useEffect } from 'react';
import type { Project, Agent } from '../api';
import Ic, { MOD } from './Icons';
import { agentHue } from '../utils/agentIdentity';
import claudeIcon from '../assets/claude.svg';
import codexIcon from '../assets/codex.svg';

interface Props {
  projects: Project[];
  agents: Map<string, Agent[]>;
  selectedProjectId: string | null;
  selectedAgentId: string | null;
  onSelectProject: (id: string) => void;
  onSelectAgent: (projectId: string, agentId: string) => void;
  onNewProject: () => void;
  onNewAgent: () => void;
  onDeleteAgent: (agent: Agent) => void;
  onDeleteProject: (project: Project) => void;
  onStartAll: (projectId: string) => void;
  onStopAll: (projectId: string) => void;
  onExpandProject: (projectId: string) => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

function formatResetTime(resetsAt: string | null): string {
  if (!resetsAt) return '';
  const reset = new Date(resetsAt);
  const now = new Date();
  const diffMs = reset.getTime() - now.getTime();
  if (diffMs <= 0) return 'now';
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return diffMins + 'm';
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return diffHrs + 'h ' + (diffMins % 60) + 'm';
  const diffDays = Math.floor(diffHrs / 24);
  return diffDays + 'd';
}

function UsageRow({
  label, pct, color, resetsAt,
}: { label: string; pct: number | null; color: string; resetsAt?: string | null }) {
  if (pct === null) return null;
  const reset = formatResetTime(resetsAt || null);
  return (
    <>
      <div className="sb-usage-row">
        <span className="sb-usage-label">{label}</span>
        <div className="sb-usage-pct">
          {Math.round(pct)}%
          {reset && <span className="reset">· resets {reset}</span>}
        </div>
      </div>
      <div className="sb-usage-bar">
        <div className="sb-usage-fill" style={{ width: Math.min(100, pct) + '%', background: color }} />
      </div>
    </>
  );
}

function UsageTitle({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="sb-usage-title">
      <img src={icon} alt={label} className="sb-usage-ic" />
      {label}
    </div>
  );
}

export default function Sidebar({
  projects, agents, selectedProjectId, selectedAgentId,
  onSelectProject, onSelectAgent, onNewProject, onNewAgent,
  onDeleteAgent, onDeleteProject, onExpandProject,
  mobileOpen, onMobileClose,
}: Props) {
  const [usageData, setUsageData] = useState<{
    claude: { session: number | null; sessionResets: string | null; week: number | null; weekResets: string | null } | null;
    codex: { session: number | null; sessionResets: string | null; week: number | null; weekResets: string | null } | null;
  }>({ claude: null, codex: null });

  useEffect(() => {
    const fetchUsage = () => {
      fetch('/api/usage').then(r => r.json()).then(data => {
        setUsageData({
          claude: data.claude ? {
            session: data.claude.session?.utilization ?? null,
            sessionResets: data.claude.session?.resetsAt ?? null,
            week: data.claude.week?.utilization ?? null,
            weekResets: data.claude.week?.resetsAt ?? null,
          } : null,
          codex: data.codex ? {
            session: data.codex.session?.utilization ?? null,
            sessionResets: data.codex.session?.resetsAt ?? null,
            week: data.codex.week?.utilization ?? null,
            weekResets: data.codex.week?.resetsAt ?? null,
          } : null,
        });
      }).catch(() => {});
    };
    fetchUsage();
    const interval = setInterval(fetchUsage, 60000);
    return () => clearInterval(interval);
  }, []);

  const handleSelectProject = (id: string) => {
    onSelectProject(id);
    onExpandProject(id);
  };

  const handleSelectAgent = (projectId: string, agentId: string) => {
    onSelectAgent(projectId, agentId);
    onMobileClose();
  };

  const selProj = projects.find(p => p.id === selectedProjectId);
  const projectAgents = selectedProjectId ? agents.get(selectedProjectId) || [] : [];

  return (
    <>
      {mobileOpen && <div className="sb-scrim" onClick={onMobileClose} />}
      <aside className={`sb ${mobileOpen ? 'mobile-open' : ''}`}>
        {mobileOpen && (
          <div className="sb-mobile-head mobile-only">
            <span className="sb-mobile-title">Workspace & Agents</span>
            <button className="sb-mobile-close" onClick={onMobileClose} aria-label="Close sidebar">
              <Ic.x size={14} />
            </button>
          </div>
        )}
        <div className="sb-section-h">
          <span>Projects</span>
          <button className="add" onClick={onNewProject} title="New project"><Ic.plus size={13} /></button>
        </div>
        <div className="sb-projects" data-tour="workspace">
          {projects.map(p => {
            const list = agents.get(p.id) || [];
            // "alive" = process exists (running / awaiting_input / idle)
            const aliveCount = list.filter(a => a.status !== 'stopped').length;
            const isActive = p.id === selectedProjectId;
            return (
              <button
                key={p.id}
                className={'sb-project' + (isActive ? ' active' : '')}
                onClick={() => handleSelectProject(p.id)}
              >
                <div className="name-row">
                  <Ic.folder size={14} className="sb-proj-ic" />
                  <span className="n">{p.name}</span>
                  {aliveCount > 0
                    ? <span className="running-chip">{aliveCount}/{list.length}</span>
                    : <span className="total-chip">{list.length}</span>}
                  {/* A span, not a button: this row is itself a <button> and
                      nesting one inside another is invalid and unclickable in
                      some browsers. Same shape as the agent delete above. */}
                  <span
                    className="sb-project-delete"
                    role="button"
                    tabIndex={0}
                    aria-label={`Delete project ${p.name}`}
                    title="Delete project"
                    onClick={(e) => { e.stopPropagation(); onDeleteProject(p); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault(); e.stopPropagation(); onDeleteProject(p);
                      }
                    }}
                  >
                    <Ic.x size={11} />
                  </span>
                </div>
              </button>
            );
          })}
          {projects.length === 0 && (
            <div style={{ padding: '16px 10px', color: 'var(--text-3)', fontSize: 12, textAlign: 'center' }}>
              No projects yet
            </div>
          )}
        </div>

        <div className="sb-section-h" style={{ marginTop: 6 }}>
          <span>Agents</span>
          {selProj && (
            <button className="add" onClick={onNewAgent} title="Add agent"><Ic.plus size={13} /></button>
          )}
        </div>

        <div className="sb-agents-wrap">
          {projectAgents.map((a, i) => {
            const hue = agentHue(a.name);
            const isActive = a.id === selectedAgentId;
            return (
              <button
                key={a.id}
                className={'sb-agent' + (isActive ? ' active' : '')}
                onClick={() => handleSelectAgent(a.projectId, a.id)}
                style={{ '--accent-color': hue } as React.CSSProperties}
                aria-current={isActive ? 'true' : undefined}
              >
                <span className="sb-agent-st">
                  {a.pendingGate ? (
                    <span className="sdot" style={{ background: 'var(--err)', boxShadow: '0 0 4px var(--err)' }} title="Gate Pending" />
                  ) : (
                    <span className={'sdot ' + a.status} />
                  )}
                </span>
                <div className="sb-agent-content">
                  <div className="sb-agent-title-row">
                    <span className="nm">{a.name}</span>
                  </div>
                  <div className="sb-agent-sub-row">
                    <span
                      className="cli-tag"
                      style={{
                        // Darkened for the same reason as the pane header's
                        // tag — see AgentGrid. 9px of the raw hue is 3.05:1.
                        color: `color-mix(in oklab, ${hue} 62%, #000)`,
                        background: `color-mix(in oklab, ${hue} 14%, transparent)`,
                      }}
                    >
                      {a.cli}
                    </span>
                    {(a.role || a.cwd) && (
                      <span className="sub">{a.role || a.cwd}</span>
                    )}
                  </div>
                </div>
                <div className="meta">
                  {i < 9 && <span className="num">{MOD}{i + 1}</span>}
                  <span
                    className="sb-agent-delete"
                    role="button"
                    tabIndex={0}
                    aria-label={`Delete ${a.name}`}
                    onClick={(e) => { e.stopPropagation(); onDeleteAgent(a); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onDeleteAgent(a); } }}
                    title="Delete agent"
                  >
                    <Ic.x size={11} />
                  </span>
                </div>
              </button>
            );
          })}
          {selProj && projectAgents.length === 0 && (
            <div style={{ padding: '14px 10px', color: 'var(--text-3)', fontSize: 11.5, textAlign: 'center' }}>
              No agents yet
            </div>
          )}
          {!selProj && (
            <div style={{ padding: '14px 10px', color: 'var(--text-3)', fontSize: 11.5, textAlign: 'center' }}>
              Select a project above
            </div>
          )}
        </div>

        {(usageData.claude || usageData.codex) && (
          <div className="sb-usage">
            {usageData.claude && (
              <>
                <UsageTitle icon={claudeIcon} label="Claude" />
                <UsageRow
                  label="Session"
                  pct={usageData.claude.session}
                  color="var(--accent)"
                  resetsAt={usageData.claude.sessionResets}
                />
                <UsageRow
                  label="Week"
                  pct={usageData.claude.week}
                  color="var(--accent)"
                  resetsAt={usageData.claude.weekResets}
                />
              </>
            )}
            {usageData.codex && (
              <div style={usageData.claude ? { marginTop: 10 } : undefined}>
                <UsageTitle icon={codexIcon} label="Codex" />
                <UsageRow
                  label="Session"
                  pct={usageData.codex.session}
                  color="oklch(70% 0.12 300)"
                  resetsAt={usageData.codex.sessionResets}
                />
                <UsageRow
                  label="Week"
                  pct={usageData.codex.week}
                  color="oklch(70% 0.12 300)"
                  resetsAt={usageData.codex.weekResets}
                />
              </div>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
