"use strict";

// Serves the browser files. Only public/ and content/ are reachable: never the
// code, the data folder, git metadata or plans. Every script and stylesheet URL
// on the page gets ?v=<content hash> at serve time, so the year-long cache on
// versioned URLs can never hand out stale code after an update.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { HttpError, PAGE_SECURITY_HEADERS } = require("./security");
const { mimeTypeFor } = require("./mime");

const COMPRESSIBLE = new Set([".html", ".css", ".js", ".json", ".svg", ".txt", ".md", ".markdown"]);
const CONTENT_EXTENSIONS = new Set([".json", ".md", ".txt", ".svg"]);

// Splits a URL path into safe segments, or throws. Rejects encoded traversal
// (%2e%2e, %2f, %5c), backslashes, NUL bytes and dot-files.
function safeSegments(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    throw new HttpError(400, "Malformed URL.", "badPath");
  }
  if (/%(?:2e|2f|5c|00)/i.test(decoded) || decoded.includes("\\") || decoded.includes("\0")) {
    throw new HttpError(400, "Malformed URL.", "badPath");
  }
  const segments = decoded.split("/").filter((segment) => segment !== "");
  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.startsWith(".")) {
      throw new HttpError(404, "Not found", "notFound");
    }
  }
  return segments;
}

// Resolves a file inside root and refuses anything whose real path (after
// following symlinks) lies outside it.
async function resolveInside(root, segments) {
  const candidate = path.join(root, ...segments);
  let realFile;
  let realRoot;
  try {
    [realFile, realRoot] = await Promise.all([fs.promises.realpath(candidate), fs.promises.realpath(root)]);
  } catch {
    return null;
  }
  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const stats = await fs.promises.stat(realFile).catch(() => null);
  if (!stats || !stats.isFile()) return null;
  return { filePath: realFile, stats };
}

function createStaticHandler({ publicDir, contentDir, sendBody, sendNotModified }) {
  const hashCache = new Map();

  function contentHash(filePath) {
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      return "";
    }
    const key = `${filePath}:${stats.mtimeMs}:${stats.size}`;
    if (hashCache.has(filePath) && hashCache.get(filePath).key === key) return hashCache.get(filePath).hash;
    const hash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").slice(0, 12);
    hashCache.set(filePath, { key, hash });
    return hash;
  }

  // Local URL of a .js or .css file, relative to the document it appears in.
  function versionUrl(rawUrl, baseFile) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(rawUrl)) return rawUrl;
    const [withoutHash] = rawUrl.split("#");
    const [pathname] = withoutHash.split("?");
    if (!/\.(?:js|css)$/i.test(pathname)) return rawUrl;
    const target = pathname.startsWith("/")
      ? path.join(publicDir, pathname)
      : path.join(path.dirname(baseFile), pathname);
    const hash = contentHash(target);
    return hash ? `${pathname}?v=${hash}` : rawUrl;
  }

  function versionHtml(html, baseFile) {
    return html.replace(/(<(?:script|link)\b[^>]*?\s(?:src|href)=")([^"]+)(")/gi, (match, before, url, after) => `${before}${versionUrl(url, baseFile)}${after}`);
  }

  function versionCss(css, baseFile) {
    return css.replace(/@import\s+url\((["']?)([^"')]+)\1\)/g, (match, quote, url) => `@import url(${quote}${versionUrl(url, baseFile)}${quote})`);
  }

  async function serve(req, res, url) {
    const segments = safeSegments(url.pathname);
    let root = publicDir;
    let fileSegments = segments.length ? segments : ["index.html"];
    if (segments[0] === "content") {
      root = contentDir;
      fileSegments = segments.slice(1);
      if (!fileSegments.length || !CONTENT_EXTENSIONS.has(path.extname(fileSegments[fileSegments.length - 1]).toLowerCase())) {
        throw new HttpError(404, "Not found", "notFound");
      }
    }
    const resolved = await resolveInside(root, fileSegments);
    if (!resolved) throw new HttpError(404, "Not found", "notFound");
    const { filePath, stats } = resolved;
    const ext = path.extname(filePath).toLowerCase();
    const isPage = ext === ".html";
    const isVersioned = /(?:^|[?&])v=[^&]+/.test(url.search || "");

    const headers = {
      "Content-Type": mimeTypeFor(ext),
      "Cache-Control": isVersioned ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      ...(isPage ? PAGE_SECURITY_HEADERS : {}),
    };

    if (isPage || ext === ".css") {
      // Rewritten documents depend on the hashes of what they reference, so
      // their validator covers those too.
      let text = await fs.promises.readFile(filePath, "utf8");
      text = isPage ? versionHtml(text, filePath) : versionCss(text, filePath);
      const etag = `W/"${crypto.createHash("sha256").update(text).digest("hex").slice(0, 16)}"`;
      headers.ETag = etag;
      if (etagListIncludes(req.headers["if-none-match"], etag)) {
        sendNotModified(res, { ETag: etag, "Cache-Control": headers["Cache-Control"] });
        return;
      }
      sendBody(res, Buffer.from(text, "utf8"), 200, headers, `${filePath}:${etag}`);
      return;
    }

    const etag = `W/"${stats.mtimeMs.toString(36)}-${stats.size.toString(36)}"`;
    headers.ETag = etag;
    if (etagListIncludes(req.headers["if-none-match"], etag)) {
      sendNotModified(res, { ETag: etag, "Cache-Control": headers["Cache-Control"] });
      return;
    }
    if (COMPRESSIBLE.has(ext)) {
      const body = await fs.promises.readFile(filePath);
      sendBody(res, body, 200, headers, `${filePath}:${stats.mtimeMs}:${stats.size}`);
      return;
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  }

  return { serve, versionHtml, versionCss, contentHash };
}

function etagListIncludes(headerValue, etag) {
  return String(headerValue || "").split(",").map((value) => value.trim()).includes(etag);
}

module.exports = { createStaticHandler, safeSegments, resolveInside };
