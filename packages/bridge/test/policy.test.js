'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkPolicy, requiredCapabilities, TOOL_CAPABILITY, DENIED_CODE } = require('../src/policy');

const ALLOW_ALL = {
  allowRead: true,
  allowMove: true,
  allowWorldWrite: true,
  allowCommands: true,
  allowChat: true,
  allowAttack: true
};

test('every mutating tool is mapped to a policy capability', () => {
  const expected = {
    mc_status: 'allowRead',
    mc_state: 'allowRead',
    mc_players: 'allowRead',
    mc_inventory: 'allowRead',
    mc_nearby_entities: 'allowRead',
    mc_nearby_blocks: 'allowRead',
    mc_block: 'allowRead',
    mc_move: 'allowMove',
    mc_mine: 'allowWorldWrite',
    mc_place: 'allowWorldWrite',
    mc_use: 'allowWorldWrite',
    mc_attack: 'allowAttack',
    mc_chat: 'allowChat',
    mc_command: 'allowCommands'
  };
  assert.deepEqual(TOOL_CAPABILITY, expected);
});

test('allow-all policy permits every tool', () => {
  for (const tool of Object.keys(TOOL_CAPABILITY)) {
    assert.equal(checkPolicy(ALLOW_ALL, tool, {}), null, tool);
  }
  assert.equal(checkPolicy(ALLOW_ALL, 'mc_chat', { message: 'hi' }), null);
});

test('each capability blocks exactly its tools with a structured error', () => {
  const cases = [
    ['allowRead', 'mc_state', {}, 'mc_state'],
    ['allowRead', 'mc_nearby_blocks', {}, 'mc_nearby_blocks'],
    ['allowMove', 'mc_move', { x: 1, z: 1 }, 'mc_move'],
    ['allowWorldWrite', 'mc_mine', { block: 'oak_log' }, 'mc_mine'],
    ['allowWorldWrite', 'mc_place', { x: 1, y: 2, z: 3 }, 'mc_place'],
    ['allowWorldWrite', 'mc_use', {}, 'mc_use'],
    ['allowCommands', 'mc_command', { command: 'time set day' }, 'mc_command'],
    ['allowAttack', 'mc_attack', { nearest: true }, 'mc_attack']
  ];
  for (const [capability, tool, args, label] of cases) {
    const policy = Object.assign({}, ALLOW_ALL, { [capability]: false });
    const denied = checkPolicy(policy, tool, args);
    assert.ok(denied, label);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, DENIED_CODE);
    assert.ok(denied.error.message.includes(label));
    assert.ok(denied.error.message.includes(capability));
  }
});

test('chat read and chat send are gated independently', () => {
  assert.deepEqual(requiredCapabilities(ALLOW_ALL, 'mc_chat', { read: true }), ['allowRead']);
  assert.deepEqual(requiredCapabilities(ALLOW_ALL, 'mc_chat', {}), ['allowRead']);
  assert.deepEqual(requiredCapabilities(ALLOW_ALL, 'mc_chat', { message: 'hi' }), ['allowChat']);

  const noChat = Object.assign({}, ALLOW_ALL, { allowChat: false });
  assert.equal(checkPolicy(noChat, 'mc_chat', { read: true }), null);
  assert.ok(checkPolicy(noChat, 'mc_chat', { message: 'hi' }));

  const noRead = Object.assign({}, ALLOW_ALL, { allowRead: false });
  assert.ok(checkPolicy(noRead, 'mc_chat', { read: true }));
  assert.equal(checkPolicy(noRead, 'mc_chat', { message: 'hi' }), null);
});

test('unknown tools are not blocked by policy (executor rejects them separately)', () => {
  assert.deepEqual(requiredCapabilities(ALLOW_ALL, 'mc_unknown', {}), []);
  assert.equal(checkPolicy(ALLOW_ALL, 'mc_unknown', {}), null);
});
