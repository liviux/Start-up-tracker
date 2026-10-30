"use strict";

// OpenRouter routing variants for OpenCode. OpenRouter accepts a routing
// suffix on any model id (https://openrouter.ai/docs/guides/routing/model-variants):
// :nitro sorts providers by speed, :floor by price, :exacto by tool-calling
// quality. OpenCode only takes a model id it lists, so each variant picked is
// registered under provider.openrouter.models in the inline config
// (OPENCODE_CONFIG_CONTENT, merged over the user's own config) the agent
// starts with.

const path = require("path");

const ROUTING_VARIANTS = Object.freeze([":nitro", ":floor", ":exacto"]);
const PREFIX = "openrouter/";

// OpenCode from the registry ("opencode", "opencode-v2"), or a custom
// command that runs it.
function supportsRouting(harness) {
  if (/^opencode(?:-|$)/.test(String(harness?.registryId || ""))) return true;
  return harness?.kind === "custom" && path.basename(String(harness.command || "")).replace(/\.(exe|cmd)$/i, "") === "opencode";
}

function isRoutingModel(model) {
  const value = String(model || "");
  return value.startsWith(PREFIX) && ROUTING_VARIANTS.some((suffix) => value.endsWith(suffix) && value.length > PREFIX.length + suffix.length);
}

// The launch environment with every routing model in `models` registered.
// An OPENCODE_CONFIG_CONTENT you set yourself is kept and added to.
function routingEnv(harness, models, env) {
  if (!supportsRouting(harness)) return env;
  const ids = [...new Set((models || []).filter(isRoutingModel))];
  if (!ids.length) return env;
  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  let config = {};
  try {
    config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}");
  } catch {
    config = {};
  }
  if (!isObject(config)) config = {};
  const provider = isObject(config.provider) ? config.provider : {};
  const openrouter = isObject(provider.openrouter) ? provider.openrouter : {};
  const registered = isObject(openrouter.models) ? { ...openrouter.models } : {};
  for (const id of ids) registered[id.slice(PREFIX.length)] ??= {};
  const next = { ...config, provider: { ...provider, openrouter: { ...openrouter, models: registered } } };
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(next) };
}

module.exports = { ROUTING_VARIANTS, supportsRouting, isRoutingModel, routingEnv };
