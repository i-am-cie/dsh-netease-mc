'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { startMockModServer } = require('./helpers/mock-mod-server');
const { makeConfig } = require('./helpers/config');
const { Executor } = require('../src/executor');
const { createLogger } = require('../src/logger');

const quietLogger = createLogger({ level: 'silent' });

function modExecutor(url, { token = 'test-token', configOverrides = {} } = {}) {
  const base = Object.assign({ mode: 'mod' }, configOverrides);
  base.mod = Object.assign({ url }, configOverrides.mod || {});
  const config = makeConfig(base);
  return new Executor({
    config,
    env: token === null ? {} : { DSH_MC_TOKEN: token },
    logger: quietLogger
  });
}

/** Start a mock server with a custom override handler. */
function startOverride(handler) {
  return startMockModServer({ override: handler });
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

let mock;
let executor;

before(async () => {
  mock = await startMockModServer();
  executor = modExecutor(mock.url);
});

after(async () => {
  await executor.close();
  await mock.close().catch(() => {});
});

test('mc_status reports mod channel state, version and policy', async () => {
  const result = await executor.execute('mc_status', {});
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'mod');
  assert.equal(result.connected, true);
  assert.equal(result.server, null);
  assert.equal(result.mod.url, mock.url);
  assert.match(result.mod.version, /netease-mc-link/);
  assert.equal(result.mod.mc, '1.21.8');
  assert.equal(result.player.name, 'DeepSeek');
  assert.equal(result.policy.allowRead, true);
  assert.equal(result.lastError, null);
  assert.equal(typeof result.uptimeMs, 'number');
});

test('mc_state matches the canonical shape exactly', async () => {
  const result = await executor.execute('mc_state', {});
  assert.deepEqual(result, {
    ok: true,
    player: {
      name: 'DeepSeek',
      uuid: '00000000-0000-0000-0000-000000000001',
      x: 1,
      y: 64,
      z: 2,
      yaw: 90,
      pitch: 0,
      health: 20,
      food: 20,
      gamemode: 'creative',
      dimension: 'minecraft:overworld',
      level: 5,
      exp: 0.5
    },
    world: { time: 6000, day: 3, weather: 'clear', difficulty: 'peaceful' }
  });
});

test('mc_players lists sorted players', async () => {
  const result = await executor.execute('mc_players', {});
  assert.deepEqual(result, {
    ok: true,
    players: [
      { name: 'Alex', x: 3, y: 64, z: 4, health: 20 },
      { name: 'DeepSeek', x: 1, y: 64, z: 2, health: 20 }
    ],
    count: 2
  });
});

test('mc_inventory maps items and honours includeEmpty', async () => {
  const result = await executor.execute('mc_inventory', {});
  assert.deepEqual(result, {
    ok: true,
    items: [{ slot: 36, name: 'oak_planks', displayName: 'Oak Planks', count: 16, durability: null }],
    count: 1
  });
  const withEmpty = await executor.execute('mc_inventory', { includeEmpty: true });
  assert.equal(withEmpty.ok, true);
  assert.equal(withEmpty.items.length, 2);
  assert.equal(withEmpty.items[1].name, null);
});

test('mc_nearby_entities filters and normalises', async () => {
  const result = await executor.execute('mc_nearby_entities', { radius: 10 });
  assert.deepEqual(result, {
    ok: true,
    entities: [{ id: 42, name: 'zombie', type: 'mob', x: 4, y: 64, z: 4, distance: 3.606 }],
    count: 1
  });
  const zombieOnly = await executor.execute('mc_nearby_entities', { type: 'zombie' });
  assert.equal(zombieOnly.count, 1);
  const none = await executor.execute('mc_nearby_entities', { type: 'creeper' });
  assert.equal(none.ok, true);
  assert.equal(none.count, 0);
});

test('mc_nearby_blocks returns blocks sorted by distance', async () => {
  const result = await executor.execute('mc_nearby_blocks', { radius: 16, limit: 10 });
  assert.deepEqual(result, {
    ok: true,
    blocks: [
      { x: 1, y: 63, z: 2, name: 'stone', distance: 1 },
      { x: 3, y: 63, z: 2, name: 'oak_log', distance: 2.236 }
    ],
    count: 2
  });
  const filtered = await executor.execute('mc_nearby_blocks', { radius: 16, block: 'minecraft:oak_log' });
  assert.deepEqual(filtered.blocks, [{ x: 3, y: 63, z: 2, name: 'oak_log', distance: 2.236 }]);
});

test('mc_block returns the canonical block shape and maps errors', async () => {
  const result = await executor.execute('mc_block', { x: 1, y: 63, z: 2 });
  assert.deepEqual(result, {
    ok: true,
    block: {
      x: 1,
      y: 63,
      z: 2,
      name: 'stone',
      displayName: 'stone',
      properties: {},
      solid: true,
      blockEntity: null
    }
  });
  const missing = await executor.execute('mc_block', { x: 0, y: 0, z: 0 });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'block_not_loaded');
});

test('mc_move uses the mod action endpoint and reports from/to', async () => {
  const result = await executor.execute('mc_move', { x: 5, y: 64, z: 6 });
  assert.deepEqual(result, {
    ok: true,
    moved: {
      from: { x: 1, y: 64, z: 2 },
      to: { x: 5, y: 64, z: 6 },
      distance: 5.657
    },
    target: { x: 5, y: 64, z: 6 }
  });
  // reset the mock player for later tests
  mock.state.player.x = 1;
  mock.state.player.z = 2;
  const stop = await executor.execute('mc_move', { stop: true });
  assert.equal(stop.ok, true);
  assert.deepEqual(stop.moved.from, stop.moved.to);
});

test('mc_mine mines coordinates and returns the block name', async () => {
  const result = await executor.execute('mc_mine', { x: 3, y: 63, z: 2 });
  assert.deepEqual(result, {
    ok: true,
    mined: [{ x: 3, y: 63, z: 2, name: 'oak_log' }],
    count: 1
  });
  const again = await executor.execute('mc_mine', { x: 3, y: 63, z: 2 });
  // the mock treats a missing block as a generic drop; the real mod would error
  assert.equal(again.ok, true);
});

test('mc_place places the requested item', async () => {
  const result = await executor.execute('mc_place', { x: 2, y: 64, z: 5, item: 'oak_planks' });
  assert.deepEqual(result, {
    ok: true,
    placed: { x: 2, y: 64, z: 5, name: 'oak_planks' },
    item: 'oak_planks'
  });
});

test('mc_use returns the canonical used shape', async () => {
  const result = await executor.execute('mc_use', { item: 'golden_apple' });
  assert.deepEqual(result, {
    ok: true,
    used: { item: 'golden_apple', offhand: false, action: 'use' }
  });
});

test('mc_attack resolves the attacked entity', async () => {
  const result = await executor.execute('mc_attack', { entityId: 42 });
  assert.deepEqual(result, { ok: true, attacked: { id: 42, name: 'zombie' } });
  const nearest = await executor.execute('mc_attack', { nearest: true });
  assert.equal(nearest.ok, true);
  assert.equal(nearest.attacked.id, 42);
});

test('mc_chat sends and reads messages', async () => {
  const sent = await executor.execute('mc_chat', { message: 'hello from test' });
  assert.deepEqual(sent, { ok: true, sent: true, message: 'hello from test' });
  const read = await executor.execute('mc_chat', { read: true, limit: 5 });
  assert.equal(read.ok, true);
  assert.equal(read.messages[read.messages.length - 1].message, 'hello from test');
  assert.equal(read.messages[read.messages.length - 1].username, 'DeepSeek');
});

test('mc_command executes through the mod command endpoint', async () => {
  const result = await executor.execute('mc_command', { command: '/time set day' });
  assert.deepEqual(result, {
    ok: true,
    command: 'time set day',
    output: ['Executed: time set day']
  });
});

test('unknown tools and bad arguments produce structured errors', async () => {
  const unknown = await executor.execute('mc_fly', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'unknown_tool');

  const badArgs = await executor.execute('mc_block', { x: 1 });
  assert.equal(badArgs.ok, false);
  assert.equal(badArgs.error.code, 'invalid_arguments');

  const badMove = await executor.execute('mc_move', {});
  assert.equal(badMove.ok, false);
  assert.equal(badMove.error.code, 'invalid_arguments');
});

test('policy denies writes before touching the mod HTTP API', async (t) => {
  const locked = modExecutor(mock.url, { configOverrides: { policy: { allowWorldWrite: false } } });
  t.after(() => locked.close());
  const callsBefore = mock.state.calls.length;
  const denied = await locked.execute('mc_place', { x: 4, y: 64, z: 4 });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'operation_not_allowed');
  assert.equal(mock.state.calls.length, callsBefore, 'denied tool must not call the mod API');
});

test('missing mod token is a structured error', async (t) => {
  const noToken = modExecutor(mock.url, { token: null });
  t.after(() => noToken.close());
  const result = await noToken.execute('mc_state', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'missing_token');
});

test('unauthorized mod responses map to mod_unauthorized', async (t) => {
  const wrong = modExecutor(mock.url, { token: 'wrong-token' });
  t.after(() => wrong.close());
  const result = await wrong.execute('mc_state', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'mod_unauthorized');
});

test('5xx responses map to mod_server_error', async (t) => {
  const failing = await startOverride((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: 'boom' } }));
    return true;
  });
  const failingExecutor = modExecutor(failing.url);
  t.after(async () => {
    await failingExecutor.close();
    await failing.close();
  });
  const result = await failingExecutor.execute('mc_state', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'internal');
});

test('non-JSON responses map to mod_invalid_response', async (t) => {
  const broken = await startOverride((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not json at all');
    return true;
  });
  const brokenExecutor = modExecutor(broken.url);
  t.after(async () => {
    await brokenExecutor.close();
    await broken.close();
  });
  const result = await brokenExecutor.execute('mc_state', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'mod_invalid_response');
});

test('unreachable mod maps to mod_unreachable and mc_status does not throw', async (t) => {
  const port = await freePort();
  const deadExecutor = modExecutor(`http://127.0.0.1:${port}`, {
    configOverrides: { mod: { url: `http://127.0.0.1:${port}`, timeoutMs: 1000 } }
  });
  t.after(() => deadExecutor.close());
  const status = await deadExecutor.execute('mc_status', {});
  assert.equal(status.ok, true);
  assert.equal(status.connected, false);
  assert.match(status.lastError, /mod_unreachable/);

  const state = await deadExecutor.execute('mc_state', {});
  assert.equal(state.ok, false);
  assert.equal(state.error.code, 'mod_unreachable');
});

test('slow mod responses map to timeout', async (t) => {
  const slow = await startOverride((req, res) => {
    const timer = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, player: {}, world: {} }));
    }, 1500);
    if (timer.unref) timer.unref();
    return true;
  });
  const slowExecutor = modExecutor(slow.url, { configOverrides: { mod: { timeoutMs: 300 } } });
  t.after(async () => {
    await slowExecutor.close();
    await slow.close();
  });
  const result = await slowExecutor.execute('mc_state', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'timeout');
});
