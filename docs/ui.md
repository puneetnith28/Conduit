# UI & Design System

React 18 + Vite, xterm.js for terminals, no component library. `client/src/styles.css` is
one file of CSS custom properties and plain selectors.

## The screen

| Part | What it is |
|---|---|
| **Sidebar** | Projects, and the agents inside each. A coloured dot per agent. |
| **Keeper bar** | Ask about everything, across all projects. |
| **Search** | `⌘K` command palette. |
| **Usage** | Claude and Codex subscription burn — session %, week %, reset times. |
| **Status bar** | How many agents are running, and whether the UI is connected to the daemon. |

## The seven tabs

| Tab | For |
|---|---|
| **Terminals** | A real terminal per agent. Five layouts: `single`, `2up`, `3up`, `grid`, `canvas`. |
| **MCP Messages** | Messages agents send each other directly. |
| **Group Chat** | One conversation per project. `@name` targets one agent. Supervisor summaries land here, labelled. |
| **Shared** | The folder every agent can read and write. |
| **Wiki** | Long-term project memory. |
| **Activity** | Everything that happened, filterable by `all / messages / files / lifecycle`. |
| **Usage** | The subscription numbers, full size. |

## Shortcuts

| Keys | Does |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette |
| `⌘J` / `Ctrl+J` | The Keeper |
| `⌘1`–`⌘5` | Focus agent 1–5 |
| `y` / `n` / `Esc` | In a gate: approve / reject / close |

## Colour

The palette is light — a warm neutral, not white. Defined once on `:root`:

```css
--bg-0: #faf8f5;   /* canvas, warm sand */
--bg-1: #ffffff;   /* cards */
--bg-2: #f4f1ea;   /* secondary surface */
--text-0: #0f0f11; /* high-contrast charcoal */
--text-1: #3f3f46; /* 6.2:1 on --bg-0 */
--text-2: #5c5c66; /* 5.4:1 */
--text-3: #656570;
--ok:  #15803d;
--err: #c81e1e;
```

Every text step is measured against the surface it actually lands on, not the lightest one.
`--text-1` moved from `#71717a` because at 4.6:1 it passed only just, and once `--text-3`
was corrected the two steps were within 0.15 of each other and stopped reading as a
hierarchy.

There is **no theme toggle**. The selector `[data-theme="dark"]` exists in the stylesheet
but nothing ever sets the attribute — the app ships light.

## Terminals

xterm.js, JetBrains Mono, with two settings worth knowing:

```ts
theme: wantsDark() ? DARK_THEME : LIGHT_THEME,
minimumContrastRatio: 7,
scrollback: 5000,
```

`minimumContrastRatio: 7` forces xterm to adjust 256-colour palette entries so agent output
stays legible on a light background. Without it, an agent printing dim grey is invisible.

`FitAddon` measures the **parent's border-box** width and never subtracts its padding — so
terminal gutters go on `.xterm`, not on `.terminal-container`. Putting them on the
container makes the terminal overflow by exactly the padding.

## Layout is measured, not looked at

```bash
npm run check:layout
```

Drives the real UI in Chrome at **four widths** — phone 390, tablet 768, laptop, desktop
1600 — across **11 surfaces**, and reports:

| Defect | Meaning |
|---|---|
| `OVERFLOW` | Content wider than its container |
| `CLIPPED` | Text cut off |
| `OVERLAP` | Two elements on top of each other |
| `OFFSCREEN` | Positioned outside the viewport |
| `TINY` | A tap target under 24×24 (WCAG 2.5.8) |
| `CONTRAST` | Small text under 4.5:1 |

A monospace character is about five pixels in a downscaled screenshot, which is why this is
a script and not a person squinting. It catches real things: the landing footer added
recently put three targets at 22, 20 and 16 pixels tall, and the audit found all ten
occurrences before anyone tapped one.

## Markdown

Everything rendered from model or agent text goes through `renderMarkdown` in
`client/src/utils/md.ts` — `marked` piped into DOMPurify. Agent output is untrusted input
arriving at a browser.

## Screenshots

```bash
npm run screenshots
```

Drives the real UI in a real browser against a running instance: seeds a project, starts
real agents, shoots each surface, then deletes what it made. The README images cannot drift
from what Conduit actually renders, and none of them are mock-ups.

## Icons

One source — `client/public/conduit1.png` — and `npm run icons` derives:

| File | Size |
|---|---|
| `favicon-16.png` | 16px, 0.5 KB |
| `favicon-32.png` | 32px, 1.0 KB |
| `apple-touch-icon.png` | 180px, 15 KB |
| `logo-128.png` | 128px, the in-app mark |
| `favicon.ico` | a real ICO container, 16/32/48 |
| `build/icon.png` | 1024px, for electron-builder |

They were all copies of the same 1254×1254, 916 KB PNG — so a browser asking for a
16-pixel icon downloaded most of a megabyte, and `favicon.ico` was a PNG wearing an `.ico`
extension. Rerun `npm run icons` after replacing the source and the derived sizes stay
honest.

Brand icons for the ecosystem section live in `client/public/icons/*.svg` and carry their
own fills.
