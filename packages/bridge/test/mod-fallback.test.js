'use strict';

// Integration contract test for the "v1 mod has no /action verb" fallback path.
// The real in-game mod only implements tp|give|setblock|summon|time|weather|gamemode|effect|kill
// on POST /action. The bridge must degrade move/mine/place/attack into /command instead of
// surfacing `unsupported_action` to the model.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { ModChannel } = require('../src/game/mod');

function startFakeV1Mod() {
  const commands = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const url = new URL(req.url, 'http://127.0.0.1');
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const auth = req.headers.authorization;
      if (auth !== 'Bearer test-token') return send(401, { ok: false, error: { code: 'unauthorized', message: 'no' } });

      if (url.pathname === '/health') return send(200, { ok: true, mod: 'netease_mc_link', mc: '1.21.8' });
      if (url.pathname === '/state') {
        return send(200, {
          ok: true,
          player: { name: 'iamcie', x: 0, y: 64, z: 0, yaw: 0, pitch: 0, health: 20 },
          world: { time: 1000, weather: 'clear' },
          players: [{ name: 'iamcie', x: 0, y: 64, z: 0 }]
        });
      }
      if (url.pathname === '/command') {
        commands.push(body.command);
        return send(200, { ok: true, command: body.command, output: ['ok'] });
      }
      if (url.pathname === '/action') {
        // v1 mod: only these verbs exist
        const allowed = new Set(['tp', 'give', 'setblock', 'summon', 'time', 'weather', 'gamemode', 'effect', 'kill']);
        if (!allowed.has(body.type)) {
          return send(400, {
            ok: false,
            error: {
              code: 'unsupported_action',
              message: `unsupported action type '${body.type}'; expected one of tp|give|setblock|summon|time|weather|gamemode|effect|kill`
            }
          });
        }
        return send(200, { ok: true, type: body.type, command: 'noop', output: [] });
      }
      if (url.pathname === '/chat' && req.method === 'GET') {
        return send(404, { ok: false, error: { code: 'not_found', message: 'unknown endpoint: /chat' } });
      }
      if (url.pathname === '/block') {
        return send(200, { ok: true, block: { id: 'minecraft:stone', properties: {}, solid: true }, blockEntity: null });
      }
      send(404, { ok: false, error: { code: 'not_found', message: `unknown endpoint: ${url.pathname}` } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        commands,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

function makeChannel(port) {
  const config = {
    mode: 'mod',
    mod: { url: `http://127.0.0.1:${port}`, token: '', timeoutMs: 3000 },
    policy: {
      allowRead: true,
      allowMove: true,
      allowWorldWrite: true,
      allowCommands: true,
      allowChat: true,
      allowAttack: true
    }
  };
  return new ModChannel(config, { env: { DSH_MC_TOKEN: 'test-token' } });
}

test('mc_move falls back to /tp when the v1 mod rejects the move verb', async () => {
  const fake = await startFakeV1Mod();
  try {
    const channel = makeChannel(fake.port);
    const result = await channel.mc_move({ x: 10, y: 65, z: -3 });
    assert.equal(result.ok, true);
    assert.equal(fake.commands.length, 1);
    assert.match(fake.commands[0], /^tp iamcie 10 65 -3$/);
  } finally {
    await fake.close();
  }
});

test('mc_mine falls back to /setblock air destroy', async () => {
  const fake = await startFakeV1Mod();
  try {
    const channel = makeChannel(fake.port);
    await channel.mc_mine({ x: 1, y: 64, z: 2 });
    assert.deepEqual(fake.commands, ['setblock 1 64 2 air destroy']);
  } finally {
    await fake.close();
  }
});

test('mc_place falls back to /setblock with an item id', async () => {
  const fake = await startFakeV1Mod();
  try {
    const channel = makeChannel(fake.port);
    await channel.mc_place({ x: 3, y: 64, z: 4, item: 'oak_planks' });
    assert.deepEqual(fake.commands, ['setblock 3 64 4 minecraft:oak_planks']);
  } finally {
    await fake.close();
  }
});

test('mc_attack falls back to /damage on the nearest non-player entity', async () => {
  const fake = await startFakeV1Mod();
  try {
    const channel = makeChannel(fake.port);
    await channel.mc_attack({ nearest: true });
    assert.equal(fake.commands.length, 1);
    assert.match(fake.commands[0], /^damage @e\[type=!player,limit=1,sort=nearest\]/);
  } finally {
    await fake.close();
  }
});

test('mc_use reports a structured unsupported_in_mod_mode error instead of faking success', async () => {
  const fake = await startFakeV1Mod();
  try {
    const channel = makeChannel(fake.port);
    await assert.rejects(() => channel.mc_use({ item: 'bread' }), (err) => {
      assert.equal(err.code, 'unsupported_in_mod_mode');
      assert.match(err.message, /mc_command|mode=bot/);
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('mc_chat read degrades to an empty list when the mod has no chat history endpoint', async () => {
  const fake = await startFakeV1Mod();
  try {
    const channel = makeChannel(fake.port);
    const result = await channel.mc_chat({ read: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.messages, []);
    assert.match(result.note || '', /history/);
  } finally {
    await fake.close();
  }
});
