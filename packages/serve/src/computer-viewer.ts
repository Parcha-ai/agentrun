// The computer viewer's page (a desktop's or a phone's screen), as three strings this server serves under the run's live
// path: the page at /v2/runs/{id}/computer/live/v/<id>, its script and style at computer-viewer.js and computer-viewer.css
// beside it, under LIVE_CSP (browser-live.ts), which allows no inline script or style. It is pi-browser's viewer
// generalized to a computer: one canvas, one WebSocket to this server's own origin, the token read from the fragment and
// sent once, in the hello (computer-live.ts has the protocol). Frames are drawn by their format (JPEG or PNG, told by their
// bytes) and acked once drawn, so the next comes only then. The bar has Take over and Hand back; no address bar, back or
// reload (a browser's). A desktop gets the mouse, the wheel and keys; a phone gets taps, swipes, its back, home and
// recents buttons, and keys. Coordinates are the screen's real pixels, the w and h each frame carries.

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live view</title>
<link rel="stylesheet" href="../computer-viewer.css">
</head>
<body>
<header id="bar">
  <button id="hands" type="button" hidden>Take over</button>
  <span id="phone" hidden>
    <button id="back" type="button" title="Back" aria-label="Back">&#9664;</button>
    <button id="home" type="button" title="Home" aria-label="Home">&#9679;</button>
    <button id="recents" type="button" title="Recents" aria-label="Recents">&#9632;</button>
  </span>
  <span id="spacer"></span>
  <span id="drive" aria-live="polite"></span>
</header>
<div id="notice" role="status" hidden></div>
<main id="stage"><canvas id="screen" tabindex="0" aria-label="The computer's screen"></canvas><textarea id="sink" rows="1" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Keyboard input for the computer"></textarea></main>
<script src="../computer-viewer.js"></script>
</body>
</html>
`;

const css = `* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #111; color: #eee; font: 14px system-ui, sans-serif; }
body { display: flex; flex-direction: column; }
#bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; background: #222; border-bottom: 1px solid #333; }
#bar button { background: #333; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
#bar button:hover { background: #444; }
#bar button:disabled { opacity: 0.5; cursor: not-allowed; }
#bar #hands { background: #1f4d2b; border-color: #2f6b3d; }
#bar #hands.holding { background: #5a3b00; border-color: #7a5410; }
#hands[hidden], #phone[hidden], #notice[hidden] { display: none; }
#phone { display: inline-flex; gap: 6px; }
#spacer { flex: 1; }
#drive { min-width: 9em; text-align: right; color: #aaa; }
#drive.agent, #drive.pending { color: #f0b429; }
#drive.person { color: #6cc070; }
.not-held #screen { cursor: not-allowed; }
#notice { padding: 6px 10px; background: #5a3b00; color: #ffe2a8; }
#notice.fatal { background: #5a1a1a; color: #ffc4c4; font-size: 18px; font-weight: 600; text-align: center; padding: 18px 16px; }
body.over #stage { opacity: 0.35; }
#stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; touch-action: none; }
#screen { display: block; background: #000; outline: none; cursor: default; touch-action: none; }
#screen:focus, #stage:focus-within #screen { box-shadow: 0 0 0 2px #3b82f6; }
#sink { position: fixed; left: 0; bottom: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; resize: none; overflow: hidden; pointer-events: none; font-size: 16px; }
`;

const js = `"use strict";
(function () {
  var params = new URLSearchParams(location.hash.slice(1));
  var token = params.get("t");
  // The fragment never stays in the address bar, the history or a screenshot of it.
  history.replaceState(null, "", location.pathname + location.search);

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $("screen");
  var sink = $("sink");
  var ctx = canvas.getContext("2d");
  var stage = $("stage");
  var notice = $("notice");
  var drive = $("drive");
  var handsEl = $("hands");
  function focusScreen() { try { sink.focus({ preventScroll: true }); } catch (e) { canvas.focus(); } }
  function fit() {
    if (!canvas.width || !canvas.height) return;
    var box = stage.getBoundingClientRect();
    var scale = Math.min(box.width / canvas.width, box.height / canvas.height);
    if (!(scale > 0)) return;
    canvas.style.width = Math.floor(canvas.width * scale) + "px";
    canvas.style.height = Math.floor(canvas.height * scale) + "px";
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(fit).observe(stage); else window.addEventListener("resize", fit);

  var fatal = false;
  function say(text, isFatal) {
    if (!text) { notice.hidden = true; notice.textContent = ""; return; }
    notice.hidden = false;
    notice.textContent = text;
    notice.className = isFatal ? "fatal" : "";
    document.body.classList.toggle("over", !!isFatal);
  }
  var holding = false;
  var kind = "";
  var input = "";
  var DRIVE = { agent: "the agent has the computer", pending: "taking over: the agent's step is ending", person: "you have the computer" };
  function setDrive(state) { drive.className = state || ""; drive.textContent = DRIVE[state] || ""; }
  function showHands() {
    handsEl.hidden = false;
    handsEl.textContent = holding ? "Hand back" : "Take over";
    handsEl.className = holding ? "holding" : "";
    document.body.classList.toggle("not-held", !holding);
    ["back", "home", "recents"].forEach(function (id) { $(id).disabled = !holding; });
  }

  if (!token) { fatal = true; say("This link has no token. Open the live view from the run's page.", true); return; }
  var proto = location.protocol === "https:" ? "wss://" : "ws://";
  var ws = new WebSocket(proto + location.host + location.pathname.replace(/\\/$/, "") + "/ws");
  ws.binaryType = "arraybuffer";
  var ready = false;
  var closed = false;
  say("Connecting to the computer.");
  ws.onopen = function () { ws.send(JSON.stringify({ type: "hello", token: token })); token = null; };
  function raw(message) { if (ws.readyState === 1) ws.send(JSON.stringify(message)); }
  var NOT_TAKEN = "Take over to drive.";
  function send(message) {
    if (!ready) return;
    if (!holding) { if (!(message.type === "mouse" && message.action === "move")) say(NOT_TAKEN); return; }
    raw(message);
  }
  handsEl.addEventListener("click", function () {
    if (!ready) return;
    raw({ type: holding ? "give" : "take" });
    if (!holding) say("Taking over the computer...");
  });

  // Frames: one at a time; each is acked once drawn, and only then does the computer send the next.
  var frame = { w: 0, h: 0 };
  function formatOf(bytes) { return bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? "image/png" : "image/jpeg"; }
  function draw(buffer) {
    if (buffer.byteLength <= 4) { raw({ type: "ack" }); return; }
    var view = new DataView(buffer);
    var w = view.getUint16(0);
    var h = view.getUint16(2);
    var bytes = new Uint8Array(buffer, 4);
    createImageBitmap(new Blob([bytes], { type: formatOf(bytes) })).then(function (bitmap) {
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; fit(); }
      ctx.drawImage(bitmap, 0, 0);
      if (bitmap.close) bitmap.close();
      frame = { w: w || bitmap.width, h: h || bitmap.height };
      document.body.dataset.frames = String(Number(document.body.dataset.frames || "0") + 1);
    }, function () {}).then(function () { raw({ type: "ack" }); });
  }

  var HOLD_ENDED = { given: "You handed the computer back to the agent.", answered: "The agent's request was answered, so the computer went back to the agent.", idle: "The computer went back to the agent: no input came from you for 15 minutes.", away: "The computer went back to the agent: the live view was closed.", released: "The computer's session ended while you had it." };
  var REFUSED = { unauthorized: "This link's token was not accepted.", viewer_in_use: "Another viewer already has this computer.", released: "This computer has been released.", bad_message: "The host did not understand this viewer.", slow_viewer: "This view fell too far behind the computer's screen: open the live view again." };
  var ENDED = { gone: "This computer has ended.", released: "This computer has been released.", ended: "This computer's session has ended.", unreachable: "The computer can't be reached right now.", refused: "The computer refused its live view.", unsupported: "This computer has no screen to show." };
  ws.onmessage = function (event) {
    if (typeof event.data !== "string") { draw(event.data); return; }
    var m;
    try { m = JSON.parse(event.data); } catch (e) { return; }
    if (m.type === "ready") {
      ready = true; kind = m.kind; input = m.input; holding = m.held === true;
      $("phone").hidden = kind !== "phone";
      document.body.dataset.kind = kind;
      showHands(); setDrive(m.drive); say(""); focusScreen();
    }
    else if (m.type === "hold") {
      holding = m.held === true;
      showHands(); setDrive(holding ? "person" : "agent");
      var extra = typeof m.message === "string" && m.message ? " " + m.message : "";
      say(holding ? "" : (HOLD_ENDED[m.reason] || "The computer went back to the agent.") + extra);
      if (holding) focusScreen();
    }
    else if (m.type === "status") { setDrive(m.drive); if (m.drive === "pending") say("Taking over: the agent's step is ending."); }
    else if (m.type === "take_refused") say(m.message || "The computer could not be handed to you.");
    else if (m.type === "held") say(m.message || "That input was held.");
    else if (m.type === "refused") { fatal = true; ready = false; say(REFUSED[m.reason] || "The host refused this viewer.", true); }
    else if (m.type === "ended") { fatal = true; ready = false; holding = false; handsEl.disabled = true; say(ENDED[m.reason] || "This computer has ended.", true); }
  };
  ws.onclose = function () { closed = true; ready = false; holding = false; handsEl.disabled = true; setDrive(""); if (!fatal) say("Disconnected. Open the live view again.", true); };

  // Input, in the screen's real pixels: from the canvas's box and the latest frame's w and h.
  function point(e) {
    var rect = canvas.getBoundingClientRect();
    if (!frame.w || !rect.width) return null;
    var x = Math.round((e.clientX - rect.left) * (frame.w / rect.width));
    var y = Math.round((e.clientY - rect.top) * (frame.h / rect.height));
    return { x: Math.max(0, Math.min(frame.w - 1, x)), y: Math.max(0, Math.min(frame.h - 1, y)) };
  }
  function mods(e) { return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0); }

  // A desktop: the mouse and the wheel.
  canvas.addEventListener("mousedown", function (e) {
    focusScreen();
    if (input !== "desktop") return;
    var p = point(e); if (!p) return;
    e.preventDefault();
    send({ type: "mouse", action: "down", x: p.x, y: p.y, button: e.button, buttons: e.buttons, clickCount: Math.max(1, Math.min(3, e.detail || 1)), modifiers: mods(e) });
  });
  canvas.addEventListener("mouseup", function (e) {
    if (input !== "desktop") return;
    var p = point(e); if (!p) return;
    e.preventDefault();
    send({ type: "mouse", action: "up", x: p.x, y: p.y, button: e.button, buttons: e.buttons, clickCount: Math.max(1, Math.min(3, e.detail || 1)), modifiers: mods(e) });
  });
  var moved = null, scheduled = false;
  canvas.addEventListener("mousemove", function (e) {
    if (input !== "desktop" || !holding) return;
    var p = point(e); if (!p) return;
    moved = { type: "mouse", action: "move", x: p.x, y: p.y, button: 0, buttons: e.buttons, clickCount: 0, modifiers: mods(e) };
    if (!scheduled) { scheduled = true; requestAnimationFrame(function () { scheduled = false; if (moved) { send(moved); moved = null; } }); }
  });
  canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  canvas.addEventListener("wheel", function (e) {
    if (input !== "desktop") return;
    var p = point(e); if (!p) return;
    e.preventDefault();
    var unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? frame.h : 1;
    send({ type: "wheel", x: p.x, y: p.y, dx: Math.round(e.deltaX * unit), dy: Math.round(e.deltaY * unit) });
  }, { passive: false });

  // A phone: a short touch that stays put is a tap, anything else a swipe; and its three buttons.
  var touchStart = null;
  canvas.addEventListener("pointerdown", function (e) {
    if (input === "desktop") return;
    focusScreen();
    var p = point(e); if (!p) return;
    e.preventDefault();
    touchStart = { x: p.x, y: p.y, at: Date.now() };
  });
  canvas.addEventListener("pointerup", function (e) {
    if (input === "desktop" || !touchStart) return;
    var p = point(e); var from = touchStart; touchStart = null;
    if (!p) return;
    e.preventDefault();
    var far = Math.abs(p.x - from.x) + Math.abs(p.y - from.y) > 12;
    if (far) send({ type: "swipe", x1: from.x, y1: from.y, x2: p.x, y2: p.y, ms: Math.max(50, Math.min(5000, Date.now() - from.at)) });
    else send({ type: "tap", x: p.x, y: p.y });
  });
  ["back", "home", "recents"].forEach(function (name) { $(name).addEventListener("click", function () { send({ type: "button", name: name }); focusScreen(); }); });

  // Keys, for both: a printable character typed goes as its char, everything else as its key.
  function onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) return;
    e.preventDefault();
    var printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (printable) send({ type: "key", action: "char", key: e.key, code: e.code || "", text: e.key, modifiers: mods(e) });
    else send({ type: "key", action: "down", key: e.key, code: e.code || "", modifiers: mods(e) });
  }
  function onPaste(e) {
    var text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    e.preventDefault();
    if (text) send({ type: "text", text: text });
  }
  [canvas, sink].forEach(function (el) { el.addEventListener("keydown", onKeyDown); el.addEventListener("paste", onPaste); });
  sink.addEventListener("compositionend", function (e) { if (e.data) send({ type: "text", text: e.data }); sink.value = ""; });
})();
`;

/** The computer viewer's page and its two files, served by this server under LIVE_CSP. */
export const computerViewerAssets: { readonly html: string; readonly js: string; readonly css: string } = Object.freeze({ html, js, css });
