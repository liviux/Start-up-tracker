"use strict";

// OpenRouter routing variants for OpenCode (lib/agents/openrouter.js).

const assert = require("node:assert/strict");
const test = require("node:test");
const { ROUTING_VARIANTS, supportsRouting, isRoutingModel, routingEnv } = require("../lib/agents/openrouter");

test("only OpenCode takes routing variants, and only on openrouter/ models", () => {
  assert.deepEqual([...ROUTING_VARIANTS], [":nitro", ":floor", ":exacto"]);
  assert.equal(supportsRouting({ registryId: "opencode" }), true);
  assert.equal(supportsRouting({ registryId: "opencode-v2" }), true);
  assert.equal(supportsRouting({ kind: "custom", command: "/usr/local/bin/opencode" }), true);
  assert.equal(supportsRouting({ registryId: "kilo" }), false);
  assert.equal(supportsRouting({ registryId: "opencoder" }), false);
  assert.equal(isRoutingModel("openrouter/deepseek/deepseek-v4-flash:floor"), true);
  assert.equal(isRoutingModel("openrouter/deepseek/deepseek-v4-flash"), false);
  assert.equal(isRoutingModel("kilo/openrouter/auto:nitro"), false);
  assert.equal(isRoutingModel("openrouter/:nitro"), false);
});

test("the variants picked are registered in OPENCODE_CONFIG_CONTENT, over the user's own", () => {
  const harness = { registryId: "opencode" };
  const env = { PATH: "/bin", OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "x", provider: { openrouter: { options: { a: 1 }, models: { "kept/model": { name: "Kept" } } } } }) };
  const next = routingEnv(harness, ["openrouter/a/b:nitro", "openrouter/a/b", "", "openrouter/a/b:nitro", "openrouter/c/d:floor"], env);
  assert.deepEqual(JSON.parse(next.OPENCODE_CONFIG_CONTENT), {
    theme: "x",
    provider: { openrouter: { options: { a: 1 }, models: { "kept/model": { name: "Kept" }, "a/b:nitro": {}, "c/d:floor": {} } } },
  });
  assert.equal(next.PATH, "/bin");
  assert.equal(routingEnv(harness, ["openrouter/a/b"], env), env, "nothing to register");
  assert.equal(routingEnv({ registryId: "kilo" }, ["openrouter/a/b:nitro"], env), env, "not OpenCode");
  const broken = routingEnv(harness, ["openrouter/a/b:exacto"], { OPENCODE_CONFIG_CONTENT: "not json" });
  assert.deepEqual(JSON.parse(broken.OPENCODE_CONFIG_CONTENT), { provider: { openrouter: { models: { "a/b:exacto": {} } } } });
});
