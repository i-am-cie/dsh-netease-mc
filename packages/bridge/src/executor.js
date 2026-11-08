'use strict';

const { ToolError, toErrorResult } = require('./errors');
const { getTool, TOOL_TIMEOUTS, validateAndCoerceArgs } = require('./tools');
const { checkPolicy } = require('./policy');
const { BotChannel } = require('./game/bot');
const { ModChannel } = require('./game/mod');
const { validateModeReadiness } = require('./config');

function createChannel(config, { env, logger }) {
  if (config.mode === 'mod') return new ModChannel(config, { env, logger });
  if (config.mode === 'bot') {
    const problems = validateModeReadiness(config, env);
    if (problems.length > 0) throw new ToolError(problems[0].code, problems[0].message);
    return new BotChannel(config, { env, logger });
  }
  throw new ToolError('invalid_config', `unknown mode "${config.mode}" (expected "bot" or "mod")`);
}

/**
 * Single entry point for executing MCP/agent tool calls.
 *
 * Responsibilities:
 *  - lazy channel creation/connection
 *  - argument validation (schema + coercion)
 *  - policy gate (ARCHITECTURE.md §3)
 *  - per-tool timeout (ARCHITECTURE.md §4)
 *  - structured error mapping + structured tool call logging
 */
class Executor {
  constructor({ config, env = process.env, logger, channelFactory = null } = {}) {
    this.config = config;
    this.env = env;
    this.logger = logger;
    this.channelFactory = channelFactory;
    this.channel = null;
    this.closed = false;
  }

  async getChannel() {
    if (this.closed) throw new ToolError('shutdown', 'executor is shutting down');
    if (this.channel) return this.channel;
    this.channel = this.channelFactory
      ? this.channelFactory(this.config, { env: this.env, logger: this.logger })
      : createChannel(this.config, { env: this.env, logger: this.logger });
    return this.channel;
  }

  /**
   * @param {string} name tool name
   * @param {object|undefined} args tool arguments
   * @returns {Promise<object>} canonical tool result ({ok:true,...} or {ok:false,error})
   */
  async execute(name, args) {
    const startedAt = Date.now();
    let result;
    try {
      const tool = getTool(name);
      if (!tool) throw new ToolError('unknown_tool', `unknown tool: ${name}`);
      if (this.config.mode === 'bot' && name === 'mc_command') {
        // Fast, explicit contract error (ARCHITECTURE.md §4) - never fake success.
        throw new ToolError(
          'unsupported_in_bot_mode',
          'mc_command is not available in bot mode (a player bot has no server console permission). Use mc_chat or type the command in the game manually, or switch to mode=mod.'
        );
      }
      const validated = validateAndCoerceArgs(name, args === undefined ? {} : args);
      if (!validated.ok) throw new ToolError('invalid_arguments', validated.message);

      const denied = checkPolicy(this.config.policy, name, validated.args);
      if (denied) {
        result = denied;
      } else {
        result = await this.executeWithTimeout(name, validated.args);
      }
    } catch (err) {
      result = toErrorResult(err);
    }
    const ms = Date.now() - startedAt;
    try {
      if (this.logger) this.logger.tool({ tool: name, args: args === undefined ? {} : args, ok: result.ok === true, ms });
    } catch {
      /* logging must never break a tool call */
    }
    return result;
  }

  async executeWithTimeout(name, args) {
    const timeout = TOOL_TIMEOUTS[name] || 10000;
    const run = async () => {
      const channel = await this.getChannel();
      if (name !== 'mc_status' && typeof channel.ensureConnected === 'function') {
        await channel.ensureConnected();
      }
      const method = channel[name];
      if (typeof method !== 'function') {
        throw new ToolError('unsupported_tool', `channel "${channel.name}" does not implement ${name}`);
      }
      return method.call(channel, args);
    };

    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new ToolError('timeout', `${name} timed out after ${timeout}ms`));
      }, timeout);
      if (timer.unref) timer.unref();
    });
    try {
      return await Promise.race([Promise.resolve().then(run), timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close() {
    this.closed = true;
    const channel = this.channel;
    this.channel = null;
    if (channel && typeof channel.close === 'function') {
      try {
        await channel.close();
      } catch {
        /* ignore shutdown errors */
      }
    }
  }
}

module.exports = { Executor, createChannel };
