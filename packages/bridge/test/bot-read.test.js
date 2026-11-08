'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startMockModServer } = require('./helpers/mock-mod-server');
const { makeConfig } = require('./helpers/config');
const { BotChannel } = require('../src/game/bot');
const { Executor } = require('../src/executor');
const { createLogger } = require('../src/logger');

const quietLogger = createLogger({ level: 'silent' });

/** Minimal Vec3 implementation (mineflayer uses Vec3; tests must not depend on it). */
class Vec {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  clone() {
    return new Vec(this.x, this.y, this.z);
  }
  offset(x, y, z) {
    return new Vec(this.x + x, this.y + y, this.z + z);
  }
  minus(other) {
    return new Vec(this.x - other.x, this.y - other.y, this.z - other.z);
  }
  plus(other) {
    return new Vec(this.x + other.x, this.y + other.y, this.z + other.z);
  }
  distanceTo(other) {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
  }
}

function block(name, x, y, z, properties = {}, solid = true) {
  return {
    name,
    position: new Vec(x, y, z),
    boundingBox: solid ? 'block' : 'empty',
    displayName: name,
    getProperties: () => properties,
    blockEntity: null
  };
}

const SELF = {
  id: 1,
  name: 'DeepSeek',
  type: 'player',
  position: new Vec(1, 64, 2),
  yaw: Math.PI / 2,
  pitch: 0,
  height: 1.8,
  onGround: true,
  health: 20
};

const ALEX = { id: 2, name: 'Alex', type: 'player', position: new Vec(3, 64, 4), health: 20 };
const ZOMBIE = { id: 42, name: 'zombie', type: 'mob', position: new Vec(4, 64, 4), health: 20 };
const CREEPER = { id: 43, name: 'creeper', type: 'mob', position: new Vec(2, 64, 2), health: 20 };

const WORLD_BLOCKS = [
  block('stone', 1, 63, 2),
  block('oak_log', 3, 63, 2, { axis: 'y' })
];

function keyOf(position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function createFakeBot() {
  const blockMap = new Map(WORLD_BLOCKS.map((entry) => [keyOf(entry.position), entry]));
  const chatSent = [];
  const attacked = [];
  const self = Object.assign({}, SELF);

  const fakeBot = {
    username: 'DeepSeek',
    version: '1.21.8',
    player: { uuid: '00000000-0000-0000-0000-000000000001' },
    entity: self,
    entities: { 1: self, 2: ALEX, 42: ZOMBIE, 43: CREEPER },
    players: { DeepSeek: { entity: self }, Alex: { entity: ALEX } },
    game: { gameMode: 'creative', dimension: 'minecraft:overworld', difficulty: 'peaceful' },
    health: 20,
    food: 20,
    experience: { level: 5, progress: 0.5 },
    time: { timeOfDay: 6000, day: 3 },
    isRaining: false,
    thunderState: 0,
    heldItem: null,
    inventory: {
      slots: [],
      items: () => [
        // shaped like mineflayer's Item (only the fields the bridge touches)
        { slot: 36, name: 'oak_planks', displayName: 'Oak Planks', count: 16 }
      ]
    },
    blockAt: (position) => blockMap.get(keyOf(position)) || null,
    findBlocks: ({ matching, maxDistance, count }) => {
      return WORLD_BLOCKS.filter((entry) => matching(entry) && self.position.distanceTo(entry.position) <= maxDistance)
        .sort((a, b) => self.position.distanceTo(a.position) - self.position.distanceTo(b.position))
        .slice(0, count)
        .map((entry) => entry.position.clone());
    },
    setControlState: () => {},
    lookAt: async () => {},
    chat: (message) => chatSent.push(message),
    attack: (entity) => attacked.push(entity),
    activateItem: () => {},
    equip: async () => {}
  };

  return { fakeBot, chatSent, attacked };
}

function createFakeChannel() {
  const config = makeConfig({ mode: 'bot' });
  const channel = new BotChannel(config, { logger: quietLogger, env: {} });
  const { fakeBot, chatSent, attacked } = createFakeBot();
  channel.bot = fakeBot;
  channel.connected = true;
  channel.chatLog = [{ username: 'Alex', message: 'hi' }];
  return { channel, fakeBot, chatSent, attacked };
}

let mock;
let modExecutor;

before(async () => {
  mock = await startMockModServer();
  modExecutor = new Executor({
    config: makeConfig({ mode: 'mod', mod: { url: mock.url } }),
    env: { DSH_MC_TOKEN: mock.token },
    logger: quietLogger
  });
});

after(async () => {
  await modExecutor.close();
  await mock.close().catch(() => {});
});

test('bot mc_state matches the mod channel output exactly', async () => {
  const { channel } = createFakeChannel();
  const botResult = await channel.mc_state();
  const modResult = await modExecutor.execute('mc_state', {});
  assert.deepEqual(botResult, modResult);
  await channel.close();
});

test('bot mc_players matches the mod channel output exactly', async () => {
  const { channel } = createFakeChannel();
  assert.deepEqual(await channel.mc_players(), await modExecutor.execute('mc_players', {}));
  await channel.close();
});

test('bot mc_inventory matches the mod channel output exactly', async () => {
  const { channel } = createFakeChannel();
  assert.deepEqual(await channel.mc_inventory({}), await modExecutor.execute('mc_inventory', {}));
  await channel.close();
});

test('bot mc_nearby_entities matches the mod channel output exactly (filtered)', async () => {
  const { channel } = createFakeChannel();
  const botResult = await channel.mc_nearby_entities({ type: 'zombie' });
  const modResult = await modExecutor.execute('mc_nearby_entities', { type: 'zombie' });
  assert.deepEqual(botResult, modResult);
  await channel.close();
});

test('bot mc_nearby_blocks matches the mod channel output exactly', async () => {
  const { channel } = createFakeChannel();
  const botResult = await channel.mc_nearby_blocks({ radius: 16, limit: 10 });
  const modResult = await modExecutor.execute('mc_nearby_blocks', { radius: 16, limit: 10 });
  assert.deepEqual(botResult, modResult);
  await channel.close();
});

test('bot mc_block matches the mod channel output exactly', async () => {
  const { channel } = createFakeChannel();
  const botResult = await channel.mc_block({ x: 1, y: 63, z: 2 });
  const modResult = await modExecutor.execute('mc_block', { x: 1, y: 63, z: 2 });
  assert.deepEqual(botResult, modResult);
  await channel.close();
});

test('bot and mod mc_status expose the same structure', async () => {
  const { channel } = createFakeChannel();
  const botStatus = await channel.mc_status();
  const modStatus = await modExecutor.execute('mc_status', {});
  assert.deepEqual(Object.keys(botStatus).sort(), Object.keys(modStatus).sort());
  assert.deepEqual(Object.keys(botStatus.policy).sort(), Object.keys(modStatus.policy).sort());
  assert.equal(botStatus.player.name, modStatus.player.name);
  assert.equal(botStatus.connected, modStatus.connected);
  assert.equal(botStatus.mode, 'bot');
  assert.equal(modStatus.mode, 'mod');
  assert.deepEqual(botStatus.server, { host: '127.0.0.1', port: 25565, version: '1.21.8' });
  assert.equal(modStatus.server, null);
  await channel.close();
});

test('bot mc_chat read matches the mod channel and send captures the message', async () => {
  const { channel, chatSent } = createFakeChannel();
  assert.deepEqual(await channel.mc_chat({ read: true }), await modExecutor.execute('mc_chat', { read: true }));
  const sent = await channel.mc_chat({ message: 'hi there' });
  assert.deepEqual(sent, { ok: true, sent: true, message: 'hi there' });
  assert.deepEqual(chatSent, ['hi there']);
  await channel.close();
});

test('bot mc_attack attacks the nearest entity', async () => {
  const { channel, attacked } = createFakeChannel();
  const result = await channel.mc_attack({ nearest: true });
  assert.equal(result.ok, true);
  assert.equal(result.attacked.id, 43); // creeper is closest (1 block)
  assert.deepEqual(result.attacked.name, 'creeper');
  assert.equal(attacked.length, 1);
  await channel.close();
});

test('bot inventory includeEmpty lists empty slots too', async () => {
  const { channel } = createFakeChannel();
  const result = await channel.mc_inventory({ includeEmpty: true });
  assert.equal(result.ok, true);
  assert.equal(result.count, 36); // slots 9..44
  assert.equal(result.items.find((item) => item.slot === 9).name, null);
  assert.equal(result.items.find((item) => item.slot === 36).name, 'oak_planks');
  await channel.close();
});

test('bot mc_command always reports unsupported_in_bot_mode (no fake success)', async () => {
  const { channel } = createFakeChannel();
  await assert.rejects(() => channel.mc_command({ command: 'time set day' }), (err) => err.code === 'unsupported_in_bot_mode');
  await channel.close();

  // Executor short-circuits before touching a channel at all.
  const executor = new Executor({ config: makeConfig({ mode: 'bot' }), env: {}, logger: quietLogger });
  const result = await executor.execute('mc_command', { command: 'time set day' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unsupported_in_bot_mode');
  assert.match(result.error.message, /mc_chat/);
  await executor.close();
});

test('executor applies the policy gate in bot mode', async () => {
  const { channel } = createFakeChannel();
  const executor = new Executor({
    config: makeConfig({ mode: 'bot', policy: { allowRead: false } }),
    env: {},
    logger: quietLogger,
    channelFactory: () => channel
  });
  const denied = await executor.execute('mc_state', {});
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'operation_not_allowed');
  await executor.close();
});

test('requiring the bridge entry point does not load mineflayer (lazy import)', () => {
  for (const key of Object.keys(require.cache)) {
    if (/node_modules[\\/]mineflayer[\\/]/.test(key)) delete require.cache[key];
  }
  require('../src/index');
  const loaded = Object.keys(require.cache).some((key) => /node_modules[\\/]mineflayer[\\/]/.test(key));
  assert.equal(loaded, false, 'mineflayer must only be imported inside BotChannel._connect()');
});
