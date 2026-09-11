import React, { useState, useEffect } from 'react';
import Ic from './Icons';

export type DemoStage =
  | 'goal_typing'        // Prompt types out
  | 'plan_formulate'    // 4-step plan is generated
  | 'step_1_middleware'  // Claude executes Step 1 (Auth refactor)
  | 'step_2_tests'       // Codex executes Step 2 (42 integration tests)
  | 'step_3_specs'       // Gemini executes Step 3 (Security & OpenAPI audit)
  | 'step_4_gate_halt'   // Claude attempts force push & gate halts
  | 'step_4_gate_modal'  // Approval Gate modal overlays
  | 'step_4_approved'    // Human confirms with lease
  | 'step_4_resumed'     // Resumes and pushes safely
  | 'workflow_complete'; // Final verification celebration with replay option

interface ConduitAgentDemoProps {
  onOpenConsole: () => void;
}

export default function ConduitAgentDemo({ onOpenConsole }: ConduitAgentDemoProps) {
  const [stage, setStage] = useState<DemoStage>('goal_typing');
  const [typedRequest, setTypedRequest] = useState('');
  const [typedCommand, setTypedCommand] = useState('');
  const [isPlaying, setIsPlaying] = useState(true);

  const fullRequestText = "Refactor authentication middleware to use session cookies, update tests, and verify.";
  const dangerousCommand = "git push origin feature/auth --force";

  // Automated cinematic timeline with clear, comprehensive pacing and manual control
  useEffect(() => {
    if (!isPlaying) return;

    let timer: NodeJS.Timeout;

    if (stage === 'goal_typing') {
      setTypedRequest('');
      setTypedCommand('');
      let charIdx = 0;
      const typeInterval = setInterval(() => {
        charIdx++;
        setTypedRequest(fullRequestText.slice(0, charIdx));
        if (charIdx >= fullRequestText.length) {
          clearInterval(typeInterval);
          timer = setTimeout(() => {
            setStage('plan_formulate');
          }, 1100);
        }
      }, 20);

      return () => {
        clearInterval(typeInterval);
        clearTimeout(timer);
      };
    }

    if (stage === 'plan_formulate') {
      timer = setTimeout(() => {
        setStage('step_1_middleware');
      }, 2600);
      return () => clearTimeout(timer);
    }

    if (stage === 'step_1_middleware') {
      // Step 1: Claude refactors middleware (4.2s for user to read)
      timer = setTimeout(() => {
        setStage('step_2_tests');
      }, 4200);
      return () => clearTimeout(timer);
    }

    if (stage === 'step_2_tests') {
      // Step 2: Codex runs Vitest suite (4.2s for user to read)
      timer = setTimeout(() => {
        setStage('step_3_specs');
      }, 4200);
      return () => clearTimeout(timer);
    }

    if (stage === 'step_3_specs') {
      // Step 3: Gemini verifies OpenAPI & cookie specs (4.0s for user to read)
      timer = setTimeout(() => {
        setStage('step_4_gate_halt');
      }, 4000);
      return () => clearTimeout(timer);
    }

    if (stage === 'step_4_gate_halt') {
      // Step 4: Claude attempts dangerous force push
      let cmdIdx = 0;
      const cmdInterval = setInterval(() => {
        cmdIdx++;
        setTypedCommand(dangerousCommand.slice(0, cmdIdx));
        if (cmdIdx >= dangerousCommand.length) {
          clearInterval(cmdInterval);
          timer = setTimeout(() => {
            setStage('step_4_gate_modal');
          }, 1000);
        }
      }, 26);

      return () => {
        clearInterval(cmdInterval);
        clearTimeout(timer);
      };
    }

    if (stage === 'step_4_gate_modal') {
      // Approval gate surfaces for review (3.2s)
      timer = setTimeout(() => {
        setStage('step_4_approved');
      }, 3200);
      return () => clearTimeout(timer);
    }

    if (stage === 'step_4_approved') {
      // Human signs off with lease (1.5s)
      timer = setTimeout(() => {
        setStage('step_4_resumed');
      }, 1500);
      return () => clearTimeout(timer);
    }

    if (stage === 'step_4_resumed') {
      // Execution resumes safely (3.8s)
      timer = setTimeout(() => {
        setStage('workflow_complete');
      }, 3800);
      return () => clearTimeout(timer);
    }

    if (stage === 'workflow_complete') {
      // Persist on complete state so user can thoroughly inspect it.
      // Auto-restart only after a generous 14 seconds (or user clicks Replay anytime)
      timer = setTimeout(() => {
        setStage('goal_typing');
      }, 14000);
      return () => clearTimeout(timer);
    }
  }, [stage, isPlaying]);

  const handleStepJump = (targetStage: DemoStage) => {
    setIsPlaying(false); // Pause auto-advancing when user manually scrubs
    setStage(targetStage);
    if (targetStage !== 'goal_typing') {
      setTypedRequest(fullRequestText);
    }
    if (targetStage === 'step_4_gate_halt' || targetStage === 'step_4_gate_modal' || targetStage === 'step_4_approved' || targetStage === 'step_4_resumed' || targetStage === 'workflow_complete') {
      setTypedCommand(dangerousCommand);
    }
  };

  const handleReplay = () => {
    setTypedRequest('');
    setTypedCommand('');
    setIsPlaying(true);
    setStage('goal_typing');
  };

  // Derived progress state for the 4 plan steps
  const isStep1Done = stage !== 'goal_typing' && stage !== 'plan_formulate' && stage !== 'step_1_middleware';
  const isStep1Active = stage === 'step_1_middleware';

  const isStep2Done = isStep1Done && stage !== 'step_2_tests';
  const isStep2Active = stage === 'step_2_tests';

  const isStep3Done = isStep2Done && stage !== 'step_3_specs';
  const isStep3Active = stage === 'step_3_specs';

  const isStep4Done = stage === 'workflow_complete';
  const isStep4Active =
    stage === 'step_4_gate_halt' ||
    stage === 'step_4_gate_modal' ||
    stage === 'step_4_approved' ||
    stage === 'step_4_resumed';

  const isGateOpen = stage === 'step_4_gate_modal' || stage === 'step_4_approved';

  return (
    <div
      className="conduit-cinematic-stage"
      role="region"
      aria-label="Interactive visual demonstration of Conduit multi-agent coordination, testing, and human-in-the-loop safety loop"
    >
      {/* Main Conduit Application Window Frame */}
      <div className="conduit-app-window">
        {/* Window Chrome Header */}
        <div className="window-chrome">
          <div className="window-traffic-lights" aria-hidden="true">
            <span className="dot red" />
            <span className="dot yellow" />
            <span className="dot green" />
          </div>

          <div className="window-center-brand">
            <div className="window-project-pill">
              <Ic.folder size={12} className="project-folder-icon" />
              <span className="project-title-name">core-auth-service</span>
              <span className="project-branch-divider">/</span>
              <span className="project-branch-tag">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="git-branch-svg">
                  <path fillRule="evenodd" d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
                </svg>
                <span>main</span>
              </span>
            </div>
          </div>

          <div className="window-status-capsule">
            <span
              className={`status-pill-dot ${
                stage === 'step_4_gate_halt' || stage === 'step_4_gate_modal'
                  ? 'amber'
                  : stage === 'workflow_complete' || stage === 'step_4_resumed'
                  ? 'green'
                  : 'blue'
              }`}
            />
            <span className="status-pill-text">
              {stage === 'goal_typing' && 'Composing Request...'}
              {stage === 'plan_formulate' && 'Keeper Plan Formulated'}
              {stage === 'step_1_middleware' && 'Step 1: Refactoring Auth'}
              {stage === 'step_2_tests' && 'Step 2: Running 42 Tests'}
              {stage === 'step_3_specs' && 'Step 3: Auditing Security Specs'}
              {stage === 'step_4_gate_halt' && 'Approval Required ⏸'}
              {stage === 'step_4_gate_modal' && 'Approval Gate Active'}
              {stage === 'step_4_approved' && 'Approved by Human'}
              {stage === 'step_4_resumed' && 'Resumed with Safety Lease'}
              {stage === 'workflow_complete' && 'All 4 Steps Completed'}
            </span>
          </div>
        </div>

        {/* Narrative Workspace Body */}
        <div className={`window-narrative-body ${isGateOpen ? 'is-blurred' : ''}`}>
          {/* TOP TIER: User Prompt Composer */}
          <div className="story-prompt-container">
            <div className="prompt-pill-bar">
              <span className="prompt-lead-avatar"><Ic.user size={14} /></span>
              <div className="prompt-input-area">
                <span className="prompt-active-text">
                  {typedRequest}
                  {stage === 'goal_typing' && <span className="caret-blink">|</span>}
                </span>
              </div>
              <div className="prompt-submit-circle" aria-hidden="true">
                <span className="arrow-up">↑</span>
              </div>
            </div>
          </div>

          {/* MIDDLE TIER: Supervisor Plan Card & Bedrock Observer */}
          {stage !== 'goal_typing' && (
            <div className="story-coordination-ribbon">
              {/* Supervisor Plan Checklist Card */}
              <div className="ribbon-plan-card">
                <div className="card-top-title">
                  <span className="badge-tag">KEEPER PLAN</span>
                  <span className="badge-sub">Autonomous Coordination</span>
                </div>
                <div className="plan-stepper">
                  {/* Step 1 */}
                  <div
                    className={`plan-step-item ${
                      isStep1Done ? 'revealed done' : isStep1Active ? 'revealed active' : 'revealed'
                    }`}
                  >
                    <span className={`step-icon ${isStep1Done ? 'done' : isStep1Active ? 'active' : ''}`}>
                      {isStep1Done ? '✓' : '1'}
                    </span>
                    <span className="step-text">Refactor auth middleware to session cookies</span>
                    <span className="step-agent">Claude</span>
                  </div>

                  {/* Step 2 */}
                  <div
                    className={`plan-step-item ${
                      isStep2Done ? 'revealed done' : isStep2Active ? 'revealed active' : 'revealed'
                    }`}
                  >
                    <span className={`step-icon ${isStep2Done ? 'done' : isStep2Active ? 'active' : ''}`}>
                      {isStep2Done ? '✓' : '2'}
                    </span>
                    <span className="step-text">Run 42 integration test suites</span>
                    <span className="step-agent">Codex</span>
                  </div>

                  {/* Step 3 */}
                  <div
                    className={`plan-step-item ${
                      isStep3Done ? 'revealed done' : isStep3Active ? 'revealed active' : 'revealed'
                    }`}
                  >
                    <span className={`step-icon ${isStep3Done ? 'done' : isStep3Active ? 'active' : ''}`}>
                      {isStep3Done ? '✓' : '3'}
                    </span>
                    <span className="step-text">Audit OpenAPI 3.1 & security policies</span>
                    <span className="step-agent">Gemini</span>
                  </div>

                  {/* Step 4 */}
                  <div
                    className={`plan-step-item ${
                      isStep4Done ? 'revealed done' : isStep4Active ? 'revealed active-gate' : 'revealed'
                    }`}
                  >
                    <span className={`step-icon ${isStep4Done ? 'done' : isStep4Active ? 'gate' : ''}`}>
                      {isStep4Done ? '✓' : '4'}
                    </span>
                    <span className="step-text">Supervised remote push & pull request</span>
                    <span className="step-agent">Gate</span>
                  </div>
                </div>
              </div>

              {/* Bedrock Strands Supervisor Observer Card */}
              <div
                className={`ribbon-supervisor-monitor ${
                  isStep4Active ? 'risk-alert' : ''
                }`}
              >
                <div className="supervisor-bar-head">
                  <div className="supervisor-identity">
                    <span className="supervisor-radar-icon" />
                    <strong>Strands Supervisor</strong>
                    <span className="badge-pill-light">Bedrock</span>
                  </div>
                  <span className="supervisor-status-tag">
                    {isStep4Active ? 'Destructive Action Intercepted' : 'Monitoring Terminals'}
                  </span>
                </div>

                <div className="supervisor-telemetry">
                  <div className="telemetry-item">
                    <span className="t-k">Active Terminals</span>
                    <span className="t-v">3 Parallel PTY Shells</span>
                  </div>
                  <div className="telemetry-item">
                    <span className="t-k">Safety Engine</span>
                    <span
                      className={`t-v ${
                        isStep4Active ? 'text-danger' : 'text-ok'
                      }`}
                    >
                      {isStep4Active ? 'Approval Gate Active' : 'Live Verified'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* LOWER TIER: 3-Pane Multi-Agent Parallel Terminals Grid */}
          {stage !== 'goal_typing' && (
            <div className="story-terminals-grid">
              {/* Agent 1: Claude Code (Refactoring & Remote Push) */}
              <div
                className={`cinematic-terminal-card ${
                  isStep4Active ? 'gated-border' : isStep1Active ? 'focused' : ''
                }`}
              >
                <div className="terminal-card-bar">
                  <div className="terminal-agent-title">
                    <span className="agent-indicator-green" />
                    <span className="agent-title-text">Claude Code</span>
                    <span className="terminal-badge">PTY #1</span>
                  </div>
                  <span className="terminal-cwd">src/middleware/auth.ts</span>
                </div>
                <div className="terminal-body">
                  <div className="term-line dim">$ claude "refactor auth to session cookies"</div>
                  <div className="term-line">Analyzing src/middleware/auth.ts...</div>

                  {isStep1Active && (
                    <>
                      <div className="term-line text-blue">Replacing Bearer tokens with HttpOnly cookies...</div>
                      <div className="term-line text-green">✓ src/middleware/session.ts created</div>
                    </>
                  )}

                  {isStep1Done && (
                    <div className="term-line text-green">
                      ✓ Migrated tokens to session cookies (2 files)
                    </div>
                  )}

                  {/* Step 4: Destructive command intercepted */}
                  {(isStep4Active || stage === 'workflow_complete') && (
                    <div className="term-line term-prompt-line text-amber">
                      $ {typedCommand}
                      {stage === 'step_4_gate_halt' && <span className="term-caret">█</span>}
                    </div>
                  )}

                  {/* Supervisor Gate Interception alert */}
                  {(stage === 'step_4_gate_modal' || stage === 'step_4_approved') && (
                    <div className="term-line" style={{ color: '#ef4444', fontWeight: 600 }}>
                      [CONDUIT GATE] Blocked: destructive --force push
                    </div>
                  )}

                  {/* Resumption state after human approval */}
                  {(stage === 'step_4_resumed' || stage === 'workflow_complete') && (
                    <>
                      <div className="term-line text-blue">
                        [Approved with Lease #LSE-4091] flag: --force-with-lease
                      </div>
                      <div className="term-line text-green">
                        remote: Branch 'feature/auth' updated safely.
                      </div>
                      <div className="term-line text-muted">
                        ✓ PR #148 drafted: "feat(auth): session cookies"
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Agent 2: Codex CLI (Running 42 Tests) */}
              <div
                className={`cinematic-terminal-card ${isStep2Active ? 'focused' : ''}`}
              >
                <div className="terminal-card-bar">
                  <div className="terminal-agent-title">
                    <span className="agent-indicator-green" />
                    <span className="agent-title-text">Codex CLI</span>
                    <span className="terminal-badge">PTY #2</span>
                  </div>
                  <span className="terminal-cwd">test/session.test.ts</span>
                </div>
                <div className="terminal-body">
                  {!isStep2Active && !isStep2Done ? (
                    <>
                      <div className="term-line dim">$ codex (standby)</div>
                      <div className="term-line text-muted">
                        Waiting for Step 1 (Claude Code) middleware refactor...
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="term-line dim">$ codex exec "update integration tests"</div>
                      <div className="term-line">Executing Vitest matrix (42 tests)...</div>
                      <div className="term-line text-green">PASS test/session.test.ts (18/18)</div>
                      <div className="term-line text-green">PASS test/middleware.test.ts (24/24)</div>
                      <div className="term-line text-muted">✓ 42 total tests passing with 0 regressions</div>
                    </>
                  )}
                </div>
              </div>

              {/* Agent 3: Gemini CLI (Auditing Security Specs) */}
              <div
                className={`cinematic-terminal-card ${isStep3Active ? 'focused' : ''}`}
              >
                <div className="terminal-card-bar">
                  <div className="terminal-agent-title">
                    <span className="agent-indicator-green" />
                    <span className="agent-title-text">Gemini CLI</span>
                    <span className="terminal-badge">PTY #3</span>
                  </div>
                  <span className="terminal-cwd">docs/openapi.yaml</span>
                </div>
                <div className="terminal-body">
                  {!isStep3Active && !isStep3Done ? (
                    <>
                      <div className="term-line dim">$ gemini (standby)</div>
                      <div className="term-line text-muted">
                        Waiting for Step 2 (Codex CLI) test verification...
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="term-line dim">$ gemini "audit security specs"</div>
                      <div className="term-line">Auditing OpenAPI 3.1 & cookie security policies...</div>
                      <div className="term-line text-green">✓ SameSite=Strict & HttpOnly flags verified</div>
                      <div className="term-line text-green">✓ OWASP ASVS session rules compliant</div>
                      <div className="term-line text-muted">✓ Zero CVE vulnerabilities detected</div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* OVERLAY: THE APPROVAL GATE (Triggered at Step 4) */}
        {isGateOpen && (
          <div className="cinematic-gate-backdrop" role="dialog" aria-modal="true">
            <div className="cinematic-gate-modal">
              <div className="gate-header-tag">
                <span className="gate-warning-indicator"><Ic.logo size={12} /></span>
                <span>APPROVAL GATE TRIGGERED (STEP 4 OF 4)</span>
              </div>

              <h3 className="gate-headline">Destructive Remote Push Intercepted</h3>

              <p className="gate-submessage">
                <strong>Claude Code</strong> attempted to force push to remote git branch. Conduit's safety engine intercepted the action and paused the agent for human review:
              </p>

              <div className="gate-terminal-snippet">
                $ git push origin feature/auth --force
              </div>

              <div className="gate-decision-actions">
                <button type="button" className="gate-btn-secondary" onClick={() => handleStepJump('step_4_halt_reject' as DemoStage)}>
                  Reject (Esc)
                </button>
                <button
                  type="button"
                  className={`gate-btn-primary ${stage === 'step_4_approved' ? 'clicked' : ''}`}
                  onClick={() => setStage('step_4_approved')}
                >
                  {stage === 'step_4_approved' ? (
                    <span>✓ Approved with Lease</span>
                  ) : (
                    <span>Approve with Lease (Y)</span>
                  )}
                </button>
              </div>

              <div className="gate-humancentered-note">
                Conduit ensures no destructive command executes without explicit human confirmation.
              </div>
            </div>
          </div>
        )}

        {/* OVERLAY: Workflow Complete Celebration */}
        {stage === 'workflow_complete' && (
          <div className="cinematic-completion-backdrop">
            <div className="completion-modal-card">
              <div className="completion-check-badge">✓</div>
              <h3 className="completion-title">All 4 Workflow Steps Completed Safely</h3>
              <p className="completion-lead">
                Claude, Codex, and Gemini coordinated concurrently under Conduit's real-time safety loop.
              </p>

              <div className="completion-metrics-row">
                <div className="metric-box">
                  <span className="m-val">3</span>
                  <span className="m-lbl">Agents Coordinated</span>
                </div>
                <div className="metric-box">
                  <span className="m-val">42</span>
                  <span className="m-lbl">Tests Verified</span>
                </div>
                <div className="metric-box">
                  <span className="m-val">1</span>
                  <span className="m-lbl">Gate Approved</span>
                </div>
                <div className="metric-box">
                  <span className="m-val">0</span>
                  <span className="m-lbl">Incidents</span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                <button
                  type="button"
                  className="gate-btn-secondary"
                  style={{ maxWidth: '160px', height: '40px' }}
                  onClick={handleReplay}
                >
                  Replay Demo ↺
                </button>
                <button type="button" className="landing-btn-black completion-cta" onClick={onOpenConsole}>
                  Open Control Center <Ic.chevR size={12} />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Bottom Interactive Step Scrubber Bar */}
        <div className="window-bottom-statusbar">
          <div className="statusbar-left">
            <button
              type="button"
              className="stepper-play-pause-btn"
              onClick={() => setIsPlaying(!isPlaying)}
              title={isPlaying ? "Pause animation" : "Resume animation"}
            >
              {isPlaying ? '⏸ Pause' : '▶ Play'}
            </button>
            <span className="status-sep">·</span>
            <span className="status-node-dot" />
            <span>Daemon active on :3210</span>
            <span className="status-sep">·</span>
            <span>Supervisor: Amazon Bedrock</span>
          </div>

          <div className="statusbar-right">
            <span className="stepper-crumb-label">Workflow Steps:</span>
            <button
              type="button"
              className={`stepper-pill-btn ${stage === 'step_1_middleware' || isStep1Done ? 'active' : ''}`}
              onClick={() => handleStepJump('step_1_middleware')}
              title="Step 1: Middleware Refactor (Claude Code)"
            >
              1. Auth
            </button>
            <button
              type="button"
              className={`stepper-pill-btn ${stage === 'step_2_tests' || isStep2Done ? 'active' : ''}`}
              onClick={() => handleStepJump('step_2_tests')}
              title="Step 2: 42 Integration Tests (Codex CLI)"
            >
              2. Tests
            </button>
            <button
              type="button"
              className={`stepper-pill-btn ${stage === 'step_3_specs' || isStep3Done ? 'active' : ''}`}
              onClick={() => handleStepJump('step_3_specs')}
              title="Step 3: Security & OpenAPI Specs (Gemini CLI)"
            >
              3. Specs
            </button>
            <button
              type="button"
              className={`stepper-pill-btn ${isStep4Active || isStep4Done ? 'active' : ''}`}
              onClick={() => handleStepJump('step_4_gate_halt')}
              title="Step 4: Approval Gate & Supervised Push"
            >
              4. Gate
            </button>
            <button
              type="button"
              className={`stepper-pill-btn ${stage === 'workflow_complete' ? 'active' : ''}`}
              onClick={() => handleStepJump('workflow_complete')}
              title="Workflow Complete Summary"
            >
              5. Done
            </button>
            <button
              type="button"
              className="stepper-pill-btn"
              onClick={handleReplay}
              title="Replay entire animation from start"
            >
              ↺
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
