// What each tile shows of its child's browser: a cloud provider's live-view URL, or a screencast of a local Chrome's
// active page. Live-view URLs carry a token: they go to the page's event stream only, never to a model or a log.

/** Wraps a child's provider so its sessions feed the tile; the browser tools see the provider unchanged. */
export function watchedProvider(provider, tile) {
  const watched = Object.create(provider);
  let current = null;
  watched.create = async (spec, signal) => {
    const ref = await provider.create(spec, signal);
    current = ref.id;
    tile.launched(ref);
    if (provider.liveView) provider.liveView(ref).then((view) => { if (current === ref.id && view?.fullscreen) tile.live(view.fullscreen); }, () => {});
    return ref;
  };
  watched.attach = async (ref, signal) => {
    const target = await provider.attach(ref, signal);
    if (!provider.liveView) tile.screencast(target.sdkCdpUrl);
    return target;
  };
  watched.release = async (ref, signal) => {
    if (current === ref.id) current = null;
    tile.stopScreencast();
    await provider.release(ref, signal);
    tile.released(ref);
  };
  return watched;
}

/** A read-only screencast of the page the agent is using: the newest page, or the one that last moved to a new URL.
 *  Every frame is acknowledged; the newest reaches `onFrame` at most once per `everyMs`, so the last one always lands. */
export function screencast(browserUrl, onFrame, { maxWidth = 640, quality = 55, everyMs = 250 } = {}) {
  const socket = new WebSocket(browserUrl);
  let seq = 0;
  let current = null;
  let lastSent = 0;
  let pending = null;
  let timer = null;
  const deliver = () => { timer = null; if (pending !== null) { lastSent = Date.now(); onFrame(pending); pending = null; } };
  const send = (method, params = {}, sessionId) => { if (socket.readyState === 1) socket.send(JSON.stringify({ id: ++seq, method, params, ...(sessionId ? { sessionId } : {}) })); };
  const follow = (targetId) => {
    if (current?.targetId === targetId) return;
    if (current?.sessionId) send("Target.detachFromTarget", { sessionId: current.sessionId });
    current = { targetId, sessionId: null };
    send("Target.attachToTarget", { targetId, flatten: true });
  };
  socket.onopen = () => send("Target.setDiscoverTargets", { discover: true });
  socket.onmessage = (event) => {
    const { method, params, sessionId } = JSON.parse(String(event.data));
    if (method === "Target.targetCreated" && params.targetInfo.type === "page") follow(params.targetInfo.targetId);
    else if (method === "Target.targetInfoChanged" && params.targetInfo.type === "page" && params.targetInfo.url !== "about:blank") follow(params.targetInfo.targetId);
    else if (method === "Target.attachedToTarget") {
      if (params.targetInfo.targetId !== current?.targetId) return send("Target.detachFromTarget", { sessionId: params.sessionId });
      current.sessionId = params.sessionId;
      send("Page.startScreencast", { format: "jpeg", quality, maxWidth, maxHeight: Math.round(maxWidth * 0.75) }, params.sessionId);
    } else if (method === "Page.screencastFrame") {
      send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId);
      if (sessionId !== current?.sessionId) return;
      pending = params.data;
      timer ??= setTimeout(deliver, Math.max(0, everyMs - (Date.now() - lastSent)));
    } else if (method === "Target.targetDestroyed" && params.targetId === current?.targetId) current = null;
  };
  socket.onerror = () => {};
  return { close: () => { clearTimeout(timer); timer = null; pending = null; try { socket.close(); } catch {} } };
}
