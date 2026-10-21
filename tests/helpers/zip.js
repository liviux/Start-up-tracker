"use strict";

// Raw zip archives with one entry, for shapes lib/backups/zip.js refuses to
// write: names that climb out of the archive, symlinks, lying sizes.

const zlib = require("node:zlib");

function handMadeZip({ name, data = Buffer.from("x"), mode = 0o100644, method = 0, claimedSize }) {
  const nameBuffer = Buffer.from(name, "utf8");
  const crc = zlib.crc32(data) >>> 0;
  const size = claimedSize ?? data.length;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt32LE((mode << 16) >>> 0, 38);
  central.writeUInt32LE(0, 42);
  const localPart = Buffer.concat([local, nameBuffer, data]);
  const centralPart = Buffer.concat([central, nameBuffer]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

module.exports = { handMadeZip };
