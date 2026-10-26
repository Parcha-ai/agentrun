// agentrun-serve's own views on the store's page, as a classic script loaded before page.js: every run across the
// agents, the forms that write through /v2 (a new agent, a new revision, the current revision, a new run), and a run
// followed live through /v2's timeline until it is final. It draws with page.js's parts, which page.js hands to
// window.agentStoreHost, and sends every write as JSON from this origin: what lets the page's cookie stand in for the
// token. Values from the API reach the page as text nodes and input values only.
(function () {
  "use strict";
  var STATUSES = ["queued", "working", "input_required", "completed", "failed", "cancelled"];
  var STATUS_CLASS = { queued: "live", working: "live", input_required: "escalated", completed: "ok", failed: "error", cancelled: "stopped" };
  var LONG_POLL_MS = 25000;
  /** What each refusal means, in words, by its code. */
  var REFUSALS = {
    agent_not_runnable: "This agent can't run here",
    input_invalid: "Some of it needs a change",
    not_continuable: "This run has ended",
    not_found: "It is not here",
    precondition_failed: "Someone changed it first",
    unauthenticated: "This page is signed out; open the link the server printed",
    rate_limited: "The server is busy; try again in a moment",
    spend_cap_reached: "The run reached its spending limit",
    unsupported_here: "This server does not offer that",
    unavailable: "The server is not ready; try again in a moment",
  };
  /** What seeds the showcase agents and their runs into the server the compose file starts. */
  var SHOWCASE = "docker compose -f packages/serve/docker/compose.yaml exec agentrun node examples/agentrun-server/showcase.mjs --token-file /data/.token --runs";
  /** The run's own start and end rows, which only a live timeline has: the stored one, and the server, count them as quiet. */
  var QUIET = /:run:(start|end)(~\d+)?$/;

  function enc(part) {
    return encodeURIComponent(part);
  }
  function decoded(part) {
    try {
      return decodeURIComponent(part);
    } catch (e) {
      return part;
    }
  }
  function params(text) {
    var out = {};
    String(text || "").split("&").forEach(function (pair) {
      var at = pair.indexOf("=");
      if (at > 0) out[decoded(pair.slice(0, at))] = decoded(pair.slice(at + 1));
    });
    return out;
  }

  window.agentStoreHost = function (kit) {
    var el = kit.el;
    var following = null;

    /** A /v2 call, JSON both ways. A refusal throws its status and message, with the fields it names. */
    function v2(method, path, body, signal, extra) {
      var headers = { accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      for (var name in extra) if (Object.prototype.hasOwnProperty.call(extra, name)) headers[name] = extra[name];
      return fetch("v2/" + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", credentials: "same-origin", signal: signal }).then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (e) {
            data = null;
          }
          if (res.ok) return data;
          var said = data && data.error && typeof data.error === "object" ? data.error : {};
          var fields = Array.isArray(said.fields) ? said.fields : [];
          var error = new Error(inWords(said.code, fields.length ? "" : said.message));
          error.status = res.status;
          error.code = said.code;
          error.fields = fields;
          throw error;
        });
      });
    }

    /** A refusal as a sentence a person reads: what it means first, then the server's own words; never its status. */
    function inWords(code, message) {
      var lead = REFUSALS[code] || "That did not work";
      return message ? lead + ": " + plainNames(message) : lead + ".";
    }
    /** A field the server names (`definition.model`), as the form calls it (`model`), in a field or in a sentence. */
    function plainNames(text) {
      return String(text || "").replace(/\bdefinition\./g, "");
    }

    function problem(error) {
      var fields = (error && error.fields) || [];
      return el(
        "div",
        { class: "problem", role: "alert" },
        String((error && error.message) || error),
        fields.length ? el("ul", null, fields.map(function (f) { return el("li", null, (f.field ? plainNames(f.field) + ": " : "") + plainNames(f.message || f.reason || "")); })) : null
      );
    }
    function say(box, error) {
      while (box.firstChild) box.removeChild(box.firstChild);
      if (error) box.appendChild(problem(error));
    }

    // ---- controls: each value is set as a property, never as markup ----------------------------------------------------
    function textInput(name, value, placeholder) {
      var node = el("input", { type: "text" });
      node.name = name;
      node.value = value || "";
      node.placeholder = placeholder || "";
      node.autocomplete = "off";
      return node;
    }
    function textArea(name, value, rows, placeholder, code) {
      var node = el("textarea", code ? { class: "code" } : null);
      node.name = name;
      node.value = value || "";
      node.rows = rows;
      node.placeholder = placeholder || "";
      if (code) node.spellcheck = false;
      return node;
    }
    function field(label, control, hint) {
      return el("label", { class: "field" }, el("span", { class: "word" }, label), control, hint ? el("span", { class: "hint" }, hint) : null);
    }
    function button(text, kind, onClick) {
      var node = el("button", { class: "btn" + (kind ? " " + kind : ""), type: "button" }, text);
      node.addEventListener("click", onClick);
      return node;
    }
    /** A run's status; /v2 says "failed" for a run that ended escalated, and its error's code says which, so it is drawn
     *  escalated, as the store's page draws it, never failed. */
    function statusPill(status, error) {
      if (status === "failed" && error && error.code === "escalated") return kit.pill("escalated", "escalated");
      return kit.pill(STATUS_CLASS[status] || "ended", String(status || "").replace("_", " "));
    }

    // ---- every run -----------------------------------------------------------------------------------------------------
    function runsHref(agent, status) {
      var query = [];
      if (agent) query.push("agent=" + enc(agent));
      if (status) query.push("status=" + enc(status));
      return "#/runs" + (query.length ? "?" + query.join("&") : "");
    }

    function runRow(run, names) {
      return el(
        "a",
        { class: "run", href: "#/runs/" + enc(run.run_id) },
        el("span", { class: "c when" }, el("b", null, kit.when(run.created_at)), el("small", null, kit.ago(run.created_at))),
        el("span", { class: "c state" }, statusPill(run.status, run.error)),
        el("span", { class: "c agent" }, names[run.agent_id] || run.agent_id),
        el("span", { class: "c rev" }, el("span", { class: "rev-id" }, kit.short(run.revision)), " ", el("span", { class: "word" }, run.kind || "")),
        kit.cost(run.cost && run.cost.usd, "c cost"),
        el("span", { class: "c id" }, run.run_id)
      );
    }

    function allRuns(filter, token) {
      kit.crumb([["All runs", "#/runs"]]);
      kit.titled("All runs");
      var query = "runs?limit=100" + (filter.agent ? "&agent=" + enc(filter.agent) : "") + (filter.status ? "&status=" + enc(filter.status) : "");
      Promise.all([v2("GET", query), kit.get("api/store")]).then(
        function (both) {
          if (!kit.live(token)) return;
          var agents = (both[1] && both[1].agents) || [];
          var names = {};
          agents.forEach(function (agent) { names[agent.id] = agent.name; });
          var runs = (both[0] && both[0].runs) || [];
          var next = both[0] && both[0].next_cursor;
          var rows = el("div", { class: "table all", role: "table" }, el("div", { class: "run head", role: "row" }, ["Started", "State", "Agent", "Revision", "Cost", "Run"].map(function (h) { return el("span", { class: "c" }, h); })), runs.map(function (run) { return runRow(run, names); }));
          var count = el("h1", null, kit.plural(runs.length, "run") + (next ? " so far" : ""));
          var more = el("div", { class: "more" });
          var out = el("div");
          var link = function (agent, status, label, on) {
            return el("a", { class: "filter" + (on ? " on" : ""), href: runsHref(agent, status), "aria-current": on ? "true" : null }, label);
          };
          var showMore = function () {
            while (more.firstChild) more.removeChild(more.firstChild);
            if (!next) return;
            more.appendChild(button("Show more", "quiet", function () {
              v2("GET", query + "&cursor=" + enc(next)).then(function (page) {
                if (!kit.live(token)) return;
                (page.runs || []).forEach(function (run) { runs.push(run); rows.appendChild(runRow(run, names)); });
                next = page.next_cursor;
                count.textContent = kit.plural(runs.length, "run") + (next ? " so far" : "");
                showMore();
              }, function (error) { say(out, error); });
            }));
          };
          showMore();
          kit.show(
            el(
              "section",
              { class: "card runs all-runs" },
              kit.kicker("Every run, newest first"),
              count,
              el("nav", { class: "filters", "aria-label": "Runs of one agent" }, link(null, filter.status, "All agents", !filter.agent), agents.map(function (agent) { return link(agent.id, filter.status, agent.name, filter.agent === agent.id); })),
              el("nav", { class: "filters", "aria-label": "Runs in one state" }, link(filter.agent, null, "Any state", !filter.status), STATUSES.map(function (status) { return link(filter.agent, status, status.replace("_", " "), filter.status === status); })),
              runs.length ? rows : el("p", { class: "none" }, filter.agent || filter.status ? "No run matches." : "No runs yet."),
              more,
              out
            )
          );
        },
        function (error) {
          if (kit.live(token)) kit.show(kit.failed(error));
        }
      );
    }

    // ---- an agent: a new revision, the current one, a new run --------------------------------------------------------
    function revisionLabel(r) {
      return kit.short(r.id) + " · " + r.kind + (r.current ? " · current" : "") + (r.note ? " · " + kit.clip(r.note, 48) : "");
    }

    function runForm(agent, revisions) {
      var input = textArea("input", "", 3, "What it should do this run");
      var pick = el("select");
      pick.name = "revision";
      revisions.forEach(function (r) {
        var option = el("option");
        option.value = r.id;
        option.textContent = revisionLabel(r);
        option.selected = r.current;
        pick.appendChild(option);
      });
      var out = el("div");
      var start = button("Start run", "", function () {
        if (!/\S/.test(input.value)) return say(out, new Error("Write the run's input first."));
        var chosen = revisions.filter(function (r) { return r.id === pick.value; })[0] || revisions.filter(function (r) { return r.current; })[0];
        var body = { input: { content: input.value } };
        if (chosen && chosen.kind === "workflow") {
          try {
            body.input = JSON.parse(input.value);
          } catch (e) {
            return say(out, new Error("A workflow's input is a JSON object its input schema takes: " + e.message));
          }
          if (!body.input || typeof body.input !== "object" || Array.isArray(body.input)) return say(out, new Error("A workflow's input is a JSON object its input schema takes."));
        }
        // Named even when it is the current one: a revision made current elsewhere since the page drew must not change what runs.
        if (chosen) body.revision = chosen.id;
        start.disabled = true;
        say(out, null);
        v2("POST", "agents/" + enc(agent.id) + "/runs", body).then(
          function (run) { window.location.hash = "#/runs/" + enc(run.run_id); },
          function (error) {
            start.disabled = false;
            say(out, error);
          }
        );
      });
      return el("div", { class: "run-form" }, el("h3", null, "Start a run"), field("Input", input, "For a workflow revision, a JSON object its input schema takes."), el("div", { class: "actions" }, field("Revision", pick), start), out);
    }

    /** What keeps the current revision from running here: each tool it names that capabilities marks unavailable, with
     *  the variables that tool needs. Start run stays, since another revision may run and the 409 says why. */
    function cantRun(current) {
      var box = el("div");
      var named = (current && current.body && current.body.tools) || [];
      if (!named.length) return box;
      v2("GET", "capabilities").then(
        function (caps) {
          var why = ((caps && caps.tools) || []).filter(function (tool) { return tool && tool.available === false && named.indexOf(tool.name) >= 0; }).map(function (tool) { return tool.name + " needs " + (tool.missing || []).join(" and "); });
          if (why.length) box.appendChild(el("p", { class: "cant-run" }, "This server can't run this agent's current revision: " + why.join("; ") + "."));
        },
        function () {}
      );
      return box;
    }

    function agentActions(agent, revisions) {
      return [
        el("div", { class: "actions" }, el("a", { class: "btn quiet", href: "#/agents/" + enc(agent.id) + "/edit" }, revisions.length ? "Edit: commit a new revision" : "Write its first revision")),
        cantRun(revisions.filter(function (r) { return r.current; })[0]),
        revisions.length ? runForm(agent, revisions) : el("p", { class: "none" }, "It has no revision to run yet."),
      ];
    }

    function revisionActions(agent, revision) {
      if (revision.current) return null;
      var make = button("Make current", "quiet small", function () {
        make.disabled = true;
        v2("POST", "agents/" + enc(agent.id) + "/current", { revision: revision.id }).then(
          function () { kit.route(); },
          function (error) {
            make.disabled = false;
            make.parentNode.appendChild(problem(error));
          }
        );
      });
      make.title = "Runs that name no revision run the current one";
      return make;
    }

    // ---- an agent's revisions, compared ------------------------------------------------------------------------------
    function duration(ms) {
      var s = Math.round(ms / 1000);
      var two = function (n) { return (n < 10 ? "0" : "") + n; };
      return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m " + two(s % 60) + "s" : Math.floor(s / 3600) + "h " + two(Math.floor((s % 3600) / 60)) + "m";
    }

    /** One revision's runs in numbers: how many, how many completed, failed or escalated, what they cost in all and per
     *  completed run (every run's cost over the completed ones), and the median time of those that ended. */
    function revisionStats(runs) {
      var costed = runs.filter(function (r) { return typeof r.costUsd === "number"; });
      var completed = runs.filter(function (r) { return r.state === "completed"; }).length;
      var total = costed.length ? costed.reduce(function (sum, r) { return sum + r.costUsd; }, 0) : null;
      var times = runs.filter(function (r) { return r.endedAt; }).map(function (r) { return Date.parse(r.endedAt) - Date.parse(r.startedAt); }).filter(function (ms) { return ms >= 0; }).sort(function (a, b) { return a - b; });
      var mid = Math.floor(times.length / 2);
      return {
        runs: runs.length,
        completed: completed,
        failed: runs.filter(function (r) { return r.state === "failed" || r.state === "escalated"; }).length,
        total: total,
        perCompleted: total !== null && completed ? total / completed : null,
        median: times.length ? (times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2) : null,
      };
    }

    /** The agent's revisions side by side, read from every run of the agent whatever the filter; a row filters the runs
     *  to its revision, as the revision chips do. */
    function compareCard(agent, revisions, filter) {
      var body = el("div", null, el("p", { class: "loading" }, "Reading the runs…"));
      kit.get("api/runs?agent=" + enc(agent.id)).then(
        function (runs) {
          var stats = revisions.map(function (r) { return revisionStats((runs || []).filter(function (run) { return run.revision === r.id; })); });
          var priced = stats.filter(function (s) { return s.perCompleted !== null; }).map(function (s) { return s.perCompleted; });
          var cheapest = priced.length ? Math.min.apply(null, priced) : null;
          var cell = function (kind, label, value) { return el("span", { class: "c " + kind, "data-label": label }, value); };
          while (body.firstChild) body.removeChild(body.firstChild);
          body.appendChild(el(
            "div",
            { class: "table compare", role: "table" },
            el("div", { class: "cmp head", role: "row" }, ["Revision", "Runs", "Completed", "Failed or escalated", "Total", "Per completed", "Median time"].map(function (h) { return el("span", { class: "c" }, h); })),
            revisions.map(function (r, i) {
              var s = stats[i];
              var on = filter === r.id;
              var rev = el("span", { class: "c rev" }, el("span", { class: "rev-id" }, kit.short(r.id)), " ", el("span", { class: "word" }, r.kind), r.current ? [" ", kit.pill("current")] : null, r.note ? [" ", el("span", { class: "rev-note" }, kit.clip(r.note, 80))] : null);
              return el(
                "a",
                { class: "cmp" + (on ? " on" : ""), href: kit.agentHref(agent.id) + "?revision=" + enc(r.id), "aria-current": on ? "true" : null },
                rev,
                s.runs
                  ? [
                      cell("n", "runs", String(s.runs)),
                      cell("done", "completed", String(s.completed)),
                      cell("bad", "failed or escalated", String(s.failed)),
                      s.total === null ? el("span", { class: "c total unknown", "data-label": "total" }, "unknown") : cell("total", "total", kit.usd(s.total)),
                      cell("per", "per completed", s.perCompleted === null ? "–" : [kit.usd(s.perCompleted), s.perCompleted === cheapest ? [" ", kit.pill("ok", "cheapest")] : null]),
                      cell("time", "median", s.median === null ? "–" : duration(s.median)),
                    ]
                  : el("span", { class: "c empty" }, "no runs")
              );
            })
          ));
        },
        function (error) {
          while (body.firstChild) body.removeChild(body.firstChild);
          body.appendChild(kit.failed(error));
        }
      );
      return el("section", { class: "card compare" }, kit.kicker("Compare revisions"), el("h2", null, "Runs and cost by revision"), body);
    }

    /** The picker of a store with no agent: what to do next. */
    function emptyStore() {
      return el(
        "div",
        { class: "empty-store" },
        el("p", null, "No agents yet. ", el("a", { class: "btn", href: "#/new" }, "New agent")),
        el("p", { class: "none" }, "or seed the showcase:"),
        el("pre", null, el("code", null, SHOWCASE))
      );
    }

    /** A new agent, or a new revision of `agentId` prefilled from its current one. */
    function agentForm(agentId, token) {
      var home = agentId ? kit.agentHref(agentId) : "#/";
      kit.crumb(agentId ? [[agentId, home], ["Edit", "#/agents/" + enc(agentId) + "/edit"]] : [["New agent", "#/new"]]);
      kit.titled(agentId ? "New revision" : "New agent");
      Promise.all([v2("GET", "capabilities"), agentId ? v2("GET", "agents/" + enc(agentId)) : null]).then(
        function (both) {
          if (!kit.live(token)) return;
          var current = both[1];
          var definition = (current && current.definition) || {};
          if (agentId) kit.crumb([[definition.name || agentId, home], ["Edit", "#/agents/" + enc(agentId) + "/edit"]]);
          kit.show(agentCard(agentId, definition, both[0] || {}, current && current.home_etag));
        },
        function (error) {
          if (kit.live(token)) kit.show(kit.failed(error));
        }
      );
    }

    /** `etag` is the agent's as the form read it: the edit commits only onto that revision (412 when another came first). */
    function agentCard(agentId, definition, caps, etag) {
      // capabilities.tools: every tool this server's table holds, each available or with the variables it is missing.
      var listed = caps.tools || [];
      var offered = listed.map(function (tool) { return typeof tool === "string" ? tool : tool.name; });
      var missing = {};
      listed.forEach(function (tool) { if (tool && tool.available === false) missing[tool.name] = (tool.missing || []).join(" and "); });
      var levels = (caps.features && caps.features.thinking) || [];
      var kind = definition.workflow ? "workflow" : "agentic";
      // The store keeps an agent's name and description from its creation: an edit neither shows nor sends them.
      var name = agentId ? null : textInput("name", "", "Company researcher");
      var description = agentId ? null : textInput("description", "", "What it does, in one line");
      var prompt = textArea("instructions", definition.instructions, 10, "You research one company and write a short brief about it.");
      var workflow = textArea("workflow", definition.workflow ? JSON.stringify(definition.workflow, null, 2) : "", 16, "{ \"name\": \"...\", \"steps\": [] }", true);
      var model = textInput("model", definition.model, "provider/model-id");
      var thinking = el("select");
      thinking.name = "thinking";
      [""].concat(levels, definition.thinking && levels.indexOf(definition.thinking) < 0 ? [definition.thinking] : []).forEach(function (level) {
        var option = el("option");
        option.value = level;
        option.textContent = level || "the run's effort";
        option.selected = level === (definition.thinking || "");
        thinking.appendChild(option);
      });
      thinking.value = definition.thinking || "";
      var note = agentId ? textInput("note", "", "What this revision changes") : null;
      var had = Array.isArray(definition.tools) ? definition.tools : [];
      var tools = offered.concat(had.filter(function (tool) { return offered.indexOf(tool) < 0; })).map(function (tool) {
        var box = el("input", { type: "checkbox" });
        box.name = "tools";
        box.value = tool;
        box.checked = had.indexOf(tool) >= 0;
        var bound = offered.indexOf(tool) >= 0;
        var title = !bound ? "This server does not bind it" : Object.prototype.hasOwnProperty.call(missing, tool) ? "This server's environment does not set " + missing[tool] : null;
        return { box: box, label: el("label", { class: title ? "unbound" : null, title: title }, box, tool) };
      });
      var promptField = field("Prompt", prompt, "The agent's instructions: what it reads first on every run.");
      var modelField = field("Model", model, "Optional: provider/model-id. Empty runs the server's own model.");
      var thinkingField = field("Thinking", thinking, "How hard the model thinks on every run; never off.");
      var workflowField = field("Workflow", workflow, "The workflow as JSON, the way the DSL writes it.");
      var kinds = {};
      var setKind = function (next) {
        kind = next;
        promptField.hidden = next !== "agentic";
        modelField.hidden = next !== "agentic";
        thinkingField.hidden = next !== "agentic";
        workflowField.hidden = next !== "workflow";
        Object.keys(kinds).forEach(function (k) { kinds[k].setAttribute("aria-pressed", String(k === next)); });
      };
      [["agentic", "Prompt"], ["workflow", "Workflow"]].forEach(function (pair) {
        kinds[pair[0]] = el("button", { type: "button" }, pair[1]);
        kinds[pair[0]].addEventListener("click", function () { setKind(pair[0]); });
      });
      setKind(kind);
      var out = el("div");
      var save = button(agentId ? "Commit revision" : "Create agent", "", function () {
        var definitionOut = { tools: tools.filter(function (t) { return t.box.checked; }).map(function (t) { return t.box.value; }) };
        if (name) {
          if (!name.value.trim()) return say(out, new Error("The agent needs a name."));
          definitionOut.name = name.value.trim();
          if (description.value.trim()) definitionOut.description = description.value.trim();
        }
        if (kind === "workflow") {
          try {
            definitionOut.workflow = JSON.parse(workflow.value);
          } catch (e) {
            return say(out, new Error("The workflow is not JSON: " + e.message));
          }
        } else {
          definitionOut.instructions = prompt.value;
          if (model.value.trim()) definitionOut.model = model.value.trim();
          if (thinking.value) definitionOut.thinking = thinking.value;
        }
        var body = { definition: definitionOut };
        if (note && note.value.trim()) body.note = note.value.trim();
        save.disabled = true;
        say(out, null);
        (agentId ? v2("PUT", "agents/" + enc(agentId) + "/definition", body, undefined, etag ? { "if-match": etag } : null) : v2("POST", "agents", body)).then(
          function (agent) { window.location.hash = kit.agentHref(agentId || agent.agent_id); },
          function (error) {
            save.disabled = false;
            say(out, error.status === 412 ? new Error("The agent has a newer revision than the one this form started from: open Edit again to start from it.") : error);
          }
        );
      });
      return el(
        "section",
        { class: "card agent-form" },
        kit.kicker(agentId ? "New revision" : "New agent"),
        el("h1", null, agentId ? definition.name || agentId : "A new agent"),
        agentId ? el("p", { class: "lede" }, (definition.description ? definition.description + " " : "") + "Saving commits a new revision from what is below and makes it current. The revisions before it stay as they were.") : null,
        name ? el("div", { class: "pair" }, field("Name", name), field("Description", description)) : null,
        el("div", { class: "field" }, el("span", { class: "word" }, "Runs"), el("div", { class: "seg", role: "group", "aria-label": "What it runs" }, kinds.agentic, kinds.workflow)),
        promptField,
        el("div", { class: "pair" }, modelField, thinkingField),
        workflowField,
        el("div", { class: "field" }, el("span", { class: "word" }, "Tools"), tools.length ? el("div", { class: "tools" }, tools.map(function (t) { return t.label; })) : el("p", { class: "none" }, "This server binds no tools.")),
        note ? field("Note", note, "Optional: a line the revision keeps.") : null,
        out,
        el("div", { class: "actions" }, save, el("a", { class: "btn quiet", href: agentId ? kit.agentHref(agentId) : "#/" }, "Cancel"))
      );
    }

    // ---- one run, live ---------------------------------------------------------------------------------------------------
    /** A run this server knows and that is not final is followed through /v2's timeline; any other is the store's page. */
    function runPage(id, token) {
      kit.crumb([["Run", "#/runs/" + enc(id)]]);
      Promise.all([v2("GET", "runs/" + enc(id)), v2("GET", "runs/" + enc(id) + "/timeline"), kit.get("api/store")]).then(
        function (all) {
          if (!kit.live(token)) return;
          if (all[1].final) return kit.storeRunPage(id, token);
          var names = {};
          ((all[2] && all[2].agents) || []).forEach(function (agent) { names[agent.id] = agent.name; });
          follow(all[0], all[1], names, token);
        },
        function (error) {
          if (!kit.live(token)) return;
          if (error.status === 404) return kit.storeRunPage(id, token);
          kit.show(kit.failed(error));
        }
      );
    }

    function follow(run, first, names, token) {
      var rows = {};
      var controller = new AbortController();
      following = controller;
      var agentName = names[run.agent_id] || run.agent_id;
      kit.crumb([[agentName, kit.agentHref(run.agent_id)], ["Run", "#/runs/" + enc(run.run_id)]]);
      kit.titled("Run " + kit.short(run.run_id) + " · " + agentName);
      // The answer box is made once, so a redraw keeps what is typed in it.
      var question = el("p", { class: "question" });
      var answer = textArea("answer", "", 3, "Your answer");
      var out = el("div");
      var send = button("Send answer", "", function () {
        if (!/\S/.test(answer.value)) return say(out, new Error("Write the answer first."));
        send.disabled = true;
        say(out, null);
        v2("POST", "runs/" + enc(run.run_id) + "/messages", { content: answer.value }).then(
          function () {
            answer.value = "";
            send.disabled = false;
          },
          function (error) {
            send.disabled = false;
            say(out, error);
          }
        );
      });
      var box = el("section", { class: "card answer-box" }, kit.kicker("The agent asked you"), question, field("Answer", answer), el("div", { class: "actions" }, send), out);

      function apply(page) {
        if (page.reset) rows = {};
        (page.drop || []).forEach(function (id) { delete rows[id]; });
        (page.rows || []).forEach(function (row) { rows[row.id] = row; });
      }
      function draw(page) {
        var list = Object.keys(rows).map(function (id) { return rows[id]; }).filter(function (row) { return !QUIET.test(row.id); });
        var waiting = page.status === "input_required" && page.state === "waiting";
        var asked = list.filter(function (row) { return row.kind === "waiting"; }).pop();
        question.textContent = (asked && (asked.text || asked.summary)) || "The agent is waiting for you.";
        var calls = list.filter(function (row) { return row.kind === "tool_use"; }).length;
        var spent = page.cost && typeof page.cost.usd === "number" ? page.cost.usd : null;
        var head = el(
          "section",
          { class: "card run-head" },
          kit.kicker("Run"),
          el("h1", { class: "id" }, run.run_id),
          el("p", { class: "facts" }, statusPill(page.status, run.error), el("span", null, "started " + kit.when(run.created_at)), spent === null ? null : el("span", null, kit.usd(spent) + " so far"), el("span", null, calls + (calls === 1 ? " tool call" : " tool calls")), el("span", { class: "live-note" }, "live")),
          el("p", { class: "facts ran" }, el("span", { class: "word" }, "agent"), el("a", { href: kit.agentHref(run.agent_id) }, agentName), run.revision ? [el("span", { class: "word" }, "revision"), el("span", { class: "rev-id" }, kit.short(run.revision))] : null, run.kind ? kit.kindPill(run.kind) : null)
        );
        var open = kit.openCalls();
        var y = window.scrollY || 0;
        kit.show([head, waiting ? box : null, kit.timeline(list)]);
        kit.reopen(open);
        if (y) window.scrollTo(0, y);
      }
      function next(after, wait) {
        var query = "?wait_ms=" + wait + (after ? "&after=" + after : "");
        v2("GET", "runs/" + enc(run.run_id) + "/timeline" + query, undefined, controller.signal).then(
          function (page) {
            if (!kit.live(token) || controller.signal.aborted) return;
            apply(page);
            if (page.final) return kit.storeRunPage(run.run_id, token);
            // A timeline page carries no error: a run that turns failed is read once more, for an escalation's code.
            var why = page.status === "failed" && run.status !== "failed" ? v2("GET", "runs/" + enc(run.run_id)).then(function (view) { run = view; }, function () {}) : null;
            Promise.resolve(why).then(function () {
              if (!kit.live(token) || controller.signal.aborted) return;
              if (!page.unchanged) draw(page);
              next(page.next_after, page.has_more ? 0 : LONG_POLL_MS);
            });
          },
          function () {
            if (kit.live(token) && !controller.signal.aborted) kit.later(token, 2000, function () { next(after, 0); });
          }
        );
      }
      apply(first);
      draw(first);
      next(first.next_after, first.has_more ? 0 : LONG_POLL_MS);
    }

    function route(hash, token) {
      if (following) following.abort();
      following = null;
      var m = /^#\/runs(?:\?([^#]*))?$/.exec(hash);
      if (m) return allRuns(params(m[1]), token), true;
      if (hash === "#/new") return agentForm(null, token), true;
      m = /^#\/agents\/([^/?#]+)\/edit$/.exec(hash);
      if (m) return agentForm(decoded(m[1]), token), true;
      m = /^#\/runs\/([^/?#]+)$/.exec(hash);
      if (m) return runPage(decoded(m[1]), token), true;
      return false;
    }

    // ---- a stored run: copy its answer, run it again -------------------------------------------------------------------
    function runActions(run, data) {
      if (run.state === "running") return null;
      var out = el("span");
      var parts = [];
      if (run.state === "completed") {
        var copy = button("Copy answer", "quiet", function () {
          copy.disabled = true;
          say(out, null);
          // The run's /v2 view has its answer whole; the store's rows cut a long one.
          v2("GET", "runs/" + enc(run.id)).then(
            function (view) {
              var answer = view && view.result && typeof view.result.final_answer === "string" ? view.result.final_answer : run.summary || "";
              var clipboard = window.navigator && window.navigator.clipboard;
              if (!clipboard) throw new Error("This browser does not let the page copy: select the answer and copy it.");
              return clipboard.writeText(answer);
            }
          ).then(
            function () {
              copy.disabled = false;
              out.appendChild(el("span", { class: "done-note" }, "Copied."));
            },
            function (error) {
              copy.disabled = false;
              say(out, error);
            }
          );
        });
        parts.push(copy);
      }
      var again = button("Run again", "quiet", function () {
        again.disabled = true;
        say(out, null);
        // The input as the run was started, whole: the timeline's rows cut a long one.
        v2("GET", "runs/" + enc(run.id) + "/input").then(function (kept) {
          if (!kept || kept.input === null || typeof kept.input !== "object") throw new Error("This run's input was not kept, so it cannot run again.");
          return v2("POST", "agents/" + enc(run.agent) + "/runs", { input: kept.input, revision: run.revision });
        }).then(
          function (next) { window.location.hash = "#/runs/" + enc(next.run_id); },
          function (error) {
            again.disabled = false;
            say(out, error);
          }
        );
      });
      again.title = "A new run of the same version, with the same input";
      parts.push(again);
      return parts.length ? el("div", { class: "actions run-actions" }, parts, out) : null;
    }

    return { name: "AgentRun Server", route: route, agent: agentActions, revision: revisionActions, cards: compareCard, empty: emptyStore, run: runActions };
  };
})();
