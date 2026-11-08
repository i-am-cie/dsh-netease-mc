'use strict';

/**
 * Canonical tool result shapes (ARCHITECTURE.md §4).
 *
 * Both transports (game/bot.js and game/mod.js) MUST build their results with
 * these helpers so the MCP tools return exactly the same structure regardless
 * of the underlying channel. Do not construct ad-hoc result objects elsewhere.
 */

const MC_NAMESPACE = 'minecraft:';

function stripNamespace(name) {
  if (typeof name !== 'string') return name;
  return name.startsWith(MC_NAMESPACE) ? name.slice(MC_NAMESPACE.length) : name;
}

function withNamespace(name) {
  if (typeof name !== 'string' || !name) return name;
  return name.startsWith(MC_NAMESPACE) ? name : MC_NAMESPACE + name;
}

function round(value, precision = 3) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? round(value) : null;
}

function str(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function bool(value) {
  return typeof value === 'boolean' ? value : null;
}

function vec(position) {
  if (!position || typeof position !== 'object') return { x: null, y: null, z: null };
  return { x: num(position.x), y: num(position.y), z: num(position.z) };
}

function distance(a, b) {
  if (!a || !b) return null;
  const dx = (a.x || 0) - (b.x || 0);
  const dy = (a.y || 0) - (b.y || 0);
  const dz = (a.z || 0) - (b.z || 0);
  return round(Math.sqrt(dx * dx + dy * dy + dz * dz));
}

function normalisePolicy(policy) {
  const source = policy || {};
  const out = {};
  for (const key of [
    'allowRead',
    'allowMove',
    'allowWorldWrite',
    'allowCommands',
    'allowChat',
    'allowAttack'
  ]) {
    out[key] = source[key] !== false;
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Result builders                                                           */
/* ------------------------------------------------------------------------- */

/**
 * @param {object} input
 * @param {'bot'|'mod'} input.mode
 * @param {boolean} input.connected
 * @param {{host?:string|null,port?:number|null,version?:string|null}|null} input.server
 * @param {{url?:string|null,version?:string|null,mc?:string|null}|null} input.mod
 * @param {{name?:string|null}|null} input.player
 * @param {object} input.policy
 * @param {number} input.uptimeMs
 * @param {string|null} [input.lastError]
 */
function status({ mode, connected, server, mod, player, policy, uptimeMs, lastError }) {
  return {
    ok: true,
    mode: mode === 'mod' ? 'mod' : 'bot',
    connected: connected === true,
    server: server
      ? { host: str(server.host), port: num(server.port), version: str(server.version) }
      : null,
    mod: mod
      ? { url: str(mod.url), version: str(mod.version), mc: str(mod.mc) }
      : null,
    player: player ? { name: str(player.name) } : null,
    policy: normalisePolicy(policy),
    uptimeMs: typeof uptimeMs === 'number' && Number.isFinite(uptimeMs) ? Math.max(0, Math.round(uptimeMs)) : 0,
    lastError: str(lastError)
  };
}

/**
 * @param {object} input
 * @param {object} input.player raw player fields
 * @param {object} input.world raw world fields
 */
function state({ player, world }) {
  const p = player || {};
  const w = world || {};
  return {
    ok: true,
    player: {
      name: str(p.name),
      uuid: str(p.uuid),
      x: num(p.x),
      y: num(p.y),
      z: num(p.z),
      yaw: num(p.yaw),
      pitch: num(p.pitch),
      health: num(p.health),
      food: num(p.food),
      gamemode: str(p.gamemode),
      dimension: str(p.dimension),
      level: num(p.level),
      exp: num(p.exp)
    },
    world: {
      time: num(w.time),
      day: num(w.day),
      weather: str(w.weather),
      difficulty: str(w.difficulty)
    }
  };
}

function players(list) {
  const entries = (Array.isArray(list) ? list : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      name: str(entry.name),
      x: num(entry.x),
      y: num(entry.y),
      z: num(entry.z),
      health: num(entry.health)
    }))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return { ok: true, players: entries, count: entries.length };
}

function inventory(items) {
  const entries = (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const name = stripNamespace(str(item.name));
      return {
        slot: typeof item.slot === 'number' && Number.isFinite(item.slot) ? Math.trunc(item.slot) : null,
        name: name || null,
        displayName: str(item.displayName) || name || null,
        count: typeof item.count === 'number' && Number.isFinite(item.count) ? Math.trunc(item.count) : null,
        durability: num(item.durability)
      };
    })
    .sort((a, b) => (a.slot === null ? -1 : a.slot) - (b.slot === null ? -1 : b.slot) || String(a.name || '').localeCompare(String(b.name || '')));
  return { ok: true, items: entries, count: entries.length };
}

function entities(list) {
  const entries = (Array.isArray(list) ? list : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: typeof entry.id === 'number' && Number.isFinite(entry.id) ? Math.trunc(entry.id) : null,
      name: stripNamespace(str(entry.name)) || null,
      type: str(entry.type),
      x: num(entry.x),
      y: num(entry.y),
      z: num(entry.z),
      distance: num(entry.distance)
    }))
    .sort((a, b) => (a.distance === null ? Infinity : a.distance) - (b.distance === null ? Infinity : b.distance) || (a.id || 0) - (b.id || 0));
  return { ok: true, entities: entries, count: entries.length };
}

function blocks(list) {
  const entries = (Array.isArray(list) ? list : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      x: num(entry.x),
      y: num(entry.y),
      z: num(entry.z),
      name: stripNamespace(str(entry.name)) || null,
      distance: num(entry.distance)
    }))
    .sort((a, b) => (a.distance === null ? Infinity : a.distance) - (b.distance === null ? Infinity : b.distance));
  return { ok: true, blocks: entries, count: entries.length };
}

function block(info) {
  const b = info || {};
  const name = stripNamespace(str(b.name)) || null;
  return {
    ok: true,
    block: {
      x: num(b.x),
      y: num(b.y),
      z: num(b.z),
      name,
      displayName: stripNamespace(str(b.displayName)) || name,
      properties: b.properties && typeof b.properties === 'object' && !Array.isArray(b.properties) ? b.properties : {},
      solid: bool(b.solid),
      blockEntity: b.blockEntity && typeof b.blockEntity === 'object' ? b.blockEntity : null
    }
  };
}

function move({ from, to, target }) {
  const fromVec = vec(from);
  const toVec = vec(to);
  return {
    ok: true,
    moved: {
      from: fromVec,
      to: toVec,
      distance: distance(fromVec, toVec)
    },
    target: target ? vec(target) : null
  };
}

function mine({ mined, count }) {
  const entries = (Array.isArray(mined) ? mined : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      x: num(entry.x),
      y: num(entry.y),
      z: num(entry.z),
      name: stripNamespace(str(entry.name)) || null
    }));
  return {
    ok: true,
    mined: entries,
    count: typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : entries.length
  };
}

function place({ placed, item }) {
  const p = placed || {};
  return {
    ok: true,
    placed: { x: num(p.x), y: num(p.y), z: num(p.z), name: stripNamespace(str(p.name)) || null },
    item: stripNamespace(str(item)) || null
  };
}

function use({ item, offhand, action }) {
  return {
    ok: true,
    used: {
      item: stripNamespace(str(item)) || null,
      offhand: offhand === true,
      action: str(action) || 'use'
    }
  };
}

function attack({ entity }) {
  const e = entity || {};
  return {
    ok: true,
    attacked: {
      id: typeof e.id === 'number' && Number.isFinite(e.id) ? Math.trunc(e.id) : null,
      name: stripNamespace(str(e.name)) || null
    }
  };
}

function chatSent({ message }) {
  return { ok: true, sent: true, message: str(message) };
}

function chatMessages(list) {
  const entries = (Array.isArray(list) ? list : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      username: str(entry.username),
      message: typeof entry.message === 'string' ? entry.message : String(entry.message ?? '')
    }));
  return { ok: true, messages: entries, count: entries.length };
}

function command({ command: cmd, output }) {
  let entries = [];
  if (Array.isArray(output)) entries = output.map((line) => String(line));
  else if (typeof output === 'string' && output !== '') entries = [output];
  return { ok: true, command: str(cmd), output: entries };
}

module.exports = {
  MC_NAMESPACE,
  stripNamespace,
  withNamespace,
  round,
  num,
  str,
  distance,
  status,
  state,
  players,
  inventory,
  entities,
  blocks,
  block,
  move,
  mine,
  place,
  use,
  attack,
  chatSent,
  chatMessages,
  command
};
