// A fake Chrome with one page, for the raw-CDP driver (src/driver/cdp.ts): it answers the commands the driver sends from a
// small model of a form (a heading, a text field, a select, an Add button, a link far down the page) and a cross-origin
// frame whose tree cannot be read. It knows the driver's in-page functions by what they contain: the settle probe, the
// visible-text walk, the hit-test, a field's kind and value, the select. A click lands on the element under the pointer;
// keys and inserted text go to the focused field. Every command is in `calls`.
import { createHash } from "node:crypto";
import http from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const encode = (text) => {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
};
function decoder(onText, onClose) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 15;
      let length = buffer[1] & 127;
      let at = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); at = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); at = 10; }
      if (buffer.length < at + 4 + length) return;
      const mask = buffer.subarray(at, at + 4);
      const body = Buffer.from(buffer.subarray(at + 4, at + 4 + length));
      for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
      buffer = buffer.subarray(at + 4 + length);
      if (opcode === 1) onText(body.toString("utf8"));
      else if (opcode === 8) { onClose(); return; }
    }
  };
}

/** The form's elements by backend node id, with where each sits once scrolled into view. */
const form = () => ({
  10: { role: "textbox", name: "City", tag: "INPUT", value: "", box: { x: 100, y: 100 } },
  11: { role: "button", name: "Add", tag: "BUTTON", box: { x: 100, y: 200 } },
  12: { role: "combobox", name: "Country", tag: "SELECT", value: "fr", options: [{ label: "France", value: "fr" }, { label: "Canada", value: "ca" }], box: { x: 100, y: 300 } },
  13: { role: "link", name: "Next page", tag: "A", box: { x: 100, y: 2000 }, href: "https://example.test/next" },
});

export async function fakeAxPage({ url = "https://example.test/form", title = "The form" } = {}) {
  const calls = [];
  const state = { url, title, doc: 1, n: 0, nodes: form(), added: [], focused: null, selectAll: false, scrolled: new Set() };
  const sockets = new Set();

  const axTree = () => {
    const nodes = [{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: state.title }, childIds: ["2", "3", ...Object.keys(state.nodes).map((id) => `n${id}`), ...state.added.map((_, i) => `a${i}`)] }];
    nodes.push({ nodeId: "2", role: { value: "heading" }, name: { value: "Plan a trip" }, childIds: [] });
    nodes.push({ nodeId: "3", role: { value: "StaticText" }, name: { value: "Fill in the form." } });
    for (const [id, node] of Object.entries(state.nodes)) {
      const popup = node.options ? [{ nodeId: `p${id}`, role: { value: "MenuListPopup" }, childIds: node.options.map((_, i) => `o${id}-${i}`) }, ...node.options.map((o, i) => ({ nodeId: `o${id}-${i}`, role: { value: "option" }, name: { value: o.label } }))] : [];
      const value = node.options ? node.options.find((o) => o.value === node.value)?.label : node.value;
      nodes.push({ nodeId: `n${id}`, role: { value: node.role }, name: { value: node.name }, ...(value ? { value: { value } } : {}), backendDOMNodeId: Number(id), properties: [{ name: "focusable", value: { value: true } }], childIds: popup.length ? [`p${id}`] : [] }, ...popup);
    }
    state.added.forEach((text, i) => nodes.push({ nodeId: `a${i}`, role: { value: "StaticText" }, name: { value: text } }));
    return nodes;
  };
  const visible = () => ["plan a trip", "fill in the form.", ...state.added.map((t) => t.toLowerCase())].join(" ");
  const at = (x, y) => Object.entries(state.nodes).find(([, n]) => n.box.x === x && n.box.y - (n.scrolledBy ?? 0) === y);
  const navigate = (to) => { state.url = to; state.title = "Next"; state.doc += 1; state.nodes = {}; state.added = []; };
  const type = (text) => {
    const node = state.nodes[state.focused];
    if (!node) return;
    node.value = state.selectAll ? text : `${node.value}${text}`;
    state.selectAll = false;
    state.n += 1;
  };

  function handle(socket, raw) {
    const { id, method, params = {}, sessionId } = JSON.parse(raw);
    calls.push({ method, params });
    const reply = (result = {}) => socket.write(encode(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), result })));
    const error = (message) => socket.write(encode(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), error: { code: -32000, message } })));
    const fn = params.functionDeclaration ?? "";
    const target = Number(String(params.objectId ?? "").replace("obj-", ""));
    const node = state.nodes[target];
    switch (method) {
      case "Target.getTargets": return reply({ targetInfos: [{ targetId: "PAGE", type: "page", url: state.url }, { targetId: "XFRAME", type: "iframe", url: "https://ads.other.test/frame", parentFrameId: "MAIN" }] });
      case "Target.attachToTarget": return reply({ sessionId: "S1" });
      case "Target.getTargetInfo": return reply({ targetInfo: { targetId: "PAGE", type: "page", url: state.url } });
      case "Page.getFrameTree": return reply({ frameTree: { frame: { id: "MAIN", url: state.url }, childFrames: [{ frame: { id: "XFRAME", url: "https://ads.other.test/frame" } }] } });
      case "Accessibility.getFullAXTree": return params.frameId ? error("Frame with the given frameId is not found.") : reply({ nodes: axTree() });
      case "Page.navigate": navigate(params.url); return reply({ frameId: "MAIN", loaderId: `L${state.doc}` });
      case "Page.captureScreenshot": return reply({ data: Buffer.from("fake-png").toString("base64") });
      case "DOM.resolveNode": return state.nodes[params.backendNodeId] ? reply({ object: { objectId: `obj-${params.backendNodeId}` } }) : error("No node with given id found");
      case "DOM.scrollIntoViewIfNeeded": {
        const scrolled = state.nodes[params.backendNodeId];
        // A node far down the page is scrolled to the middle of an 800 px viewport.
        if (scrolled && scrolled.box.y > 800) scrolled.scrolledBy = scrolled.box.y - 400;
        state.scrolled.add(params.backendNodeId);
        return reply();
      }
      case "DOM.focus": state.focused = params.backendNodeId; return reply();
      case "Input.dispatchMouseEvent": {
        if (params.type === "mouseReleased") {
          const hit = at(params.x, params.y);
          if (hit) {
            const [hitId, clicked] = hit;
            if (clicked.tag === "INPUT") state.focused = Number(hitId);
            if (clicked.name === "Add") { state.added.push(`Added ${state.nodes[10].value || "nothing"}`); state.n += 1; }
            if (clicked.href) navigate(clicked.href);
          }
        }
        return reply();
      }
      case "Input.insertText": type(params.text); return reply();
      case "Input.dispatchKeyEvent":
        if (params.commands?.includes("selectAll")) state.selectAll = true;
        else if (params.type === "keyDown" && params.text) type(params.text);
        else if (params.type === "rawKeyDown" && params.key === "Backspace" && state.selectAll) type("");
        return reply();
      case "Runtime.evaluate": {
        const expression = params.expression ?? "";
        if (expression.includes("__buObs")) return reply({ result: { value: { idle: 1000, ready: "complete", url: state.url, title: state.title, n: state.n, doc: state.doc } } });
        if (expression.includes("createTreeWalker")) return reply({ result: { value: visible() } });
        // The caret put after a field's whole text before a type: counted, so a test sees it was placed.
        if (expression.includes("setSelectionRange")) {
          state.caretAtEnd = (state.caretAtEnd ?? 0) + 1;
          return reply({ result: { value: true } });
        }
        if (expression.includes('document.readyState !== "loading"')) return reply({ result: { value: true } });
        if (expression.includes("outerHTML")) return reply({ result: { value: { url: state.url, title: state.title, text: visible(), html: "<html></html>" } } });
        return reply({ result: { value: null } });
      }
      case "Runtime.callFunctionOn": {
        if (!node) return error("Could not find object with given id");
        if (fn.includes("elementFromPoint")) return reply({ result: { value: { x: node.box.x, y: node.box.y - (node.scrolledBy ?? 0), covered: false } } });
        if (fn.includes("return {tag:e.tagName")) return reply({ result: { value: { tag: node.tag, type: node.tag === "INPUT" ? "text" : "" } } });
        if (fn.includes("document.activeElement")) return reply({ result: { value: false } });
        if (fn.includes("e.isContentEditable?e.innerText")) return reply({ result: { value: node.value ?? "" } });
        if (fn.includes("this.tagName !== 'SELECT'")) {
          if (node.tag !== "SELECT") return reply({ exceptionDetails: { exception: { description: "Error: not a select: click it and then the option instead" } } });
          const want = params.arguments[0].value[0].toLowerCase();
          const option = node.options.find((o) => o.label.toLowerCase() === want || o.value === want);
          if (!option) return reply({ exceptionDetails: { exception: { description: `Error: no option "${want}"` } } });
          node.value = option.value;
          state.n += 1;
          return reply({ result: { value: [option.label] } });
        }
        return reply({ result: { value: null } });
      }
      default: return reply();
    }
  }

  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}${GUID}`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on("data", decoder((text) => handle(socket, text), () => socket.end(Buffer.from([0x88, 0x00]))));
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    state, calls,
    url: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); },
  };
}
