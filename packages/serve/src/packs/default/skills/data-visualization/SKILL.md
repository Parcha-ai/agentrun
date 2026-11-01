---
name: data-visualization
description: Build charts, data tables and dashboards in a self-contained HTML page with Chart.js or D3, from sourced data. Load it right before building a dashboard or any page whose job is to show data.
---

# Data visualization

Build interactive charts, tables and dashboards inside one self-contained HTML page (the html-app-architecture skill
covers the page itself). The run's output names the file: `dashboard.html` for a dashboard.

## Data first

- Every number on the page comes from the run's research: a source you fetched, an input file, or a calculation you
  made from those and kept under `data/`. Never invent values to fill a chart or round out a series.
- Keep the data in one `const DATA = {...}` block near the top of the script, each series with its unit and its
  source, and draw every chart and table from it, so one fix updates every view.
- Each chart or panel shows its unit, its period and a short linked source line (`Source: [Publication, date](url)`).
  A derived figure says it is derived.
- Missing data stays missing: a gap in a line, an empty cell marked "n/a", never a guessed value.

## Chart.js

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<div class="chart-box"><canvas id="revenue"></canvas></div>
<script>
// Animations off: a page with several charts and live resizing can otherwise loop and spike memory.
Chart.defaults.animation = false;
// Chart.js does not read CSS variables: resolve the theme's colors once.
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
new Chart(document.getElementById('revenue'), {
  type: 'bar',
  data: { labels: DATA.revenue.labels, datasets: [{ label: 'Revenue ($M)', data: DATA.revenue.values, backgroundColor: css('--accent') }] },
  options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { position: 'top' } } },
});
</script>
```

Give the canvas a parent with a set height (`.chart-box { position: relative; height: 320px; }`); with
`maintainAspectRatio: false` the chart fills it.

| Type | Use it for |
|---|---|
| `bar` | comparing categories; horizontal (`indexAxis: 'y'`) when labels are long |
| `line` | a trend over time |
| `doughnut` | a share of a whole, five parts or fewer |
| `scatter` | a relationship between two measures |
| `bubble` | three measures at once |
| `radar` | a profile across a few dimensions, for two or three items |

Choose by the question the chart answers, not by variety. Label the axes with units, start a bar chart's value axis at
zero, and give each series a color that stays the same across every chart on the page.

## D3, for what Chart.js cannot draw

Use D3 for maps, networks, hierarchies (treemaps, sunbursts) and custom layouts:

```html
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<div id="viz"></div>
<script>
const width = 640, height = 400;
const svg = d3.select('#viz').append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img').attr('aria-label', 'What the chart shows');
// scales from DATA, then axes, then marks
</script>
```

A `viewBox` with no fixed width lets the drawing scale with its container.

## Dashboard layout

Lead with the few numbers that matter, then the charts that explain them, then the detail.

```html
<section class="kpis">
  <div class="kpi"><p class="kpi-label">Total revenue, 2025</p><p class="kpi-value">$2.4M</p><p class="kpi-delta up">+12.5% vs 2024</p></div>
  <!-- three to five KPIs -->
</section>
<section class="panels">
  <div class="panel wide"><h2>Revenue grew every quarter</h2><div class="chart-box"><canvas id="revenue"></canvas></div><p class="source">Source: ...</p></div>
  <div class="panel"><h2>...</h2>...</div>
</section>
```

```css
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; }
.panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 1rem; }
.panel.wide { grid-column: 1 / -1; }
.kpi, .panel { background: var(--surface); border: 1px solid var(--border); padding: 1.25rem; }
```

Title each panel with its finding ("Revenue grew every quarter"), not its topic ("Revenue"). A KPI shows its period and
its comparison. Do not give every panel the same size: let the main chart lead.

## Data tables

A table the reader can sort and filter:

```html
<input id="filter" type="search" placeholder="Filter rows" aria-label="Filter rows">
<table id="rows"><thead><tr><th data-key="name" aria-sort="none"><button type="button">Name</button></th><th data-key="value" aria-sort="none"><button type="button">Value</button></th></tr></thead><tbody></tbody></table>
<script>
let rows = DATA.table.slice(), sortKey = null, ascending = true;
function render() {
  const q = document.getElementById('filter').value.toLowerCase();
  document.querySelector('#rows tbody').innerHTML = rows
    .filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(q)))
    .map((r) => `<tr><td>${r.name}</td><td class="num">${r.value.toLocaleString()}</td></tr>`).join('');
}
document.querySelectorAll('#rows th').forEach((th) => th.querySelector('button').addEventListener('click', () => {
  const key = th.dataset.key;
  ascending = sortKey === key ? !ascending : true; sortKey = key;
  rows.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (ascending ? 1 : -1));
  document.querySelectorAll('#rows th').forEach((h) => h.setAttribute('aria-sort', h === th ? (ascending ? 'ascending' : 'descending') : 'none'));
  render();
}));
document.getElementById('filter').addEventListener('input', render);
render();
</script>
```

Right-align numbers (`.num { text-align: right; font-variant-numeric: tabular-nums; }`) and escape any text that came
from a source before you put it in `innerHTML`.

## Before you finish

- [ ] Every number traces to a source or a kept calculation, and each panel names its source.
- [ ] Axes carry units; bar charts start at zero; colors stay consistent per series.
- [ ] Charts resize with the page, and the page works at a phone's width.
- [ ] The file opens on its own: libraries from a CDN at a pinned major version, data inline.
