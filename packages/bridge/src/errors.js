'use strict';

/**
 * Structured tool/channel error.
 *
 * Every failure that can reach an MCP tool result should carry a stable
 * machine readable `code` (ARCHITECTURE.md §4: `{ok:false,error:{code,message}}`).
 */
class ToolError extends Error {
  /**
   * @param {string} code stable snake_case error code
   * @param {string} message human readable message
   * @param {object} [details] optional machine readable details
   */
  constructor(code, message, details) {
    super(message || code);
    this.name = 'ToolError';
    this.code = code || 'tool_error';
    if (details !== undefined) this.details = details;
  }
}

/** Raised by the MCP layer for JSON-RPC level failures. */
class RpcError extends Error {
  constructor(code, message, data) {
    super(message || 'rpc error');
    this.name = 'RpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/**
 * Convert any thrown value into the canonical tool error result.
 * @param {unknown} err
 * @returns {{ok:false,error:{code:string,message:string,details?:unknown}}}
 */
function toErrorResult(err) {
  if (err && typeof err === 'object' && err.ok === false && err.error && typeof err.error === 'object') {
    return err;
  }
  const code = err && typeof err.code === 'string' && err.code ? err.code : 'internal_error';
  const message = err && typeof err.message === 'string' && err.message ? err.message : String(err);
  const result = { ok: false, error: { code, message } };
  if (err && typeof err === 'object' && err.details !== undefined) {
    result.error.details = err.details;
  }
  return result;
}

module.exports = { ToolError, RpcError, toErrorResult };
