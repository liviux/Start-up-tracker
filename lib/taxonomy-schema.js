"use strict";

// The shape of the category library (content/taxonomy/<section>.json and the
// nodes the editor saves), checked without the database so the content check
// can use it too.

const fs = require("fs");
const path = require("path");

const SECTIONS = ["mk", "po", "fu"];
const LEVELS = ["category", "subcategory", "type"];
const PARENT_LEVEL = { category: null, subcategory: "category", type: "subcategory" };
const ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,120}$/;
const LIBRARY_DIR = path.join(__dirname, "..", "content", "taxonomy");
const MAX_DESCRIPTION = 400;

class TaxonomyError extends Error {
  constructor(message, code = "badTaxonomy", statusCode = 400) {
    super(message);
    this.name = "TaxonomyError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function cleanText(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new TaxonomyError(`${field} must be text.`);
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (required && !cleaned) throw new TaxonomyError(`${field} cannot be empty.`, "required");
  if (cleaned.length > max) throw new TaxonomyError(`${field}: keep it under ${max} characters.`, "tooLong");
  return cleaned;
}

// One node, cleaned. `section` comes from the node or the file it is in.
function cleanNode(node, section) {
  if (!node || typeof node !== "object") throw new TaxonomyError("A node must be an object.");
  const id = String(node.id || "");
  if (!ID_PATTERN.test(id)) throw new TaxonomyError(`Unusable node id: ${JSON.stringify(node.id)}`, "badId");
  const nodeSection = node.section || section;
  if (!SECTIONS.includes(nodeSection)) throw new TaxonomyError(`${id}: the section must be one of ${SECTIONS.join(", ")}.`, "badSection");
  if (!LEVELS.includes(node.level)) throw new TaxonomyError(`${id}: the level must be one of ${LEVELS.join(", ")}.`, "badLevel");
  const cleaned = {
    id,
    section: nodeSection,
    level: node.level,
    parentId: node.parentId ? String(node.parentId) : null,
    name: cleanText(node.name, `${id}.name`, 80, { required: true }),
    description: cleanText(node.description, `${id}.description`, MAX_DESCRIPTION, { required: true }),
    order: Number.isFinite(Number(node.order)) ? Number(node.order) : 0,
  };
  if (node.level === "category") cleaned.shortName = cleanText(node.shortName || node.name, `${id}.shortName`, 24, { required: true });
  if (node.recommended) cleaned.recommended = true;
  if (node.custom) cleaned.custom = true;
  if (node.libraryVersion !== undefined) cleaned.libraryVersion = Number(node.libraryVersion) || 1;
  return cleaned;
}

// A whole set of nodes: ids unique, every parent present, levels chained
// category > subcategory > type, children in the parent's section.
function validateNodes(nodes, section) {
  if (!Array.isArray(nodes)) throw new TaxonomyError("The nodes must be a list.");
  const cleaned = nodes.map((node) => cleanNode(node, section));
  const byId = new Map();
  for (const node of cleaned) {
    if (byId.has(node.id)) throw new TaxonomyError(`${node.id} is listed twice.`, "duplicateId");
    byId.set(node.id, node);
  }
  for (const node of cleaned) {
    const wanted = PARENT_LEVEL[node.level];
    const parent = node.parentId ? byId.get(node.parentId) : null;
    if (wanted === null && node.parentId) throw new TaxonomyError(`${node.id}: a category has no parent.`, "badParent");
    if (wanted !== null && (!parent || parent.level !== wanted)) throw new TaxonomyError(`${node.id}: a ${node.level} needs a ${wanted} as its parent.`, "badParent");
    if (parent && parent.section !== node.section) throw new TaxonomyError(`${node.id}: its parent is in another section.`, "badParent");
  }
  return cleaned;
}

// One library file: { section, libraryVersion, nodes }.
function validateLibraryFile(file) {
  if (!file || typeof file !== "object") throw new TaxonomyError("A library file must be an object.");
  if (!SECTIONS.includes(file.section)) throw new TaxonomyError(`section must be one of ${SECTIONS.join(", ")}.`, "badSection");
  if (!Number.isInteger(file.libraryVersion) || file.libraryVersion < 1) throw new TaxonomyError("libraryVersion must be a whole number from 1.", "badVersion");
  const nodes = validateNodes(file.nodes, file.section);
  if (nodes.some((node) => node.section !== file.section)) throw new TaxonomyError("Every node must be in the file's section.", "badSection");
  return { section: file.section, libraryVersion: file.libraryVersion, nodes };
}

// The shipped library, all three sections, with each node stamped with the
// version it arrived in.
function loadLibrary(dir = LIBRARY_DIR) {
  const library = {};
  for (const section of SECTIONS) {
    const file = validateLibraryFile(JSON.parse(fs.readFileSync(path.join(dir, `${section}.json`), "utf8")));
    library[section] = {
      libraryVersion: file.libraryVersion,
      nodes: file.nodes.map((node) => ({ ...node, libraryVersion: node.libraryVersion || file.libraryVersion })),
    };
  }
  return library;
}

module.exports = { SECTIONS, LEVELS, PARENT_LEVEL, TaxonomyError, cleanNode, validateNodes, validateLibraryFile, loadLibrary };
