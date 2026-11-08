'use strict';

const { ToolError } = require('../errors');
const normalize = require('../normalize');

const TICK_MS = 50;
const DEFAULT_CONNECT_TIMEOUT_MS = 20000;
const MAX_CHAT_HISTORY = 200;
const MAX_MOVE_TIMEOUT_MS = 120000;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

function isAirLike(name) {
  return typeof name === 'string' && (name === 'air' || name.endsWith('_air') || name === 'cave_air' || name === 'void_air');
}

function isReplaceable(name) {
  return isAirLike(name) || name === 'water' || name === 'lava' || name === 'short_grass' || name === 'grass';
}

function radToDeg(radians) {
  return typeof radians === 'number' && Number.isFinite(radians) ? (radians * 180) / Math.PI : null;
}

function classifyBotError(err) {
  const message = String((err && err.message) || err || '');
  const code = String((err && err.code) || '');
  if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package) '?mineflayer/i.test(message)) {
    return 'mineflayer_missing';
  }
  if (/timed out|timeout|ETIMEDOUT/i.test(message)) return 'connect_timeout';
  if (/ECONNREFUSED/i.test(message)) return 'connection_refused';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return 'host_not_found';
  if (/ECONNRESET|socket closed|end of stream|network is unreachable/i.test(message)) return 'connection_lost';
  if (/unsupported version|version/i.test(message)) return 'unsupported_version';
  return 'bot_error';
}

function waitForSpawn(bot, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bot.removeListener('spawn', onSpawn);
      bot.removeListener('error', onError);
      bot.removeListener('kicked', onKicked);
      fn(value);
    };
    const onSpawn = () => finish(resolve, true);
    const onError = (err) => finish(reject, new ToolError(classifyBotError(err), `bot connection failed: ${err.message}`));
    const onKicked = (reason) => finish(reject, new ToolError('kicked', `bot was kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`));
    const timer = setTimeout(
      () => finish(reject, new ToolError('connect_timeout', `bot did not spawn within ${timeoutMs}ms`)),
      Math.max(1000, timeoutMs)
    );
    if (timer.unref) timer.unref();
    bot.once('spawn', onSpawn);
    bot.once('error', onError);
    bot.once('kicked', onKicked);
  });
}

/**
 * Channel A — mineflayer player bot (ARCHITECTURE.md §2/§4).
 *
 * mineflayer is imported lazily and only from `_connect()`, so `mode=mod`
 * works on a machine where `node_modules` was never installed.
 */
class BotChannel {
  constructor(config, { logger, env = process.env } = {}) {
    this.config = config || {};
    this.botCfg = this.config.bot || {};
    this.logger = logger;
    this.env = env;
    this.bot = null;
    this.connected = false;
    this.connecting = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.closed = false;
    this.lastError = null;
    this.startedAt = Date.now();
    this.chatLog = [];
    this.mineflayer = null;
  }

  get name() {
    return 'bot';
  }

  /* --------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* --------------------------------------------------------------------- */

  async loadMineflayer() {
    if (this.mineflayer) return this.mineflayer;
    try {
      const imported = await import('mineflayer');
      this.mineflayer = imported && imported.default ? imported.default : imported;
    } catch (err) {
      throw new ToolError(
        'mineflayer_missing',
        `mineflayer is not installed (or failed to load) but mode=bot needs it: ${err.message}. Run "npm install" inside packages/bridge, or switch to mode=mod.`
      );
    }
    return this.mineflayer;
  }

  /** Kick off a background connection attempt (used by mc_status, never throws). */
  startConnect() {
    if (this.closed || this.connected || this.connecting || this.bot) return;
    this.connecting = this._connect()
      .catch(() => {
        /* lastError and reconnect scheduling are handled in _connect */
      })
      .finally(() => {
        this.connecting = null;
      });
  }

  /** Wait for a working connection (bounded); connection attempts continue in the background. */
  async ensureConnected({ waitMs = 8000 } = {}) {
    if (this.connected) return;
    this.startConnect();
    const deadline = Date.now() + Math.max(0, waitMs);
    while (Date.now() < deadline) {
      if (this.connected) return;
      await sleep(100);
    }
    if (this.connected) return;
    throw new ToolError(
      'bot_not_connected',
      this.lastError
        ? `bot is not connected: ${this.lastError}`
        : 'bot is still connecting; call mc_status and retry shortly'
    );
  }

  async _connect() {
    let mineflayer;
    try {
      mineflayer = await this.loadMineflayer();
    } catch (err) {
      this.lastError = `${(err && err.code) || 'mineflayer_missing'}: ${err.message}`;
      throw err;
    }
    const cfg = this.botCfg;
    const port = Number(cfg.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.lastError = 'invalid_config: bot.port must be a TCP port between 1 and 65535';
      throw new ToolError('invalid_config', 'bot.port must be a TCP port between 1 and 65535 (mode=bot)');
    }
    const connectTimeoutMs = Number.isFinite(Number(cfg.connectTimeoutMs))
      ? Number(cfg.connectTimeoutMs)
      : DEFAULT_CONNECT_TIMEOUT_MS;

    this.logger && this.logger.info('bot connecting', {
      host: cfg.host || '127.0.0.1',
      port,
      username: cfg.username || 'DeepSeek',
      version: cfg.version || null
    });

    let bot;
    try {
      bot = mineflayer.createBot({
        host: cfg.host || '127.0.0.1',
        port,
        username: cfg.username || 'DeepSeek',
        auth: cfg.auth || 'offline',
        version: cfg.version || false,
        hideErrors: true,
        checkTimeoutInterval: 60000
      });
    } catch (err) {
      this.lastError = `${classifyBotError(err)}: ${err.message}`;
      throw new ToolError(classifyBotError(err), `failed to create bot: ${err.message}`);
    }

    this.bot = bot;
    bot.on('error', (err) => {
      const code = classifyBotError(err);
      this.lastError = `${code}: ${err.message}`;
      this.logger && this.logger.warn('bot error', { code, message: String(err.message) });
    });
    bot.on('kicked', (reason) => {
      const message = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this.connected = false;
      this.lastError = `kicked: ${message}`;
      this.logger && this.logger.warn('bot kicked', { reason: message });
    });
    bot.on('end', (reason) => {
      this.connected = false;
      if (!this.closed) {
        this.logger && this.logger.warn('bot disconnected', { reason: String(reason || '') });
        this._scheduleReconnect();
      }
    });
    bot.on('chat', (username, message) => {
      this.chatLog.push({ username: String(username), message: String(message) });
      if (this.chatLog.length > MAX_CHAT_HISTORY) this.chatLog.splice(0, this.chatLog.length - MAX_CHAT_HISTORY);
    });
    bot.on('death', () => {
      this.logger && this.logger.warn('bot died');
    });
    bot.once('spawn', () => {
      this.connected = true;
      this.lastError = null;
      this.reconnectAttempt = 0;
      const position = bot.entity && bot.entity.position ? bot.entity.position : null;
      this.logger && this.logger.info('bot spawned', {
        username: bot.username,
        position: position ? { x: normalize.round(position.x), y: normalize.round(position.y), z: normalize.round(position.z) } : null
      });
    });

    try {
      await waitForSpawn(bot, connectTimeoutMs);
    } catch (err) {
      this.connected = false;
      this.lastError = `${err.code || 'bot_error'}: ${err.message}`;
      try {
        if (typeof bot.quit === 'function') bot.quit();
        else if (typeof bot.end === 'function') bot.end();
      } catch {
        /* the socket may already be gone */
      }
      this._cleanupBotTimers(bot);
      if (this.bot === bot) this.bot = null;
      if (err.code !== 'mineflayer_missing') this._scheduleReconnect();
      throw err instanceof ToolError ? err : new ToolError(classifyBotError(err), err.message);
    }
  }

  _scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const attempt = this.reconnectAttempt;
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 10);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    this.logger && this.logger.info('bot reconnect scheduled', { attempt, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startConnect();
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  async close() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const bot = this.bot;
    this.bot = null;
    this.connected = false;
    if (bot) {
      try {
        if (typeof bot.quit === 'function') bot.quit();
        else if (typeof bot.end === 'function') bot.end();
      } catch {
        /* already gone */
      }
      this._cleanupBotTimers(bot);
    }
  }

  /**
   * minecraft-protocol sets a 30s "close safety" timer on Client#end(); when the
   * socket already closed (e.g. ECONNREFUSED while connecting) that timer is
   * never cleared and would keep the bridge process alive for 30s. Clear it.
   */
  _cleanupBotTimers(bot) {
    const client = bot && (bot._client || bot.client);
    if (!client) return;
    if (client.closeTimer) {
      clearTimeout(client.closeTimer);
      client.closeTimer = null;
    }
    try {
      if (client.ended && client.socket && typeof client.socket.destroy === 'function') {
        client.socket.destroy();
      }
    } catch {
      /* ignore */
    }
  }

  requireBot() {
    if (!this.bot || !this.connected) {
      throw new ToolError(
        'bot_not_connected',
        this.lastError ? `bot is not connected: ${this.lastError}` : 'bot is not connected'
      );
    }
    return this.bot;
  }

  /* --------------------------------------------------------------------- */
  /* Small helpers                                                          */
  /* --------------------------------------------------------------------- */

  /** Build a Vec3 for arbitrary coordinates using the bot's own Vec3 class. */
  vec(x, y, z) {
    const bot = this.requireBot();
    const base = bot.entity && bot.entity.position ? bot.entity.position : null;
    if (!base || typeof base.clone !== 'function') return { x, y, z };
    const v = base.clone();
    v.x = x;
    v.y = y;
    v.z = z;
    return v;
  }

  positionOf(entity) {
    const position = entity && entity.position ? entity.position : null;
    return position ? { x: position.x, y: position.y, z: position.z } : { x: null, y: null, z: null };
  }

  stopMovement() {
    const bot = this.bot;
    if (!bot || typeof bot.setControlState !== 'function') return;
    for (const state of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
      try {
        bot.setControlState(state, false);
      } catch {
        /* ignore */
      }
    }
  }

  /** Minecraft yaw for a horizontal direction (0 = +Z / south). */
  yawTowards(dx, dz) {
    return Math.atan2(-dx, dz);
  }

  /**
   * Walk (pathfind-like, no extra dependency) to an absolute position.
   * Stops when within `stopDistance` horizontally and 1.5 blocks vertically.
   */
  async walkTo(target, { timeoutMs = 30000, stopDistance = 0.6 } = {}) {
    const bot = this.requireBot();
    const timeout = Math.max(1000, Math.min(MAX_MOVE_TIMEOUT_MS, Number(timeoutMs) || 30000));
    const deadline = Date.now() + timeout;
    const current = bot.entity.position;
    const targetVec = this.vec(
      Number.isFinite(target.x) ? target.x : current.x,
      Number.isFinite(target.y) ? target.y : current.y,
      Number.isFinite(target.z) ? target.z : current.z
    );
    let lastPos = current.clone();
    let lastProgressAt = Date.now();
    let stuck = 0;

    try {
      while (Date.now() < deadline) {
        if (!this.connected) throw new ToolError('bot_not_connected', 'bot disconnected while moving');
        const pos = bot.entity.position;
        const horizontal = Math.hypot(targetVec.x - pos.x, targetVec.z - pos.z);
        const vertical = targetVec.y - pos.y;
        if (horizontal <= stopDistance && Math.abs(vertical) <= 1.5) {
          return { x: pos.x, y: pos.y, z: pos.z };
        }

        if (typeof bot.lookAt === 'function') {
          await bot.lookAt(targetVec, true).catch(() => {});
        }
        bot.setControlState('forward', true);
        bot.setControlState('sprint', horizontal > 6);

        const moved = pos.distanceTo(lastPos) > 0.03;
        if (moved) {
          lastPos = pos.clone();
          lastProgressAt = Date.now();
          stuck = 0;
        } else if (Date.now() - lastProgressAt > 400) {
          // Blocked by terrain: jump and strafe around the obstacle.
          stuck += 1;
          if (bot.entity.onGround) bot.setControlState('jump', true);
          if (stuck % 3 === 1) bot.setControlState('left', true);
          else if (stuck % 3 === 2) bot.setControlState('right', true);
          await sleep(250);
          bot.setControlState('jump', false);
          bot.setControlState('left', false);
          bot.setControlState('right', false);
          lastProgressAt = Date.now();
        }
        await sleep(TICK_MS);
      }
      throw new ToolError(
        'timeout',
        `move timed out after ${timeout}ms (target ${normalize.round(target.x)}, ${normalize.round(target.y)}, ${normalize.round(target.z)})`
      );
    } finally {
      this.stopMovement();
    }
  }

  async withTimeout(promise, ms, code, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ToolError(code, message)), ms);
      if (timer.unref) timer.unref();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /* --------------------------------------------------------------------- */
  /* Tools                                                                  */
  /* --------------------------------------------------------------------- */

  async mc_status() {
    // Non-blocking: kick off a connection attempt but report current state.
    this.startConnect();
    const cfg = this.botCfg;
    return normalize.status({
      mode: 'bot',
      connected: this.connected,
      server: {
        host: cfg.host || '127.0.0.1',
        port: Number.isFinite(Number(cfg.port)) ? Number(cfg.port) : null,
        version: this.bot ? this.bot.version : cfg.version || null
      },
      mod: null,
      player: this.bot && this.bot.username ? { name: this.bot.username } : null,
      policy: this.config.policy,
      uptimeMs: Date.now() - this.startedAt,
      lastError: this.lastError
    });
  }

  async mc_state() {
    const bot = this.requireBot();
    const entity = bot.entity || {};
    const position = entity.position || {};
    const game = bot.game || {};
    const experience = bot.experience || {};
    const time = bot.time || {};
    let weather = 'clear';
    if (bot.thunderState > 0) weather = 'thunder';
    else if (bot.isRaining) weather = 'rain';

    return normalize.state({
      player: {
        name: bot.username || null,
        uuid: (bot.player && bot.player.uuid) || null,
        x: position.x,
        y: position.y,
        z: position.z,
        yaw: radToDeg(entity.yaw),
        pitch: radToDeg(entity.pitch),
        health: bot.health,
        food: bot.food,
        gamemode: game.gameMode || null,
        dimension: game.dimension || null,
        level: experience.level,
        exp: experience.progress
      },
      world: {
        time: time.timeOfDay,
        day: time.day,
        weather,
        difficulty: game.difficulty || null
      }
    });
  }

  async mc_players() {
    const bot = this.requireBot();
    const list = [];
    for (const [name, player] of Object.entries(bot.players || {})) {
      const entity = player && player.entity ? player.entity : null;
      const position = entity && entity.position ? entity.position : null;
      list.push({
        name,
        x: position ? position.x : null,
        y: position ? position.y : null,
        z: position ? position.z : null,
        health: entity && Number.isFinite(entity.health) ? entity.health : null
      });
    }
    return normalize.players(list);
  }

  itemToCanonical(item) {
    let durability = null;
    if (item && Number.isFinite(item.maxDurability) && item.maxDurability > 0) {
      durability = item.maxDurability - (Number.isFinite(item.durabilityUsed) ? item.durabilityUsed : 0);
    }
    return {
      slot: item.slot,
      name: item.name,
      displayName: item.displayName || item.name,
      count: item.count,
      durability
    };
  }

  async mc_inventory(args = {}) {
    const bot = this.requireBot();
    if (!bot.inventory || typeof bot.inventory.items !== 'function') {
      throw new ToolError('inventory_unavailable', 'inventory is not loaded yet; try again after spawn');
    }
    const items = bot.inventory.items().map((item) => this.itemToCanonical(item));
    if (args.includeEmpty === true) {
      const used = new Set(items.map((item) => item.slot));
      // Player inventory window slots: main inventory 9..35, hotbar 36..44.
      for (let slot = 9; slot <= 44; slot += 1) {
        if (!used.has(slot)) {
          items.push({ slot, name: null, displayName: null, count: 0, durability: null });
        }
      }
    }
    return normalize.inventory(items);
  }

  async mc_nearby_entities(args = {}) {
    const bot = this.requireBot();
    const position = bot.entity && bot.entity.position ? bot.entity.position : null;
    if (!position) throw new ToolError('bot_not_ready', 'player entity is not available yet');
    const radius = Number.isFinite(args.radius) ? Math.min(128, Math.max(1, args.radius)) : 16;
    const limit = Number.isFinite(args.limit) ? Math.min(100, Math.max(1, Math.trunc(args.limit))) : 20;
    const typeFilter = args.type ? normalize.stripNamespace(String(args.type)) : null;
    const selfId = bot.entity.id;
    const list = [];
    for (const entity of Object.values(bot.entities || {})) {
      if (!entity || entity === bot.entity || entity.id === selfId || !entity.position) continue;
      const distance = position.distanceTo(entity.position);
      if (!(distance <= radius)) continue;
      const type = entity.type || null;
      const name = entity.name || entity.username || null;
      if (typeFilter && normalize.stripNamespace(String(type)) !== typeFilter && normalize.stripNamespace(String(name)) !== typeFilter) {
        continue;
      }
      list.push({
        id: entity.id,
        name,
        type,
        x: entity.position.x,
        y: entity.position.y,
        z: entity.position.z,
        distance
      });
    }
    list.sort((a, b) => a.distance - b.distance);
    return normalize.entities(list.slice(0, limit));
  }

  async mc_nearby_blocks(args = {}) {
    const bot = this.requireBot();
    const position = bot.entity && bot.entity.position ? bot.entity.position : null;
    if (!position || typeof bot.findBlocks !== 'function') {
      throw new ToolError('bot_not_ready', 'world is not loaded yet');
    }
    const radius = Number.isFinite(args.radius) ? Math.min(128, Math.max(1, args.radius)) : 16;
    const limit = Number.isFinite(args.limit) ? Math.min(100, Math.max(1, Math.trunc(args.limit))) : 10;
    const wanted = args.block ? normalize.stripNamespace(String(args.block)) : null;
    const matching = (candidate) => {
      if (!candidate || !candidate.name) return false;
      const name = normalize.stripNamespace(candidate.name);
      if (wanted !== null) return name === wanted;
      return !isAirLike(name);
    };
    const positions = bot.findBlocks({ point: position, matching, maxDistance: radius, count: limit });
    const list = [];
    for (const blockPosition of positions) {
      const block = bot.blockAt(blockPosition);
      if (!block) continue;
      list.push({
        x: block.position.x,
        y: block.position.y,
        z: block.position.z,
        name: block.name,
        distance: position.distanceTo(block.position)
      });
    }
    list.sort((a, b) => a.distance - b.distance);
    return normalize.blocks(list.slice(0, limit));
  }

  async mc_block(args = {}) {
    const bot = this.requireBot();
    const { x, y, z } = args;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new ToolError('invalid_arguments', 'mc_block requires numeric x, y and z');
    }
    const block = bot.blockAt(this.vec(x, y, z));
    if (!block) throw new ToolError('block_not_loaded', `block at (${x}, ${y}, ${z}) is not loaded`);
    return normalize.block({
      x: block.position.x,
      y: block.position.y,
      z: block.position.z,
      name: block.name,
      displayName: block.displayName || block.name,
      properties: typeof block.getProperties === 'function' ? block.getProperties() : {},
      solid: block.boundingBox === 'block',
      blockEntity: block.blockEntity && typeof block.blockEntity === 'object' ? block.blockEntity : null
    });
  }

  async mc_move(args = {}) {
    const bot = this.requireBot();
    const from = this.positionOf(bot.entity);
    const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.min(MAX_MOVE_TIMEOUT_MS, args.timeoutMs) : 30000;

    if (args.stop === true) {
      this.stopMovement();
      return normalize.move({ from, to: this.positionOf(bot.entity), target: null });
    }

    let target = null;

    if (args.player) {
      const name = String(args.player);
      const teammate = bot.players && bot.players[name];
      const entity = teammate && teammate.entity ? teammate.entity : null;
      if (!entity || !entity.position) {
        throw new ToolError('player_not_found', `player "${name}" is not visible or online`);
      }
      target = this.positionOf(entity);
      await this.walkTo(entity.position, { timeoutMs, stopDistance: 2 });
    } else if (Number.isFinite(args.x) || Number.isFinite(args.z)) {
      const current = bot.entity.position;
      const x = Number.isFinite(args.x) ? args.x : current.x;
      const y = Number.isFinite(args.y) ? args.y : current.y;
      const z = Number.isFinite(args.z) ? args.z : current.z;
      target = { x, y, z };
      await this.walkTo(target, { timeoutMs });
    } else if (args.lookAt) {
      const { x, y, z } = args.lookAt;
      const point = this.vec(x, y, z);
      if (typeof bot.lookAt === 'function') await bot.lookAt(point, true);
      target = { x, y, z };
    } else {
      throw new ToolError(
        'invalid_arguments',
        'mc_move needs coordinates (x/z), a player name, lookAt, or stop=true'
      );
    }

    return normalize.move({ from, to: this.positionOf(bot.entity), target });
  }

  isMineableBlock(block) {
    return !!block && !isAirLike(block.name) && block.name !== 'bedrock' && block.name !== 'barrier';
  }

  findNearestBlock(name, radius = 32, exclude = new Set()) {
    const bot = this.requireBot();
    const position = bot.entity.position;
    const matching = (candidate) => {
      if (!candidate || !candidate.name) return false;
      return normalize.stripNamespace(candidate.name) === name;
    };
    const positions = bot.findBlocks({ point: position, matching, maxDistance: radius, count: 64 });
    const scored = positions
      .map((blockPosition) => ({ blockPosition, distance: position.distanceTo(blockPosition) }))
      .sort((a, b) => a.distance - b.distance);
    for (const entry of scored) {
      const key = `${entry.blockPosition.x},${entry.blockPosition.y},${entry.blockPosition.z}`;
      if (exclude.has(key)) continue;
      return bot.blockAt(entry.blockPosition);
    }
    return null;
  }

  async mineBlock(block) {
    const bot = this.requireBot();
    const name = block.name;
    const position = block.position;
    const distance = bot.entity.position.distanceTo(position);
    if (distance > 4.2) {
      await this.walkTo({ x: position.x + 0.5, y: position.y, z: position.z + 0.5 }, { timeoutMs: 20000, stopDistance: 2.5 });
    }
    const fresh = bot.blockAt(position);
    if (!fresh || isAirLike(fresh.name)) throw new ToolError('block_not_found', `block at (${position.x}, ${position.y}, ${position.z}) is already gone`);
    if (fresh.name === 'bedrock' || fresh.name === 'barrier') {
      throw new ToolError('block_unbreakable', `block ${fresh.name} cannot be mined`);
    }
    await bot.lookAt(this.vec(position.x + 0.5, position.y + 0.5, position.z + 0.5), true).catch(() => {});
    try {
      await this.withTimeout(bot.dig(fresh, true), 25000, 'mine_timeout', `mining ${fresh.name} at (${position.x}, ${position.y}, ${position.z}) timed out`);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      // The server may have already removed the block (lag / another player).
      const after = bot.blockAt(position);
      if (after && isAirLike(after.name)) {
        return { x: position.x, y: position.y, z: position.z, name };
      }
      throw new ToolError('mine_failed', `failed to mine ${name}: ${err.message}`);
    }
    return { x: position.x, y: position.y, z: position.z, name: fresh.name || name };
  }

  async mc_mine(args = {}) {
    const bot = this.requireBot();
    const hasCoords = Number.isFinite(args.x) && Number.isFinite(args.y) && Number.isFinite(args.z);
    if (!hasCoords && !args.block) {
      throw new ToolError('invalid_arguments', 'mc_mine needs x/y/z coordinates or a block name');
    }
    const count = Number.isFinite(args.count) ? Math.min(64, Math.max(1, Math.trunc(args.count))) : 1;
    const mined = [];

    if (hasCoords) {
      const block = bot.blockAt(this.vec(args.x, args.y, args.z));
      if (!block) throw new ToolError('block_not_loaded', `block at (${args.x}, ${args.y}, ${args.z}) is not loaded`);
      if (isAirLike(block.name)) throw new ToolError('block_not_found', `block at (${args.x}, ${args.y}, ${args.z}) is already air`);
      mined.push(await this.mineBlock(block));
    } else {
      const wanted = normalize.stripNamespace(String(args.block));
      const exclude = new Set();
      for (let index = 0; index < count; index += 1) {
        const block = this.findNearestBlock(wanted, 32, exclude);
        if (!block) {
          if (index === 0) throw new ToolError('block_not_found', `no "${wanted}" block found within 32 blocks`);
          break;
        }
        exclude.add(`${block.position.x},${block.position.y},${block.position.z}`);
        mined.push(await this.mineBlock(block));
      }
    }

    return normalize.mine({ mined });
  }

  async mc_place(args = {}) {
    const bot = this.requireBot();
    const { x, y, z } = args;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new ToolError('invalid_arguments', 'mc_place requires numeric x, y and z');
    }
    const target = bot.blockAt(this.vec(x, y, z));
    if (!target) throw new ToolError('block_not_loaded', `block at (${x}, ${y}, ${z}) is not loaded`);
    if (!isReplaceable(target.name)) {
      throw new ToolError('target_occupied', `block at (${x}, ${y}, ${z}) is already ${target.name}`);
    }

    const offsets = [
      [0, -1, 0],
      [0, 1, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1]
    ];
    let reference = null;
    let referenceOffset = null;
    for (const offset of offsets) {
      const neighbour = bot.blockAt(this.vec(x + offset[0], y + offset[1], z + offset[2]));
      if (neighbour && neighbour.boundingBox === 'block') {
        reference = neighbour;
        referenceOffset = offset;
        break;
      }
    }
    if (!reference) throw new ToolError('no_place_support', `no solid neighbour block around (${x}, ${y}, ${z}) to place against`);

    const distance = bot.entity.position.distanceTo(reference.position);
    if (distance > 4.2) {
      await this.walkTo({ x: x + 0.5, y, z: z + 0.5 }, { timeoutMs: 20000, stopDistance: 3 });
    }

    let itemName = args.item ? normalize.stripNamespace(String(args.item)) : null;
    let item = null;
    if (itemName) {
      item = bot.inventory.items().find((candidate) => normalize.stripNamespace(candidate.name) === itemName);
      if (!item) throw new ToolError('item_not_found', `item "${itemName}" is not in the inventory`);
    } else {
      item = bot.heldItem || null;
      if (!item) throw new ToolError('item_not_found', 'nothing is held in the hand; pass item explicitly');
    }
    await bot.equip(item, 'hand');

    const faceVec = this.vec(-referenceOffset[0], -referenceOffset[1], -referenceOffset[2]);
    try {
      await this.withTimeout(
        bot.placeBlock(reference, faceVec),
        10000,
        'place_timeout',
        `placing block at (${x}, ${y}, ${z}) timed out`
      );
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError('place_failed', `failed to place block at (${x}, ${y}, ${z}): ${err.message}`);
    }
    await sleep(150);
    const placed = bot.blockAt(this.vec(x, y, z));
    return normalize.place({ placed: { x, y, z, name: placed ? placed.name : item.name }, item: args.item || item.name });
  }

  async mc_use(args = {}) {
    const bot = this.requireBot();
    const offhand = args.offhand === true;
    let item = null;
    if (args.item) {
      const wanted = normalize.stripNamespace(String(args.item));
      item = bot.inventory.items().find((candidate) => normalize.stripNamespace(candidate.name) === wanted);
      if (!item) throw new ToolError('item_not_found', `item "${wanted}" is not in the inventory`);
      await bot.equip(item, offhand ? 'off-hand' : 'hand');
    } else if (offhand) {
      item = (bot.inventory.slots && bot.inventory.slots[45]) || null;
      if (!item) throw new ToolError('item_not_found', 'the off hand is empty');
    } else {
      item = bot.heldItem || null;
      if (!item) throw new ToolError('item_not_found', 'nothing is held in the hand; pass item explicitly');
    }
    await bot.activateItem(offhand);
    await sleep(200);
    try {
      if (typeof bot.deactivateItem === 'function') bot.deactivateItem();
    } catch {
      /* some items auto-deactivate */
    }
    return normalize.use({ item: item.name, offhand, action: 'use' });
  }

  async mc_attack(args = {}) {
    const bot = this.requireBot();
    let entity = null;
    if (Number.isFinite(args.entityId) && bot.entities) entity = bot.entities[args.entityId] || null;
    if (!entity && args.nearest !== false) {
      let best = null;
      let bestDistance = Infinity;
      for (const candidate of Object.values(bot.entities || {})) {
        if (!candidate || candidate.id === bot.entity.id || !candidate.position) continue;
        if (candidate.type === 'object' || candidate.name === 'item' || candidate.name === 'experience_orb') continue;
        const distance = bot.entity.position.distanceTo(candidate.position);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
      entity = best;
    }
    if (!entity) throw new ToolError('entity_not_found', 'no matching entity near the player');

    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 3.2) {
      await this.walkTo(entity.position, { timeoutMs: 15000, stopDistance: 2.2 });
    }
    await this.withTimeout(
      Promise.resolve(bot.attack(entity)),
      5000,
      'attack_timeout',
      'attack timed out'
    );
    return normalize.attack({ entity: { id: entity.id, name: entity.name || entity.username } });
  }

  async mc_chat(args = {}) {
    const bot = this.requireBot();
    const isRead = args.read === true || (args.read === undefined && args.message === undefined);
    if (isRead) {
      const limit = Number.isFinite(args.limit) ? Math.min(100, Math.max(1, Math.trunc(args.limit))) : 20;
      return normalize.chatMessages(this.chatLog.slice(-limit));
    }
    let message = String(args.message ?? '');
    if (!message) throw new ToolError('invalid_arguments', 'mc_chat needs a message to send (or read=true to read chat)');
    if (message.length > 256) message = message.slice(0, 256);
    bot.chat(message);
    return normalize.chatSent({ message });
  }

  async mc_command() {
    throw new ToolError(
      'unsupported_in_bot_mode',
      'mc_command is not available in bot mode (a player bot has no server console permission). Use mc_chat, or type the command in the game manually, or switch to mode=mod.'
    );
  }
}

module.exports = { BotChannel, classifyBotError, isAirLike, isReplaceable };
