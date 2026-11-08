'use strict';

const http = require('node:http');

const DEFAULT_TOKEN = 'test-token';

function positionDistance(state, x, y, z) {
  const dx = x - state.player.x;
  const dy = y - state.player.y;
  const dz = z - state.player.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function stripNamespace(name) {
  return typeof name === 'string' && name.startsWith('minecraft:') ? name.slice('minecraft:'.length) : name;
}

function createState() {
  return {
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
    world: { time: 6000, day: 3, weather: 'clear', difficulty: 'peaceful' },
    players: [
      { name: 'DeepSeek', x: 1, y: 64, z: 2, health: 20 },
      { name: 'Alex', x: 3, y: 64, z: 4, health: 20 }
    ],
    inventory: [{ slot: 36, name: 'minecraft:oak_planks', displayName: 'Oak Planks', count: 16, durability: null }],
    blocks: {
      '1,63,2': { id: 'minecraft:stone', properties: {}, solid: true },
      '3,63,2': { id: 'minecraft:oak_log', properties: { axis: 'y' }, solid: true }
    },
    entities: [{ id: 42, name: 'zombie', type: 'mob', x: 4, y: 64, z: 4 }],
    chat: [{ username: 'Alex', message: 'hi' }],
    calls: []
  };
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({ __invalidJson: text });
      }
    });
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function sendError(response, status, code, message) {
  sendJson(response, status, { ok: false, error: { code, message } });
}

/**
 * Mock of the in-game mod HTTP API (ARCHITECTURE.md §5) plus the extended
 * action types the bridge uses for the non-§5 tools.
 *
 * @param {{token?: string, override?: Function}} [opts]
 *   override(req, res, url, state) -> true when it handled the response.
 * @returns {Promise<{server: import('node:http').Server, port: number, url: string, token: string, state: object, close: Function}>}
 */
function startMockModServer(opts = {}) {
  const token = opts.token || DEFAULT_TOKEN;
  const state = createState();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = req.method === 'POST' ? await readBody(req) : null;
    state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });

    if (typeof opts.override === 'function' && opts.override(req, res, url, state)) return;

    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, mod: 'netease-mc-link 0.1.0', mc: '1.21.8', port: server.address().port });
      return;
    }

    const authorization = req.headers.authorization || '';
    const headerToken = req.headers['x-mc-token'];
    const authorized = authorization === `Bearer ${token}` || headerToken === token;
    if (!authorized) {
      sendError(res, 401, 'unauthorized', 'invalid or missing token');
      return;
    }

    if (url.pathname === '/state' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, player: state.player, world: state.world, players: state.players });
      return;
    }

    if (url.pathname === '/inventory' && req.method === 'GET') {
      const items = state.inventory.map((item) => Object.assign({}, item));
      if (url.searchParams.get('includeEmpty') === 'true') {
        items.push({ slot: 37, name: null, displayName: null, count: 0, durability: null });
      }
      // Real mod shape: both aliases carry the same array.
      sendJson(res, 200, { ok: true, inventory: items, slots: items });
      return;
    }

    if (url.pathname === '/block' && req.method === 'GET') {
      const x = Number(url.searchParams.get('x'));
      const y = Number(url.searchParams.get('y'));
      const z = Number(url.searchParams.get('z'));
      const info = state.blocks[`${x},${y},${z}`];
      if (!info) {
        sendError(res, 404, 'block_not_loaded', `block at ${x},${y},${z} is not loaded`);
        return;
      }
      // Real mod shape: {ok:true, block:{id,properties,solid}, blockEntity:null}
      sendJson(res, 200, {
        ok: true,
        block: { id: info.id, properties: info.properties, solid: info.solid },
        blockEntity: info.blockEntity || null
      });
      return;
    }

    if (url.pathname === '/blocks' && req.method === 'GET') {
      const radius = Number(url.searchParams.get('radius')) || 16;
      const limit = Number(url.searchParams.get('limit')) || 10;
      const wanted = url.searchParams.get('block');
      const blocks = Object.entries(state.blocks)
        .map(([key, info]) => {
          const [x, y, z] = key.split(',').map(Number);
          return { x, y, z, name: info.id, distance: positionDistance(state, x, y, z) };
        })
        .filter((entry) => entry.distance <= radius)
        .filter((entry) => !wanted || stripNamespace(entry.name) === stripNamespace(wanted))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit);
      sendJson(res, 200, { ok: true, blocks });
      return;
    }

    if (url.pathname === '/entities' && req.method === 'GET') {
      const radius = Number(url.searchParams.get('radius')) || 16;
      const limit = Number(url.searchParams.get('limit')) || 20;
      const type = url.searchParams.get('type');
      const entities = state.entities
        .map((entity) => ({
          id: entity.id,
          name: entity.name,
          type: entity.type,
          x: entity.x,
          y: entity.y,
          z: entity.z,
          distance: positionDistance(state, entity.x, entity.y, entity.z)
        }))
        .filter((entity) => entity.distance <= radius)
        .filter((entity) => !type || stripNamespace(entity.name) === stripNamespace(type) || entity.type === type)
        .slice(0, limit);
      sendJson(res, 200, { ok: true, entities });
      return;
    }

    if (url.pathname === '/chat' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit')) || 20;
      sendJson(res, 200, { ok: true, messages: state.chat.slice(-limit) });
      return;
    }

    if (url.pathname === '/chat' && req.method === 'POST') {
      state.chat.push({ username: state.player.name, message: String((body && body.message) || '') });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/command' && req.method === 'POST') {
      const command = String((body && body.command) || '');
      sendJson(res, 200, { ok: true, output: [`Executed: ${command}`] });
      return;
    }

    if (url.pathname === '/action' && req.method === 'POST') {
      const action = body || {};
      switch (action.type) {
        case 'move': {
          if (action.stop !== true) {
            if (Number.isFinite(action.x)) state.player.x = action.x;
            if (Number.isFinite(action.y)) state.player.y = action.y;
            if (Number.isFinite(action.z)) state.player.z = action.z;
          }
          sendJson(res, 200, { ok: true, player: Object.assign({}, state.player) });
          return;
        }
        case 'mine': {
          const x = Number.isFinite(action.x) ? action.x : 1;
          const y = Number.isFinite(action.y) ? action.y : 63;
          const z = Number.isFinite(action.z) ? action.z : 2;
          const key = `${x},${y},${z}`;
          const info = state.blocks[key];
          const name = info ? info.id : 'minecraft:grass_block';
          delete state.blocks[key];
          sendJson(res, 200, { ok: true, mined: [{ x, y, z, name }], count: Number.isFinite(action.count) ? action.count : 1 });
          return;
        }
        case 'place': {
          const x = action.x;
          const y = action.y;
          const z = action.z;
          const item = action.item ? (stripNamespace(action.item) === action.item ? `minecraft:${action.item}` : action.item) : 'minecraft:oak_planks';
          state.blocks[`${x},${y},${z}`] = { id: item, properties: {}, solid: true };
          sendJson(res, 200, { ok: true, placed: { x, y, z, name: item } });
          return;
        }
        case 'use': {
          sendJson(res, 200, { ok: true, item: action.item || 'minecraft:golden_apple', offhand: action.offhand === true, action: 'use' });
          return;
        }
        case 'attack': {
          sendJson(res, 200, { ok: true, entity: { id: Number.isFinite(action.entityId) ? action.entityId : 42, name: 'zombie' } });
          return;
        }
        default:
          sendError(res, 400, 'unsupported_action', `unsupported action type "${action.type}"`);
      }
      return;
    }

    sendError(res, 404, 'not_found', `unknown route ${req.method} ${url.pathname}`);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        token,
        state,
        close() {
          return new Promise((done) => {
            try {
              server.closeAllConnections();
            } catch {
              /* older node */
            }
            server.close(() => done());
          });
        }
      });
    });
  });
}

module.exports = { startMockModServer, createState, DEFAULT_TOKEN };
