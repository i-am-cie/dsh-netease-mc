'use strict';

const readline = require('node:readline');
const { createLogger } = require('./logger');
const { Executor } = require('./executor');
const { TOOLS } = require('./tools');
const { PROTOCOL_VERSION, IMPLEMENTATION_NAME, SERVER_VERSION } = require('./config');
const { RpcError, toErrorResult } = require('./errors');

const JSONRPC_VERSION = '2.0';

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id: id === undefined ? null : id, error };
}

function rpcResult(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

/**
 * Hand-written MCP server over NDJSON (one JSON-RPC message per line) on stdio.
 *
 * - stdout carries JSON-RPC messages only; all diagnostics go to stderr
 * - stateless: a probe process that only sends initialize/tools/list is fully
 *   functional and has no side effects (no connection is attempted until a
 *   tool other than mc_status is called)
 * - MCP protocol version: 2025-06-18
 */
class McpServer {
  constructor({ config, logger, executor, input = process.stdin, output = process.stdout } = {}) {
    this.config = config;
    this.logger = logger || createLogger({ level: 'silent' });
    this.executor = executor || new Executor({ config, logger: this.logger });
    this.input = input;
    this.output = output;
    this.rl = null;
    this.started = false;
    this.closing = false;
    this.queue = Promise.resolve();
    this.closed = new Promise((resolve) => {
      this._resolveClosed = resolve;
    });
  }

  write(message) {
    try {
      this.output.write(JSON.stringify(message) + '\n');
    } catch (err) {
      this.logger.warn('failed to write JSON-RPC response', { message: String(err && err.message) });
    }
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.rl = readline.createInterface({ input: this.input, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch (err) {
        this.write(rpcError(null, -32700, 'Parse error', String(err && err.message)));
        return;
      }
      this.queue = this.queue
        .then(() => this.handleMessage(message))
        .catch((err) => {
          this.logger.error('message handler failed', { message: String(err && err.message) });
        });
    });
    this.rl.on('close', () => {
      this.logger.info('stdin closed, shutting down');
      void this.close();
    });
    this.input.on?.('error', (err) => {
      this.logger.warn('stdin error', { message: String(err && err.message) });
    });
    return this;
  }

  async handleMessage(message) {
    if (Array.isArray(message)) {
      for (const item of message) await this.handleMessage(item);
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.write(rpcError(null, -32600, 'Invalid Request'));
      return;
    }
    if (message.jsonrpc !== JSONRPC_VERSION) {
      this.write(rpcError(message.id, -32600, 'Invalid Request: jsonrpc must be "2.0"'));
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const id = message.id;
    const isNotification = !hasId;
    const method = message.method;
    if (typeof method !== 'string' || method.length === 0) {
      if (!isNotification) this.write(rpcError(id, -32600, 'Invalid Request: missing method'));
      return;
    }
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    try {
      const result = await this.dispatch(method, params);
      if (isNotification || result === undefined) return;
      this.write(rpcResult(id, result));
    } catch (err) {
      if (isNotification) return;
      if (err instanceof RpcError) {
        this.write(rpcError(id, err.code, err.message, err.data));
        return;
      }
      this.logger.error('request failed', { method, message: String(err && err.message), stack: err && err.stack });
      this.write(rpcError(id, -32603, 'Internal error', String(err && err.message)));
    }
  }

  async dispatch(method, params) {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
            prompts: { listChanged: false }
          },
          serverInfo: { name: IMPLEMENTATION_NAME, version: SERVER_VERSION },
          instructions:
            'Minecraft (NetEase Java 1.21.8) control for DeepSeek. Tools are named mcp__neteasemc__<tool>. Call mc_status first; it reports connection state without blocking.'
        };

      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/progress':
      case 'notifications/roots/list_changed':
        return undefined;

      case 'ping':
        return {};

      case 'tools/list':
        return {
          tools: TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
          }))
        };

      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string' || !name) throw new RpcError(-32602, 'Invalid params: tools/call requires a tool name');
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? params.arguments
          : {};
        const result = await this.executor.execute(name, args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError: result.ok !== true
        };
      }

      case 'resources/list':
        return { resources: [] };
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      case 'prompts/list':
        return { prompts: [] };
      case 'roots/list':
        return { roots: [] };
      case 'logging/setLevel':
        return {};
      case 'completion/complete':
        return { completion: { values: [], total: 0, hasMore: false } };
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  async close() {
    if (this.closing) return this.closed;
    this.closing = true;
    if (this.rl) {
      try {
        this.rl.close();
      } catch {
        /* already closed */
      }
      this.rl = null;
    }
    try {
      await this.executor.close();
    } catch (err) {
      this.logger.warn('executor close failed', { message: String(err && err.message) });
    }
    if (this._resolveClosed) this._resolveClosed();
    return this.closed;
  }
}

/** Create + start an MCP stdio server. */
function startMcpServer({ config, logger, executor, input, output } = {}) {
  if (!config) throw new Error('startMcpServer requires a config object');
  const effectiveLogger = logger || createLogger({ level: (config.log && config.log.level) || 'info' });
  const server = new McpServer({ config, logger: effectiveLogger, executor, input, output });
  server.start();
  return server;
}

module.exports = { McpServer, startMcpServer, rpcError, rpcResult, JSONRPC_VERSION, toErrorResult };

/* Entry point: `node src/index.js [serve|agent|doctor|probe] ...` */
if (require.main === module) {
  const { main } = require('./cli');
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = typeof code === 'number' ? code : 0;
    },
    (err) => {
      process.stderr.write(`fatal: ${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    }
  );
}
