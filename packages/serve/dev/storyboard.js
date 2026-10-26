// The storyboard's screens: what each is, its components, the states it must handle, and where the sample data has each
// state. The frames are the live page at that route.
(function () {
  "use strict";
  var BASE = ["empty", "loading", "error", "long text", "phone width (390)", "dark"];

  /** Picks a run of the sample data for a state; `null` when it has none. */
  function find(runs, test) {
    var run = runs.filter(test)[0];
    return run ? "#/runs/" + encodeURIComponent(run.run_id) : null;
  }

  function screens(runs) {
    var of = function (agent, test) { return find(runs, function (r) { return r.agent_id === agent && test(r); }); };
    return [
      {
        name: "Shell", route: "#/", what: "Brand, breadcrumbs, the pages' links, the theme switch; the locked page without a cookie.",
        components: ["Header and breadcrumbs", "Navigation (Agents, All runs, New agent)", "Theme switch: light, dark, auto", "Locked page (no cookie)", "Slot: account menu (hosted)"],
        states: BASE.concat(["no cookie: the locked page"]),
      },
      {
        name: "Agents", route: "#/", frames: ["#/", "#/?archived=1"],
        what: "Every agent as a card: name, kind, description, run count. Archived ones behind Show archived.",
        components: ["Agent card", "Kind badge (agentic, workflow)", "Archived toggle", "Empty state: what to do on a new server"],
        states: BASE.concat(["archived shown", "an agent with no runs"]),
      },
      {
        name: "All runs", route: "#/runs", frames: ["#/runs", "#/runs?status=failed"],
        what: "Every run of every agent, newest first, filtered by agent and state; archived behind Show archived.",
        components: ["Runs table", "Status badge", "Cost cell (estimate, unknown)", "Filters: agent, state", "Pager (100 a page)"],
        states: BASE.concat(["queued", "working", "input_required", "completed", "failed", "cancelled", "archived"]),
        examples: {
          working: of("meeting-notes", function (r) { return r.state === "working"; }),
          input_required: of("invoice-checker", function (r) { return r.status === "input_required"; }),
          failed: of("release-notes", function (r) { return r.status === "failed"; }),
          cancelled: of("support-triage", function (r) { return r.status === "cancelled"; }),
        },
      },
      {
        name: "Agent", route: "#/agents/{id}", frames: ["#/agents/invoice-checker", "#/agents/support-triage"],
        what: "The agent's card and actions, Start a run, its runs filtered by revision, its revisions newest first with what changed.",
        components: ["Agent card with Edit and Archive", "Start a run: input, revision picker", "Runs table with revision filter", "Revision list: note, current, Make current", "Prompt diff (agentic)", "Workflow graph and its diff (workflow)", "Tools and skills changed"],
        states: BASE.concat(["one revision", "many revisions", "workflow revision", "archived agent: no new runs", "a revision that cannot run here (warnings)"]),
      },
      {
        name: "New agent and Edit", route: "#/new, #/agents/{id}/edit", frames: ["#/new", "#/agents/invoice-checker/edit"],
        what: "A prompt or a workflow's JSON, a model and thinking for a prompt, the tools the server binds; Save commits a revision.",
        components: ["Kind tabs: prompt, workflow", "Model picker (from capabilities)", "Thinking level", "Tools checklist (from capabilities)", "Skills", "Warnings before leaving", "Field errors (422 by field)", "Conflict (412): someone saved first"],
        states: BASE.concat(["422 by field", "412 conflict", "save with warnings"]),
      },
      {
        name: "Run (agentic)", route: "#/runs/{id}",
        what: "Status, cost, revision, the answer, and the timeline: input, thinking, tool calls, questions, answers; followed live until final.",
        components: ["Run header: status, started, took, cost, tool calls", "Answer (Markdown: tables, lists)", "Timeline rows: input, thinking, tool call, tool result, waiting, answer, error", "Answer box for ask_person", "Stop, Cancel, Archive", "Live follow (long poll or SSE)", "Files the run wrote (/runs/{id}/files)"],
        states: BASE.concat(["working (live)", "waiting on the person", "stopped (idle)", "follow-up after a stop", "completed with tool calls", "failed: model error", "failed: spend cap", "cancelled", "archived"]),
        examples: {
          "working (live)": of("meeting-notes", function (r) { return r.state === "working"; }),
          "waiting on the person": of("invoice-checker", function (r) { return r.status === "input_required"; }),
          "follow-up after a stop": of("meeting-notes", function (r) { return /whiteboard/.test(r.title); }),
          "completed with tool calls": of("release-notes", function (r) { return r.status === "completed" && r.agent_version === 2; }),
          "failed: model error": of("release-notes", function (r) { return r.status === "failed"; }),
          "failed: spend cap": of("invoice-checker", function (r) { return r.error && r.error.code === "spend_cap_reached"; }),
          cancelled: of("meeting-notes", function (r) { return r.status === "cancelled"; }),
        },
      },
      {
        name: "Run (workflow)", route: "#/runs/{id}",
        what: "The path the workflow took through its graph, each node's state, an escalation, and the output.",
        components: ["Workflow graph with node states", "Escalation notice", "Output (JSON, or Markdown)"],
        states: BASE.concat(["working", "completed", "escalated", "cancelled"]),
        examples: {
          working: of("support-triage", function (r) { return r.status === "queued" || r.status === "working"; }),
          completed: of("lead-scorer", function (r) { return r.status === "completed"; }),
          escalated: of("support-triage", function (r) { return r.error && r.error.code === "escalated"; }),
          cancelled: of("support-triage", function (r) { return r.status === "cancelled"; }),
        },
      },
      {
        name: "Usage", route: "(missing)", missing: true,
        what: "Spend by agent, day and meter from GET /v2/usage, with unpriced runs counted, never shown as $0.",
        components: ["Totals", "By agent, by day", "Unpriced runs"],
        states: BASE.concat(["no runs yet", "unpriced runs"]),
      },
      {
        name: "Server", route: "(missing)", missing: true,
        what: "What this server can do, from GET /v2/capabilities: the models of each tier, the tools it binds, what is not set up yet.",
        components: ["Models by tier", "Tools", "Not set up here: what to set where the server starts"],
        states: BASE,
      },
      {
        name: "API", route: "(missing)", missing: true,
        what: "The /v2 routes with a request builder, curl and SDK snippets, and the base URL and token to copy.",
        components: ["Route list", "Request builder", "Snippets: curl, TypeScript", "Base URL and token"],
        states: BASE,
      },
      {
        name: "Account, organization, keys, billing", route: "(hosted)", hosted: true,
        what: "Hosted only, through the page's slots: sign-in, the organization switcher, API keys, spend caps and invoices.",
        components: ["Slot: account menu", "Slot: settings pages", "Slot: run actions"],
        states: BASE,
      },
    ];
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    for (var key in attrs || {}) if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, attrs[key]);
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child == null) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function frame(hash, width, height, scale) {
    var iframe = el("iframe", { src: "/" + hash, title: hash + " at " + width, loading: "lazy" });
    iframe.style.width = width + "px";
    iframe.style.height = height + "px";
    iframe.style.transform = "scale(" + scale + ")";
    var box = el("div", { class: "frame" }, el("div", { class: "label" }, hash + " · " + width + "px"), iframe);
    box.style.width = Math.round(width * scale) + "px";
    box.style.height = Math.round(height * scale) + 25 + "px";
    return box;
  }

  function list(items) {
    return el.apply(null, ["ul", null].concat(items.map(function (item) { return el("li", null, item); })));
  }

  function draw(runs) {
    var box = document.getElementById("screens");
    box.textContent = "";
    screens(runs).forEach(function (screen) {
      var examples = screen.examples || {};
      var states = screen.states.map(function (state) {
        if (!(state in examples)) return el("li", null, state);
        return examples[state] ? el("li", null, el("a", { href: "/" + examples[state], target: "_blank" }, state)) : el("li", null, state + " ", el("span", { class: "none" }, "(needs data)"));
      });
      var hashes = screen.frames || (screen.examples ? Object.keys(examples).map(function (k) { return examples[k]; }).filter(Boolean).slice(0, 2) : screen.missing || screen.hosted ? [] : [screen.route]);
      box.appendChild(
        el("section", { class: "screen" },
          el("h2", null, screen.name, screen.missing ? el("span", { class: "tag missing" }, "missing") : null, screen.hosted ? el("span", { class: "tag hosted" }, "hosted") : null),
          el("div", { class: "route" }, screen.route),
          el("p", null, screen.what),
          el("div", { class: "cols" },
            el("div", null, el("h3", null, "Components"), list(screen.components)),
            el("div", null, el("h3", null, "States"), el.apply(null, ["ul", null].concat(states))),
            el("div", null, el("h3", null, "Frames"), hashes.length ? list(hashes) : el("p", { class: "none" }, "Not on the page yet."))
          ),
          el.apply(null, ["div", { class: "frames" }].concat(hashes.slice(0, 2).reduce(function (all, hash) { return all.concat([frame(hash, 1280, 900, 0.45), frame(hash, 390, 844, 0.6)]); }, [])))
        )
      );
    });
  }

  function runsOf(query) {
    return fetch("/v2/runs?limit=100" + query, { credentials: "same-origin", cache: "no-store" }).then(function (res) {
      if (res.status === 401) throw Object.assign(new Error("no cookie"), { locked: true });
      return res.json();
    }).then(function (body) { return body.runs; });
  }

  Promise.all([runsOf(""), runsOf("&archived=true")]).then(function (pages) { draw(pages[0].concat(pages[1])); }, function (error) {
    if (error.locked) document.getElementById("cookie").hidden = false;
    draw([]);
  });
})();
