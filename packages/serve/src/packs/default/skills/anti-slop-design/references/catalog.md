# Catalog: font pairs, palettes and layouts

Choose one font pair, one palette and one layout per page. Do not mix pairs or palettes within a page.

## Font pairs (Google Fonts)

| Pair | Mood | Heading | Body | Suits |
|---|---|---|---|---|
| Industrial | engineering, dense, functional | Space Grotesk 700 | IBM Plex Sans 400/500 | dashboards, tools, technical reports |
| Editorial | magazine, long-form | Playfair Display 900 | Source Sans 3 400/600 | articles, brand sites, reports |
| Poster | signage, bold headlines | Bebas Neue 400 | Work Sans 400/500 | landing pages, event pages |
| Raw | zine, protest poster, maximum impact | Archivo Black 400 | Space Grotesk 400/500 | bold landing pages, tools |
| Swiss | grids, systematic, one family | DM Sans 800 | DM Sans 400/500 | data explorers, minimal dashboards |
| Studio | creative agency, experimental | Syne 700/800 | Inter Tight 400/500 | portfolios, brand sites |
| Scholarly | academic press, warm authority | Fraunces 900 | Outfit 400/500 | research sites, reports |
| Technical | developer documentation | JetBrains Mono 700 | Manrope 400/500 | developer tools, technical docs |
| Crafted | texture, personality | Bricolage Grotesque 800 | Karla 400/500 | brand and creative pages |
| Monumental | architecture, public signage | Oswald 700 | Lato 400/700 | data-heavy sites, event pages |

Load a pair in one link, for example:
`<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,900&family=Outfit:wght@400;500&display=swap" rel="stylesheet">`

## Palettes

| Palette | Mood | `--bg` | `--surface` | `--text` | `--accent` | Chart colors |
|---|---|---|---|---|---|---|
| Ink and Crimson | urgent, high stakes, dark | `#0a0a0a` | `#1a1a1a` | `#f1faee` | `#e63946` | `#e63946 #457b9d #f1faee #a8dadc #1d3557` |
| Concrete and Saffron | cool grey with gold | `#edf2f4` | `#ffffff` | `#2b2d42` | `#edb230` | `#2b2d42 #edb230 #8d99ae #ef233c #5c677d` |
| Forest and Copper | organic authority on parchment | `#f5f0eb` | `#ffffff` | `#1b3a2d` | `#c17f59` | `#1b3a2d #c17f59 #6b8f71 #d4a373 #3a5a40` |
| Electric Midnight | command centre, dark | `#0d1b2a` | `#1b2838` | `#e0e1dd` | `#00f5d4` | `#00f5d4 #f15bb5 #fee440 #9b5de5 #00bbf9` |
| Paper and Carbon | warm paper, black structure | `#fafaf9` | `#ffffff` | `#18181b` | `#18181b` | `#18181b #dc2626 #2563eb #ca8a04 #16a34a` |
| Rust and Slate | workshop, utilitarian warmth | `#f8fafc` | `#ffffff` | `#0f172a` | `#ea580c` | `#0f172a #ea580c #64748b #0891b2 #a16207` |
| Harbor | maritime, steady, institutional | `#f2efe8` | `#ffffff` | `#102a43` | `#0e7490` | `#102a43 #0e7490 #c2410c #829ab1 #f0b429` |
| Bone and Charcoal | printmaking, warm minimal | `#faf7f2` | `#ffffff` | `#292524` | `#b45309` | `#292524 #b45309 #78716c #0f766e #9f1239` |

Add `--muted` (a mid-tone of the text color with 4.5:1 contrast on `--bg`) and `--border` to each. A dark palette
suits monitoring and dramatic subjects; a light one suits reading. With an accent equal to the text color, emphasis
comes from weight and rules rather than color.

## Layouts

**Websites and landing pages**
- *Asymmetric split*: a hero on `grid-template-columns: 3fr 2fr`, sections alternating `3fr 2fr` and `2fr 3fr`.
- *Full-bleed editorial*: full-width bands of color or image between a measured text column.
- *Magazine grid*: a narrow label column and three content columns (`200px repeat(3, 1fr)`), tall items spanning two
  rows.

**Dashboards**
- *Command centre*: a KPI bar across the top (`repeat(5, 1fr)`), then a lead chart and a side column (`2fr 1fr`).
- *Narrative dashboard*: sections in reading order, each a finding as a heading, its chart, and two lines of
  explanation.

**Data explorers**
- *Console*: a sticky filter sidebar (`280px 1fr`) and a main area that scrolls on its own.
- *Card gallery*: filter chips above a grid of entity cards, each opening a detail panel.

**Articles and long report pages**
- *Long-form editorial*: a prose column (`max-width: 70ch`) with pull quotes, figures and tables breaking out wider.
- *Annotated report*: a main column with margin notes and sources beside the paragraphs they support.
