"use strict";

// JSON-RPC 2.0 over newline-delimited JSON on a pair of streams: one message
// per line, no embedded newlines. Both the Agent Client Protocol (to an agent
// started as a child process) and the Model Context Protocol over stdio (the
// tracker tools in bin/tracker-mcp.js) use this framing.
//
// A peer sends requests and notifications and answers the other side's
// requests through `onRequest`, whose result or thrown RpcError becomes the
// response. A request the handler does not know answers -32601.

const { EventEmitter } = require("events");

const ERRORS = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
});
// A line longer than this is dropped and reported; it protects the server
// from an agent that prints a huge blob on stdout.
const DEFAULT_MAX_LINE = 8 * 1024 * 1024;

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

class JsonRpcPeer extends EventEmitter {
  // input: a readable stream of the other side's messages; output: where
  // ours go. onRequest(method, params) and onNotification(method, params)
  // may be async. Every raw line in and out is emitted as "message" with its
  // direction, for logs.
  constructor(input, output, { onRequest = null, onNotification = null, maxLine = DEFAULT_MAX_LINE } = {}) {
    super();
    this.input = input;
    this.output = output;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.maxLine = maxLine;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;
    this.onData = (chunk) => this.#receive(chunk);
    this.onEnd = () => this.close(new Error("The other side closed the connection."));
    input.setEncoding?.("utf8");
    input.on("data", this.onData);
    input.on("end", this.onEnd);
    input.on("error", this.onEnd);
  }

  #receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > this.maxLine && !this.buffer.includes("\n")) {
      this.emit("oversize", this.buffer.length);
      this.buffer = "";
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.#handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  #handleLine(line) {
    this.emit("message", "in", line);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#send({ jsonrpc: "2.0", id: null, error: { code: ERRORS.PARSE, message: "Parse error" } });
      return;
    }
    if (Array.isArray(message)) {
      for (const entry of message) this.#dispatch(entry);
      return;
    }
    this.#dispatch(message);
  }

  #dispatch(message) {
    if (!message || typeof message !== "object") return;
    if (typeof message.method === "string") {
      if (message.id === undefined || message.id === null) {
        Promise.resolve()
          .then(() => this.onNotification?.(message.method, message.params || {}))
          .catch((error) => this.emit("handlerError", error));
        return;
      }
      this.#answer(message);
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(Object.assign(new RpcError(message.error.code, message.error.message || "Error", message.error.data), { method: entry.method }));
      else entry.resolve(message.result);
    }
  }

  async #answer(message) {
    const { id, method } = message;
    try {
      if (!this.onRequest) throw new RpcError(ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
      const result = await this.onRequest(method, message.params || {}, { id });
      this.#send({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (error) {
      const code = Number.isInteger(error?.code) ? error.code : ERRORS.INTERNAL;
      const body = { code, message: error?.message || "Internal error" };
      if (error?.data !== undefined) body.data = error.data;
      this.#send({ jsonrpc: "2.0", id, error: body });
    }
  }

  #send(message) {
    if (this.closed) return false;
    const line = JSON.stringify(message);
    this.emit("message", "out", line);
    try {
      this.output.write(`${line}\n`);
      return true;
    } catch (error) {
      this.close(error);
      return false;
    }
  }

  // Sends a request; resolves with its result or rejects with an RpcError.
  request(method, params = {}, { timeoutMs = 0 } = {}) {
    if (this.closed) return Promise.reject(new Error("The connection is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(Object.assign(new Error(`${method} did not answer within ${Math.round(timeoutMs / 1000)} s.`), { code: "timeout", method }));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) {
    return this.#send({ jsonrpc: "2.0", method, params });
  }

  // Rejects what is still waiting and stops listening.
  close(reason = new Error("The connection is closed.")) {
    if (this.closed) return;
    this.closed = true;
    this.input.off?.("data", this.onData);
    this.input.off?.("end", this.onEnd);
    this.input.off?.("error", this.onEnd);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
    this.emit("close", reason);
  }
}

module.exports = { JsonRpcPeer, RpcError, ERRORS };
