'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const normalize = require('../src/normalize');
const { toErrorResult, ToolError } = require('../src/errors');
const { TOOLS, TOOL_TIMEOUTS, getToolNames, toOpenAITools, validateAndCoerceArgs } = require('../src/tools');

test('status has the canonical shape regardless of channel', () => {
  const base = {
    mode: 'bot',
    connected: true,
    server: { host: '127.0.0.1', port: 25565, version: '1.21.8' },
    mod: null,
    player: { name: 'DeepSeek' },
    policy: { allowRead: true, allowMove: false },
    uptimeMs: 1234.6,
    lastError: null
  };
  const bot = normalize.status(base);
  const mod = normalize.status(Object.assign({}, base, { mode: 'mod', server: null, mod: { url: 'http://127.0.0.1:38210', version: '0.1.0', mc: '1.21.8' } }));
  assert.deepEqual(bot, {
    ok: true,
    mode: 'bot',
    connected: true,
    server: { host: '127.0.0.1', port: 25565, version: '1.21.8' },
    mod: null,
    player: { name: 'DeepSeek' },
    policy: {
      allowRead: true,
      allowMove: false,
      allowWorldWrite: true,
      allowCommands: true,
      allowChat: true,
      allowAttack: true
    },
    uptimeMs: 1235,
    lastError: null
  });
  assert.deepEqual(Object.keys(bot).sort(), Object.keys(mod).sort());
  assert.deepEqual(Object.keys(bot.policy).sort(), Object.keys(mod.policy).sort());
  assert.equal(mod.mode, 'mod');
  assert.equal(mod.server, null);
});

test('state is rounded and normalised', () => {
  const result = normalize.state({
    player: {
      name: 'DeepSeek',
      uuid: 'uuid',
      x: 1.23456789,
      y: 64,
      z: -2.5,
      yaw: 90,
      pitch: 0,
      health: 20,
      food: 18,
      gamemode: 'creative',
      dimension: 'minecraft:overworld',
      level: 5,
      exp: 0.5
    },
    world: { time: 6000, day: 3, weather: 'clear', difficulty: 'peaceful' }
  });
  assert.deepEqual(result, {
    ok: true,
    player: {
      name: 'DeepSeek',
      uuid: 'uuid',
      x: 1.235,
      y: 64,
      z: -2.5,
      yaw: 90,
      pitch: 0,
      health: 20,
      food: 18,
      gamemode: 'creative',
      dimension: 'minecraft:overworld',
      level: 5,
      exp: 0.5
    },
    world: { time: 6000, day: 3, weather: 'clear', difficulty: 'peaceful' }
  });
});

test('players/blocks/entities are sorted and namespaced names stripped', () => {
  assert.deepEqual(
    normalize.players([
      { name: 'Zed', x: 1, y: 2, z: 3, health: 20 },
      { name: 'Alex', x: 4, y: 5, z: 6, health: null }
    ]),
    {
      ok: true,
      players: [
        { name: 'Alex', x: 4, y: 5, z: 6, health: null },
        { name: 'Zed', x: 1, y: 2, z: 3, health: 20 }
      ],
      count: 2
    }
  );

  assert.deepEqual(
    normalize.blocks([
      { x: 3, y: 2, z: 1, name: 'minecraft:oak_log', distance: 2.2360679 },
      { x: 1, y: 2, z: 3, name: 'minecraft:stone', distance: 1 }
    ]),
    {
      ok: true,
      blocks: [
        { x: 1, y: 2, z: 3, name: 'stone', distance: 1 },
        { x: 3, y: 2, z: 1, name: 'oak_log', distance: 2.236 }
      ],
      count: 2
    }
  );

  assert.deepEqual(
    normalize.entities([
      { id: 7, name: 'minecraft:zombie', type: 'mob', x: 4, y: 64, z: 4, distance: 3.6055 },
      { id: 3, name: 'Alex', type: 'player', x: 2, y: 64, z: 2, distance: 1 }
    ]),
    {
      ok: true,
      entities: [
        { id: 3, name: 'Alex', type: 'player', x: 2, y: 64, z: 2, distance: 1 },
        { id: 7, name: 'zombie', type: 'mob', x: 4, y: 64, z: 4, distance: 3.606 }
      ],
      count: 2
    }
  );
});

test('inventory normalises slots and names', () => {
  const result = normalize.inventory([
    { slot: 36, name: 'minecraft:oak_planks', displayName: 'Oak Planks', count: 16, durability: null },
    { slot: 9, name: 'minecraft:diamond_pickaxe', count: 1, durability: 1561 },
    { slot: 10, name: null, count: 0 }
  ]);
  assert.deepEqual(result, {
    ok: true,
    items: [
      { slot: 9, name: 'diamond_pickaxe', displayName: 'diamond_pickaxe', count: 1, durability: 1561 },
      { slot: 10, name: null, displayName: null, count: 0, durability: null },
      { slot: 36, name: 'oak_planks', displayName: 'Oak Planks', count: 16, durability: null }
    ],
    count: 3
  });
});

test('block, move, mine, place, use, attack, chat, command shapes', () => {
  assert.deepEqual(
    normalize.block({ x: 1, y: 63, z: 2, name: 'minecraft:stone', properties: { facing: 'north' }, solid: true }),
    {
      ok: true,
      block: {
        x: 1,
        y: 63,
        z: 2,
        name: 'stone',
        displayName: 'stone',
        properties: { facing: 'north' },
        solid: true,
        blockEntity: null
      }
    }
  );

  assert.deepEqual(
    normalize.move({ from: { x: 1, y: 64, z: 2 }, to: { x: 5, y: 64, z: 6 }, target: { x: 5, y: 64, z: 6 } }),
    {
      ok: true,
      moved: {
        from: { x: 1, y: 64, z: 2 },
        to: { x: 5, y: 64, z: 6 },
        distance: 5.657
      },
      target: { x: 5, y: 64, z: 6 }
    }
  );

  assert.deepEqual(
    normalize.mine({ mined: [{ x: 3, y: 63, z: 2, name: 'minecraft:oak_log' }] }),
    { ok: true, mined: [{ x: 3, y: 63, z: 2, name: 'oak_log' }], count: 1 }
  );

  assert.deepEqual(
    normalize.place({ placed: { x: 2, y: 64, z: 5, name: 'minecraft:oak_planks' }, item: 'oak_planks' }),
    { ok: true, placed: { x: 2, y: 64, z: 5, name: 'oak_planks' }, item: 'oak_planks' }
  );

  assert.deepEqual(normalize.use({ item: 'minecraft:golden_apple', action: 'use' }), {
    ok: true,
    used: { item: 'golden_apple', offhand: false, action: 'use' }
  });

  assert.deepEqual(normalize.attack({ entity: { id: 42, name: 'zombie' } }), {
    ok: true,
    attacked: { id: 42, name: 'zombie' }
  });

  assert.deepEqual(normalize.chatSent({ message: 'hello' }), { ok: true, sent: true, message: 'hello' });
  assert.deepEqual(normalize.chatMessages([{ username: 'Alex', message: 'hi' }]), {
    ok: true,
    messages: [{ username: 'Alex', message: 'hi' }],
    count: 1
  });
  assert.deepEqual(normalize.command({ command: 'time set day', output: 'ok' }), {
    ok: true,
    command: 'time set day',
    output: ['ok']
  });
});

test('error results are canonical', () => {
  assert.deepEqual(toErrorResult(new ToolError('missing_token', 'no token')), {
    ok: false,
    error: { code: 'missing_token', message: 'no token' }
  });
  assert.deepEqual(toErrorResult(new Error('boom')), {
    ok: false,
    error: { code: 'internal_error', message: 'boom' }
  });
  const already = { ok: false, error: { code: 'x', message: 'y' } };
  assert.equal(toErrorResult(already), already);
  assert.deepEqual(toErrorResult(new ToolError('x', 'y', { detail: 1 })), {
    ok: false,
    error: { code: 'x', message: 'y', details: { detail: 1 } }
  });
});

test('tool registry contains exactly the 14 contracted tools with schemas', () => {
  const expected = [
    'mc_status',
    'mc_state',
    'mc_players',
    'mc_inventory',
    'mc_nearby_entities',
    'mc_nearby_blocks',
    'mc_block',
    'mc_move',
    'mc_mine',
    'mc_place',
    'mc_use',
    'mc_attack',
    'mc_chat',
    'mc_command'
  ];
  assert.deepEqual(getToolNames(), expected);
  assert.equal(TOOLS.length, 14);
  for (const tool of TOOLS) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.inputSchema.properties, 'object');
  }
  assert.equal(TOOL_TIMEOUTS.mc_state, 10000);
  assert.equal(TOOL_TIMEOUTS.mc_mine, 35000);
  assert.equal(TOOL_TIMEOUTS.mc_command, 15000);

  const openai = toOpenAITools();
  assert.equal(openai.length, 14);
  assert.equal(openai[0].type, 'function');
  assert.equal(openai[0].function.name, 'mc_status');
  assert.equal(openai[0].function.parameters.type, 'object');
});

test('argument validation/coercion works for LLM style args', () => {
  assert.deepEqual(validateAndCoerceArgs('mc_state', undefined), { ok: true, args: {} });

  const coords = validateAndCoerceArgs('mc_block', { x: '1', y: 63, z: -2 });
  assert.equal(coords.ok, true);
  assert.deepEqual(coords.args, { x: 1, y: 63, z: -2 });

  assert.equal(validateAndCoerceArgs('mc_block', { x: 1, y: 2 }).ok, false);
  assert.equal(validateAndCoerceArgs('mc_block', { x: 'abc', y: 2, z: 3 }).ok, false);
  assert.equal(validateAndCoerceArgs('mc_place', { x: 1, y: 2, z: 3, odd: true }).ok, true);
  assert.equal(validateAndCoerceArgs('mc_unknown', {}).ok, false);
  assert.equal(validateAndCoerceArgs('mc_move', { x: 1, z: 2, lookAt: { x: 1 } }).ok, false);
  assert.equal(validateAndCoerceArgs('mc_move', { stop: 'true' }).ok, true);
  assert.equal(validateAndCoerceArgs('mc_state', []).ok, false);
});
