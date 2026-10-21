"use strict";

// Request checks that keep the local API private to this computer's browser
// tab and to callers holding the API token.

const crypto = require("crypto");

class HttpError extends Error {
  constructor(statusCode, message, code = "") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostnameOf(hostHeader) {
  const host = String(hostHeader || "").trim().toLowerCase();
  if (!host) return "";
  if (host.startsWith("[")) {
    const closing = host.indexOf("]");
    return closing === -1 ? host : host.slice(0, closing + 1);
  }
  return host.split(":")[0];
}

function parseAllowedHosts(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

// The Host header must name this computer, or a host listed in ALLOWED_HOSTS.
// This blocks DNS rebinding: a page on another site that resolves its own name
// to 127.0.0.1 still sends its own name as Host.
function isAllowedHost(hostHeader, allowedHosts = []) {
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return false;
  if (LOCAL_HOSTNAMES.has(hostname)) return true;
  return allowedHosts.includes(hostname);
}

// A browser marks requests from the app's own page as same-origin. Older
// browsers that do not send Sec-Fetch-Site still send Origin on writes.
function isSameOriginRequest(req) {
  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite) return fetchSite === "same-origin";
  const origin = req.headers.origin;
  if (!origin || origin === "null") return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host.toLowerCase() === String(req.headers.host || "").toLowerCase();
  } catch {
    return false;
  }
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : "";
}

function tokensMatch(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Every request that changes something must come from the app's own page or
// carry the API token. Returns null when allowed, otherwise an HttpError.
function checkWriteAccess(req, { apiToken }) {
  if (bearerToken(req)) {
    return tokensMatch(bearerToken(req), apiToken) ? null : new HttpError(403, "The API token is not valid.", "badToken");
  }
  if (isSameOriginRequest(req)) return null;
  return new HttpError(403, "Requests that change data must come from the tracker page or carry the API token.", "crossOrigin");
}

function isWriteMethod(method) {
  return !["GET", "HEAD", "OPTIONS"].includes(String(method || "").toUpperCase());
}

// JSON routes accept only JSON bodies, so a cross-site form post cannot reach
// them as text/plain.
function requireJsonContentType(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!/^application\/json\b/.test(contentType)) {
    throw new HttpError(415, "Send the request body as application/json.", "unsupportedMediaType");
  }
}

function parseJsonBody(text, { allowEmpty = true } = {}) {
  if (!text) {
    if (allowEmpty) return {};
    throw new HttpError(400, "The request body is empty.", "badRequest");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.", "invalidJson");
  }
}

// Headers for the app page. Scripts may only come from this server; the page
// cannot be framed and sends no referrer to the sites it links to.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const PAGE_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
});

// Only these URL schemes are stored and rendered as links.
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function isSafeLink(value) {
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(String(value || "").trim()).protocol);
  } catch {
    return false;
  }
}

module.exports = {
  HttpError,
  hostnameOf,
  parseAllowedHosts,
  isAllowedHost,
  isSameOriginRequest,
  checkWriteAccess,
  isWriteMethod,
  requireJsonContentType,
  parseJsonBody,
  bearerToken,
  tokensMatch,
  CONTENT_SECURITY_POLICY,
  PAGE_SECURITY_HEADERS,
  SAFE_LINK_PROTOCOLS,
  isSafeLink,
};
