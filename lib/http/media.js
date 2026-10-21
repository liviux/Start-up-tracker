"use strict";

// Uploaded files live in the media folder of the data folder and are served
// only through /media/. Paths are checked by their real location, so a symlink
// inside the media folder cannot lead anywhere else.

const fs = require("fs");
const path = require("path");
const { HttpError } = require("./security");
const { mimeTypeFor } = require("./mime");
const { safeSegments } = require("./static");

// Types a browser could run as a page; they are downloaded, never rendered.
const ACTIVE_CONTENT_EXTENSIONS = new Set([".html", ".htm", ".xhtml", ".svg", ".xml", ".xsl", ".xslt"]);

function isInsideRealPath(realFile, realRoot) {
  const relative = path.relative(realRoot, realFile);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Returns the real path of an existing file inside mediaDir, or null.
function resolveMediaFileSync(mediaDir, relativePath) {
  const segments = String(relativePath || "").split(/[\\/]+/).filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || segment.includes("\0"))) return null;
  try {
    const realRoot = fs.realpathSync(mediaDir);
    const realFile = fs.realpathSync(path.join(mediaDir, ...segments));
    if (!isInsideRealPath(realFile, realRoot)) return null;
    return fs.statSync(realFile).isFile() ? realFile : null;
  } catch {
    return null;
  }
}

// Checks that a file about to be written lands inside mediaDir, following
// symlinks in its parent folders.
function assertWritableMediaPath(mediaDir, filePath) {
  const realRoot = fs.realpathSync(mediaDir);
  const realParent = fs.realpathSync(path.dirname(filePath));
  if (!isInsideRealPath(realParent, realRoot)) {
    throw new HttpError(403, "Files can only be written inside the media folder.", "outsideMedia");
  }
  try {
    const existing = fs.lstatSync(filePath);
    if (existing.isSymbolicLink()) throw new HttpError(403, "Refusing to write through a symbolic link.", "symlink");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error.code !== "ENOENT") throw error;
  }
}

function mediaHeaders(filePath, stats) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    "Content-Type": mimeTypeFor(ext),
    "Content-Length": String(stats.size),
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
  if (ACTIVE_CONTENT_EXTENSIONS.has(ext)) {
    headers["Content-Security-Policy"] = "sandbox";
    headers["Content-Disposition"] = `attachment; filename="${path.basename(filePath).replace(/["\\\r\n]/g, "_")}"`;
  }
  return headers;
}

function createMediaHandler({ mediaDir }) {
  async function serve(req, res, url) {
    const segments = safeSegments(url.pathname.slice("/media".length));
    const filePath = resolveMediaFileSync(mediaDir, segments.join("/"));
    if (!filePath) throw new HttpError(404, "Not found", "notFound");
    const stats = await fs.promises.stat(filePath);
    res.writeHead(200, mediaHeaders(filePath, stats));
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  }
  return { serve };
}

module.exports = {
  ACTIVE_CONTENT_EXTENSIONS,
  createMediaHandler,
  resolveMediaFileSync,
  assertWritableMediaPath,
  mediaHeaders,
  isInsideRealPath,
};
