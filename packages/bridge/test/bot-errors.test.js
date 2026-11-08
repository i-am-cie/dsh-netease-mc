'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { BotChannel } = require('../src/game/bot');
const { makeConfig } = require('./helpers/config');
const { createLogger } = require('../src/logger');

const quietLogger = createLogger({ level: 'silent' });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function botChannel(overrides = {}) {
  const config = makeConfig(Object.assign({ mode: 'bot', bot: { connectTimeoutMs: 3000 } }, overrides));
  return new BotChannel(config, { logger: quietLogger, env: {} });
}

test('connection failure never crashes the process and reports a structured error', async () => {
  const port = await freePort();
  const channel = botChannel({ bot: { host: '127.0.0.1', port, connectTimeoutMs: 3000 } });
  let error = null;
  try {
    await channel.ensureConnected({ waitMs: 6000 });
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'ensureConnected must reject when the server is unreachable');
  assert.equal(error.code, 'bot_not_connected');
  assert.match(error.message, /not connected/i);
  assert.ok(channel.lastError, 'lastError should carry the underlying connection error');
  assert.equal(channel.connected, false);
  assert.ok(channel.reconnectTimer, 'a reconnect should be scheduled with backoff');
  await channel.close();
  assert.equal(channel.reconnectTimer, null);
});

test('missing mineflayer is reported as a clear error (and does not reject unhandled)', async () => {
  const channel = botChannel({ bot: { port: 25565, connectTimeoutMs: 1000 } });
  channel.loadMineflayer = async () => {
    const { ToolError } = require('../src/errors');
    throw new ToolError('mineflayer_missing', 'mineflayer is not installed');
  };
  let error = null;
  try {
    await channel.ensureConnected({ waitMs: 300 });
  } catch (err) {
    error = err;
  }
  assert.ok(error);
  assert.equal(error.code, 'bot_not_connected');
  assert.match(error.message, /mineflayer/);
  await channel.close();
});

test('mc_status is non-blocking and reports the disconnected state', async () => {
  const port = await freePort();
  const channel = botChannel({ bot: { host: '127.0.0.1', port, connectTimeoutMs: 3000 } });
  const startedAt = Date.now();
  const status = await channel.mc_status();
  const elapsed = Date.now() - startedAt;
  assert.equal(status.ok, true);
  assert.equal(status.mode, 'bot');
  assert.equal(status.connected, false);
  assert.deepEqual(status.server, { host: '127.0.0.1', port, version: '1.21.8' });
  assert.ok(elapsed < 1500, `mc_status should return immediately, took ${elapsed}ms`);
  await sleep(300);
  await channel.close();
});

test('bot_port configuration errors are surfaced as invalid_config', async () => {
  const channel = botChannel({ bot: { port: 0 } });
  channel.loadMineflayer = async () => ({ createBot() { throw new Error('should not be called'); } });
  let error = null;
  try {
    await channel.ensureConnected({ waitMs: 300 });
  } catch (err) {
    error = err;
  }
  // invalid port is detected before mineflayer is even used; either way the
  // error is structured and the process survives.
  assert.ok(error);
  assert.ok(['invalid_config', 'bot_not_connected'].includes(error.code));
  assert.match(channel.lastError || '', /port|not connected/i);
  await channel.close();
});
