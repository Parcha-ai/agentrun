---
name: html-app-architecture
description: Build a self-contained HTML page or app - one file with inline CSS and JavaScript, libraries from pinned CDN versions, responsive, accessible and interactive. Load it right before building a website, a dashboard, an interactive tool or any HTML deliverable.
---

# HTML app architecture

Build the run's page as one self-contained HTML file: the run's output names it (`index.html` for a website,
`dashboard.html` for a dashboard). It opens straight from the workspace in any browser, with no build step and no
install.

## Principles

1. **Self-contained.** One HTML file with inline CSS and JavaScript. Images and media sit beside it in the workspace and
   are referenced by relative path.
2. **Libraries from a CDN, pinned.** Load each at a pinned major version (below), never `@latest`, so the page renders
   the same tomorrow.
3. **Responsive.** Mobile first; it works from a phone's width to a wide screen.
4. **Interactive where it helps.** Sorting, filtering, tabs, toggles and drill-downs that serve the content, not
   decoration.
5. **Accessible.** Semantic elements (`header`, `nav`, `main`, `section`, `button`), text contrast of at least 4.5:1,
   every control reachable and usable from the keyboard with a visible focus style, `alt` text on images, and
   `prefers-reduced-motion` honored.

## Design before CSS

Choose the look before writing any CSS: a font pair, a palette and a layout that suit the content. If the run also has
the anti-slop-design skill, follow its selection steps now. Either way, do not ship the generic default (a plain system
or Inter-style sans on a pale grey page, centered everything, identical cards): it reads as unconsidered. Put the
choices in CSS variables so the theme lives in one place.

## Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Page title</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=HEADING_FONT:wght@700&family=BODY_FONT:wght@400;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #...; --surface: #...; --text: #...; --muted: #...; --accent: #...; --border: #...;
      --font-heading: 'HEADING_FONT', serif; --font-body: 'BODY_FONT', sans-serif;
      --space: clamp(1rem, 2.5vw, 2rem);
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: var(--font-body); background: var(--bg); color: var(--text); line-height: 1.55; }
    h1, h2, h3 { font-family: var(--font-heading); line-height: 1.1; }
    a { color: var(--accent); }
    :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
  </style>
</head>
<body>
  <header>...</header>
  <main>...</main>
  <footer>Sources and the date of the data</footer>
  <script>
    // Page logic here: data first, then rendering, then event handlers.
  </script>
</body>
</html>
```

Plain CSS with variables is enough for most pages. For utility classes, the Tailwind play CDN
(`https://cdn.tailwindcss.com`) works in a single file; configure it in a `tailwind.config = {...}` script and keep
the theme's colors in the same variables.

## CDN libraries

| Library | Load from | Use it for |
|---|---|---|
| Chart.js 4 | `https://cdn.jsdelivr.net/npm/chart.js@4` | standard charts (turn animation off) |
| D3 7 | `https://cdn.jsdelivr.net/npm/d3@7` | custom and complex visualizations |
| Leaflet 1.9 | `https://unpkg.com/leaflet@1.9.4/dist/leaflet.js` and `.../leaflet.css` | maps |
| Three.js | `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js` (as a module) | 3D |
| Prism 1 | `https://cdn.jsdelivr.net/npm/prismjs@1/prism.min.js` and a theme CSS | code highlighting |
| Lucide | `https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js` | icons |
| Google Fonts | `https://fonts.googleapis.com/css2?...` | typography |

Load only what the page uses. Put scripts at the end of `body`, or mark them `defer`.

## Assets

- Save images, audio and video in the workspace beside the HTML and reference them by relative path:
  `<img src="hero.png" alt="...">`.
- Never use a signed or expiring URL, or an image hotlinked from another site: it breaks later.
- Inline a small icon or diagram as SVG markup; it scales and needs no file.

## In-page navigation

A page may be shown inside a frame or with a `<base>` element, where `href="#section"` can navigate away instead of
scrolling. Scroll with script:

```html
<button type="button" data-target="findings">Findings</button>
<script>
document.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', () =>
  document.getElementById(b.dataset.target).scrollIntoView({ behavior: 'smooth', block: 'start' })));
</script>
```

## Light and dark

Define the palette for both schemes when the content suits it:

```css
@media (prefers-color-scheme: dark) { :root { --bg: #...; --surface: #...; --text: #...; } }
```

Check contrast in both.

## Responsive layout

```css
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: var(--space); }
.split { display: grid; grid-template-columns: 3fr 2fr; gap: var(--space); }
@media (max-width: 760px) { .split { grid-template-columns: 1fr; } }
```

Images get `max-width: 100%; height: auto;`, long tables sit in a container with `overflow-x: auto`, and text
measures stay readable (`max-width: 70ch` for long prose).

## Content

Facts on the page are sourced like any other deliverable: link each figure or claim to the page it came from, and end
with a sources list and the date of the data. Write real content from the run's research; never ship placeholder text
("Lorem ipsum", "Company Name").

## Before you finish

- [ ] One file that opens on its own; assets by relative path; CDN libraries pinned.
- [ ] A deliberate look: fonts, palette and layout chosen for this content, held in CSS variables.
- [ ] Works at a phone's width and a wide screen; nothing overflows sideways.
- [ ] Keyboard reachable, visible focus, contrast checked, reduced motion honored.
- [ ] Real, sourced content, with a sources list.
