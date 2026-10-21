"use strict";

// A small reader and writer for gzip-compressed tar archives (ustar with pax
// long names), so building and unpacking a release needs no system tar.
//
// Only regular files and folders are written or accepted. Links, devices and
// any entry whose path is absolute or climbs out with ".." are refused before
// anything is written to disk.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const BLOCK = 512;

class TarError extends Error {
  constructor(message) {
    super(message);
    this.name = "TarError";
  }
}

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function writeString(buffer, offset, length, value) {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function header({ name, size, mode, type, mtime }) {
  const block = Buffer.alloc(BLOCK);
  writeString(block, 0, 100, name);
  writeString(block, 100, 8, octal(mode & 0o7777, 8));
  writeString(block, 108, 8, octal(0, 8));
  writeString(block, 116, 8, octal(0, 8));
  writeString(block, 124, 12, octal(size, 12));
  writeString(block, 136, 12, octal(Math.floor(mtime / 1000), 12));
  block.fill(" ", 148, 156);
  writeString(block, 156, 1, type);
  writeString(block, 257, 6, "ustar\0");
  writeString(block, 263, 2, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function padding(size) {
  const rest = size % BLOCK;
  return rest ? Buffer.alloc(BLOCK - rest) : Buffer.alloc(0);
}

// A pax record is "<length> path=<value>\n", where the length counts itself.
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length += 1;
  return `${length}${body}`;
}

// entries: [{ name, data?: Buffer, mode?, directory?: true }]. Folder names
// end with "/" in the archive.
function createTarGz(entries, { mtime = Date.now() } = {}) {
  const parts = [];
  for (const entry of entries) {
    const isDirectory = Boolean(entry.directory);
    const name = checkEntryName(entry.name) + (isDirectory ? "/" : "");
    const data = isDirectory ? Buffer.alloc(0) : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ""), "utf8");
    const mode = entry.mode ?? (isDirectory ? 0o755 : 0o644);
    if (Buffer.byteLength(name) > 100) {
      const pax = Buffer.from(paxRecord("path", name), "utf8");
      parts.push(header({ name: "././@PaxHeader", size: pax.length, mode: 0o644, type: "x", mtime }), pax, padding(pax.length));
    }
    parts.push(header({ name: name.slice(0, 100), size: data.length, mode, type: isDirectory ? "5" : "0", mtime }));
    if (data.length) parts.push(data, padding(data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

function readString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readOctal(buffer, offset, length) {
  const text = readString(buffer, offset, length).trim();
  return text ? parseInt(text, 8) : 0;
}

function checkEntryName(name) {
  const value = String(name).replace(/\/+$/, "");
  if (!value || value.includes("\0") || value.includes("\\")) throw new TarError(`Unusable entry name in the archive: ${JSON.stringify(value)}`);
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) throw new TarError(`The archive holds an absolute path: ${value}`);
  if (value.split("/").some((segment) => segment === ".." || segment === "")) throw new TarError(`The archive holds a path that leaves its folder: ${value}`);
  return value.split("/").filter((segment) => segment !== ".").join("/");
}

// Lists the entries of a .tar.gz buffer: [{ name, type: "file"|"directory", mode, data }].
function readTarGz(buffer) {
  let tar;
  try {
    tar = zlib.gunzipSync(buffer);
  } catch (error) {
    throw new TarError(`The archive is not a gzip file: ${error.message}`);
  }
  const entries = [];
  let offset = 0;
  let pendingName = null;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const size = readOctal(block, 124, 12);
    const type = String.fromCharCode(block[156] || 48);
    const prefix = readString(block, 345, 155);
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    if (data.length !== size) throw new TarError("The archive ends in the middle of a file.");
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x" || type === "L") {
      const text = data.toString("utf8");
      pendingName = type === "L" ? text.replace(/\0+$/, "") : (text.match(/(?:^|\n)\d+ path=([^\n]*)\n/) || [])[1] || pendingName;
      continue;
    }
    if (type === "g") continue;
    const rawName = pendingName || (prefix ? `${prefix}/${readString(block, 0, 100)}` : readString(block, 0, 100));
    pendingName = null;
    const name = checkEntryName(rawName);
    if (name === "." || name === "") continue;
    if (type === "5") entries.push({ name, type: "directory", mode: readOctal(block, 100, 8), data: Buffer.alloc(0) });
    else if (type === "0" || type === "\0" || type === "7") entries.push({ name, type: "file", mode: readOctal(block, 100, 8), data: Buffer.from(data) });
    else throw new TarError(`The archive holds a link or special file, which a release never does: ${name}`);
  }
  return entries;
}

// Unpacks into `destination`, which must not exist yet. Returns the entries.
function extractTarGz(buffer, destination) {
  const entries = readTarGz(buffer);
  if (fs.existsSync(destination)) throw new TarError(`${destination} already exists.`);
  fs.mkdirSync(destination, { recursive: true });
  const root = path.resolve(destination);
  for (const entry of entries) {
    const target = path.resolve(root, ...entry.name.split("/"));
    if (target !== root && !target.startsWith(root + path.sep)) throw new TarError(`The archive holds a path that leaves its folder: ${entry.name}`);
    if (entry.type === "directory") {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.data, { mode: entry.mode & 0o111 ? 0o755 : 0o644 });
    }
  }
  return entries;
}

module.exports = { TarError, createTarGz, readTarGz, extractTarGz, checkEntryName };
