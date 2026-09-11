import React, { useEffect, useState } from 'react';
import Ic from './Icons';
import ConduitAgentDemo from './ConduitAgentDemo';
import ToolEcosystemSection from './ecosystem/ToolEcosystemSection';
import WorkflowShowcaseSection from './WorkflowShowcaseSection';
import { BrandIcons } from './ecosystem/BrandIcons';
import DownloadModal from './DownloadModal';
import { WatchClassifyDemo, GateApprovalDemo } from './safety/SafetyLoopShowcase';
import InteractiveCanvas from './InteractiveCanvas';

interface LandingPageProps {
  onOpenConsole: () => void;
  onStartTour?: () => void;
}

const navItems = [
  { name: 'How it works', id: 'how-it-works', icon: Ic.shield },
  { name: 'Ecosystem', id: 'ecosystem', icon: Ic.grid },
  { name: 'Features', id: 'features', icon: Ic.sparkles },
  { name: 'FAQ', id: 'faq', icon: Ic.help },
];

export default function LandingPage({ onOpenConsole, onStartTour }: LandingPageProps) {
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [isDownloadOpen, setIsDownloadOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('how-it-works');

  useEffect(() => {
    const sectionIds = ['how-it-works', 'ecosystem', 'features', 'faq'];
    const handleScroll = () => {
      // If at top or in hero section, stay on first tab 'how-it-works'
      if (window.scrollY < 350) {
        setActiveTab('how-it-works');
        return;
      }
      const scrollPosition = window.scrollY + 220;
      for (let i = sectionIds.length - 1; i >= 0; i--) {
        const el = document.getElementById(sectionIds[i]);
        if (el && el.offsetTop <= scrollPosition) {
          setActiveTab(sectionIds[i]);
          break;
        }
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToSection = (e: React.MouseEvent, sectionId: string) => {
    e.preventDefault();
    setActiveTab(sectionId);
    const el = document.getElementById(sectionId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="landing-page">
      {/* Purple Gradient Grid Right Background */}
      <div className="landing-bg-gradient-grid" aria-hidden="true" />

      {/* Tubelight Floating Navigation */}
      <div className="landing-nav-wrapper">
        <header className="landing-nav">
          <div
            className="landing-nav-brand"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            role="button"
            tabIndex={0}
            title="Conduit Home"
          >
            <span className="brand-logo-icon">
              <Ic.logo size={15} />
            </span>
            <span className="brand-title">CONDUIT</span>
          </div>

          <nav className="landing-tubelight-track" aria-label="Main Navigation">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={(e) => scrollToSection(e, item.id)}
                  className={`landing-tubelight-item ${isActive ? 'active' : ''}`}
                >
                  <span className="tubelight-item-icon">
                    <Icon size={14} />
                  </span>
                  <span className="tubelight-item-label">{item.name}</span>
                  {isActive && (
                    <div className="tubelight-lamp" aria-hidden="true">
                      <div className="tubelight-lamp-emitter">
                        <div className="tubelight-lamp-glow-wide" />
                        <div className="tubelight-lamp-glow-mid" />
                        <div className="tubelight-lamp-glow-core" />
                      </div>
                    </div>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="landing-nav-actions">
            {onStartTour && (
              <button
                type="button"
                className="landing-nav-tour-btn"
                onClick={onStartTour}
                title="Start Interactive Product Tour"
              >
                <Ic.sparkles size={13} />
                <span>Tour</span>
              </button>
            )}
            <button className="landing-btn-black" onClick={onOpenConsole}>
              <span className="btn-text-full">Open Control Center</span>
              <span className="btn-text-short">Console</span>
              <Ic.chevR size={12} />
            </button>
            <button
              type="button"
              className="landing-nav-mobile-toggle"
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              aria-label="Toggle navigation menu"
              aria-expanded={isMobileMenuOpen}
            >
              {isMobileMenuOpen ? <Ic.x size={17} /> : <Ic.menu size={17} />}
            </button>
          </div>
        </header>

        {/* Mobile Navigation Dropdown Drawer & Dimmed Backdrop */}
        {isMobileMenuOpen && (
          <>
            <div
              className="landing-nav-backdrop"
              onClick={() => setIsMobileMenuOpen(false)}
              aria-hidden="true"
            />
            <div className="landing-nav-mobile-drawer">
              <div className="mobile-drawer-header">
                <span className="drawer-title">Navigation</span>
                <button
                  type="button"
                  className="drawer-close-btn"
                  onClick={() => setIsMobileMenuOpen(false)}
                  aria-label="Close menu"
                >
                  <Ic.x size={15} />
                </button>
              </div>
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`mobile-drawer-link ${isActive ? 'active' : ''}`}
                    onClick={(e) => {
                      scrollToSection(e, item.id);
                      setIsMobileMenuOpen(false);
                    }}
                  >
                    <span className="drawer-icon-wrap"><Icon size={16} /></span>
                    <span className="drawer-item-name">{item.name}</span>
                    {isActive && <span className="drawer-active-dot" />}
                  </button>
                );
              })}
              <div className="mobile-drawer-actions">
                {onStartTour && (
                  <button
                    type="button"
                    className="mobile-drawer-tour-btn"
                    onClick={() => {
                      onStartTour();
                      setIsMobileMenuOpen(false);
                    }}
                  >
                    <Ic.sparkles size={14} />
                    <span>Take Product Tour</span>
                  </button>
                )}
                <button
                  type="button"
                  className="mobile-drawer-cta-btn"
                  onClick={() => {
                    onOpenConsole();
                    setIsMobileMenuOpen(false);
                  }}
                >
                  <span>Open Control Center</span>
                  <Ic.chevR size={13} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Hero Section */}
      <section className="landing-hero">
        {/* Hero Background Illustration */}
        <div className="landing-hero-bg-container" aria-hidden="true">
          <InteractiveCanvas />
          <div className="landing-hero-bg-glow" />
        </div>

        {/* Center Hero Content */}
        <div className="hero-center-content" data-tour="landing-hero">
          <h1 className="hero-title">
            The multi-agent control center<br />
            for <span className="highlight-pill">engineers</span>
          </h1>

          <p className="hero-subtitle">
            Run Claude Code, Codex, Gemini, OpenCode, GPT-OSS, and Nemotron side by side. Supervised by Amazon Bedrock with human-in-the-loop approval gates.
          </p>

          <div className="hero-actions">
            {/* Inside the desktop app there is nothing left to download. */}
            {window.conduitDesktop?.isDesktop ? (
              <button className="hero-cta-button" onClick={onOpenConsole}>
                Open Control Center →
              </button>
            ) : (
              <button className="hero-cta-button" onClick={() => setIsDownloadOpen(true)}>
                Download ↓
              </button>
            )}
            <span className="hero-cta-subtext">Real terminals · Full human supervision · MIT License</span>
          </div>
        </div>
      </section>

      {/* Interactive Product Demonstration Showcase (Conduit Live Story) */}
      <section className="landing-section demo-showcase-section" data-tour="landing-demo">
        <div className="demo-showcase-header">
          <span className="demo-eyebrow">THE HUMAN-DRIVEN MULTI-AGENT CONTROL CENTER</span>
          <h2 className="demo-showcase-heading">
            Your agents work.<br />
            You stay in control.
          </h2>
          <p className="demo-showcase-desc">
            Coordinate Claude, Codex, Gemini, OpenCode, GPT-OSS, and Nemotron from one unified workspace while Conduit's Supervisor continuously monitors terminal output for blockers and dangerous commands.
          </p>
        </div>

        {/* The Animated Conduit Workspace */}
        <ConduitAgentDemo onOpenConsole={onOpenConsole} />
      </section>

      {/* Section 2: How the Safety Loop Works */}
      <section id="how-it-works" className="landing-section how-it-works-sec">
        <h2 className="section-title">How the human-in-the-loop safety loop works</h2>

        <div className="how-it-works-grid">
          {/* Step 01 */}
          <div className="how-step-row">
            <div className="how-step-text">
              <span className="step-num">01</span>
              <h3 className="step-title">Watch and classify in real time.</h3>
              <p className="step-desc">
                Conduit scans agent terminals in real time running instant regex checks for destructive commands and AI classification for progress and blockers.
              </p>
            </div>
            <div className="how-step-preview">
              <div className="preview-container-box">
                <WatchClassifyDemo />
              </div>
            </div>
          </div>

          {/* Step 02 */}
          <div className="how-step-row">
            <div className="how-step-text">
              <span className="step-num">02</span>
              <h3 className="step-title">Gate & Plan approval.</h3>
              <p className="step-desc">
                Risky commands pause the agent instantly. Approval Gates require your explicit sign-off before any destructive action or plan can proceed.
              </p>
            </div>
            <div className="how-step-preview">
              <div className="preview-container-box">
                <GateApprovalDemo onOpenConsole={onOpenConsole} />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Tool Ecosystem Section: Works With the Tools Engineers Already Use */}
      <ToolEcosystemSection />

      {/* Features Tabs Showcase — Animated Living Product Showcase */}
      <WorkflowShowcaseSection onOpenConsole={onOpenConsole} />

      {/* Section 5: Real FAQ */}
      <section id="faq" className="landing-section faq-sec">
        <h2 className="section-title">Frequently asked questions</h2>

        <div className="faq-list">
          {/* FAQ 1 */}
          <div className={'faq-item' + (openFaq === 0 ? ' open' : '')} onClick={() => setOpenFaq(openFaq === 0 ? null : 0)}>
            <div className="faq-question">
              <span>What is Conduit and who is it built for?</span>
              <span className="faq-toggle">{openFaq === 0 ? '×' : '+'}</span>
            </div>
            {openFaq === 0 && (
              <div className="faq-answer">
                Conduit is a multi-agent control center for professional software engineers who want to run multiple AI coding agents (Claude Code, Codex, Gemini CLI, OpenCode, GPT-OSS on Groq, Nemotron on OpenRouter) side by side in real terminals while retaining full visibility and veto power over actions.
              </div>
            )}
          </div>

          {/* FAQ 2 */}
          <div className={'faq-item' + (openFaq === 1 ? ' open' : '')} onClick={() => setOpenFaq(openFaq === 1 ? null : 1)}>
            <div className="faq-question">
              <span>How do approval gates protect my codebase?</span>
              <span className="faq-toggle">{openFaq === 1 ? '×' : '+'}</span>
            </div>
            {openFaq === 1 && (
              <div className="faq-answer">
                Conduit uses two layers of protection: instant regex pattern detection for dangerous shell commands (like force pushes, rm -rf, drop tables) and periodic Bedrock classification. When a gate triggers, the agent is paused and surfaced in an approval modal—nothing is sent without your confirmation.
              </div>
            )}
          </div>

          {/* FAQ 3 */}
          <div className={'faq-item' + (openFaq === 2 ? ' open' : '')} onClick={() => setOpenFaq(openFaq === 2 ? null : 2)}>
            <div className="faq-question">
              <span>Can agents collaborate and talk to each other?</span>
              <span className="faq-toggle">{openFaq === 2 ? '×' : '+'}</span>
            </div>
            {openFaq === 2 && (
              <div className="faq-answer">
                Yes. Agents in the same project can share context via the Project Wiki (Karpathy's LLM-wiki pattern), access shared folders (`shared_content/`), and communicate directly via MCP tools (`message_agent`, `list_teammates`).
              </div>
            )}
          </div>

          {/* FAQ 4 */}
          <div className={'faq-item' + (openFaq === 3 ? ' open' : '')} onClick={() => setOpenFaq(openFaq === 3 ? null : 3)}>
            <div className="faq-question">
              <span>Is my data private and can I run it locally?</span>
              <span className="faq-toggle">{openFaq === 3 ? '×' : '+'}</span>
            </div>
            {openFaq === 3 && (
              <div className="faq-answer">
                Yes. Conduit runs entirely on your local machine or private cloud instance. All project data, agent transcripts, and audit logs are stored locally under `~/.conduit/`. HTTP Basic Auth (`CONDUIT_AUTH`) protects the dashboard when deployed remotely.
              </div>
            )}
          </div>

          {/* FAQ 5 */}
          <div className={'faq-item' + (openFaq === 4 ? ' open' : '')} onClick={() => setOpenFaq(openFaq === 4 ? null : 4)}>
            <div className="faq-question">
              <span>What platforms is Conduit available on?</span>
              <span className="faq-toggle">{openFaq === 4 ? '×' : '+'}</span>
            </div>
            {openFaq === 4 && (
              <div className="faq-answer">
                The standalone Windows desktop application (`Conduit.exe`) is available for immediate download. Native packages for macOS (Apple Silicon / Intel) and Linux (AppImage / Debian) are currently in build and coming soon. You can also run Conduit on Linux/macOS directly from source with Node 20+.
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Desktop App Download Modal Popup */}
      <DownloadModal isOpen={isDownloadOpen} onClose={() => setIsDownloadOpen(false)} />
    </div>
  );
}
