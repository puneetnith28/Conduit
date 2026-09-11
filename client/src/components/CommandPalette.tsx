/**
 * Command palette — ⌘K/Ctrl+K. Fuzzy-filter a list of commands and run.
 * Commands: go-to-agent, layout switch, theme switch, project/agent actions.
 */

import { useState, useEffect, useRef, Fragment } from 'react';
import Ic, { MOD } from './Icons';
import type { Agent } from '../api';
import type { GridLayout } from './AgentGrid';


interface Command {
  group: string;
  icon: React.ReactNode;
  label: string;
  sub?: string;
  hint?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  onSelectAgent: (id: string) => void;
  onLayout: (v: GridLayout) => void;

  onNewProject: () => void;
  onNewAgent: () => void;
  onStartAll?: () => void;
  onStopAll?: () => void;
  onStartTour?: () => void;
  /** Absent when no project is open — there is then nothing to delete. */
  onDeleteProject?: () => void;
  /** Shown in the command's label, so it is obvious what is about to go. */
  currentProjectName?: string;
}

export default function CommandPalette({
  open, onClose, agents,
  onSelectAgent, onLayout,
  onNewProject, onNewAgent, onStartAll, onStopAll, onStartTour,
  onDeleteProject, currentProjectName,
}: Props) {
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (open) {
      setQ(''); setFocus(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      itemRefs.current[focus]?.scrollIntoView({ block: 'nearest' });
    }
  }, [focus, open]);

  if (!open) return null;

  const commands: Command[] = [
    ...agents.map((a, i) => ({
      group: 'Go to agent',
      icon: <Ic.terminal size={13} />,
      label: a.name,
      sub: (a.role ? a.role + ' · ' : '') + a.cli,
      hint: i < 5 ? MOD + (i + 1) : undefined,
      run: () => { onSelectAgent(a.id); onClose(); },
    })),
    { group: 'Layout', icon: <Ic.single size={13} />, label: 'Single view', run: () => { onLayout('single'); onClose(); } },
    { group: 'Layout', icon: <Ic.twoup size={13} />, label: '2-up side-by-side', run: () => { onLayout('2up'); onClose(); } },
    { group: 'Layout', icon: <Ic.threeup size={13} />, label: '3-up dashboard', run: () => { onLayout('3up'); onClose(); } },
    { group: 'Layout', icon: <Ic.grid size={13} />, label: 'Grid (splits & resize)', run: () => { onLayout('grid'); onClose(); } },
    { group: 'Layout', icon: <Ic.canvas size={13} />, label: 'Canvas (drag & resize)', run: () => { onLayout('canvas'); onClose(); } },

    { group: 'Project', icon: <Ic.plus size={13} />, label: 'New project…', run: () => { onNewProject(); onClose(); } },
    { group: 'Project', icon: <Ic.plus size={13} />, label: 'New agent…', run: () => { onNewAgent(); onClose(); } },
  ];
  // The sidebar's delete control only appears on hover, which is fine as an
  // affordance and useless as a way to find out the feature exists. This is
  // where people look for a thing they cannot see.
  if (onDeleteProject) {
    commands.push({
      group: 'Project',
      icon: <Ic.x size={12} />,
      label: currentProjectName ? `Delete project "${currentProjectName}"…` : 'Delete project…',
      sub: 'Stops its agents first, and asks before removing any files',
      run: () => { onClose(); onDeleteProject(); },
    });
  }
  if (onStartAll) commands.push({ group: 'Action', icon: <Ic.play size={11} />, label: 'Start all agents', run: () => { onStartAll(); onClose(); } });
  if (onStopAll) commands.push({ group: 'Action', icon: <Ic.stop size={10} />, label: 'Stop all agents', run: () => { onStopAll(); onClose(); } });
  if (onStartTour) commands.push({ group: 'Help & Tour', icon: <Ic.bolt size={12} />, label: 'Product Tour (2-Phase Onboarding)', sub: 'Guided interactive tour', run: () => { onStartTour(); onClose(); } });

  const filtered = !q
    ? commands
    : commands.filter(c =>
        (c.label + ' ' + c.group + ' ' + (c.sub || '')).toLowerCase().includes(q.toLowerCase())
      );

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(f => Math.min(f + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(f => Math.max(f - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); filtered[focus]?.run(); }
  };

  let currentGroup: string | null = null;
  return (
    <div className="palette-scrim" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-in">
          <Ic.search size={16} style={{ color: 'var(--text-2)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setFocus(0); }}
            onKeyDown={onKey}
            placeholder="Search agents, layouts, actions…"
          />
          <span className="kbd">ESC</span>
        </div>
        <div className="palette-list">
          {filtered.map((c, i) => {
            const groupH = c.group !== currentGroup
              ? <div key={'g-' + c.group + i} className="palette-group">{c.group}</div>
              : null;
            currentGroup = c.group;
            return (
              <Fragment key={i}>
                {groupH}
                <div
                  ref={(el) => { itemRefs.current[i] = el; }}
                  className={'palette-it' + (i === focus ? ' focus' : '')}
                  onMouseEnter={() => setFocus(i)}
                  onClick={() => c.run()}
                >
                  <div className="ic">{c.icon}</div>
                  <div className="lbl">{c.label}{c.sub && <span className="sub">{c.sub}</span>}</div>
                  {c.hint && <div className="hint">{c.hint}</div>}
                </div>
              </Fragment>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
              No matches found
            </div>
          )}
        </div>
        <div className="palette-footer">
          <div className="palette-footer-item"><kbd>↑</kbd><kbd>↓</kbd> <span>navigate</span></div>
          <div className="palette-footer-item"><kbd>↵</kbd> <span>select</span></div>
          <div className="palette-footer-item"><kbd>esc</kbd> <span>close</span></div>
        </div>
      </div>
    </div>
  );
}
