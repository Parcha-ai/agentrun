// The page `pi-durable-agent serve` shows, as a classic script: it reads the server's api/agent, api/runs and
// api/runs/:id, routes by the hash, and draws the agent card, how a run's prompt is picked, the runs, and one run's
// timeline; a live run is read again every 2 s. On an agent store (<html data-serve="store">) it reads api/store and
// the store's routes instead and draws the agent picker, an agent's revisions and runs, and one run. It needs no inline
// script or style: the CSP allows only this origin's.
(function () {
  "use strict";
  // Every string from the API is data: run text comes from web pages. It reaches the page only as text nodes and as
  // attribute values set one by one, and an href only when it is http(s) or this page's own hash.
  var doc = document;
  var app = doc.getElementById("app");
  var crumbs = doc.getElementById("crumbs");
  var themeButton = doc.getElementById("theme");
  var timer = null;
  var view = 0;
  var runsNode = null;
  var said = 0;
  var STORE = doc.documentElement.getAttribute("data-serve") === "store";
  var drawing = [];
  var WHAT = STORE ? "agent store" : "agent home";

  var SAFE_ATTRS = { class: 1, href: 1, title: 1, id: 1, role: 1, type: 1, open: 1, target: 1, rel: 1, tabindex: 1, datetime: 1 };

  function safeHref(value) {
    var text = String(value);
    if (text.charAt(0) === "#") return text;
    try {
      var url = new URL(text);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  /** An element: attributes from a fixed list (an href only when safe), then children as nodes or text. */
  function el(tag, attrs) {
    var node = doc.createElement(tag);
    if (attrs) {
      for (var name in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, name)) continue;
        var value = attrs[name];
        if (value == null || value === false) continue;
        if (!SAFE_ATTRS[name] && name.indexOf("aria-") !== 0 && name.indexOf("data-") !== 0) continue;
        if (name === "href") {
          value = safeHref(value);
          if (value == null) continue;
        }
        node.setAttribute(name, value === true ? "" : String(value));
      }
    }
    for (var i = 2; i < arguments.length; i++) add(node, arguments[i]);
    return node;
  }

  function add(node, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) {
      for (var i = 0; i < kid.length; i++) add(node, kid[i]);
      return;
    }
    node.appendChild(typeof kid === "object" ? kid : doc.createTextNode(String(kid)));
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function show(node) {
    clear(app);
    add(app, node);
    // A graph is drawn once its svg is in the page, where the drawer can measure it.
    var due = drawing;
    drawing = [];
    due.forEach(function (draw) { draw(); });
  }

  // ---- formatting ------------------------------------------------------------------------------------------------------
  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function when(iso) {
    var at = new Date(iso);
    if (!iso || isNaN(at.getTime())) return "";
    return at.getFullYear() + "-" + pad(at.getMonth() + 1) + "-" + pad(at.getDate()) + " " + pad(at.getHours()) + ":" + pad(at.getMinutes());
  }
  function ago(iso) {
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (isNaN(s)) return "";
    return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : Math.floor(s / 86400) + "d ago";
  }
  function took(from, to) {
    var ms = Date.parse(to) - Date.parse(from);
    if (!(ms >= 0)) return "";
    var s = Math.round(ms / 1000);
    return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m " + pad(s % 60) + "s" : Math.floor(s / 3600) + "h " + pad(Math.floor((s % 3600) / 60)) + "m";
  }
  function usd(n) {
    return typeof n === "number" && isFinite(n) ? "$" + n.toFixed(n < 1 ? 3 : 2) : "";
  }
  function bytes(n) {
    if (typeof n !== "number") return "";
    return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
  }
  function percent(p) {
    return Math.round(Math.max(0, Math.min(1, p)) * 100) + "%";
  }
  function clip(text, max) {
    text = String(text == null ? "" : text);
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }
  function short(sha) {
    return typeof sha === "string" ? sha.slice(0, 12) : "";
  }

  /** A bar from 0 to 1: its fill is a CSS variable set through the CSSOM, never a style attribute. */
  function bar(p, kind) {
    var fill = el("span", { class: "fill" });
    var track = el("span", { class: "bar" + (kind ? " " + kind : ""), role: "img", "aria-label": percent(p) }, fill);
    track.style.setProperty("--p", String(Math.max(0, Math.min(1, p))));
    return track;
  }

  function kicker(text) {
    return el("p", { class: "kicker" }, text);
  }

  function pill(state, text) {
    return el("span", { class: "pill " + state }, text || state);
  }

  // ---- markdown, as nodes ----------------------------------------------------------------------------------------------
  /** Inline markdown: code, bold, italic and http(s) links, each made as an element with text inside. */
  function inline(text) {
    var out = [];
    var re = /(\x60[^\x60]+\x60)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()\[\]"']+[^\s<>()\[\]"'.,;:!?])/g;
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      if (m[1]) out.push(el("code", null, m[1].slice(1, -1)));
      else if (m[2]) out.push(el("b", null, m[2].slice(2, -2)));
      else if (m[3]) out.push(el("i", null, m[3].slice(1, -1)));
      else if (m[4]) out.push(el("a", { href: m[5], target: "_blank", rel: "noopener noreferrer" }, m[4].slice(1, m[4].indexOf("]("))));
      else out.push(el("a", { href: m[6], target: "_blank", rel: "noopener noreferrer" }, m[6]));
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  /** Markdown as a fragment: headings, lists, fences and paragraphs, every piece of text a text node. */
  function md(text) {
    var root = el("div", { class: "md" });
    var open = null;
    var kind = "";
    function close() {
      open = null;
      kind = "";
    }
    var lines = String(text).split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\x60\x60\x60/.test(line)) {
        if (kind === "code") close();
        else {
          var code = el("code");
          root.appendChild(el("pre", null, code));
          open = code;
          kind = "code";
        }
      } else if (kind === "code") open.appendChild(doc.createTextNode(line + "\n"));
      else if (/^#{1,6}\s/.test(line)) {
        close();
        var level = Math.min(5, 3 + line.match(/^#+/)[0].length - 1);
        root.appendChild(el("h" + level, null, inline(line.replace(/^#+\s*/, ""))));
      } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
        if (kind !== "ul") {
          open = el("ul");
          root.appendChild(open);
          kind = "ul";
        }
        open.appendChild(el("li", null, inline(line.replace(/^\s*([-*]|\d+\.)\s+/, ""))));
      } else if (!line.trim()) close();
      else {
        if (kind === "p") open.appendChild(el("br"));
        else {
          open = el("p");
          root.appendChild(open);
          kind = "p";
        }
        add(open, inline(line));
      }
    }
    return root;
  }

  // ---- the API -----------------------------------------------------------------------------------------------------------
  function get(path) {
    return fetch(path, { headers: { accept: "application/json" }, cache: "no-store" }).then(function (res) {
      return res.text().then(function (body) {
        var data = null;
        try {
          data = body ? JSON.parse(body) : null;
        } catch (e) {
          data = null;
        }
        if (!res.ok) {
          var said = data && (data.message || data.error);
          throw new Error(res.status + (said ? " " + said : ""));
        }
        return data;
      });
    });
  }

  function failed(error) {
    return el("section", { class: "panel error", role: "alert" }, el("b", null, "Could not read the " + WHAT + ". "), String((error && error.message) || error));
  }

  // ---- the agent ---------------------------------------------------------------------------------------------------------
  function variantsOf(prompts) {
    if (Array.isArray(prompts)) return prompts.filter(function (v) { return v && typeof v === "object"; });
    if (prompts && typeof prompts === "object") {
      return Object.keys(prompts).map(function (id) {
        var v = prompts[id] || {};
        var copy = { id: id };
        for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) copy[k] = v[k];
        return copy;
      });
    }
    return [];
  }

  function agentCard(agent) {
    var identity = agent.identity || {};
    var definition = agent.definition || {};
    var source = agent.source || null;
    var name = identity.name || definition.name || identity.id || "Agent";
    doc.title = name + " · agent home";
    var facts = [el("span", { class: "id" }, identity.id || "")];
    if (definition.version != null) facts.push(el("span", null, "v" + definition.version));
    if (source && source.sha) facts.push(el("span", { title: source.sha }, "source " + short(source.sha)));
    if (source && source.refreshedAt) facts.push(el("span", null, "refreshed " + when(source.refreshedAt)));
    var counts = agent.counts && typeof agent.counts === "object" ? agent.counts : {};
    var stats = Object.keys(counts).filter(function (k) { return typeof counts[k] === "number"; }).map(function (k) {
      var name = k.replace(/_/g, " ");
      return el("div", { class: "stat" }, el("b", null, String(counts[k])), el("span", null, counts[k] === 1 && /s$/.test(name) ? name.slice(0, -1) : name));
    });
    var tools = Array.isArray(definition.tools) ? definition.tools : [];
    var skills = Array.isArray(agent.skills) ? agent.skills : [];
    return el(
      "section",
      { class: "card agent" },
      kicker("Agent"),
      el("h1", null, name),
      el("p", { class: "facts" }, facts),
      definition.description ? el("p", { class: "lede" }, definition.description) : null,
      stats.length ? el("div", { class: "stats" }, stats) : null,
      el(
        "div",
        { class: "split" },
        el(
          "div",
          null,
          el("h3", null, "Skills"),
          skills.length
            ? el("ul", { class: "files" }, skills.map(function (s) {
                return el("li", null, el("span", { class: "path" }, s.path || ""), el("span", { class: "meta" }, [bytes(s.size), s.sha256 ? "sha256 " + short(s.sha256) : ""].filter(Boolean).join(" · ")));
              }))
            : el("p", { class: "none" }, "No skills.")
        ),
        el("div", null, el("h3", null, "Tools"), tools.length ? el("p", { class: "chips" }, tools.map(function (t) { return el("span", { class: "chip" }, t); })) : el("p", { class: "none" }, "No tools."))
      ),
      definition.instructions ? el("details", { class: "fold" }, el("summary", null, "Instructions"), el("pre", null, definition.instructions)) : null
    );
  }

  function promptText(v) {
    return el("details", { class: "fold" }, el("summary", null, "Prompt text"), el("pre", null, v.text || ""));
  }

  /** The prompt variants as the decision they make: the question Jev answers, each overlay's option and threshold, the
   *  lookup and the generic when none is sure, and the base under all of them. */
  function decision(prompts) {
    var variants = variantsOf(prompts);
    if (!variants.length) return null;
    var question = variants.filter(function (v) { return v.role === "question"; })[0];
    var base = variants.filter(function (v) { return v.role === "base"; })[0];
    var generic = variants.filter(function (v) { return v.role === "generic"; })[0];
    var overlays = variants.filter(function (v) { return v.role === "overlay"; });
    var criteria = question && question.criteria && typeof question.criteria === "object" ? question.criteria : {};
    var taken = {};
    overlays.forEach(function (o) { if (o.when) taken[o.when.option] = true; });

    var steps = el("ol", { class: "ladder" });
    overlays.forEach(function (o) {
      var rule = o.when || {};
      var threshold = typeof rule.threshold === "number" ? rule.threshold : null;
      steps.appendChild(
        el(
          "li",
          { class: "step" },
          el(
            "div",
            { class: "head" },
            el("div", { class: "if" }, el("span", { class: "word" }, "if"), el("span", { class: "chip option" }, rule.option || "?"), el("span", { class: "word" }, "≥"), el("b", { class: "num" }, threshold == null ? "?" : threshold.toFixed(2)), threshold == null ? null : bar(threshold, "threshold")),
            el("span", { class: "arrow", "aria-hidden": "true" }, "→"),
            el("div", { class: "then" }, el("span", { class: "word" }, "load"), el("b", null, o.label || o.id), o.label && o.label !== o.id ? el("span", { class: "id" }, o.id) : null)
          ),
          criteria[rule.option] ? el("p", { class: "criterion" }, criteria[rule.option]) : null,
          promptText(o)
        )
      );
    });
    var rest = Object.keys(criteria).filter(function (k) { return !taken[k]; });
    var fallback = el(
      "li",
      { class: "step else" },
      el(
        "div",
        { class: "head" },
        el("div", { class: "if" }, el("span", { class: "word" }, "else"), el("span", { class: "plain" }, "no option reaches its threshold, even after the host's one lookup if it has one")),
        el("span", { class: "arrow", "aria-hidden": "true" }, "→"),
        el("div", { class: "then" }, el("span", { class: "word" }, "load"), el("b", null, generic ? generic.label || generic.id : "the generic prompt"), generic && generic.label && generic.label !== generic.id ? el("span", { class: "id" }, generic.id) : null)
      ),
      rest.length ? el("p", { class: "criterion" }, rest.map(function (k) { return k + ": " + criteria[k]; }).join(" · ")) : null,
      generic ? promptText(generic) : null
    );
    steps.appendChild(fallback);

    return el(
      "section",
      { class: "card decision" },
      kicker("Prompt variants"),
      el("h2", null, "How a run's prompt is picked"),
      question
        ? el("div", { class: "question" }, el("span", { class: "word" }, "Jev answers"), el("b", null, question.label || question.id), el("p", null, question.text || ""))
        : el("p", { class: "none" }, "No question row: every run gets the base and the generic."),
      steps,
      base ? el("div", { class: "base" }, el("span", { class: "word" }, "every run starts with"), el("b", null, base.label || base.id), base.label && base.label !== base.id ? el("span", { class: "id" }, base.id) : null, promptText(base)) : null
    );
  }

  // ---- runs --------------------------------------------------------------------------------------------------------------
  function stateOf(run) {
    if (run.live) return ["live", "Live"];
    if (run.endedAt) return [run.outcome === "completed" ? "ok" : /fail|error/i.test(run.outcome || "") ? "error" : "ended", run.outcome || "ended"];
    return ["idle", "Not ended"];
  }

  function confidence(prompt) {
    if (!prompt || typeof prompt.confidence !== "number") return el("span", { class: "none" }, "–");
    return el("span", { class: "conf" }, bar(prompt.confidence), el("span", { class: "num" }, percent(prompt.confidence)));
  }

  /** One run as a row; without prompted (no run of the home had a variant) there are no variant columns. */
  function runRow(run, prompted) {
    var state = stateOf(run);
    var prompt = run.prompt || null;
    return el(
      "a",
      { class: "run", href: "#/runs/" + encodeURIComponent(run.id) },
      el("span", { class: "c when" }, el("b", null, when(run.startedAt)), el("small", null, ago(run.startedAt))),
      el("span", { class: "c state" }, pill(state[0], state[1])),
      prompted ? el("span", { class: "c variant" }, prompt ? el("span", { class: "chip option" }, prompt.id) : el("span", { class: "none" }, "none")) : null,
      prompted ? el("span", { class: "c conf-cell" }, confidence(prompt)) : null,
      prompted ? el("span", { class: "c reason" }, prompt && prompt.reason ? clip(prompt.reason, 140) : "") : null,
      el("span", { class: "c cost" }, usd(run.cost)),
      el("span", { class: "c id" }, run.id)
    );
  }

  function runsList(runs) {
    var sorted = runs.slice().sort(function (a, b) { return (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0); });
    var prompted = sorted.some(function (r) { return r && r.prompt; });
    var heads = prompted ? ["Started", "State", "Variant", "Confidence", "Why", "Cost", "Run"] : ["Started", "State", "Cost", "Run"];
    return el(
      "section",
      { class: "card runs" },
      kicker("Runs"),
      el("h2", null, sorted.length + (sorted.length === 1 ? " run" : " runs")),
      sorted.length
        ? el(
            "div",
            { class: "table" + (prompted ? "" : " plain"), role: "table" },
            el("div", { class: "run head", role: "row" }, heads.map(function (h) { return el("span", { class: "c" }, h); })),
            sorted.map(function (r) { return runRow(r, prompted); })
          )
        : el("p", { class: "none" }, "No runs yet.")
    );
  }

  function overview(token) {
    crumb([]);
    Promise.all([get("api/agent"), get("api/runs")]).then(
      function (both) {
        if (token !== view) return;
        var runs = Array.isArray(both[1]) ? both[1] : [];
        runsNode = runsList(runs);
        show([agentCard(both[0] || {}), decision((both[0] || {}).prompts), runsNode]);
        if (runs.some(function (r) { return r && r.live; })) later(token, 5000, function () { refreshRuns(token); });
      },
      function (error) {
        if (token === view) show(failed(error));
      }
    );
  }

  function refreshRuns(token) {
    get("api/runs").then(
      function (runs) {
        if (token !== view) return;
        var list = Array.isArray(runs) ? runs : [];
        var next = runsList(list);
        if (runsNode && runsNode.parentNode === app) app.replaceChild(next, runsNode);
        runsNode = next;
        if (list.some(function (r) { return r && r.live; })) later(token, 5000, function () { refreshRuns(token); });
      },
      function () {
        if (token === view) later(token, 5000, function () { refreshRuns(token); });
      }
    );
  }

  // ---- one run: its timeline -------------------------------------------------------------------------------------------
  /** Rows to groups, as @parcha/pi-durable-agent/timeline groups them: a round is the calls of one assistant entry, a
   *  call holds its result (by tool_use_id) and the rows it spawned, and adjacent one-call rounds of one tool fold. */
  function groupRows(rows) {
    var uses = {};
    var results = {};
    rows.forEach(function (row) {
      if (row.kind === "tool_use" && row.tool_use_id) uses[row.tool_use_id] = row;
      else if (row.kind === "tool_result" && row.tool_use_id) results[row.tool_use_id] = row;
    });
    var inside = {};
    var top = [];
    rows.forEach(function (row) {
      var spawned = row.kind === "subagent_started" || row.kind === "subagent_completed";
      var named = spawned ? row.tool_use_id : row.parent_tool_use_id;
      var parent = named && uses[named] && !(row.kind === "tool_use" && named === row.tool_use_id) ? named : null;
      if (parent) (inside[parent] = inside[parent] || []).push(row);
      else if (!(row.kind === "tool_result" && row.tool_use_id && uses[row.tool_use_id])) top.push(row);
    });
    var order = new Map();
    rows.forEach(function (row, index) { order.set(row, index); });
    var lead = function (row) { return row.kind === "subagent_started" ? 0 : row.kind === "subagent_completed" ? 2 : 1; };
    // Every row under a call, at any depth, in log order: a nested call's own nested calls included.
    var within = function (id, seen) {
      if (seen[id]) return [];
      seen[id] = true;
      var direct = inside[id] || [];
      var found = direct.slice();
      direct.forEach(function (row) {
        if (row.kind === "tool_use" && row.tool_use_id) found = found.concat(within(row.tool_use_id, seen));
      });
      return found.sort(function (a, b) { return order.get(a) - order.get(b); });
    };
    var groups = [];
    top.forEach(function (row) {
      if (row.kind !== "tool_use" || !row.tool_use_id) {
        groups.push({ type: "row", row: row });
        return;
      }
      var under = within(row.tool_use_id, Object.create(null)).sort(function (a, b) { return lead(a) - lead(b); });
      var call = { use: row, result: results[row.tool_use_id], inner: groupRows(under) };
      var last = groups[groups.length - 1];
      if (last && last.type === "calls" && row.round !== undefined && last.round === row.round && last.conv === row.conversation_id) last.calls.push(call);
      else groups.push({ type: "calls", round: row.round, conv: row.conversation_id, rounds: 1, calls: [call] });
    });
    var plain = function (c) { return !failedCall(c) && c.inner.length === 0; };
    var foldable = function (g) { return g.type === "calls" && g.calls.length === g.rounds && g.calls.every(plain); };
    var folded = [];
    groups.forEach(function (g) {
      var last = folded[folded.length - 1];
      if (last && foldable(last) && foldable(g) && last.conv === g.conv && last.calls[0].use.tool_name === g.calls[0].use.tool_name) {
        last.calls = last.calls.concat(g.calls);
        last.rounds += g.rounds;
      } else folded.push(g);
    });
    return folded;
  }

  function failedCall(c) {
    return !!(c.result && c.result.tool_status === "failed");
  }

  function foldCalls(calls) {
    var folds = [];
    calls.forEach(function (c) {
      var tool = c.use.tool_name || "";
      var last = folds[folds.length - 1];
      if (last && last.tool === tool && c.inner.length === 0 && last.calls.every(function (o) { return o.inner.length === 0; })) last.calls.push(c);
      else folds.push({ tool: tool, calls: [c] });
    });
    return folds;
  }

  function callState(c) {
    return !c.result ? "running" : !failedCall(c) ? "ok" : c.result.tool_result_size_bytes === null ? "interrupted" : "error";
  }

  function callLine(c) {
    var state = callState(c);
    var body = [];
    if (c.use.tool_input_preview) body.push(el("div", { class: "io" }, el("span", { class: "label" }, "input"), el("pre", null, c.use.tool_input_preview)));
    if (c.result && c.result.tool_result_preview) body.push(el("div", { class: "io" }, el("span", { class: "label" }, "result"), el("pre", null, c.result.tool_result_preview)));
    if (failedCall(c) && c.result.summary) body.push(el("pre", { class: "bad" }, c.result.summary));
    if (c.inner.length) body.push(el("div", { class: "kids" }, c.inner.map(item)));
    return el("details", { class: "call " + state }, el("summary", null, pill(state, state === "ok" ? "done" : state), el("b", null, c.use.summary || c.use.tool_name || "call"), el("span", { class: "tool" }, c.use.tool_name || "")), body);
  }

  function foldLine(fold) {
    var bad = fold.calls.filter(failedCall).length;
    var running = fold.calls.some(function (c) { return !c.result; });
    var state = running ? "running" : bad ? "error" : "ok";
    var first = fold.calls[0].use.summary || fold.tool;
    var label = first + (fold.calls.length > 1 ? " and " + (fold.calls.length - 1) + " more" : "");
    return el(
      "details",
      { class: "call many " + state },
      el("summary", null, pill(state, fold.calls.length + "×"), el("b", null, label), el("span", { class: "tool" }, fold.tool + (bad ? " · " + bad + " failed" : ""))),
      el("div", { class: "kids" }, fold.calls.map(callLine))
    );
  }

  function rowNode(r) {
    switch (r.kind) {
      case "user_message":
        said += 1;
        return el("div", { class: "row user" }, el("span", { class: "who" }, said === 1 ? "Input" : "Message"), el("p", null, r.text || r.summary || ""));
      case "thinking":
        return el("details", { class: "row think" }, el("summary", null, el("span", { class: "who" }, "Thinking"), el("span", { class: "gist" }, clip((r.summary || "").replace(/^Thinking:\s*/, ""), 160))), el("pre", null, r.text || r.summary || ""));
      case "text_block":
        return el("div", { class: "row said" }, md(r.text || r.summary || ""));
      case "final_answer":
        return el("div", { class: "row answer" }, el("span", { class: "who" }, "Answer"), md(r.text || r.summary || ""));
      case "waiting":
        return el("div", { class: "row phase waiting" }, r.summary || "Waiting");
      case "error":
        return el("div", { class: "row error" }, r.text || r.summary || "Error");
      case "usage":
        return null;
      case "tool_result":
        // A result no call in the rows asked for: shown alone, a failed one as an error.
        return el("div", { class: r.tool_status === "failed" ? "row error" : "row phase" }, r.summary || r.text || "");
      case "subagent_started":
      case "subagent_progress":
      case "subagent_completed":
        return el("div", { class: "row phase sub" }, (r.agent_label ? r.agent_label + ": " : "") + (r.summary || ""));
      default:
        return el("div", { class: "row phase" }, r.summary || r.kind);
    }
  }

  function item(g) {
    if (g.type === "row") return rowNode(g.row);
    return el("div", { class: "round" }, foldCalls(g.calls).map(function (f) { return f.calls.length === 1 ? callLine(f.calls[0]) : foldLine(f); }));
  }

  function timeline(rows) {
    said = 0;
    var sorted = rows.slice().sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
    var shown = groupRows(sorted.filter(function (r) { return r.kind !== "usage"; })).map(item).filter(Boolean);
    return el("section", { class: "card timeline" }, kicker("Timeline"), shown.length ? el("div", { class: "steps" }, shown) : el("p", { class: "none" }, "Nothing recorded yet."));
  }

  function runHead(run, rows) {
    var state = stateOf(run);
    var prompt = run.prompt || null;
    var calls = rows.filter(function (r) { return r.kind === "tool_use"; }).length;
    var facts = [el("span", null, "started " + when(run.startedAt))];
    if (run.endedAt) facts.push(el("span", null, "took " + took(run.startedAt, run.endedAt)));
    var spent = rows.filter(function (r) { return r.kind === "usage" && r.usage && typeof r.usage.usd === "number"; }).pop();
    if (usd(run.cost)) facts.push(el("span", null, usd(run.cost)));
    else if (spent) facts.push(el("span", null, usd(spent.usage.usd) + " so far"));
    facts.push(el("span", null, calls + (calls === 1 ? " tool call" : " tool calls")));
    return el(
      "section",
      { class: "card run-head" },
      kicker("Run"),
      el("h1", { class: "id" }, run.id),
      el("p", { class: "facts" }, pill(state[0], state[1]), facts, run.live ? el("span", { class: "live-note" }, "refreshing every 2 s") : null),
      prompt
        ? el(
            "div",
            { class: "picked" },
            el("div", { class: "if" }, el("span", { class: "word" }, "variant"), el("span", { class: "chip option" }, prompt.id), confidence(prompt)),
            prompt.reason ? el("p", { class: "reason" }, prompt.reason) : null
          )
        : el("p", { class: "none" }, "No prompt variant: the home kept none when this run started.")
    );
  }

  /** `live` is set when the page already shows this run live: a failed refresh then keeps it and tries again. */
  function runView(id, token, live) {
    crumb([["Run", "#/runs/" + encodeURIComponent(id)]]);
    get("api/runs/" + encodeURIComponent(id)).then(
      function (data) {
        if (token !== view) return;
        var run = (data && data.run) || { id: id };
        if (!run.id) run.id = id;
        var rows = data && Array.isArray(data.rows) ? data.rows : [];
        var open = openCalls();
        var y = window.scrollY || 0;
        show([runHead(run, rows), timeline(rows)]);
        reopen(open);
        if (y) window.scrollTo(0, y);
        if (run.live) later(token, 2000, function () { runView(id, token, true); });
      },
      function (error) {
        if (token !== view) return;
        if (live) later(token, 2000, function () { runView(id, token, true); });
        else show(failed(error));
      }
    );
  }

  /** The details a reader opened, by their place in the page, so a refresh keeps them open. */
  function openCalls() {
    var all = app.querySelectorAll("details");
    var open = [];
    for (var i = 0; i < all.length; i++) if (all[i].open) open.push(i);
    return open;
  }
  function reopen(open) {
    var all = app.querySelectorAll("details");
    open.forEach(function (i) { if (all[i]) all[i].open = true; });
  }

  // ---- an agent store ------------------------------------------------------------------------------------------------
  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  function kindPill(kind) {
    return kind === "agentic" || kind === "workflow" ? pill(kind) : null;
  }

  function agentTile(agent) {
    return el(
      "a",
      { class: "agent-tile", href: "#/agents/" + encodeURIComponent(agent.id) },
      el("span", { class: "head" }, el("b", null, agent.name || agent.id), kindPill(agent.currentKind), agent.missing ? pill("missing") : null),
      agent.description ? el("span", { class: "lede" }, agent.description) : null,
      el("span", { class: "facts" }, agent.currentKind ? null : el("span", null, "no revision yet"), el("span", null, plural(agent.revisions || 0, "revision")), el("span", null, plural(agent.runs || 0, "run")), el("span", { class: "id" }, agent.id))
    );
  }

  function picker(token) {
    crumb([]);
    doc.title = "Agent store";
    get("api/store").then(
      function (data) {
        if (token !== view) return;
        var agents = data && Array.isArray(data.agents) ? data.agents : [];
        show(
          el(
            "section",
            { class: "card picker" },
            kicker("Agent store"),
            el("h1", null, plural(agents.length, "agent")),
            el("p", { class: "lede" }, "Every agent in this folder, with its revisions and its runs: copy the folder and they all come with it."),
            agents.length ? el("div", { class: "agents" }, agents.map(agentTile)) : el("p", { class: "none" }, "No agents in this store yet.")
          )
        );
      },
      function (error) {
        if (token === view) show(failed(error));
      }
    );
  }

  function decoded(part) {
    try {
      return decodeURIComponent(part);
    } catch (e) {
      return part;
    }
  }

  function agentHref(agent) {
    return "#/agents/" + encodeURIComponent(agent);
  }
  function revisionHref(agent, id) {
    return agentHref(agent) + "/revisions/" + encodeURIComponent(id);
  }
  function runsHref(agent, revision) {
    return agentHref(agent) + "?revision=" + encodeURIComponent(revision);
  }
  function revisionApi(agent, id) {
    return "api/agents/" + encodeURIComponent(agent) + "/revisions/" + encodeURIComponent(id);
  }

  function stat(n, word) {
    return el("div", { class: "stat" }, el("b", null, String(n || 0)), el("span", null, n === 1 ? word : word + "s"));
  }

  function agentHead(agent) {
    var name = agent.name || agent.id || "Agent";
    doc.title = name + " · agent store";
    var facts = [el("span", { class: "id" }, agent.id || "")];
    if (agent.createdAt) facts.push(el("span", null, "created " + when(agent.createdAt)));
    if (agent.current) facts.push(el("span", null, "current ", el("a", { href: revisionHref(agent.id, agent.current) }, short(agent.current))));
    return el(
      "section",
      { class: "card agent" },
      kicker("Agent"),
      el("h1", null, name),
      el("p", { class: "facts" }, kindPill(agent.currentKind), agent.missing ? pill("missing") : null, facts),
      agent.description ? el("p", { class: "lede" }, agent.description) : null,
      el("div", { class: "stats" }, stat(agent.revisions, "revision"), stat(agent.runs, "run"))
    );
  }

  var MARKS = { add: "+", del: "−", same: " " };
  function diffLine(line) {
    var op = MARKS[line && line.op] ? line.op : "same";
    return el("div", { class: "line " + op }, el("span", { class: "mark", "aria-hidden": "true" }, MARKS[op]), el("span", { class: "text" }, line && line.text != null ? line.text : ""));
  }

  /** The tools as chips: the ones it kept, then the ones it added and removed against its parent. */
  function toolChips(tools, change) {
    var added = change && Array.isArray(change.added) ? change.added : [];
    var removed = change && Array.isArray(change.removed) ? change.removed : [];
    var chips = tools.filter(function (t) { return added.indexOf(t) < 0; }).map(function (t) { return el("span", { class: "chip" }, t); })
      .concat(added.map(function (t) { return el("span", { class: "chip add", title: "added" }, "+" + t); }))
      .concat(removed.map(function (t) { return el("span", { class: "chip del", title: "removed" }, "−" + t); }));
    return chips.length ? el("p", { class: "chips" }, chips) : el("p", { class: "none" }, "No tools.");
  }

  /** The skills by path and sha256, each marked when its parent did not have it, had it with another sha256, or had a
   *  skill this one dropped. */
  function skillList(skills, change) {
    var byPath = function (list) {
      var out = {};
      (change && Array.isArray(list) ? list : []).forEach(function (s) { if (s && typeof s.path === "string") out[s.path] = s; });
      return out;
    };
    var added = byPath(change && change.added);
    var removed = byPath(change && change.removed);
    var changed = byPath(change && change.changed);
    var paths = Object.keys(skills).concat(Object.keys(removed).filter(function (p) { return !Object.prototype.hasOwnProperty.call(skills, p); })).sort();
    if (!paths.length) return el("p", { class: "none" }, "No skills.");
    return el("ul", { class: "files" }, paths.map(function (p) {
      if (changed[p]) return el("li", { class: "changed" }, el("span", { class: "path" }, p), el("span", { class: "meta" }, "sha256 " + short(changed[p].was) + " → " + short(changed[p].now)));
      if (added[p]) return el("li", { class: "add" }, el("span", { class: "path" }, p), el("span", { class: "meta" }, "added · sha256 " + short(skills[p])));
      if (removed[p]) return el("li", { class: "del" }, el("span", { class: "path" }, p), el("span", { class: "meta" }, "removed · sha256 " + short(removed[p].sha256)));
      return el("li", null, el("span", { class: "path" }, p), el("span", { class: "meta" }, "sha256 " + short(skills[p])));
    }));
  }

  function settingsLine(body, diff) {
    var settings = [];
    ["model", "thinking"].forEach(function (k) {
      var change = diff && diff[k];
      if (change) settings.push(el("span", null, k + " " + (change.was || "unset") + " → " + (change.now || "unset")));
      else if (body[k]) settings.push(el("span", null, k + " " + body[k]));
    });
    return settings.length ? el("p", { class: "facts settings" }, settings) : null;
  }

  function agenticBody(detail) {
    var body = detail.revision.body || {};
    var diff = detail.diff && typeof detail.diff === "object" ? detail.diff : null;
    var parent = detail.parent;
    var prompt;
    if (diff && Array.isArray(diff.prompt)) {
      var count = function (op) { return diff.prompt.filter(function (l) { return l && l.op === op; }).length; };
      prompt = [
        el("h3", null, "Prompt, against ", el("span", { class: "id" }, short(diff.against))),
        el("p", { class: "facts" }, el("span", { class: "size" }, "+" + count("add") + " −" + count("del") + " lines")),
        el("div", { class: "diff", role: "group", "aria-label": "The prompt against its parent's" }, diff.prompt.map(diffLine)),
      ];
    } else {
      prompt = [
        el("h3", null, "Prompt"),
        parent && parent.kind !== "agentic" ? el("p", { class: "none" }, "Its parent " + short(parent.id) + " is a " + parent.kind + " revision: it has no prompt to compare with.") : null,
        el("pre", { class: "prompt" }, body.instructions || ""),
      ];
    }
    return el(
      "div",
      { class: "rev-body" },
      prompt,
      settingsLine(body, diff),
      el("div", { class: "split" }, el("div", null, el("h3", null, "Skills"), skillList(body.skills && typeof body.skills === "object" ? body.skills : {}, diff && diff.skills)), el("div", null, el("h3", null, "Tools"), toolChips(Array.isArray(body.tools) ? body.tools : [], diff && diff.tools)))
    );
  }

  var SVG_NS = "http://www.w3.org/2000/svg";
  var NODE_STATES = { done: "ok", working: "running", failed: "error", "not-run": "idle", escalated: "escalated" };

  function nodeState(state) {
    return pill(NODE_STATES[state] || "idle", state);
  }

  /** The graph's nodes as text, indented by how deep each is, with the marks the drawer would draw: added and edited
   *  nodes, each node's state in a run, the node an escalation stopped at, and the removed nodes by name. */
  function nodeList(graph, marks) {
    var nodes = graph && Array.isArray(graph.nodes) ? graph.nodes.filter(function (n) { return n && typeof n.path === "string"; }) : [];
    var diff = (marks && marks.diff) || {};
    var status = (marks && marks.status) || {};
    var added = Array.isArray(diff.added) ? diff.added : [];
    var edited = Array.isArray(diff.edited) ? diff.edited : [];
    var removed = Array.isArray(diff.removed) ? diff.removed : [];
    var list = el("ol", { class: "nodes" }, nodes.map(function (n) {
      var mark = added.indexOf(n.path) >= 0 ? "added" : edited.indexOf(n.path) >= 0 ? "edited" : null;
      var state = Object.prototype.hasOwnProperty.call(status, n.path) ? status[n.path] : null;
      var fired = marks && marks.fired === n.path;
      var item = el("li", { class: ["node", mark, fired ? "fired" : null].filter(Boolean).join(" "), title: n.path }, el("span", { class: "word" }, n.kind || ""), el("b", null, n.label || n.kind || ""), mark ? pill(mark) : null, state ? nodeState(state) : null, fired ? el("span", { class: "word fired" }, "stopped here") : null);
      var depth = nodes.filter(function (m) { return m.path !== n.path && n.path.indexOf(m.path + "/") === 0; }).length;
      item.style.setProperty("--depth", String(depth));
      return item;
    }));
    return [
      list,
      removed.length ? el("p", { class: "chips removed" }, el("span", { class: "word" }, "removed"), removed.map(function (r) { return el("span", { class: "chip del" }, (r && r.label) + " (" + (r && r.kind) + ")"); })) : null,
    ];
  }

  /** A workflow's graph: drawn by graph.js's window.drawWorkflowGraph into an svg once the svg is in the page, or, when
   *  the drawer is not loaded or cannot draw it, its nodes as text. */
  function graphBox(graph, marks, label) {
    var box = el("div", { class: "graph" });
    if (typeof window.drawWorkflowGraph !== "function") {
      add(box, nodeList(graph, marks));
      return box;
    }
    var svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "workflow-graph");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    box.appendChild(svg);
    drawing.push(function () {
      try {
        window.drawWorkflowGraph(svg, graph, marks);
      } catch (e) {
        clear(box);
        add(box, nodeList(graph, marks));
      }
    });
    return box;
  }

  function diffLegend(diff) {
    var m = diff.marks || {};
    var n = function (list) { return Array.isArray(list) ? list.length : 0; };
    return el(
      "p",
      { class: "facts legend" },
      pill("added", "+" + n(m.added) + " added"),
      pill("edited", n(m.edited) + " edited"),
      pill("removed", n(m.removed) + " removed"),
      n(diff.moved) ? el("span", null, n(diff.moved) + " moved") : null
    );
  }

  function workflowBody(detail) {
    var body = detail.revision.body || {};
    var diff = detail.diff && typeof detail.diff === "object" && detail.diff.marks ? detail.diff : null;
    var parent = detail.parent;
    return el(
      "div",
      { class: "rev-body" },
      el("h3", null, diff ? ["Workflow, against ", el("span", { class: "id" }, short(diff.against))] : "Workflow"),
      diff ? diffLegend(diff) : null,
      !diff && parent && parent.kind !== "workflow" ? el("p", { class: "none" }, "Its parent " + short(parent.id) + " is an agentic revision: this revision runs a workflow in place of a prompt.") : null,
      detail.unavailable ? el("p", { class: "note" }, detail.unavailable) : graphBox(detail.graph, diff ? { diff: diff.marks } : {}, "The workflow's graph"),
      el("div", { class: "split" }, el("div", null, el("h3", null, "Skills"), skillList(body.skills && typeof body.skills === "object" ? body.skills : {}, null)), el("div", null, el("h3", null, "Tools"), toolChips(Array.isArray(body.tools) ? body.tools : [], null)))
    );
  }

  /** One revision: its id, kind, note, parent and runs, then what it is. `detail` is its api/agents/:id/revisions/:id,
   *  or { error } when that could not be read. */
  function revisionBlock(agentId, row, detail) {
    var r = detail && detail.revision ? detail.revision : row;
    var body;
    if (!detail || detail.error) body = failed(detail ? detail.error : "no answer");
    else if (r.kind === "workflow") body = workflowBody(detail);
    else body = agenticBody(detail);
    return el(
      "article",
      { class: "revision" + (r.current ? " current" : "") },
      el("div", { class: "rev-head" }, el("a", { class: "rev-id", href: revisionHref(agentId, r.id), title: r.id }, short(r.id)), kindPill(r.kind), r.current ? pill("current") : null, r.note ? el("b", { class: "note" }, r.note) : null),
      el(
        "p",
        { class: "facts" },
        el("span", null, "created " + when(r.createdAt)),
        r.parent ? el("span", null, "from ", el("a", { href: revisionHref(agentId, r.parent) }, short(r.parent))) : el("span", null, "the first revision"),
        el("a", { href: runsHref(agentId, r.id) }, plural(row.runs || 0, "run"))
      ),
      body
    );
  }

  var RUN_STATES = { running: "live", completed: "ok", failed: "error", stopped: "stopped", escalated: "escalated", missing: "missing" };
  /** A run's state as its own word and class: escalated (a gate stopped it for a person) and missing (its directory is
   *  gone) are never drawn as failed. */
  function runState(state) {
    return pill(Object.prototype.hasOwnProperty.call(RUN_STATES, state) ? RUN_STATES[state] : "ended", state || "ended");
  }

  /** A recorded cost in dollars; a run with none recorded reads unknown, never $0. */
  function cost(n, kind) {
    var known = usd(n);
    return el("span", { class: kind + (known ? "" : " unknown") }, known || (kind === "c cost" ? "unknown" : "cost unknown"));
  }

  function storeRunRow(run) {
    return el(
      "a",
      { class: "run", href: "#/runs/" + encodeURIComponent(run.id) },
      el("span", { class: "c when" }, el("b", null, when(run.startedAt)), el("small", null, ago(run.startedAt))),
      el("span", { class: "c state" }, runState(run.state)),
      el("span", { class: "c rev" }, el("span", { class: "rev-id" }, short(run.revision)), " ", el("span", { class: "word" }, run.kind || "")),
      cost(run.costUsd, "c cost"),
      el("span", { class: "c reason" }, run.summary ? clip(run.summary, 160) : ""),
      el("span", { class: "c id" }, run.id)
    );
  }

  function runsApi(agentId, filter) {
    return "api/runs?agent=" + encodeURIComponent(agentId) + (filter ? "&revision=" + encodeURIComponent(filter) : "");
  }

  /** The agent's runs across its revisions, with links that filter them by revision; `runs` is the API's answer, or
   *  { error } when it could not be read. */
  function storeRuns(agentId, rows, runs, filter) {
    var filters = [el("a", { class: "filter" + (filter ? "" : " on"), href: agentHref(agentId), "aria-current": filter ? null : "true" }, "All revisions")].concat(
      rows.map(function (r) {
        return el("a", { class: "filter" + (filter === r.id ? " on" : ""), href: runsHref(agentId, r.id), "aria-current": filter === r.id ? "true" : null }, el("span", { class: "rev-id" }, short(r.id)), " ", el("span", { class: "word" }, r.kind));
      })
    );
    var list = Array.isArray(runs) ? runs : [];
    return el(
      "section",
      { class: "card runs" },
      kicker("Runs"),
      el("h2", null, plural(list.length, "run") + (filter ? " of " + short(filter) : "")),
      el("nav", { class: "filters", "aria-label": "Runs of one revision" }, filters),
      runs && runs.error
        ? failed(runs.error)
        : list.length
          ? el("div", { class: "table store", role: "table" }, el("div", { class: "run head", role: "row" }, ["Started", "State", "Revision", "Cost", "Summary", "Run"].map(function (h) { return el("span", { class: "c" }, h); })), list.map(storeRunRow))
          : el("p", { class: "none" }, filter ? "No runs of this revision yet." : "No runs yet.")
    );
  }

  function running(runs) {
    return Array.isArray(runs) && runs.some(function (r) { return r && r.state === "running"; });
  }

  /** While one of them is running, the runs are read again every 5 s, and only the runs. */
  function pollRuns(agentId, rows, filter, token) {
    later(token, 5000, function () {
      get(runsApi(agentId, filter)).then(
        function (runs) {
          if (token !== view) return;
          var next = storeRuns(agentId, rows, runs, filter);
          if (runsNode && runsNode.parentNode === app) app.replaceChild(next, runsNode);
          runsNode = next;
          if (running(runs)) pollRuns(agentId, rows, filter, token);
        },
        function () {
          if (token === view) pollRuns(agentId, rows, filter, token);
        }
      );
    });
  }

  function agentPage(agentId, filter, token) {
    crumb([[agentId, agentHref(agentId)]]);
    Promise.all([get("api/agents/" + encodeURIComponent(agentId)), get(runsApi(agentId, filter)).catch(function (error) { return { error: error }; })])
      .then(function (both) {
        if (token !== view) return;
        var data = both[0];
        var agent = (data && data.agent) || { id: agentId };
        var rows = data && Array.isArray(data.revisions) ? data.revisions : [];
        crumb([[agent.name || agentId, agentHref(agentId)]]);
        return Promise.all(rows.map(function (row) { return get(revisionApi(agentId, row.id)).catch(function (error) { return { error: error }; }); })).then(function (details) {
          if (token !== view) return;
          runsNode = storeRuns(agentId, rows, both[1], filter);
          show([
            agentHead(agent),
            runsNode,
            el("section", { class: "card revs" }, kicker("Revisions"), el("h2", null, plural(rows.length, "revision") + (rows.length > 1 ? ", newest first" : "")), rows.length ? rows.map(function (row, i) { return revisionBlock(agentId, row, details[i]); }) : el("p", { class: "none" }, "No revisions yet.")),
          ]);
          if (running(both[1])) pollRuns(agentId, rows, filter, token);
        });
      })
      .catch(function (error) {
        if (token === view) show(failed(error));
      });
  }

  function revisionPage(agentId, id, token) {
    crumb([[agentId, agentHref(agentId)], [short(id), revisionHref(agentId, id)]]);
    Promise.all([get("api/agents/" + encodeURIComponent(agentId)), get(revisionApi(agentId, id)), get(runsApi(agentId, id)).catch(function (error) { return { error: error }; })]).then(
      function (got) {
        if (token !== view) return;
        var agent = (got[0] && got[0].agent) || { id: agentId };
        var rows = (got[0] && got[0].revisions) || [];
        var row = rows.filter(function (r) { return r.id === id; })[0] || (got[1] && got[1].revision) || { id: id };
        crumb([[agent.name || agentId, agentHref(agentId)], [short(id), revisionHref(agentId, id)]]);
        doc.title = short(id) + " · " + (agent.name || agentId) + " · agent store";
        runsNode = storeRuns(agentId, rows, got[2], id);
        show([el("section", { class: "card revs" }, kicker("Revision of " + (agent.name || agentId)), revisionBlock(agentId, row, got[1])), runsNode]);
        if (running(got[2])) pollRuns(agentId, rows, id, token);
      },
      function (error) {
        if (token === view) show(failed(error));
      }
    );
  }

  /** A workflow run: its graph with each node's state as marks.status and, when an escalation stopped it, that node as
   *  marks.fired. */
  function workflowRunCard(data) {
    var w = data.workflow && typeof data.workflow === "object" ? data.workflow : null;
    var at = w && w.escalatedAt && typeof w.escalatedAt.path === "string" ? w.escalatedAt : null;
    var marks = { status: (w && w.status) || {} };
    if (at) marks.fired = at.path;
    return el(
      "section",
      { class: "card workflow-run" },
      kicker("Workflow"),
      el("h2", null, at ? "Escalated at " + (at.label || at.path) : "The path it took"),
      data.unavailable ? el("p", { class: "note" }, data.unavailable) : w ? graphBox(w.graph, marks, "The workflow's graph, with the path this run took") : el("p", { class: "none" }, "No record of the path it took.")
    );
  }

  /** A store run's head: its state, when it ran and what it cost, its agent and revision, and its summary. */
  function storeRunHead(data, rows) {
    var run = data.run;
    var agent = data.agent || { id: run.agent, name: run.agent };
    var revision = data.revision || { id: run.revision, kind: run.kind };
    var facts = [el("span", null, "started " + when(run.startedAt))];
    if (run.endedAt) facts.push(el("span", null, "took " + took(run.startedAt, run.endedAt)));
    var spent = rows.filter(function (r) { return r.kind === "usage" && r.usage && typeof r.usage.usd === "number"; }).pop();
    if (!usd(run.costUsd) && spent && run.state === "running") facts.push(el("span", null, usd(spent.usage.usd) + " so far"));
    else facts.push(cost(run.costUsd, "cost"));
    if (run.kind !== "workflow") {
      var calls = rows.filter(function (r) { return r.kind === "tool_use"; }).length;
      facts.push(el("span", null, calls + (calls === 1 ? " tool call" : " tool calls")));
    }
    return el(
      "section",
      { class: "card run-head" },
      kicker("Run"),
      el("h1", { class: "id" }, run.id),
      el("p", { class: "facts" }, runState(run.state), facts, run.state === "running" ? el("span", { class: "live-note" }, "refreshing every 2 s") : null),
      el(
        "p",
        { class: "facts ran" },
        el("span", { class: "word" }, "agent"),
        el("a", { href: agentHref(agent.id) }, agent.name || agent.id),
        el("span", { class: "word" }, "revision"),
        el("a", { class: "rev-id", href: revisionHref(agent.id, revision.id) }, short(revision.id)),
        kindPill(revision.kind || run.kind),
        revision.note ? el("span", null, revision.note) : null
      ),
      run.summary ? el("p", { class: "lede summary" }, run.summary) : null,
      data.stored === false ? el("p", { class: "note" }, "This run's directory is not in the store: only its row in the index is left.") : null
    );
  }

  function storeRunPage(id, token) {
    crumb([["Run", "#/runs/" + encodeURIComponent(id)]]);
    get("api/runs/" + encodeURIComponent(id)).then(
      function (data) {
        if (token !== view) return;
        var run = (data && data.run) || { id: id };
        var agent = (data && data.agent) || { id: run.agent, name: run.agent };
        crumb([[agent.name || agent.id, agentHref(agent.id)], [short(run.revision), revisionHref(agent.id, run.revision)], ["Run", "#/runs/" + encodeURIComponent(id)]]);
        doc.title = "Run " + short(run.id) + " · " + (agent.name || agent.id) + " · agent store";
        var rows = data && Array.isArray(data.rows) ? data.rows : [];
        var open = openCalls();
        var y = window.scrollY || 0;
        if (run.kind === "workflow") show([storeRunHead(data, rows), data.stored === false ? null : workflowRunCard(data)]);
        else show([storeRunHead(data, rows), timeline(rows)]);
        reopen(open);
        if (y) window.scrollTo(0, y);
        if (run.state === "running") later(token, 2000, function () { storeRunPage(id, token); });
      },
      function (error) {
        if (token === view) show(failed(error));
      }
    );
  }

  function storeRoute(hash, token) {
    var m = /^#\/runs\/([^/?#]+)$/.exec(hash);
    if (m) return storeRunPage(decoded(m[1]), token);
    m = /^#\/agents\/([^/?#]+)\/revisions\/([^/?#]+)$/.exec(hash);
    if (m) return revisionPage(decoded(m[1]), decoded(m[2]), token);
    m = /^#\/agents\/([^/?#]+)(?:\?revision=([^&#]*))?$/.exec(hash);
    if (m) return agentPage(decoded(m[1]), m[2] ? decoded(m[2]) : null, token);
    picker(token);
  }

  // ---- routing ------------------------------------------------------------------------------------------------------------
  function crumb(parts) {
    clear(crumbs);
    add(crumbs, el("a", { href: "#/" }, STORE ? "Agents" : "Home"));
    parts.forEach(function (p) {
      add(crumbs, el("span", { class: "sep", "aria-hidden": "true" }, "/"));
      add(crumbs, el("a", { href: p[1] }, p[0]));
    });
  }

  function later(token, ms, fn) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      if (token === view) fn();
    }, ms);
  }

  function route() {
    view += 1;
    drawing = [];
    if (timer) clearTimeout(timer);
    timer = null;
    var token = view;
    var hash = window.location.hash || "#/";
    if (STORE) return storeRoute(hash, token);
    var m = /^#\/runs\/([^/?#]+)$/.exec(hash);
    if (m) {
      var id;
      try {
        id = decodeURIComponent(m[1]);
      } catch (e) {
        id = m[1];
      }
      runView(id, token);
    } else overview(token);
  }

  // ---- theme ---------------------------------------------------------------------------------------------------------------
  var THEMES = ["auto", "light", "dark"];
  function setTheme(theme) {
    if (theme === "auto") doc.documentElement.removeAttribute("data-theme");
    else doc.documentElement.setAttribute("data-theme", theme);
    if (themeButton) themeButton.textContent = theme;
  }
  var saved = "auto";
  try {
    saved = window.localStorage.getItem("agent-home-theme") || "auto";
  } catch (e) {
    saved = "auto";
  }
  setTheme(THEMES.indexOf(saved) >= 0 ? saved : "auto");
  if (themeButton) {
    themeButton.addEventListener("click", function () {
      var next = THEMES[(THEMES.indexOf(themeButton.textContent) + 1) % THEMES.length];
      setTheme(next);
      try {
        window.localStorage.setItem("agent-home-theme", next);
      } catch (e) {
        /* a private window keeps no theme */
      }
    });
  }

  window.addEventListener("hashchange", route);
  route();
})();
