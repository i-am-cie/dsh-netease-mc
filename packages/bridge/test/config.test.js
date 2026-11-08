'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadConfig,
  findConfigPath,
  validateModeReadiness,
  resolveModToken,
  resolveAgentApiKey,
  SERVER_VERSION,
  IMPLEMENTATION_NAME,
  PROTOCOL_VERSION
} = require('../src/config');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

test('constants match the MCP contract', () => {
  assert.equal(PROTOCOL_VERSION, '2025-06-18');
  assert.equal(IMPLEMENTATION_NAME, 'dsh-netease-mc-bridge');
  assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+$/);
});

test('defaults are complete when no config file exists', () => {
  const cwd = tempDir('dsh-mc-cwd-');
  const home = tempDir('dsh-mc-home-');
  const loaded = loadConfig({ argv: [], env: {}, cwd, home });
  assert.equal(loaded.configPath, null);
  assert.equal(loaded.source, 'defaults');
  assert.deepEqual(loaded.warnings, []);
  const { config } = loaded;
  assert.equal(config.mode, 'bot');
  assert.equal(config.bot.host, '127.0.0.1');
  assert.equal(config.bot.port, 25565);
  assert.equal(config.bot.username, 'DeepSeek');
  assert.equal(config.bot.version, '1.21.8');
  assert.equal(config.bot.auth, 'offline');
  assert.equal(config.bot.connectTimeoutMs, 20000);
  assert.equal(config.mod.url, 'http://127.0.0.1:38210');
  assert.equal(config.mod.token, '');
  assert.equal(config.mod.timeoutMs, 5000);
  for (const value of Object.values(config.policy)) assert.equal(value, true);
  assert.equal(config.agent.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.agent.model, 'deepseek-chat');
  assert.equal(config.agent.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(config.agent.maxSteps, 40);
  assert.equal(config.agent.temperature, 0.3);
  assert.deepEqual(config.log, { level: 'info', file: '' });
});

test('config lookup order: --config > DSH_MC_CONFIG > cwd > home', () => {
  const cwd = tempDir('dsh-mc-cwd-');
  const home = tempDir('dsh-mc-home-');
  const argvFile = path.join(tempDir('dsh-mc-argv-'), 'a.json');
  const envFile = path.join(tempDir('dsh-mc-env-'), 'b.json');
  const cwdFile = path.join(cwd, 'dsh-mc.config.json');
  const homeFile = path.join(home, '.dsh-mc', 'config.json');
  fs.mkdirSync(path.dirname(homeFile), { recursive: true });
  fs.writeFileSync(argvFile, JSON.stringify({ bot: { port: 25568 } }));
  fs.writeFileSync(envFile, JSON.stringify({ bot: { port: 25567 } }));
  fs.writeFileSync(cwdFile, JSON.stringify({ bot: { port: 25566 } }));
  fs.writeFileSync(homeFile, JSON.stringify({ bot: { port: 25565 } }));

  const homeOnly = loadConfig({ argv: [], env: {}, cwd: tempDir('dsh-mc-empty-'), home });
  assert.equal(homeOnly.source, 'home');
  assert.equal(homeOnly.config.bot.port, 25565);

  const fromCwd = loadConfig({ argv: [], env: {}, cwd, home });
  assert.equal(fromCwd.source, 'cwd');
  assert.equal(fromCwd.config.bot.port, 25566);

  const fromEnv = loadConfig({ argv: [], env: { DSH_MC_CONFIG: envFile }, cwd, home });
  assert.equal(fromEnv.source, 'env:DSH_MC_CONFIG');
  assert.equal(fromEnv.config.bot.port, 25567);

  const fromArgv = loadConfig({ argv: ['--config', argvFile], env: { DSH_MC_CONFIG: envFile }, cwd, home });
  assert.equal(fromArgv.source, '--config');
  assert.equal(fromArgv.config.bot.port, 25568);
  assert.equal(findConfigPath({ argv: [`--config=${argvFile}`], env: {}, cwd, home }).path, argvFile);
});

test('unknown fields are ignored, known fields are merged and coerced', () => {
  const dir = tempDir('dsh-mc-merge-');
  const file = writeJson(dir, 'dsh-mc.config.json', {
    mode: 'mod',
    unknownTopLevel: { a: 1 },
    bot: { port: '25599', host: 'example.local', unknownBotField: true },
    mod: { url: 'http://127.0.0.1:39000', timeoutMs: 1234 },
    policy: { allowChat: false, allowAttack: 'false' },
    agent: { maxSteps: 7 },
    log: { level: 'debug' }
  });
  const { config } = loadConfig({ argv: ['--config', file], env: {}, cwd: dir, home: dir });
  assert.equal(config.mode, 'mod');
  assert.equal(config.bot.port, 25599);
  assert.equal(config.bot.host, 'example.local');
  assert.equal(config.bot.unknownBotField, undefined);
  assert.equal(config.unknownTopLevel, undefined);
  assert.equal(config.mod.timeoutMs, 1234);
  assert.equal(config.policy.allowChat, false);
  assert.equal(config.policy.allowAttack, false);
  assert.equal(config.policy.allowRead, true);
  assert.equal(config.agent.maxSteps, 7);
  assert.equal(config.log.level, 'debug');
});

test('invalid JSON and invalid mode throw ConfigError', () => {
  const dir = tempDir('dsh-mc-invalid-');
  const badJson = path.join(dir, 'bad.json');
  fs.writeFileSync(badJson, '{ this is not json');
  assert.throws(
    () => loadConfig({ argv: ['--config', badJson], env: {}, cwd: dir, home: dir }),
    (err) => err.code === 'invalid_config'
  );

  const badMode = writeJson(dir, 'mode.json', { mode: 'hybrid' });
  assert.throws(
    () => loadConfig({ argv: ['--config', badMode], env: {}, cwd: dir, home: dir }),
    (err) => err.code === 'invalid_mode'
  );

  assert.throws(
    () => loadConfig({ argv: ['--config', path.join(dir, 'missing.json')], env: {}, cwd: dir, home: dir }),
    (err) => err.code === 'invalid_config'
  );
});

test('secrets are only read from the environment (config file token is ignored with a warning)', () => {
  const dir = tempDir('dsh-mc-secret-');
  const file = writeJson(dir, 'dsh-mc.config.json', {
    mode: 'mod',
    mod: { token: 'file-secret' },
    agent: { apiKey: 'sk-in-file' }
  });
  const loaded = loadConfig({ argv: ['--config', file], env: {}, cwd: dir, home: dir });
  assert.equal(loaded.config.mod.token, '');
  assert.equal(loaded.config.agent.apiKey, undefined);
  assert.equal(loaded.warnings.length, 2);
  assert.ok(loaded.warnings.some((warning) => warning.includes('mod.token')));
  assert.ok(loaded.warnings.some((warning) => warning.includes('agent.apiKey')));
  assert.equal(resolveModToken({}), '');
  assert.equal(resolveModToken({ DSH_MC_TOKEN: '  env-token  ' }), 'env-token');
  assert.equal(resolveAgentApiKey(loaded.config, { DEEPSEEK_API_KEY: 'sk-env' }), 'sk-env');
  assert.equal(
    resolveAgentApiKey({ agent: { apiKeyEnv: 'MY_DS_KEY' } }, { MY_DS_KEY: 'sk-custom' }),
    'sk-custom'
  );
});

test('mode readiness problems are structured', () => {
  const dir = tempDir('dsh-mc-ready-');
  const modConfig = loadConfig({
    argv: ['--config', writeJson(dir, 'mod.json', { mode: 'mod' })],
    env: {},
    cwd: dir,
    home: dir
  }).config;
  const problems = validateModeReadiness(modConfig, {});
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'missing_token');
  assert.deepEqual(validateModeReadiness(modConfig, { DSH_MC_TOKEN: 'x' }), []);

  const botConfig = loadConfig({ argv: [], env: {}, cwd: dir, home: dir }).config;
  botConfig.bot.port = 0;
  const botProblems = validateModeReadiness(botConfig, {});
  assert.equal(botProblems.length, 1);
  assert.equal(botProblems[0].code, 'invalid_config');
});
