// The workflow graph the serve page draws, as a classic script: window.drawWorkflowGraph(svg, graph, marks) lays out the
// DSL's workflowGraph (nodes with JSON-pointer paths) and draws it into svg. The shape comes from the paths alone: a chain
// is a spine, an escalate step an exit pill off it, a route or a parallel fans its branches out under its card and joins
// them, and a map, a loop or a child workflow is a frame around its body. marks add a diff's NEW and EDITED tags and the
// nodes it removed, and a run's state on each node.
(function () {
  "use strict";
  // Every label, branch name and transport is data from a workflow document. It reaches the drawing only as text nodes;
  // every attribute is a number, a fixed word or a node's path, set one by one, and a state names a class only through
  // STATES.
  var doc = document;
  var NS = "http://www.w3.org/2000/svg";
  var PAD = 16;
  var W = 232;
  var H = 40;
  var GAP = 16;
  var ROW = 26;
  var PILL = 18;
  var TICK = 14;
  var FAN = 16;
  var NAMES = 26;
  var JOIN = 14;
  var BRANCH_GAP = 28;
  var FRAME = 14;
  var LINE = 16;
  // Text is sized by its length: the page's monospace faces advance 0.6em a character (the tags' tracking adds .06em).
  var LABEL = 12.5 * 0.6;
  var SMALL = 10.5 * 0.6;
  var NOTE = 11 * 0.6;
  var TAG = 9 * 0.66;

  var WHO = {
    agent: "agent", decide: "agent", extract: "agent", report: "agent", artifact: "agent",
    judge: "jev", pick: "jev", sift: "jev", route: "jev",
    call: "tool", code: "code", escalate: "exit",
    chain: "control", parallel: "control", map: "control", loop: "control", workflow: "control",
  };
  var STATES = { done: "done", working: "working", failed: "failed", escalated: "escalated", "not-run": "not-run", skipped: "skipped" };
  // The states a word names: on a card all but not-run, which its fade shows; on an exit only those that are news.
  var CARD_WORDS = { done: 1, working: 1, failed: 1, escalated: 1, skipped: 1 };
  var EXIT_WORDS = { working: 1, failed: 1, escalated: 1 };

  function own(object, key) {
    return object != null && Object.prototype.hasOwnProperty.call(object, key);
  }

  /** An SVG element: attributes set one by one, then children as nodes or text. */
  function svgEl(tag, attrs) {
    var node = doc.createElementNS(NS, tag);
    for (var name in attrs) {
      if (own(attrs, name) && attrs[name] != null && attrs[name] !== false) node.setAttribute(name, String(attrs[name]));
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

  function clip(text, max) {
    text = String(text == null ? "" : text);
    return text.length > max ? text.slice(0, Math.max(0, max - 1)) + "…" : text;
  }
  function fits(width, advance) {
    return Math.max(1, Math.floor(width / advance));
  }
  function wide(text, advance) {
    return Math.ceil(String(text).length * advance);
  }
  function wire(x1, y1, x2, y2, kind) {
    return svgEl("line", { x1: x1, y1: y1, x2: x2, y2: y2, class: "wire" + (kind ? " " + kind : "") });
  }
  function setOf(list) {
    var out = {};
    if (Array.isArray(list)) list.forEach(function (path) { if (typeof path === "string") out[path] = true; });
    return out;
  }
  function unpointer(segment) {
    return segment.replace(/~1/g, "/").replace(/~0/g, "~");
  }

  // ---- the tree the paths describe ---------------------------------------------------------------------------------------
  /** Each node's children by its path: a chain's steps in order, a route's branches with their names, a parallel's
   *  branches, a map's or a loop's body, a child workflow's root. A path counts only under a parent of the kind that has it. */
  function treeOf(nodes) {
    var byPath = {};
    var kids = {};
    nodes.forEach(function (node) { byPath[node.path] = node; });
    function kindAt(path) {
      return own(byPath, path) ? byPath[path].kind : "";
    }
    nodes.forEach(function (node) {
      var m;
      var kid = { node: node, order: 0, name: null };
      var parent = null;
      if ((m = /^(.*)\/steps\/(\d+)$/.exec(node.path)) && kindAt(m[1]) === "chain") {
        parent = m[1];
        kid.order = Number(m[2]);
      } else if ((m = /^(.*)\/branches\/([^/]*)\/body$/.exec(node.path)) && kindAt(m[1]) === "route") {
        parent = m[1];
        kid.name = unpointer(m[2]);
      } else if ((m = /^(.*)\/branches\/(\d+)$/.exec(node.path)) && kindAt(m[1]) === "parallel") {
        parent = m[1];
        kid.order = Number(m[2]);
      } else if ((m = /^(.*)\/body$/.exec(node.path)) && (kindAt(m[1]) === "map" || kindAt(m[1]) === "loop")) parent = m[1];
      else if ((m = /^(.*)\/workflow\/root$/.exec(node.path)) && kindAt(m[1]) === "workflow") parent = m[1];
      if (parent !== null) (kids[parent] = kids[parent] || []).push(kid);
    });
    for (var path in kids) if (own(kids, path)) kids[path].sort(function (a, b) { return a.order - b.order; });
    return { byPath: byPath, kids: kids };
  }

  // ---- marks -------------------------------------------------------------------------------------------------------------
  /** A node's diff tag and run state. The fired exit is escalated whatever its state says: the record holds no mark for it. */
  function looks(marks) {
    var diff = marks && marks.diff && typeof marks.diff === "object" ? marks.diff : {};
    var status = marks && marks.status && typeof marks.status === "object" ? marks.status : {};
    var added = setOf(diff.added);
    var edited = setOf(diff.edited);
    var fired = marks && typeof marks.fired === "string" ? marks.fired : null;
    return function (path) {
      var said = own(status, path) && typeof status[path] === "string" && own(STATES, status[path]) ? STATES[status[path]] : "";
      return { tag: own(added, path) ? "NEW" : own(edited, path) ? "EDITED" : "", state: path === fired ? "escalated" : said };
    };
  }

  function titleOf(node, look) {
    var text = node.label + " (" + node.kind + (node.via ? " via " + node.via : "") + ")";
    if (look.state) text += ": " + (look.state === "not-run" ? "not run" : look.state);
    if (look.tag) text += (look.state ? ", " : ": ") + look.tag.toLowerCase();
    return text;
  }

  /** A node's group: its own shapes only, so a state's class never reaches the nodes drawn inside it. */
  function group(ctx, node, shape) {
    var look = ctx.look(node.path);
    var who = own(WHO, node.kind) ? WHO[node.kind] : "code";
    var cls = "node " + shape + " who-" + who + (look.state ? " " + look.state : "") + (look.tag === "NEW" ? " new" : look.tag === "EDITED" ? " edited" : "");
    var g = svgEl("g", { class: cls, "data-path": node.path }, svgEl("title", null, titleOf(node, look)));
    ctx.svg.appendChild(g);
    return g;
  }

  function tagWidth(tag) {
    return wide(tag, TAG) + 10;
  }
  function tag(g, x, y, word) {
    var w = tagWidth(word);
    add(g, [svgEl("rect", { x: x, y: y, width: w, height: 13, class: "tag-box" }), svgEl("text", { x: x + w / 2, y: y + 9.5, class: "tag", "text-anchor": "middle" }, word)]);
  }

  // ---- shapes ------------------------------------------------------------------------------------------------------------
  /** A card: a stripe coloured by who works, the label, the kind (and a call's transport), a state's word, a diff's tag on
   *  its top edge. */
  function card(ctx, g, node, x, y) {
    var look = ctx.look(node.path);
    var word = look.state && CARD_WORDS[look.state] ? look.state : "";
    var kind = node.kind + (node.via ? " · " + node.via : "");
    var room = W - 24 - (word ? wide(word, TAG) + 8 : 0);
    add(g, [
      svgEl("rect", { x: x, y: y, width: W, height: H, class: "box" }),
      svgEl("rect", { x: x, y: y, width: 4, height: H, class: "swatch" }),
      svgEl("text", { x: x + 14, y: y + 17, class: "label" }, clip(node.label, fits(W - 24, LABEL))),
      svgEl("text", { x: x + 14, y: y + 31, class: "kind" }, clip(kind, fits(room, SMALL))),
      word ? svgEl("text", { x: x + W - 10, y: y + 31, class: "state", "text-anchor": "end" }, word) : null,
    ]);
    if (look.tag) tag(g, x + W - tagWidth(look.tag), y - 7, look.tag);
  }

  function leaf(ctx, node) {
    return { w: W, h: H, cx: W / 2, place: function (x, y) { card(ctx, group(ctx, node, "card"), node, x, y); } };
  }

  /** An exit: a pill off the spine at x, then its tag and its state's word. Alone (not a chain's step) it draws its own
   *  piece of spine. */
  function exitRow(ctx, node, alone) {
    var look = ctx.look(node.path);
    var text = clip(node.label === node.kind ? "exit" : "exit: " + node.label, 40);
    var pill = wide(text, SMALL) + 16;
    var word = look.state && EXIT_WORDS[look.state] ? look.state : "";
    var right = TICK + pill + (look.tag ? 6 + tagWidth(look.tag) : 0) + (word ? 6 + wide(word, TAG) : 0);
    return {
      w: right, h: ROW, cx: 0, exit: true,
      place: function (x, y) {
        var g = group(ctx, node, "exit");
        var mid = y + ROW / 2;
        var at = x + TICK + pill;
        if (alone) g.appendChild(wire(x, y, x, y + ROW, "spine"));
        add(g, [
          wire(x, mid, x + TICK, mid, "exit-wire"),
          svgEl("rect", { x: x + TICK, y: mid - PILL / 2, width: pill, height: PILL, class: "exit-box" }),
          svgEl("text", { x: x + TICK + 8, y: mid + 3.5, class: "exit-text" }, text),
        ]);
        if (look.tag) {
          tag(g, at + 6, mid - 6.5, look.tag);
          at += 6 + tagWidth(look.tag);
        }
        if (word) g.appendChild(svgEl("text", { x: at + 6, y: mid + 3.5, class: "state" }, word));
      },
    };
  }

  /** A chain: its steps down one spine. The spine runs from each step's bottom to the next card's top, through the rows of
   *  the exits between them. */
  function chainBox(ctx, node, kids) {
    var parts = kids.map(function (kid) { return kid.node.kind === "escalate" ? exitRow(ctx, kid.node, false) : layout(ctx, kid.node); });
    var left = W / 2;
    var right = W / 2;
    var h = -GAP;
    parts.forEach(function (part) {
      left = Math.max(left, part.cx);
      right = Math.max(right, part.w - part.cx);
      h += part.h + GAP;
    });
    return {
      w: left + right, h: h, cx: left,
      place: function (x, y) {
        var g = group(ctx, node, "chain");
        var spine = x + left;
        var at = y;
        var from = null;
        parts.forEach(function (part, i) {
          if (i) at += GAP;
          if (part.exit) {
            if (from === null) from = at;
          } else if (from !== null) g.appendChild(wire(spine, from, spine, at, "spine"));
          part.place(part.exit ? spine : spine - part.cx, at);
          at += part.h;
          if (!part.exit) from = at;
        });
        if (parts[parts.length - 1].exit) g.appendChild(wire(spine, from, spine, at, "spine"));
      },
    };
  }

  /** A route or a parallel: its card, a bus its branches hang from (a route's named), and a join under the deepest. The
   *  card sits midway between the outer branches, so the spine goes on from the join's middle. */
  function fanBox(ctx, node, kids) {
    var branches = kids.map(function (kid) { return { kid: kid, box: layout(ctx, kid.node) }; });
    var at = 0;
    var deepest = 0;
    branches.forEach(function (branch, i) {
      if (i) at += BRANCH_GAP;
      branch.x = at;
      branch.c = at + branch.box.cx;
      at += branch.box.w;
      deepest = Math.max(deepest, branch.box.h);
    });
    var last = branches.length - 1;
    var mid = Math.round((branches[0].c + branches[last].c) / 2);
    var left = Math.min(0, mid - W / 2);
    var right = Math.max(at, mid + W / 2);
    var top = H + FAN + NAMES;
    var h = top + deepest + JOIN;
    return {
      w: right - left, h: h, cx: mid - left,
      place: function (x, y) {
        var g = group(ctx, node, "card");
        var o = x - left;
        var bus = y + H + FAN;
        var join = y + h;
        card(ctx, g, node, o + mid - W / 2, y);
        g.appendChild(wire(o + mid, y + H, o + mid, bus));
        if (last) add(g, [wire(o + branches[0].c, bus, o + branches[last].c, bus), wire(o + branches[0].c, join, o + branches[last].c, join)]);
        branches.forEach(function (branch, i) {
          var c = o + branch.c;
          var path = branch.kid.node.path;
          var taken = own(ctx.taken, path) ? " taken" : "";
          g.appendChild(svgEl("line", { x1: c, y1: bus, x2: c, y2: y + top, class: "wire branch" + taken, "data-to": path }));
          if (branch.kid.name !== null) {
            var room = (i < last ? branches[i + 1].c - 6 : branch.x + branch.box.w) - branch.c - 12;
            var name = clip(branch.kid.name, fits(room, SMALL));
            var text = svgEl("text", { x: c + 6, y: bus + 15, class: "branch-name" + taken }, name);
            g.appendChild(name === branch.kid.name ? text : svgEl("g", null, svgEl("title", null, branch.kid.name), text));
          }
          g.appendChild(wire(c, y + top + branch.box.h, c, join));
          branch.box.place(o + branch.x, y + top);
        });
      },
    };
  }

  /** A map, a loop or a child workflow: its card on the top edge of a frame around its body. */
  function frameBox(ctx, node, body) {
    var inner = layout(ctx, body);
    var left = Math.max(W / 2, inner.cx) + FRAME;
    var right = Math.max(W / 2, inner.w - inner.cx) + FRAME;
    var h = H + FRAME + inner.h + FRAME;
    return {
      w: left + right, h: h, cx: left,
      place: function (x, y) {
        var g = group(ctx, node, "card");
        var c = x + left;
        add(g, [
          svgEl("rect", { x: x, y: y + H / 2, width: left + right, height: h - H / 2, class: "frame" }),
          wire(c, y + H, c, y + H + FRAME),
          wire(c, y + H + FRAME + inner.h, c, y + h),
        ]);
        card(ctx, g, node, c - W / 2, y);
        inner.place(c - inner.cx, y + H + FRAME);
      },
    };
  }

  /** A node laid out: its size, the x of the spine it hangs on (cx), and place(x, y) to draw it there. */
  function layout(ctx, node) {
    var kids = own(ctx.kids, node.path) ? ctx.kids[node.path] : [];
    if (node.kind === "escalate") return exitRow(ctx, node, true);
    if (!kids.length) return leaf(ctx, node);
    if (node.kind === "chain") return chainBox(ctx, node, kids);
    if (node.kind === "route" || node.kind === "parallel") return fanBox(ctx, node, kids);
    if (node.kind === "map" || node.kind === "loop" || node.kind === "workflow") return frameBox(ctx, node, kids[0].node);
    return leaf(ctx, node);
  }

  /** The removed nodes as lines of text that fit `width`, the first starting "Removed:". */
  function removedLines(items, width) {
    var max = fits(width, NOTE);
    var lines = [];
    var line = "Removed:";
    items.forEach(function (item, i) {
      var piece = clip(item, max - 1) + (i < items.length - 1 ? "," : "");
      if ((line + " " + piece).length > max) {
        lines.push(line);
        line = piece;
      } else line += " " + piece;
    });
    lines.push(line);
    return lines;
  }

  function size(svg, w, h) {
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
  }

  /** Draws `graph` (workflowGraph's output) into `svg` at its natural size, which CSS shrinks to fit and never grows;
   *  `marks` are optional: { diff: { added, edited, removed }, status, fired, taken }. Drawing again clears the last. */
  window.drawWorkflowGraph = function (svg, graph, marks) {
    clear(svg);
    var cls = svg.getAttribute("class") || "";
    if (!/(^|\s)wf(\s|$)/.test(cls)) svg.setAttribute("class", (cls ? cls + " " : "") + "wf");
    var nodes = (graph && Array.isArray(graph.nodes) ? graph.nodes : [])
      .filter(function (n) { return n && typeof n.path === "string" && typeof n.kind === "string"; })
      .map(function (n) { return { path: n.path, kind: n.kind, label: String(n.label == null ? n.kind : n.label), via: typeof n.via === "string" ? n.via : "" }; });
    var tree = treeOf(nodes);
    if (!own(tree.byPath, "/root")) {
      size(svg, 0, 0);
      return;
    }
    var ctx = { svg: svg, kids: tree.kids, look: looks(marks), taken: setOf(marks && marks.taken) };
    var drawn = layout(ctx, tree.byPath["/root"]);
    drawn.place(PAD, PAD);

    var removed = marks && marks.diff && Array.isArray(marks.diff.removed) ? marks.diff.removed : [];
    var items = removed.filter(function (r) { return r && typeof r === "object"; }).map(function (r) { return String(r.label) + " (" + String(r.kind) + ")"; });
    var w = drawn.w;
    var h = drawn.h;
    if (items.length) {
      var lines = removedLines(items, Math.max(drawn.w, 300));
      var top = PAD + drawn.h + 22;
      var list = svgEl("g", { class: "removed-list" }, svgEl("title", null, "Removed: " + items.join(", ")));
      lines.forEach(function (line, i) {
        list.appendChild(svgEl("text", { x: PAD, y: top + 11 + i * LINE, class: "removed" }, line));
        w = Math.max(w, wide(line, NOTE));
      });
      svg.appendChild(list);
      h += 22 + lines.length * LINE;
    }
    size(svg, w + 2 * PAD, h + 2 * PAD);
  };
})();
