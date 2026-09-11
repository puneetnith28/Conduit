import React, { useState, useEffect, useRef } from 'react';
import Ic from './Icons';
import { BrandIcons } from './ecosystem/BrandIcons';

export interface WorkflowFeature {
  id: string;
  stepNumber: string;
  tabLabel: string;
  title: string;
  badge: string;
  description: string;
  ctaText: string;
}

export const WORKFLOW_FEATURES: WorkflowFeature[] = [
  {
    id: 'terminals',
    stepNumber: '01',
    tabLabel: 'Live Terminals',
    title: 'Side-by-side terminal supervision',
    badge: 'xterm.js · node-pty',
    description:
      'Every agent runs in a real pseudo-terminal you can watch and type into, with automatic scrollback replay on reconnection.',
    ctaText: 'Open Live Terminals →',
  },
  {
    id: 'layouts',
    stepNumber: '02',
    tabLabel: '5 Window Layouts',
    title: 'Multi-agent persistent layouts',
    badge: 'Saved per project',
    description:
      'Tile your coding agents your way: 1-to-3 agent splits, tmux-style draggable dividers, or freeform window cards.',
    ctaText: 'Explore Layouts in Console →',
  },
  {
    id: 'group_chat',
    stepNumber: '03',
    tabLabel: 'Universal Group Chat',
    title: 'Universal project Group Chat',
    badge: 'Broadcast & @agent',
    description:
      'Broadcast instructions to all running agents at once or target a specific agent with @name with automatic status updates.',
    ctaText: 'Try Group Chat →',
  },
  {
    id: 'mcp',
    stepNumber: '04',
    tabLabel: 'MCP Agent Messaging',
    title: 'Model Context Protocol coordination',
    badge: 'Session-scoped JSON-RPC',
    description:
      'Agents within the same project discover teammates and coordinate peer-to-peer via session-scoped Model Context Protocol servers.',
    ctaText: 'View MCP Configs →',
  },
  {
    id: 'keeper',
    stepNumber: '05',
    tabLabel: 'The Keeper Orchestrator',
    title: 'Repository architecture orchestrator',
    badge: '⌘J Spotlight · Codex',
    description:
      'An orchestrator answering repository-wide architecture questions, verifying progress across all agents, and coordinating tasks.',
    ctaText: 'Launch The Keeper →',
  },
  {
    id: 'voice',
    stepNumber: '06',
    tabLabel: 'Push-to-Talk Voice',
    title: 'Push-to-talk voice pipeline',
    badge: '⌘; Push-to-talk',
    description:
      'Speak instructions directly to your agents using browser Web Speech or cloud voice endpoints with audio feedback.',
    ctaText: 'Configure Voice Settings →',
  },
];

interface WorkflowShowcaseSectionProps {
  onOpenConsole: () => void;
}

export const WorkflowShowcaseSection: React.FC<WorkflowShowcaseSectionProps> = ({
  onOpenConsole,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const [displayIndex, setDisplayIndex] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const autoCycleTimerRef = useRef<NodeJS.Timeout | null>(null);

  const tabsRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<{ left: number; width: number }>({
    left: 0,
    width: 0,
  });

  // Calculate sliding active pill position
  const updatePillPosition = (index: number, shouldScrollTrack = false) => {
    if (!tabsRef.current) return;
    const tabButtons = tabsRef.current.querySelectorAll<HTMLButtonElement>('.workflow-tab-item');
    const target = tabButtons[index];
    if (target) {
      const containerLeft = tabsRef.current.getBoundingClientRect().left;
      const targetRect = target.getBoundingClientRect();
      setIndicatorStyle({
        left: targetRect.left - containerLeft + tabsRef.current.scrollLeft,
        width: targetRect.width,
      });

      if (shouldScrollTrack) {
        const targetOffsetLeft = target.offsetLeft;
        const targetWidth = target.offsetWidth;
        const containerWidth = tabsRef.current.clientWidth;
        tabsRef.current.scrollTo({
          left: targetOffsetLeft - (containerWidth / 2) + (targetWidth / 2),
          behavior: 'smooth',
        });
      }
    }
  };

  useEffect(() => {
    const onResize = () => updatePillPosition(activeIndex, false);
    updatePillPosition(activeIndex, false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [activeIndex]);

  // Smooth feature state transition coordinator
  const selectFeature = (index: number, isManual = true) => {
    if (index === activeIndex) return;
    setActiveIndex(index);
    setIsTransitioning(true);

    setTimeout(() => {
      setDisplayIndex(index);
      setIsTransitioning(false);
    }, 200);

    if (isManual) {
      setIsPaused(true);
      if (autoCycleTimerRef.current) clearTimeout(autoCycleTimerRef.current);
      autoCycleTimerRef.current = setTimeout(() => {
        setIsPaused(false);
      }, 12000);
    }
  };

  // Automatic demo cycling (6s per feature when not hovered)
  useEffect(() => {
    if (isPaused) return;
    const interval = setInterval(() => {
      selectFeature((activeIndex + 1) % WORKFLOW_FEATURES.length, false);
    }, 6000);
    return () => clearInterval(interval);
  }, [activeIndex, isPaused]);

  const currentFeature = WORKFLOW_FEATURES[displayIndex];

  return (
    <section
      id="features"
      className="landing-section tools-sec workflow-showcase-section"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <div className="faster-showcase-wrap">
        <h2 className="section-title faster-title">
          Built for serious <span className="highlight-pill animated-highlight">engineering workflows</span>
        </h2>

        {/* Sliding Pill Navigation */}
        <div className="workflow-tabs-track-wrap" ref={tabsRef}>
          <div
            className="workflow-tab-sliding-indicator"
            style={{
              transform: `translateX(${indicatorStyle.left}px)`,
              width: `${indicatorStyle.width}px`,
              opacity: indicatorStyle.width > 0 ? 1 : 0,
            }}
          />
          {WORKFLOW_FEATURES.map((item, idx) => (
            <button
              key={item.id}
              className={`workflow-tab-item ${activeIndex === idx ? 'active' : ''}`}
              onClick={() => selectFeature(idx, true)}
            >
              {item.tabLabel}
            </button>
          ))}
        </div>

        {/* Clean Showcase Card Container */}
        <div className="workflow-master-card-container">
          <div className={`workflow-feature-card ${isTransitioning ? 'card-exiting' : 'card-entering'}`}>
            {/* Top Header Row */}
            <div className="feature-header-row">
              <span className="feature-step-tag">{currentFeature.stepNumber}</span>
              <span className="feature-step-name">{currentFeature.title}</span>
              <span className="feature-tools-badge">{currentFeature.badge}</span>
            </div>

            {/* Description */}
            <p className="feature-step-desc">{currentFeature.description}</p>

            {/* Feature-Specific Animated Interactive Visual */}
            <div className="workflow-visual-stage">
              {displayIndex === 0 && <FeatureTerminalVisual isRunning={!isTransitioning} />}
              {displayIndex === 1 && <FeatureLayoutsVisual isRunning={!isTransitioning} />}
              {displayIndex === 2 && <FeatureGroupChatVisual isRunning={!isTransitioning} />}
              {displayIndex === 3 && <FeatureMcpVisual isRunning={!isTransitioning} />}
              {displayIndex === 4 && <FeatureKeeperVisual isRunning={!isTransitioning} />}
              {displayIndex === 5 && <FeatureVoiceVisual isRunning={!isTransitioning} />}
            </div>

            {/* Feature Action Row */}
            <div className="feature-action-row">
              <button className="preview-action-pill workflow-cta-btn" onClick={onOpenConsole}>
                <span>{currentFeature.ctaText}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

/* ============================================================
   Feature 1 Visual: Live Terminals (xterm.js · node-pty)
   ============================================================ */
const FeatureTerminalVisual: React.FC<{ isRunning: boolean }> = ({ isRunning }) => {
  const [typedLine, setTypedLine] = useState('');
  const [lines, setLines] = useState<string[]>([]);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!isRunning) return;
    setTypedLine('');
    setLines([]);
    setStep(0);

    const t1 = setTimeout(() => {
      setTypedLine('$ claude "run test matrix"');
      setStep(1);
    }, 400);

    const t2 = setTimeout(() => {
      setLines(['Executing Vitest suite across auth service...', 'PASS src/middleware/auth.test.ts (18/18)']);
      setStep(2);
    }, 1300);

    const t3 = setTimeout(() => {
      setLines((prev) => [
        ...prev,
        'PASS src/services/session.test.ts (24/24)',
        '✓ 42 total test suites passed with 0 failures',
      ]);
      setStep(3);
    }, 2400);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [isRunning]);

  return (
    <div className="mini-term-visual">
      <div className="mini-term-chrome">
        <div className="mini-term-dots">
          <span className="m-dot red" />
          <span className="m-dot yellow" />
          <span className="m-dot green" />
        </div>
        <div className="mini-term-title-wrap">
          {BrandIcons.claude ? BrandIcons.claude({ size: 14 }) : <Ic.terminal size={12} />}
          <span className="mini-term-title">Claude Code · PTY Shell #1</span>
        </div>
        <span className="mini-term-status">
          <span className={`status-led ${step === 3 ? 'green' : 'active'}`} />
          {step === 3 ? 'DONE' : 'RUNNING'}
        </span>
      </div>
      <div className="mini-term-body">
        {typedLine && <div className="mini-line cmd">{typedLine}</div>}
        {lines.map((l, i) => (
          <div
            key={i}
            className={`mini-line ${l.includes('PASS') || l.includes('✓') ? 'pass' : 'dim'}`}
          >
            {l.includes('✓') && <Ic.check size={11} style={{ marginRight: 4 }} />}
            {l}
          </div>
        ))}
        {step < 3 && <span className="mini-term-caret">█</span>}
      </div>
    </div>
  );
};

/* ============================================================
   Feature 2 Visual: 5 Window Layouts
   ============================================================ */
const FeatureLayoutsVisual: React.FC<{ isRunning: boolean }> = ({ isRunning }) => {
  const [activeLayout, setActiveLayout] = useState<'single' | 'two_up' | 'tmux' | 'canvas'>('tmux');
  const [userInteracted, setUserInteracted] = useState(false);

  useEffect(() => {
    if (!isRunning || userInteracted) return;
    const layouts: Array<'single' | 'two_up' | 'tmux' | 'canvas'> = ['single', 'two_up', 'tmux', 'canvas'];
    let idx = 0;
    const interval = setInterval(() => {
      idx = (idx + 1) % layouts.length;
      setActiveLayout(layouts[idx]);
    }, 2800);

    return () => clearInterval(interval);
  }, [isRunning, userInteracted]);

  const handleSelect = (layout: 'single' | 'two_up' | 'tmux' | 'canvas') => {
    setUserInteracted(true);
    setActiveLayout(layout);
  };

  return (
    <div className="mini-layouts-visual">
      <div className="layouts-mode-bar">
        <div className="layouts-pill-group">
          <button
            type="button"
            className={`mode-pill-btn ${activeLayout === 'single' ? 'active' : ''}`}
            onClick={() => handleSelect('single')}
          >
            <Ic.single size={11} />
            <span>Single</span>
          </button>
          <button
            type="button"
            className={`mode-pill-btn ${activeLayout === 'two_up' ? 'active' : ''}`}
            onClick={() => handleSelect('two_up')}
          >
            <Ic.twoup size={11} />
            <span>2-up Split</span>
          </button>
          <button
            type="button"
            className={`mode-pill-btn ${activeLayout === 'tmux' ? 'active' : ''}`}
            onClick={() => handleSelect('tmux')}
          >
            <Ic.grid size={11} />
            <span>Tmux Grid</span>
          </button>
          <button
            type="button"
            className={`mode-pill-btn ${activeLayout === 'canvas' ? 'active' : ''}`}
            onClick={() => handleSelect('canvas')}
          >
            <Ic.canvas size={11} />
            <span>Canvas</span>
          </button>
        </div>
        <span className="layouts-state-tag">
          <Ic.check size={11} />
          <span>Layout Persisted</span>
        </span>
      </div>

      <div className={`layouts-grid-stage layout-${activeLayout}`}>
        {/* Pane 1: Claude Code */}
        <div className="layout-cell cell-claude">
          <div className="mini-pane-bar">
            <div className="pane-left">
              {BrandIcons.claude ? BrandIcons.claude({ size: 13 }) : <span className="pane-status-dot active" />}
              <span className="pane-title">Claude Code</span>
            </div>
            <span className="pane-path">src/auth.ts</span>
          </div>
          <div className="mini-pane-body">
            <span className="pane-line text-green">✓ Migrated to session cookies</span>
            <span className="pane-line text-muted">Listening for requests...</span>
          </div>
        </div>

        {/* Pane 2: Codex CLI (Shown in 2-up, tmux, canvas) */}
        {activeLayout !== 'single' && (
          <div className="layout-cell cell-codex">
            <div className="mini-pane-bar">
              <div className="pane-left">
                {BrandIcons.openai ? BrandIcons.openai({ size: 13 }) : <span className="pane-status-dot active" />}
                <span className="pane-title">Codex CLI</span>
              </div>
              <span className="pane-path">tests/</span>
            </div>
            <div className="mini-pane-body">
              <span className="pane-line text-green">PASS 42/42 tests passing</span>
              <span className="pane-line text-muted">0 regressions found</span>
            </div>
          </div>
        )}

        {/* Panes 3 & 4 (Shown in tmux and canvas) */}
        {(activeLayout === 'tmux' || activeLayout === 'canvas') && (
          <>
            <div className="layout-cell cell-gemini">
              <div className="mini-pane-bar">
                <div className="pane-left">
                  {BrandIcons.gemini ? BrandIcons.gemini({ size: 13 }) : <span className="pane-status-dot active" />}
                  <span className="pane-title">Gemini CLI</span>
                </div>
                <span className="pane-path">docs/openapi.yaml</span>
              </div>
              <div className="mini-pane-body">
                <span className="pane-line text-blue">✓ OpenAPI 3.1 validated</span>
                <span className="pane-line text-muted">SameSite=Strict confirmed</span>
              </div>
            </div>

            <div className="layout-cell cell-opencode">
              <div className="mini-pane-bar">
                <div className="pane-left">
                  {BrandIcons.opencode ? BrandIcons.opencode({ size: 13 }) : <span className="pane-status-dot idle" />}
                  <span className="pane-title">OpenCode</span>
                </div>
                <span className="pane-path">daemon/</span>
              </div>
              <div className="mini-pane-body">
                <span className="pane-line text-muted">$ pty daemon active</span>
                <span className="pane-line text-muted">Ready for dispatch</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

/* ============================================================
   Feature 3 Visual: Universal Group Chat (Broadcast & @agent)
   ============================================================ */
const FeatureGroupChatVisual: React.FC<{ isRunning: boolean }> = ({ isRunning }) => {
  const [messages, setMessages] = useState<Array<{ sender: string; text: string; role: 'human' | 'agent' }>>([]);

  useEffect(() => {
    if (!isRunning) return;
    setMessages([]);

    const t1 = setTimeout(() => {
      setMessages([{ sender: 'Engineer', text: '@all update session cookie specs and verify test matrix', role: 'human' }]);
    }, 400);

    const t2 = setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        { sender: 'Claude Code', text: 'Refactored auth middleware in src/middleware/auth.ts to use HttpOnly cookies.', role: 'agent' },
      ]);
    }, 1400);

    const t3 = setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        { sender: 'Codex CLI', text: 'Vitest matrix executed: 42/42 tests passing with zero regressions.', role: 'agent' },
      ]);
    }, 2400);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [isRunning]);

  return (
    <div className="mini-chat-visual">
      <div className="mini-chat-head">
        <div className="chat-head-left">
          <Ic.hash size={12} />
          <span className="chat-badge-channel">project-group-chat</span>
        </div>
        <div className="chat-head-right">
          <Ic.sparkles size={11} />
          <span className="chat-broadcast-tag">Broadcast to 3 Agents</span>
        </div>
      </div>
      <div className="mini-chat-stream">
        {messages.map((m, i) => (
          <div key={i} className={`mini-chat-bubble ${m.role}`}>
            <div className="bubble-sender-row">
              <span className="sender-avatar">
                {m.role === 'human' ? (
                  <Ic.user size={12} />
                ) : m.sender.includes('Claude') && BrandIcons.claude ? (
                  BrandIcons.claude({ size: 14 })
                ) : m.sender.includes('Codex') && BrandIcons.openai ? (
                  BrandIcons.openai({ size: 14 })
                ) : (
                  <Ic.terminal size={12} />
                )}
              </span>
              <strong className="sender-title">{m.sender}</strong>
              <span className="sender-time">Just now</span>
            </div>
            <p className="bubble-msg-text">
              {m.role === 'agent' && <Ic.check size={11} style={{ marginRight: 4, color: '#16a34a' }} />}
              {m.text}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ============================================================
   Feature 4 Visual: MCP Inter-Agent Messaging (JSON-RPC)
   ============================================================ */
const FeatureMcpVisual: React.FC<{ isRunning: boolean }> = ({ isRunning }) => {
  const [activeStep, setActiveStep] = useState<0 | 1 | 2>(0);

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      setActiveStep((prev) => ((prev + 1) % 3) as 0 | 1 | 2);
    }, 1600);
    return () => clearInterval(interval);
  }, [isRunning]);

  return (
    <div className="mini-mcp-visual">
      <div className="mcp-hub-wrap">
        <div className={`mcp-node node-left ${activeStep === 0 ? 'active' : ''}`}>
          <div className="node-head">
            {BrandIcons.claude ? BrandIcons.claude({ size: 15 }) : <Ic.logo size={13} />}
            <span className="node-name">Claude Code</span>
          </div>
          <span className="node-payload">message_agent("codex")</span>
        </div>

        <div className="mcp-center-bus">
          <div className="bus-title-row">
            {BrandIcons.mcp ? BrandIcons.mcp({ size: 15 }) : <Ic.bolt size={12} />}
            <span className="bus-title">Conduit MCP Bus</span>
          </div>
          <span className="bus-spec">JSON-RPC / stdio</span>
          <div className={`mcp-packet-pulse ${activeStep === 1 ? 'pulsing' : ''}`} />
        </div>

        <div className={`mcp-node node-right ${activeStep === 2 ? 'active' : ''}`}>
          <div className="node-head">
            {BrandIcons.openai ? BrandIcons.openai({ size: 15 }) : <Ic.terminal size={13} />}
            <span className="node-name">Codex CLI</span>
          </div>
          <span className="node-payload">
            <Ic.check size={11} style={{ marginRight: 3 }} />
            Packet received & synced
          </span>
        </div>
      </div>
    </div>
  );
};

/* ============================================================
   Feature 5 Visual: The Keeper (Codex Orchestrator)
   ============================================================ */
const FeatureKeeperVisual: React.FC<{ isRunning: boolean }> = ({ isRunning }) => {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!isRunning) return;
    setStep(0);
    const t1 = setTimeout(() => setStep(1), 500);
    const t2 = setTimeout(() => setStep(2), 1600);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [isRunning]);

  return (
    <div className="mini-keeper-visual">
      <div className="keeper-palette-header">
        <div className="keeper-palette-left">
          {BrandIcons.openai ? BrandIcons.openai({ size: 14 }) : <Ic.sparkles size={12} />}
          <span className="keeper-shortcut-badge">⌘J Command Panel</span>
        </div>
        <span className="keeper-backend-tag">Codex App-Server Orchestrator</span>
      </div>
      <div className="keeper-command-prompt">
        <Ic.search size={13} className="k-arrow" />
        <span className="k-query">"Summarize auth refactor status and blockers across all agents"</span>
      </div>
      <div className="keeper-structured-answer">
        {step < 2 ? (
          <div className="keeper-evaluating">
            <span className="eval-spinner" />
            <span>Evaluating repository telemetry across 3 agents...</span>
          </div>
        ) : (
          <div className="keeper-telemetry-result">
            <div className="k-stat-item">
              <div className="stat-icon-num">
                <Ic.terminal size={12} />
                <span className="k-num">3</span>
              </div>
              <span className="k-label">Active Agents</span>
            </div>
            <div className="k-stat-item green">
              <div className="stat-icon-num">
                <Ic.check size={12} />
                <span className="k-num">42/42</span>
              </div>
              <span className="k-label">Tests Passing</span>
            </div>
            <div className="k-stat-item">
              <div className="stat-icon-num">
                <Ic.shield size={12} />
                <span className="k-num">0</span>
              </div>
              <span className="k-label">Blockers Flagged</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ============================================================
   Feature 6 Visual: Push-to-talk Voice Pipeline
   ============================================================ */
const FeatureVoiceVisual: React.FC<{ isRunning: boolean }> = ({ isRunning }) => {
  const [state, setState] = useState<'listening' | 'answering'>('listening');

  useEffect(() => {
    if (!isRunning) return;
    setState('listening');
    const t = setTimeout(() => setState('answering'), 1800);
    return () => clearTimeout(t);
  }, [isRunning]);

  return (
    <div className="mini-voice-visual">
      <div className="voice-mic-cockpit">
        <div className={`voice-orb ${state}`}>
          <Ic.mic size={16} />
        </div>
        <div className="voice-waveform-bars">
          <span className="v-bar b1" />
          <span className="v-bar b2" />
          <span className="v-bar b3" />
          <span className="v-bar b4" />
          <span className="v-bar b5" />
        </div>
        <span className="voice-badge">Push-to-talk (⌘;)</span>
      </div>
      <div className="voice-transcript-card">
        <div className="voice-query-line">
          <Ic.user size={12} style={{ color: '#71717a', flexShrink: 0, marginTop: 2 }} />
          <span className="voice-label">Spoken:</span>
          <span className="voice-text">"Jarvis, summarize current agent progress."</span>
        </div>
        {state === 'answering' && (
          <div className="voice-audio-response">
            <Ic.volume size={13} style={{ flexShrink: 0, marginTop: 2 }} />
            <span className="tts-text">
              "Claude refactored auth middleware. Codex verified all 42 tests passing with zero regressions."
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default WorkflowShowcaseSection;


