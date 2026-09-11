import React, { useState } from 'react';
import Ic from './Icons';

export interface FaqItem {
  id: string;
  category: 'all' | 'architecture' | 'safety' | 'collaboration' | 'privacy' | 'platform';
  categoryLabel: string;
  question: string;
  answer: React.ReactNode;
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    id: 'cli-support',
    category: 'architecture',
    categoryLabel: 'Architecture',
    question: 'Does Conduit require special forks, or do my existing CLI agents work directly?',
    answer: (
      <>
        Conduit executes your real, locally-installed CLI tools (such as Claude Code, OpenAI Codex, Gemini CLI, OpenCode, Aider, or custom scripts) in authentic pseudo-terminals (<code>node-pty</code>) on your machine. There are no proprietary wrapper packages or custom agent forks required. Conduit preserves your shell environment, API keys, Git credentials, and command history with full xterm.js terminal emulation and automatic scrollback replay on reconnection.
      </>
    ),
  },
  {
    id: 'safety-gates',
    category: 'safety',
    categoryLabel: 'Safety Loop',
    question: 'How do the Human-in-the-Loop approval gates intercept dangerous commands?',
    answer: (
      <>
        Conduit deploys a dual-tier safety loop: an instant zero-latency regex scanner that intercepts destructive operations (such as <code>git push --force</code>, <code>rm -rf</code>, dropping database tables, or exposing secret keys), combined with an AI classification supervisor. When a gate triggers, the PTY process is suspended immediately in an Approval Gate modal. Nothing is executed in the terminal until you explicitly review the diff and approve it with a time-limited safety lease.
      </>
    ),
  },
  {
    id: 'mcp-collaboration',
    category: 'collaboration',
    categoryLabel: 'Multi-Agent MCP',
    question: 'How do multiple agents communicate, share context, and coordinate tasks with each other?',
    answer: (
      <>
        Agents communicate peer-to-peer using Conduit&apos;s session-scoped Model Context Protocol (MCP) server over JSON-RPC stdio. Agents can discover teammates via <code>list_teammates()</code>, message peers directly with <code>message_agent(&quot;codex&quot;, ...)</code>, coordinate in the universal project Group Chat with <code>@all</code> broadcasts, and share verified repository knowledge through the local Project Wiki.
      </>
    ),
  },
  {
    id: 'data-privacy',
    category: 'privacy',
    categoryLabel: 'Privacy & Storage',
    question: 'Is my source code or project data sent to any third-party Conduit servers?',
    answer: (
      <>
        No. Conduit is local-first and self-hosted. All project workspaces, terminal scrollback logs, agent transcripts, and security audit records are stored directly on your disk under <code>~/.conduit/</code>. Conduit never proxies, inspects, or trains on your proprietary codebase. When running Conduit on a remote server, HTTP Basic Authentication (<code>CONDUIT_AUTH</code>) secures your workspace.
      </>
    ),
  },
  {
    id: 'layouts',
    category: 'architecture',
    categoryLabel: 'Window Layouts',
    question: 'What terminal layouts and multiplexing options are supported?',
    answer: (
      <>
        Conduit provides 5 persistent multi-agent window layouts: Single agent focus, 2-up split, 3-up column split, 2x2 tmux-style grid with draggable splitters, and a freeform window canvas. Your chosen layout, terminal dimensions, and working directories are automatically saved per repository and restored whenever you re-open the workspace.
      </>
    ),
  },
  {
    id: 'voice',
    category: 'architecture',
    categoryLabel: 'Voice Pipeline',
    question: 'How does the Push-to-Talk voice pipeline work?',
    answer: (
      <>
        Pressing <code>⌘;</code> (or <code>Ctrl+;</code> on Windows/Linux) activates the push-to-talk voice cockpit. Conduit captures audio via browser Web Speech or custom speech endpoints, transcribes your instruction in real time, routes it to the targeted agent or broadcast channel, and provides synthesized audio confirmation upon completion.
      </>
    ),
  },
  {
    id: 'platforms',
    category: 'platform',
    categoryLabel: 'Platforms & Setup',
    question: 'What operating systems are supported and how do I install Conduit?',
    answer: (
      <>
        Conduit is available as a standalone desktop application for Windows (<code>Conduit-Setup.exe</code>), with native macOS and Linux packages downloadable from GitHub Releases. You can also run Conduit as a local web server on any operating system by cloning the repository and running <code>npm install &amp;&amp; npm run dev</code> with Node.js 20+.
      </>
    ),
  },
];

const CATEGORIES = [
  { id: 'all', label: 'All Questions' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'safety', label: 'Safety Loop' },
  { id: 'collaboration', label: 'Multi-Agent MCP' },
  { id: 'privacy', label: 'Privacy & Storage' },
  { id: 'platform', label: 'Platforms & Setup' },
];

export const FaqSection: React.FC = () => {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set(['cli-support']));
  const [activeCategory, setActiveCategory] = useState<string>('all');

  const toggleItem = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const filteredItems = activeCategory === 'all'
    ? FAQ_ITEMS
    : FAQ_ITEMS.filter((item) => item.category === activeCategory);

  return (
    <section id="faq" className="landing-section faq-sec">
      <div className="faq-section-wrapper">
        {/* Eyebrow badge */}
        <div className="faq-eyebrow">
          <Ic.help size={13} />
          <span>FREQUENTLY ASKED QUESTIONS</span>
        </div>

        {/* Section Title */}
        <h2 className="section-title faq-title">
          Everything you need to know about <span className="highlight-pill animated-highlight">Conduit</span>
        </h2>
        <p className="faq-subtitle">
          Clear answers on architecture, safety gates, multi-agent coordination, and local privacy.
        </p>

        {/* Category Filter Pills */}
        <div className="faq-filter-track">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={`faq-filter-pill ${activeCategory === cat.id ? 'active' : ''}`}
              onClick={() => setActiveCategory(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Accordion List */}
        <div className="faq-accordion-list">
          {filteredItems.map((item) => {
            const isOpen = openIds.has(item.id);
            return (
              <div
                key={item.id}
                className={`faq-card ${isOpen ? 'is-open' : ''}`}
                onClick={() => toggleItem(item.id)}
              >
                <div className="faq-card-header">
                  <div className="faq-card-title-group">
                    <span className="faq-card-badge">{item.categoryLabel}</span>
                    <h3 className="faq-card-question">{item.question}</h3>
                  </div>
                  <div className={`faq-card-chevron-wrap ${isOpen ? 'open' : ''}`}>
                    <Ic.chevDown size={14} className="faq-chevron-svg" />
                  </div>
                </div>

                <div className={`faq-card-collapse ${isOpen ? 'open' : ''}`}>
                  <div className="faq-card-content">
                    <div className="faq-card-body">{item.answer}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default FaqSection;
