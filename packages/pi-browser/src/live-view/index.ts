export { createLiveView, type LiveViewHost, type LiveViewOptions, type TakeAnswer } from "./server.js";
export { liveViewProvider } from "./provider.js";
export * from "./protocol.js";
export { createDrivingGates, drivingGates, personDrivingFailure, PERSON_DRIVING, withModelCall, type DrivingOptions } from "../core/driving.js";
export { viewerAssets } from "./viewer.js";
// The WebSocket server and the viewer's credentials, for another live view built on this protocol (serve's computer
// viewer, computer-live.ts): the same handshake, frames and token checks.
export { acceptWebSocket, type WsConn, type WsOptions } from "./ws.js";
export { newToken, newViewerId, tokenMatches } from "./token.js";
