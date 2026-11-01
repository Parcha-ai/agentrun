---
name: anti-slop-design
description: Make a web page look designed for its content rather than generated - choose a font pair, a palette and a layout on purpose before any CSS, and check the result against the common generated-look traps. Load it right before building a website, a landing page, an article page or a data explorer.
---

# Anti-slop design

Generated web pages drift toward one look: a plain sans-serif on a pale grey page, a centered hero, a row of identical
rounded cards, a purple accent. Readers recognize it at a glance and read it as low effort. This skill makes every
choice a decision instead of a default, so two pages on different subjects never look alike.

## The rules

1. **Decide the mood first.** Before any CSS, name the page's character in a few words (industrial, editorial,
   scholarly, technical, warm, urgent) from the subject and the audience. Every later choice follows from it.
2. **Every visual choice is made, not inherited.** Font, palette, spacing, layout and decoration each come from the
   mood. Quiet and restrained is as valid as loud and dense; what fails is the unconsidered middle.
3. **Pick one structural system and hold it everywhere.** Decide the corner radius (sharp, or one radius used
   throughout), the case of headings and labels, the weight scale, whether surfaces use borders or shadows. Then apply
   it to every element. Mixed systems look accidental.
4. **Vary across builds.** A new page does not reuse the last page's font pair and palette unless the brief asks for a
   house style.

## Selection steps (before writing CSS)

1. **Font pair.** Choose one pair from `references/catalog.md` (or one of equal character) that fits the mood. The
   heading font sets the voice; the body font must read comfortably at length. Load both from Google Fonts in one
   `<link>`.
2. **Palette.** Choose one palette from the catalog, or build one: a dominant ground, a surface, a text color with
   4.5:1 contrast on both, a muted text color, one accent used sparingly for emphasis and interaction, a border color,
   and five chart colors that stay distinguishable. Put them in `:root` variables.
3. **Layout.** Choose the pattern for the page type from the catalog: asymmetric splits and editorial grids for
   websites, a lead-panel layout for dashboards, a sidebar console for data explorers, a measured column with
   breakouts for articles.
4. **Check the traps** below before you call the page done.

| Building | Read in the catalog |
|---|---|
| Website or landing page | font pairs, palettes, website layouts |
| Dashboard | font pairs, palettes, dashboard layouts |
| Data explorer | font pairs, palettes, explorer layouts |
| Article or long report page | font pairs, palettes, article layouts |
| Slide deck | the slides skill's own styles instead |

## Defaults to avoid

- **As heading fonts:** Inter, Roboto, Arial, Open Sans, Poppins, Montserrat, or the system font stack. (They are fine
  body faces in a deliberate pair; as the page's voice they say nothing.)
- **As the scheme:** a pale grey page background with white cards, purple or indigo on white, a gradient for its own
  sake.
- **As the layout:** everything centered; a uniform grid of identical cards; the same hero (big centered heading,
  grey subtitle, two buttons) whatever the subject; identical dividers between every section.
- **As detail:** monospace for all text; black and white only, with no accent; every chart in one hue.

## The traps (check before finishing)

1. **The clone hero.** Does the opening look like any other site's? Give it the subject's own shape: an oversized key
   figure, an offset block in the accent, a split with a real image or chart.
2. **The grey void.** Is the page mostly pale grey and white? Commit to the palette's ground and surfaces.
3. **The card factory.** Are there rows of same-size cards? Vary size by importance; let one item lead.
4. **The identical table.** Is every table the default look? Align numbers right, give the header the heading font,
   zebra or rule the rows to suit the palette.
5. **The black box.** Is the accent unused, so everything is black, white and grey? Use it for emphasis, links, the key
   figure and interactive states.
6. **The system font.** Did a font fail to load, or was none chosen? Check the `<link>` and the `font-family` values.
7. **The border monotone.** Is every element boxed by the same thin grey border? Use the structural system: strong
   rules where structure matters, none where it does not.
8. **The mono chart.** Is every series one color? Use the palette's chart colors, one per series, the same across the
   page.

## Example

```html
<!-- Default look: avoid -->
<body style="font-family: Inter, sans-serif; background: #f9fafb;">

<!-- Chosen: an industrial mood (Space Grotesk and IBM Plex Sans, a slate and burnt-orange palette, sharp corners) -->
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root { --bg: #f8fafc; --surface: #ffffff; --text: #0f172a; --muted: #475569; --accent: #ea580c; --border: #0f172a; }
  * { border-radius: 0; }
  h1, h2, h3, nav { font-family: 'Space Grotesk', sans-serif; font-weight: 700; letter-spacing: -0.01em; }
  body { font-family: 'IBM Plex Sans', sans-serif; background: var(--bg); color: var(--text); }
</style>
```
