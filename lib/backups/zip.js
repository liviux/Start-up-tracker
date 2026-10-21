"use strict";

// A small zip writer and reader for exports, built on zlib alone. It handles
// what the tracker writes: stored or deflated files, no encryption, no zip64.
// The reader is strict because it reads files people bring in: paths that
// climb out of the archive, absolute paths, symlinks, too many entries and
// oversized content are refused before anything is extracted.

const zlib = require("zlib");

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const UTF8_FLAG = 0x0800;
const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

const DEFAULT_LIMITS = {
  maxEntries: 20_000,
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

class ZipError extends Error {
  constructor(message, code = "badZip") {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

// DOS date and time, which zip stores in local time without a zone.
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// Archive paths use forward slashes, are relative and never climb out.
function checkEntryName(name) {
  const value = String(name);
  if (!value || value.length > 1024) throw new ZipError(`Unusable entry name: ${JSON.stringify(value.slice(0, 80))}`, "badEntryName");
  if (value.includes("\0") || value.includes("\\")) throw new ZipError(`Entry name has a forbidden character: ${value}`, "badEntryName");
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) throw new ZipError(`Entry name is an absolute path: ${value}`, "absolutePath");
  const segments = value.replace(/\/$/, "").split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new ZipError(`Entry name leaves the archive or is malformed: ${value}`, "pathTraversal");
  }
  return value;
}

// entries: [{ name, data: Buffer | string, date?: Date }]. Text and JSON
// compress well; files that are already compressed are stored as they are
// when deflating would not make them smaller.
function createZip(entries, { now = new Date() } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const seen = new Set();

  for (const entry of entries) {
    const name = checkEntryName(entry.name);
    if (seen.has(name)) throw new ZipError(`Duplicate entry name: ${name}`, "duplicateEntry");
    seen.add(name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ""), "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORED;
    const crc = zlib.crc32(data) >>> 0;
    const { time, date } = dosDateTime(entry.date || now);
    const nameBuffer = Buffer.from(name, "utf8");
    if (body.length > 0xfffffffe || data.length > 0xfffffffe || offset > 0xfffffffe) {
      throw new ZipError("The export is too large for a zip file without zip64.", "tooLarge");
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE((UNIX_HOST << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    // A regular file with mode 0644, so unzip tools never see a link.
    central.writeUInt32LE(((0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuffer, body);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + body.length;
  }

  if (seen.size > 0xffff) throw new ZipError("Too many entries for a zip file without zip64.", "tooLarge");
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(seen.size, 8);
  end.writeUInt16LE(seen.size, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, end]);
}

function findEndOfCentralDirectory(buffer) {
  // The record is 22 bytes plus a comment of at most 65535 bytes.
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let index = buffer.length - 22; index >= lowest; index -= 1) {
    if (buffer.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY) return index;
  }
  throw new ZipError("This is not a zip file (no end of central directory).", "notZip");
}

// Lists the entries without extracting anything, checking every name, type
// and size against the limits first.
function listZip(buffer, limits = {}) {
  const max = { ...DEFAULT_LIMITS, ...limits };
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new ZipError("This is not a zip file.", "notZip");
  const endIndex = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(endIndex + 10);
  const size = buffer.readUInt32LE(endIndex + 12);
  const start = buffer.readUInt32LE(endIndex + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new ZipError("zip64 archives are not supported.", "zip64");
  if (count > max.maxEntries) throw new ZipError(`The archive has ${count} entries; the limit is ${max.maxEntries}.`, "tooManyEntries");
  if (start + size > endIndex) throw new ZipError("The central directory is out of bounds.", "corrupt");

  const entries = [];
  const names = new Set();
  let total = 0;
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > endIndex || buffer.readUInt32LE(cursor) !== CENTRAL_HEADER) throw new ZipError("The central directory is damaged.", "corrupt");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const host = buffer.readUInt16LE(cursor + 4) >> 8;
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString(flags & UTF8_FLAG ? "utf8" : "latin1");
    cursor += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x0001) throw new ZipError(`Encrypted entries are not supported: ${name}`, "encrypted");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("zip64 archives are not supported.", "zip64");
    const mode = host === UNIX_HOST ? (externalAttributes >>> 16) & S_IFMT : 0;
    if (mode === S_IFLNK) throw new ZipError(`Symbolic links are not accepted: ${name}`, "symlink");
    const isDirectory = name.endsWith("/") || mode === S_IFDIR;
    checkEntryName(name);
    if (names.has(name)) throw new ZipError(`Duplicate entry name: ${name}`, "duplicateEntry");
    names.add(name);
    if (!isDirectory && method !== METHOD_STORED && method !== METHOD_DEFLATE) throw new ZipError(`Unsupported compression in ${name}.`, "unsupportedMethod");
    if (uncompressedSize > max.maxEntryBytes) throw new ZipError(`${name} is too large.`, "entryTooLarge");
    total += uncompressedSize;
    if (total > max.maxTotalBytes) throw new ZipError("The archive's content is too large.", "tooLarge");
    entries.push({ name, isDirectory, method, crc, compressedSize, uncompressedSize, localOffset });
  }
  return entries;
}

function readEntryData(buffer, entry, limits = {}) {
  const max = { ...DEFAULT_LIMITS, ...limits };
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_HEADER) throw new ZipError(`The local header of ${entry.name} is damaged.`, "corrupt");
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) throw new ZipError(`${entry.name} is cut off.`, "corrupt");
  const raw = buffer.subarray(dataStart, dataEnd);
  let data;
  if (entry.method === METHOD_STORED) {
    data = Buffer.from(raw);
  } else {
    try {
      // The size in the directory is only a claim; the cap holds whatever it says.
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(max.maxEntryBytes, entry.uncompressedSize || 1) });
    } catch (error) {
      throw new ZipError(`${entry.name} could not be decompressed: ${error.message}`, "corrupt");
    }
  }
  if (data.length !== entry.uncompressedSize) throw new ZipError(`${entry.name} does not have the size the archive states.`, "corrupt");
  if ((zlib.crc32(data) >>> 0) !== entry.crc) throw new ZipError(`${entry.name} failed its checksum.`, "badChecksum");
  return data;
}

// Every file in the archive as { name, data }, directories left out.
function readZip(buffer, limits = {}) {
  return listZip(buffer, limits)
    .filter((entry) => !entry.isDirectory)
    .map((entry) => ({ name: entry.name, data: readEntryData(buffer, entry, limits) }));
}

module.exports = { ZipError, DEFAULT_LIMITS, createZip, listZip, readZip, readEntryData, checkEntryName };
