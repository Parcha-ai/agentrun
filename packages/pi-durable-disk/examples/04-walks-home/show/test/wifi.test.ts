import assert from "node:assert/strict";
import { test } from "node:test";
import { wifiLabel } from "../page/wifi.ts";

test("the control reads Wi-Fi: on while the browser is online and nobody has clicked it", () => {
  assert.equal(wifiLabel(true, null, 1000), "Wi-Fi: on");
});

test("a click is the user's action: it reads off at once, then follows the browser's real state", () => {
  assert.equal(wifiLabel(true, 1000, 1200), "Wi-Fi: off", "just clicked");
  assert.equal(wifiLabel(false, 1000, 2500), "Wi-Fi: off", "the browser went offline");
  assert.equal(wifiLabel(false, null, 2500), "Wi-Fi: off", "offline for any reason says off");
});

test("a click that never became a real offline does not leave the label saying off", () => {
  assert.equal(wifiLabel(true, 1000, 1000 + 5_999), "Wi-Fi: off");
  assert.equal(wifiLabel(true, 1000, 1000 + 6_000), "Wi-Fi: on", "the network never went off, so the label goes back");
});
