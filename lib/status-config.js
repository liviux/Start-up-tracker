"use strict";

// The shape of a status configuration (content/statuses.json and the list the
// editor saves), checked without touching the database so the content check
// can use it too.

const fs = require("fs");
const path = require("path");

const BUILT_IN_FILE = path.join(__dirname, "..", "content", "statuses.json");
const ID_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;

class StatusError extends Error {
  constructor(message, code = "badStatuses", statusCode = 400) {
    super(message);
    this.name = "StatusError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

let builtInCache = null;
function builtIn() {
  if (!builtInCache) builtInCache = JSON.parse(fs.readFileSync(BUILT_IN_FILE, "utf8"));
  return JSON.parse(JSON.stringify(builtInCache));
}

function cleanText(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new StatusError(`${field} must be text.`);
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (required && !cleaned) throw new StatusError(`${field} cannot be empty.`);
  if (cleaned.length > max) throw new StatusError(`${field}: keep it under ${max} characters.`);
  return cleaned;
}

// Checks a whole configuration and returns it cleaned. Used for the editor's
// writes and by the content check on content/statuses.json itself.
function validateStatusConfig(config, reference = builtIn()) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new StatusError("The status configuration must be an object.");
  const groupIds = reference.groups.map((group) => group.id);
  if (!Array.isArray(config.groups) || config.groups.map((group) => group?.id).join() !== groupIds.join()) {
    throw new StatusError(`The groups are fixed: ${groupIds.join(", ")}, in that order.`, "fixedGroups");
  }
  const groups = config.groups.map((group, index) => ({
    id: group.id,
    label: cleanText(group.label, `groups[${index}].label`, 60, { required: true }),
    description: cleanText(group.description, `groups[${index}].description`, 300),
  }));

  if (!Array.isArray(config.statuses) || !config.statuses.length) throw new StatusError("The status list cannot be empty.");
  const seen = new Set();
  const builtInById = new Map(reference.statuses.map((status) => [status.id, status]));
  const statuses = config.statuses.map((status, index) => {
    const at = `statuses[${index}]`;
    if (!status || typeof status !== "object") throw new StatusError(`${at} must be an object.`);
    if (typeof status.id !== "string" || !ID_PATTERN.test(status.id)) throw new StatusError(`${at}.id must be lower case letters, digits and _ (got ${JSON.stringify(status.id)}).`, "badId");
    if (seen.has(status.id)) throw new StatusError(`${status.id} is listed twice.`, "duplicateId");
    seen.add(status.id);
    if (!groupIds.includes(status.group)) throw new StatusError(`${status.id}: the group must be one of ${groupIds.join(", ")}.`, "badGroup");
    const original = builtInById.get(status.id);
    if (original && original.group !== status.group) throw new StatusError(`${status.id} is built in and stays in ${original.group}.`, "builtInGroup");
    return {
      id: status.id,
      group: status.group,
      label: cleanText(status.label, `${status.id}.label`, 60, { required: true }),
      description: cleanText(status.description, `${status.id}.description`, 300),
      ...(original ? {} : { custom: true }),
    };
  });
  for (const id of builtInById.keys()) {
    if (!seen.has(id)) throw new StatusError(`${id} is built in and cannot be removed.`, "builtInRemoved");
  }

  const defaultStatus = config.defaultStatus ?? reference.defaultStatus;
  if (!seen.has(defaultStatus)) throw new StatusError(`The default status ${defaultStatus} is not in the list.`, "badDefault");
  const waitingStatuses = Array.isArray(config.waitingStatuses) ? config.waitingStatuses : reference.waitingStatuses;
  for (const id of waitingStatuses) {
    if (!seen.has(id)) throw new StatusError(`The waiting status ${id} is not in the list.`, "badWaiting");
  }

  if (!Array.isArray(config.campaignStatuses) || !config.campaignStatuses.length) throw new StatusError("Campaigns need at least one status.", "noCampaignStatuses");
  const campaignSeen = new Set();
  const campaignStatuses = config.campaignStatuses.map((status, index) => {
    const at = `campaignStatuses[${index}]`;
    if (!status || typeof status !== "object" || typeof status.id !== "string" || !ID_PATTERN.test(status.id)) throw new StatusError(`${at}.id must be lower case letters, digits and _.`, "badId");
    if (campaignSeen.has(status.id)) throw new StatusError(`Campaign status ${status.id} is listed twice.`, "duplicateId");
    campaignSeen.add(status.id);
    return {
      id: status.id,
      label: cleanText(status.label, `${status.id}.label`, 60, { required: true }),
      description: cleanText(status.description, `${status.id}.description`, 300),
    };
  });

  return { version: 1, defaultStatus, groups, statuses, waitingStatuses: [...waitingStatuses], campaignStatuses };
}

module.exports = { StatusError, builtIn, validateStatusConfig, ID_PATTERN };
