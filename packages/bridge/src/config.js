'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'neteasemc';
const IMPLEMENTATION_NAME = 'dsh-netease-mc-bridge';
const SERVER_VERSION = '0.1.0';

/**
 * Canonical configuration defaults (ARCHITECTURE.md §3).
 * `loadConfig()` always returns a fresh deep clone with these keys filled in.
 */
const DEFAULT_CONFIG = Object.freeze({
  mode: 'bot',
  bot: Object.freeze({
    host: '127.0.0.1',
    port: 25565,
    username: 'DeepSeek',
    version: '1.21.8',
    auth: 'offline',
    connectTimeoutMs: 20000
  }),
  mod: Object.freeze({
    url: 'http://127.0.0.1:38210',
    token: '',
    timeoutMs: 5000
  }),
  policy: Object.freeze({
    allowRead: true,
    allowMove: true,
    allowWorldWrite: true,
    allowCommands: true,
    allowChat: true,
    allowAttack: true
  }),
  agent: Object.freeze({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    maxSteps: 40,
    temperature: 0.3
  }),
  log: Object.freeze({ level: 'info', file: '' })
});

class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code || 'invalid_config';
  }
}

const SECRET_ENV = Object.freeze({
  modToken: 'DSH_MC_TOKEN',
  agentApiKey: 'DEEPSEEK_API_KEY'
});

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function coerceNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function coerceBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return fallback;
}

function coerceString(value, fallback) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/**
 * Merge only known keys. Unknown keys are ignored (ARCHITECTURE.md §3).
 * Returns warnings for insecure/ignored input (e.g. a token in a config file).
 */
function mergeConfig(base, input, warnings) {
  if (!isPlainObject(input)) {
    throw new ConfigError('invalid_config', 'config file must contain a JSON object');
  }
  const merged = base;

  if (input.mode !== undefined) {
    const mode = String(input.mode);
    if (mode !== 'bot' && mode !== 'mod') {
      throw new ConfigError('invalid_mode', `mode must be "bot" or "mod", got "${mode}"`);
    }
    merged.mode = mode;
  }

  if (isPlainObject(input.bot)) {
    const bot = input.bot;
    if (bot.host !== undefined) merged.bot.host = coerceString(bot.host, merged.bot.host);
    if (bot.port !== undefined) merged.bot.port = Math.trunc(coerceNumber(bot.port, merged.bot.port));
    if (bot.username !== undefined) merged.bot.username = coerceString(bot.username, merged.bot.username);
    if (bot.version !== undefined) merged.bot.version = coerceString(bot.version, merged.bot.version);
    if (bot.auth !== undefined) merged.bot.auth = coerceString(bot.auth, merged.bot.auth);
    if (bot.connectTimeoutMs !== undefined) {
      merged.bot.connectTimeoutMs = Math.max(1000, coerceNumber(bot.connectTimeoutMs, merged.bot.connectTimeoutMs));
    }
  }

  if (isPlainObject(input.mod)) {
    const mod = input.mod;
    if (mod.url !== undefined) merged.mod.url = coerceString(mod.url, merged.mod.url);
    if (mod.token !== undefined && String(mod.token) !== '') {
      // Secrets must come from the environment only. Never trust a config file.
      warnings.push(
        `config file contains mod.token; it is ignored for security. Set ${SECRET_ENV.modToken} in the environment instead.`
      );
    }
    if (mod.timeoutMs !== undefined) {
      merged.mod.timeoutMs = Math.max(250, coerceNumber(mod.timeoutMs, merged.mod.timeoutMs));
    }
  }

  if (isPlainObject(input.policy)) {
    for (const key of Object.keys(DEFAULT_CONFIG.policy)) {
      if (input.policy[key] !== undefined) merged.policy[key] = coerceBoolean(input.policy[key], merged.policy[key]);
    }
  }

  if (isPlainObject(input.agent)) {
    const agent = input.agent;
    if (agent.baseUrl !== undefined) merged.agent.baseUrl = coerceString(agent.baseUrl, merged.agent.baseUrl);
    if (agent.model !== undefined) merged.agent.model = coerceString(agent.model, merged.agent.model);
    if (agent.apiKeyEnv !== undefined) merged.agent.apiKeyEnv = coerceString(agent.apiKeyEnv, merged.agent.apiKeyEnv);
    if (agent.maxSteps !== undefined) {
      merged.agent.maxSteps = Math.max(1, Math.trunc(coerceNumber(agent.maxSteps, merged.agent.maxSteps)));
    }
    if (agent.temperature !== undefined) {
      merged.agent.temperature = coerceNumber(agent.temperature, merged.agent.temperature);
    }
    if (agent.apiKey !== undefined && String(agent.apiKey) !== '') {
      warnings.push(
        `config file contains agent.apiKey; it is ignored for security. Set ${SECRET_ENV.agentApiKey} (or agent.apiKeyEnv) in the environment instead.`
      );
    }
  }

  if (isPlainObject(input.log)) {
    if (input.log.level !== undefined) merged.log.level = coerceString(input.log.level, merged.log.level);
    if (input.log.file !== undefined) merged.log.file = coerceString(input.log.file, merged.log.file);
  }

  return merged;
}

/** Expand a leading `~` in a user supplied config path. */
function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Config file lookup order (ARCHITECTURE.md §3):
 *   --config <path> -> DSH_MC_CONFIG -> ./dsh-mc.config.json -> ~/.dsh-mc/config.json
 *
 * @returns {{path: string|null, source: string}}
 */
function findConfigPath({ argv = [], env = process.env, cwd = process.cwd(), home = os.homedir() } = {}) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new ConfigError('invalid_config', '--config requires a file path');
      return { path: path.resolve(cwd, expandHome(value)), source: '--config' };
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (!value) throw new ConfigError('invalid_config', '--config requires a file path');
      return { path: path.resolve(cwd, expandHome(value)), source: '--config' };
    }
  }

  if (env.DSH_MC_CONFIG) {
    return { path: path.resolve(cwd, expandHome(String(env.DSH_MC_CONFIG))), source: 'env:DSH_MC_CONFIG' };
  }

  const cwdCandidate = path.resolve(cwd, 'dsh-mc.config.json');
  if (fs.existsSync(cwdCandidate)) return { path: cwdCandidate, source: 'cwd' };

  const homeCandidate = path.resolve(home, '.dsh-mc', 'config.json');
  if (fs.existsSync(homeCandidate)) return { path: homeCandidate, source: 'home' };

  return { path: null, source: 'defaults' };
}

/**
 * Load and normalize the bridge configuration.
 *
 * Missing structural problems (e.g. missing bot.port / mod token) do not throw
 * here; they are surfaced as structured tool errors by the channels. Invalid
 * JSON, non-object config and invalid `mode` do throw.
 *
 * @returns {{config: object, configPath: string|null, source: string, warnings: string[]}}
 */
function loadConfig({ argv = [], env = process.env, cwd = process.cwd(), home = os.homedir() } = {}) {
  const warnings = [];
  const found = findConfigPath({ argv, env, cwd, home });
  const config = cloneDefaultConfig();

  if (found.path) {
    let text;
    try {
      text = fs.readFileSync(found.path, 'utf8');
    } catch (err) {
      throw new ConfigError('invalid_config', `cannot read config file ${found.path}: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (err) {
      throw new ConfigError('invalid_config', `config file ${found.path} is not valid JSON: ${err.message}`);
    }
    mergeConfig(config, parsed, warnings);
  }

  return { config, configPath: found.path, source: found.source, warnings };
}

/**
 * Resolve the mod HTTP token. Secrets are read from the environment only.
 * @returns {string}
 */
function resolveModToken(env = process.env) {
  const value = env && env[SECRET_ENV.modToken];
  return typeof value === 'string' ? value.trim() : '';
}

/** Resolve the DeepSeek API key from the configured env var name (fallback: DEEPSEEK_API_KEY). */
function resolveAgentApiKey(config, env = process.env) {
  const name = (config && config.agent && config.agent.apiKeyEnv) || SECRET_ENV.agentApiKey;
  const value = (env && env[name]) || (env && env[SECRET_ENV.agentApiKey]);
  return typeof value === 'string' ? value.trim() : '';
}

/** Static validation problems for the selected mode; returns [] when ready. */
function validateModeReadiness(config, env = process.env) {
  const problems = [];
  if (config.mode === 'bot') {
    const port = Number(config.bot && config.bot.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push({ code: 'invalid_config', message: 'bot.port must be a TCP port between 1 and 65535 (mode=bot)' });
    }
  } else if (config.mode === 'mod') {
    if (!resolveModToken(env)) {
      problems.push({
        code: 'missing_token',
        message: `mode=mod requires the ${SECRET_ENV.modToken} environment variable (token printed by the in-game mod on first start)`
      });
    }
  }
  return problems;
}

/** Copy of the config with secrets/dynamic fields removed, for doctor/support output. */
function redactConfig(config, env = process.env) {
  const copy = JSON.parse(JSON.stringify(config));
  copy.mod.token = '';
  copy.mod.tokenPresent = !!resolveModToken(env);
  copy.agent.apiKeyPresent = !!resolveAgentApiKey(config, env);
  return copy;
}

module.exports = {
  PROTOCOL_VERSION,
  SERVER_NAME,
  IMPLEMENTATION_NAME,
  SERVER_VERSION,
  DEFAULT_CONFIG,
  ConfigError,
  SECRET_ENV,
  loadConfig,
  findConfigPath,
  validateModeReadiness,
  resolveModToken,
  resolveAgentApiKey,
  redactConfig
};
