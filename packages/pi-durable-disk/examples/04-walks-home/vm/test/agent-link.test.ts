import assert from "node:assert/strict";
import { test } from "node:test";
import { agentLink } from "../agent-link.ts";

test("the robot's page address carries the go-live switch before the fragment, once, whoever opens it", () => {
  assert.equal(agentLink("http://127.0.0.1:8763/run/walks-home#SECRET", "golive=1"), "http://127.0.0.1:8763/run/walks-home?golive=1#SECRET");
  assert.equal(agentLink("http://127.0.0.1:8763/run/walks-home?golive=1#SECRET", "golive=1"), "http://127.0.0.1:8763/run/walks-home?golive=1#SECRET", "not added twice");
  assert.equal(agentLink("http://127.0.0.1:8763/run/walks-home", "golive=1"), "http://127.0.0.1:8763/run/walks-home?golive=1");
  assert.ok(agentLink("http://h/run/x#a#b", "golive=1").endsWith("#a#b"), "the fragment stays last and whole");
});
