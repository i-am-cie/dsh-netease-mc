'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

/**
 * Structured JSON-lines logger.
 *
 * IMPORTANT: the MCP transport owns stdout. This logger always writes to
 * stderr (or an explicitly injected stream) and never to stdout.
 */
class Logger {
  constructor({ level = 'info', file = '', stream = process.stderr, prefix = '', fields = null } = {}) {
    this.level = LEVELS[level] !== undefined ? LEVELS[level] : LEVELS.info;
    this.stream = stream;
    this.prefix = prefix;
    this.fields = fields || null;
    this.fileStream = null;
    if (file) {
      try {
        const target = path.resolve(String(file));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        this.fileStream = fs.createWriteStream(target, { flags: 'a' });
        this.fileStream.on('error', () => {});
      } catch {
        this.fileStream = null;
      }
    }
  }

  /** @param {object} fields additional structured fields */
  child(fields) {
    const child = Object.create(Logger.prototype);
    child.level = this.level;
    child.stream = this.stream;
    child.prefix = this.prefix;
    child.fields = Object.assign({}, this.fields || {}, fields || {});
    child.fileStream = this.fileStream;
    return child;
  }

  log(level, msg, fields) {
    if ((LEVELS[level] !== undefined ? LEVELS[level] : LEVELS.info) < this.level) return;
    let record;
    try {
      record = JSON.stringify(
        Object.assign(
          { ts: new Date().toISOString(), level, msg: String(msg) },
          this.fields || {},
          fields || {}
        )
      );
    } catch {
      record = JSON.stringify({ ts: new Date().toISOString(), level, msg: String(msg) });
    }
    const line = (this.prefix ? `[${this.prefix}] ` : '') + record;
    try {
      if (this.stream && typeof this.stream.write === 'function') this.stream.write(line + '\n');
    } catch {
      /* stderr closed, nothing else we can do */
    }
    if (this.fileStream) {
      try {
        this.fileStream.write(line + '\n');
      } catch {
        /* ignore file logging failures */
      }
    }
  }

  debug(msg, fields) { this.log('debug', msg, fields); }
  info(msg, fields) { this.log('info', msg, fields); }
  warn(msg, fields) { this.log('warn', msg, fields); }
  error(msg, fields) { this.log('error', msg, fields); }

  /**
   * Tool invocation record required by ARCHITECTURE.md §4:
   * `{ts,tool,args,ok,ms}` (ts is added by the logger).
   */
  tool({ tool, args, ok, ms }) {
    this.log('info', 'tool_call', { tool, args: args === undefined ? {} : args, ok: ok === true, ms });
  }

  close() {
    if (this.fileStream) {
      try {
        this.fileStream.end();
      } catch {
        /* ignore */
      }
      this.fileStream = null;
    }
  }
}

function createLogger(opts) {
  return new Logger(opts);
}

module.exports = { Logger, createLogger, LEVELS };
