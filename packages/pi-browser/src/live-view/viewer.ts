// The live view's viewer page, as three strings the server serves: the page at {base}/v/{id}, and its script and style at {base}/viewer.js and {base}/viewer.css. Three files because the
// page is served under `default-src 'self'`, which refuses inline script and style. Nothing external: one canvas, the page's own two files and one WebSocket to the page's own origin.
//
// The script reads the token from the URL fragment (#t=<token>) and drops the fragment from the address bar at once, opens ws(s)://<this host><this path>/ws, and sends {type:"hello", token} as
// its first message; nothing else is sent before the server has answered. Frames arrive as binary [u16 w][u16 h][jpeg] and are drawn to the canvas; mouse, wheel, key and paste on the canvas go
// back as protocol.ts messages in the page's own CSS pixels (the w and h of the latest frame), and the address bar and its back and reload buttons go back as `nav`. It writes no frame to
// storage: a frame lives in the canvas and in the one decode in flight.

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live view</title>
<link rel="stylesheet" href="../viewer.css">
</head>
<body>
<header id="bar">
  <button id="back" type="button" title="Back" aria-label="Back">&#8592;</button>
  <button id="reload" type="button" title="Reload" aria-label="Reload">&#8635;</button>
  <form id="go" autocomplete="off"><input id="url" type="text" spellcheck="false" aria-label="Address" placeholder="https://"></form>
  <span id="drive" aria-live="polite"></span>
</header>
<div id="notice" role="status" hidden></div>
<div id="still" role="status" hidden>This page is in a background tab or has not drawn yet, so there is no picture until it is shown. Typing and clicking still work.</div>
<div id="dialog" role="alertdialog" aria-modal="true" hidden>
  <div id="dialog-box">
    <p id="dialog-kind"></p>
    <p id="dialog-message"></p>
    <input id="dialog-prompt" type="text" hidden aria-label="Answer">
    <div id="dialog-buttons"><button id="dialog-accept" type="button">OK</button><button id="dialog-dismiss" type="button">Cancel</button></div>
  </div>
</div>
<main id="stage"><canvas id="screen" tabindex="0" aria-label="The browser's page"></canvas><textarea id="sink" rows="1" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Keyboard input for the page"></textarea></main>
<script src="../viewer.js"></script>
</body>
</html>
`;

const css = `* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #111; color: #eee; font: 14px system-ui, sans-serif; }
body { display: flex; flex-direction: column; }
#bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; background: #222; border-bottom: 1px solid #333; }
#bar button { background: #333; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
#bar button:hover { background: #444; }
#go { flex: 1; margin: 0; }
#url { width: 100%; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 5px 8px; font: inherit; }
#drive { min-width: 9em; text-align: right; color: #aaa; }
#drive.agent { color: #f0b429; }
#drive.person { color: #6cc070; }
#notice { padding: 6px 10px; background: #5a3b00; color: #ffe2a8; }
#notice.fatal { background: #5a1a1a; color: #ffc4c4; }
#stage { flex: 1; min-height: 0; display: flex; align-items: flex-start; justify-content: center; overflow: auto; }
#screen { max-width: 100%; max-height: 100%; background: #000; outline: none; cursor: default; }
#screen:focus, #stage:focus-within #screen { box-shadow: 0 0 0 2px #3b82f6; }
#still { padding: 6px 12px; background: #3a3a1a; color: #f3e9a8; border-bottom: 1px solid #5a5a2a; }
#sink { position: fixed; left: 0; bottom: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; resize: none; overflow: hidden; pointer-events: none; font-size: 16px; }
#dialog { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); display: flex; align-items: center; justify-content: center; }
#dialog[hidden], #notice[hidden], #dialog-prompt[hidden] { display: none; }
#dialog-box { background: #222; border: 1px solid #555; border-radius: 6px; padding: 16px; width: min(28em, 90vw); }
#dialog-kind { margin: 0 0 6px; color: #aaa; text-transform: uppercase; font-size: 12px; }
#dialog-message { margin: 0 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
#dialog-prompt { width: 100%; margin: 0 0 12px; background: #111; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 5px 8px; font: inherit; }
#dialog-buttons { display: flex; gap: 8px; justify-content: flex-end; }
#dialog-buttons button { background: #333; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 5px 14px; cursor: pointer; }
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
  // The page is shown on a canvas, which cannot take text: the keyboard's focus sits on a hidden textarea beside it, so a virtual keyboard and an IME have something to type into.
  function focusScreen() { try { sink.focus({ preventScroll: true }); } catch (e) { canvas.focus(); } }
  var ctx = canvas.getContext("2d");
  var urlBox = $("url");
  var notice = $("notice");
  var drive = $("drive");
  var frame = { w: 0, h: 0 };
  var stillEl = $("still");
  var stillTimer = null;
  var drewSince = false;
  var shownUrl = null;
  // A page that gives no picture (a tab opened in the background, which Chrome does not paint) leaves the canvas as it was: after a while the viewer says so, and input still works.
  function expectPicture() { drewSince = false; stillEl.hidden = true; clearTimeout(stillTimer); stillTimer = setTimeout(function () { if (!drewSince && !fatal) stillEl.hidden = false; }, 2500); }
  function gotPicture() { drewSince = true; clearTimeout(stillTimer); stillEl.hidden = true; }
  var fatal = false;

  function say(text, isFatal) {
    if (!text) { notice.hidden = true; notice.textContent = ""; return; }
    notice.hidden = false;
    notice.textContent = text;
    notice.className = isFatal ? "fatal" : "";
  }
  function setDrive(state) {
    drive.className = state === "agent" || state === "person" ? state : "";
    drive.textContent = state === "agent" ? "the agent is acting" : state === "person" ? "you are driving" : "";
  }

  if (!token) { fatal = true; say("This link has no token. Open the live view from the link the host gave you.", true); return; }
  var proto = location.protocol === "https:" ? "wss://" : "ws://";
  var ws = new WebSocket(proto + location.host + location.pathname.replace(/\\/$/, "") + "/ws");
  ws.binaryType = "arraybuffer";
  var ready = false;
  var closed = false;
  var CONNECTING = "Connecting to the browser. Input is not sent until it is ready.";
  var WAITING = "Still connecting: that input was not sent. Try again when this message goes away.";
  say(CONNECTING);

  // Input before the host's ready is refused out loud and never queued: a keystroke replayed into a page the person has since lost sight of is worse than one that was not sent. A hover is not worth a notice.
  function stillConnecting() { if (ready || fatal || closed) return false; say(WAITING); return true; }
  function send(message) {
    if (!ready) { if (!(message.type === "mouse" && message.action === "move")) stillConnecting(); return; }
    if (ws.readyState === 1) ws.send(JSON.stringify(message));
  }
  ws.onopen = function () { ws.send(JSON.stringify({ type: "hello", token: token })); token = null; };

  // Frames: the latest only. A decode in flight and one waiting; a newer frame replaces the one waiting.
  var decoding = false;
  var waiting = null;
  function draw(buffer) {
    if (buffer.byteLength <= 4) { decoding = false; return; }
    var view = new DataView(buffer);
    var w = view.getUint16(0);
    var h = view.getUint16(2);
    var blob = new Blob([new Uint8Array(buffer, 4)], { type: "image/jpeg" });
    createImageBitmap(blob).then(function (bitmap) {
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
      ctx.drawImage(bitmap, 0, 0);
      gotPicture();
      if (bitmap.close) bitmap.close();
      frame = { w: w || bitmap.width, h: h || bitmap.height };
    }, function () {}).then(function () {
      decoding = false;
      if (waiting) { var next = waiting; waiting = null; decoding = true; draw(next); }
    });
  }

  var dialogEl = $("dialog");
  var promptEl = $("dialog-prompt");
  function showDialog(d) {
    $("dialog-kind").textContent = d.kind;
    $("dialog-message").textContent = d.message;
    promptEl.hidden = d.kind !== "prompt";
    promptEl.value = d.defaultPrompt || "";
    dialogEl.hidden = false;
    (d.kind === "prompt" ? promptEl : $("dialog-accept")).focus();
  }
  function hideDialog() { dialogEl.hidden = true; focusScreen(); }
  function answer(accept) {
    var message = { type: "dialog", accept: accept };
    if (!promptEl.hidden && accept) message.promptText = promptEl.value;
    send(message);
  }
  $("dialog-accept").addEventListener("click", function () { answer(true); });
  $("dialog-dismiss").addEventListener("click", function () { answer(false); });

  var HELD = { agent_acting: "The agent is acting, so that input was held. Try again in a moment.", no_page: "There is no page to drive yet.", bad_message: "That input was not understood." };
  var REFUSED = { unauthorized: "This link's token was not accepted.", viewer_in_use: "Another viewer already has this session.", released: "This session has been released.", bad_message: "The host did not understand this viewer." };
  ws.onmessage = function (event) {
    if (typeof event.data !== "string") {
      if (decoding) { waiting = event.data; return; }
      decoding = true;
      draw(event.data);
      return;
    }
    var m;
    try { m = JSON.parse(event.data); } catch (e) { return; }
    if (m.type === "ready") { ready = true; setDrive(m.drive); say(""); focusScreen(); expectPicture(); }
    else if (m.type === "status") { setDrive(m.drive); if (m.drive !== "agent") say(""); else say("The agent is acting. Your input is held until it is done."); }
    else if (m.type === "page") { document.title = m.title ? m.title + " - Live view" : "Live view"; if (document.activeElement !== urlBox) urlBox.value = m.url; if (m.url !== shownUrl) { shownUrl = m.url; expectPicture(); } }
    else if (m.type === "dialog") showDialog(m);
    else if (m.type === "dialog_closed") hideDialog();
    else if (m.type === "held") say(HELD[m.reason] || "That input was held.");
    else if (m.type === "refused") { fatal = true; ready = false; stillEl.hidden = true; say(REFUSED[m.reason] || "The host refused this viewer.", true); }
    else if (m.type === "ended") { fatal = true; ready = false; say("This session has ended: the browser was released.", true); }
  };
  ws.onclose = function () { closed = true; ready = false; setDrive(""); if (!fatal) say("Disconnected. Open the live view link again.", true); };

  // Input: the page's CSS pixels, from the canvas's own box and the latest frame's width and height.
  var lastPoint = null;
  function point(e) {
    var rect = canvas.getBoundingClientRect();
    if (!frame.w || !rect.width) return null;
    var x = Math.round((e.clientX - rect.left) * (frame.w / rect.width));
    var y = Math.round((e.clientY - rect.top) * (frame.h / rect.height));
    // Kept inside the page's own area: a drag that leaves the canvas still names a place on the page.
    lastPoint = { x: Math.max(0, Math.min(frame.w, x)), y: Math.max(0, Math.min(frame.h, y)) };
    return lastPoint;
  }
  function mods(e) { return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0); }
  var BUTTONS = ["left", "middle", "right"];
  var moved = null;
  var scheduled = false;
  var pressing = false;
  // The buttons the page believes are held (MouseEvent.buttons: left 1, right 2, middle 4), so a window that loses focus can release each by its own name.
  var heldButtons = 0;
  // Moves are coalesced to one per animation frame; a button event must not overtake the move before it, so it flushes the pending move first.
  function flushMove() { if (moved) { send(moved); moved = null; } }
  function queueMove(e, p) {
    if (pressing) heldButtons = e.buttons;
    moved = { type: "mouse", action: "move", x: p.x, y: p.y, buttons: e.buttons, modifiers: mods(e) };
    if (!scheduled) { scheduled = true; requestAnimationFrame(function () { scheduled = false; flushMove(); }); }
  }
  function clicks(e) { return Math.max(1, Math.min(3, e.detail || 1)); }
  function release(e, p) {
    flushMove();
    pressing = e.buttons !== 0;
    heldButtons = e.buttons;
    send({ type: "mouse", action: "up", x: p.x, y: p.y, button: BUTTONS[e.button] || "left", buttons: e.buttons, clickCount: clicks(e), modifiers: mods(e) });
  }
  canvas.addEventListener("mousemove", function (e) {
    var p = point(e);
    if (!p) return;
    queueMove(e, p);
  });
  canvas.addEventListener("mousedown", function (e) {
    focusScreen();
    if (stillConnecting()) return;
    var p = point(e);
    if (!p) return;
    e.preventDefault();
    flushMove();
    pressing = true;
    heldButtons = e.buttons;
    send({ type: "mouse", action: "down", x: p.x, y: p.y, button: BUTTONS[e.button] || "left", buttons: e.buttons, clickCount: clicks(e), modifiers: mods(e) });
  });
  canvas.addEventListener("mouseup", function (e) {
    var p = point(e);
    if (!p) return;
    e.preventDefault();
    release(e, p);
  });
  // A drag that leaves the canvas still ends where the person lets go, or the page keeps the button down: while a button is held, moves and the release outside the canvas are sent too, and a window that loses focus releases.
  window.addEventListener("mousemove", function (e) {
    if (!pressing || e.target === canvas) return;
    var p = point(e);
    if (p) queueMove(e, p);
  });
  window.addEventListener("mouseup", function (e) {
    if (!pressing || e.target === canvas) return;
    var p = point(e);
    if (p) release(e, p);
  });
  window.addEventListener("blur", function () {
    if (!pressing || !lastPoint) return;
    flushMove();
    var held = heldButtons || 1;
    pressing = false;
    heldButtons = 0;
    // One release per held button, each by its own name and with the buttons still held after it: a right press is released as the right button, not the left.
    [[4, "middle"], [2, "right"], [1, "left"]].forEach(function (pair) {
      if (!(held & pair[0])) return;
      held = held & ~pair[0];
      send({ type: "mouse", action: "up", x: lastPoint.x, y: lastPoint.y, button: pair[1], buttons: held, clickCount: 1, modifiers: 0 });
    });
  });
  canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  canvas.addEventListener("wheel", function (e) {
    if (stillConnecting()) return;
    var p = point(e);
    if (!p) return;
    e.preventDefault();
    var unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? frame.h : 1;
    send({ type: "wheel", x: p.x, y: p.y, deltaX: Math.round(e.deltaX * unit), deltaY: Math.round(e.deltaY * unit), modifiers: mods(e) });
  }, { passive: false });

  // A key event can carry no code (a script's CDP keys, a virtual keyboard); the host refuses a message without one, so the viewer names the key: a letter or a digit by its own code, anything else Unidentified.
  function codeOf(e) {
    if (e.code) return e.code;
    var k = e.key;
    if (k.length === 1 && /[a-z]/i.test(k)) return "Key" + k.toUpperCase();
    if (k.length === 1 && /[0-9]/.test(k)) return "Digit" + k;
    return "Unidentified";
  }
  function keyMessage(action, e) {
    var printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    var text = printable ? e.key : e.key === "Enter" ? "\\r" : undefined;
    var message = { type: "key", action: action, key: e.key, code: codeOf(e), windowsVirtualKeyCode: e.keyCode, modifiers: mods(e) };
    if (text !== undefined && action === "down") message.text = text;
    return message;
  }
  // A keydown the browser made for an IME or a virtual keyboard (keyCode 229, isComposing, or key "Unidentified") says nothing about what was typed: the text comes as input and composition events, below.
  function textComesLater(e) { return e.isComposing || e.keyCode === 229 || e.key === "Unidentified"; }
  function onKeyDown(e) {
    if (textComesLater(e)) return;
    // Paste arrives as a paste event with the text; the shortcut itself is not sent as keys.
    if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) return;
    e.preventDefault();
    send(keyMessage("down", e));
  }
  function onKeyUp(e) {
    if (textComesLater(e)) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) return;
    e.preventDefault();
    send(keyMessage("up", e));
  }
  function onPaste(e) {
    var text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    e.preventDefault();
    if (text) send({ type: "text", text: text });
  }
  [canvas, sink].forEach(function (el) {
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("keyup", onKeyUp);
    el.addEventListener("paste", onPaste);
  });

  // Text that arrives without usable key events: a virtual keyboard's insertText, an autocorrection, its Enter and Backspace, and an IME's composition, whose text is sent once, when it ends.
  var committed = { text: "", at: 0 };
  function sendText(text) { if (text) send({ type: "text", text: text }); }
  function sendKey(key, code, vk, text) {
    var down = { type: "key", action: "down", key: key, code: code, windowsVirtualKeyCode: vk, modifiers: 0 };
    if (text) down.text = text;
    send(down);
    send({ type: "key", action: "up", key: key, code: code, windowsVirtualKeyCode: vk, modifiers: 0 });
  }
  sink.addEventListener("beforeinput", function (e) {
    if (e.isComposing) return;
    var t = e.inputType;
    if (t === "insertText" || t === "insertReplacementText") {
      var text = e.data || (e.dataTransfer ? e.dataTransfer.getData("text/plain") : "");
      e.preventDefault();
      // Some browsers repeat a composition's text as an insertText right after it ends.
      if (text && !(text === committed.text && Date.now() - committed.at < 100)) sendText(text);
    } else if (t === "insertLineBreak" || t === "insertParagraph") { e.preventDefault(); sendKey("Enter", "Enter", 13, "\\r"); }
    else if (t === "deleteContentBackward") { e.preventDefault(); sendKey("Backspace", "Backspace", 8); }
    else if (t === "deleteContentForward") { e.preventDefault(); sendKey("Delete", "Delete", 46); }
  });
  sink.addEventListener("compositionend", function (e) {
    if (e.data) { committed = { text: e.data, at: Date.now() }; sendText(e.data); }
    sink.value = "";
  });

  $("back").addEventListener("click", function () { send({ type: "nav", action: "back" }); focusScreen(); });
  $("reload").addEventListener("click", function () { send({ type: "nav", action: "reload" }); focusScreen(); });
  $("go").addEventListener("submit", function (e) {
    e.preventDefault();
    var value = urlBox.value.trim();
    if (!value) return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = "https://" + value;
    send({ type: "nav", action: "url", url: value });
    focusScreen();
  });
})();
`;

/** The viewer page and its two static files, served by the live view's server (never an inline script or style: the page's policy is `default-src 'self'`). */
export const viewerAssets: { readonly html: string; readonly js: string; readonly css: string } = Object.freeze({ html, js, css });
