// The "Wi-Fi" control next to the badge. Cutting the network is the user's act, so the viewer sees it done: a click reads "Wi-Fi: off" at once, and
// then the browser's own offline event (the take cuts the network with CDP offline emulation) is the truth the label follows. If a click is
// never followed by a real offline, the label goes back after a few seconds rather than keep saying something that is not so.
export function wifiLabel(online: boolean, clickedAt: number | null, now: number, graceMs = 6000): string {
  return !online || (clickedAt !== null && now - clickedAt < graceMs) ? "Wi-Fi: off" : "Wi-Fi: on";
}
