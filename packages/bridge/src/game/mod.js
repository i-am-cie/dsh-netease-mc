'use strict';

const { ToolError } = require('../errors');
const normalize = require('../normalize');
const { resolveModToken } = require('../config');

const DEFAULT_TIMEOUT_MS = 5000;
const HEALTH_TIMEOUT_MS = 2000;
const HEALTH_CACHE_MS = 5000;

function positionFrom(source) {
  if (!source || typeof source !== 'object') return { x: null, y: null, z: null };
  return { x: source.x, y: source.y, z: source.z };
}

/**
 * Channel B — in-game NeoForge mod HTTP client (ARCHITECTURE.md §5).
 *
 * The mod exposes a localhost-only JSON HTTP API. Every response is normalised
 * through src/normalize.js so MCP tool output is identical to the bot channel.
 */
class ModChannel {
  constructor(config, { logger, env = process.env } = {}) {
    this.config = config || {};
    this.modCfg = this.config.mod || {};
    this.logger = logger;
    this.env = env;
    this.startedAt = Date.now();
    this.lastError = null;
    this.healthCache = null;
  }

  get name() {
    return 'mod';
  }

  baseUrl() {
    return String(this.modCfg.url || 'http://127.0.0.1:38210').replace(/\/+$/, '');
  }

  /** Secrets come from the environment only (ARCHITECTURE.md §3). */
  token() {
    return resolveModToken(this.env);
  }

  requireToken() {
    if (!this.token()) {
      throw new ToolError(
        'missing_token',
        'mode=mod requires the DSH_MC_TOKEN environment variable (token printed by the in-game mod on first start, see <gameDir>/config/netease_mc_link.json)'
      );
    }
  }

  requireUrl() {
    const url = String(this.modCfg.url || '');
    if (!/^https?:\/\//i.test(url)) {
      throw new ToolError('invalid_config', `mod.url must be an http(s) URL, got "${url}"`);
    }
  }

  async request(method, path, { query, body, timeoutMs, auth = true } = {}) {
    this.requireUrl();
    if (auth) this.requireToken();
    const url = new URL(this.baseUrl() + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
    }
    const timeout = Number.isFinite(Number(timeoutMs))
      ? Number(timeoutMs)
      : Number.isFinite(Number(this.modCfg.timeoutMs))
        ? Number(this.modCfg.timeoutMs)
        : DEFAULT_TIMEOUT_MS;

    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      const token = this.token();
      headers.authorization = `Bearer ${token}`;
      headers['x-mc-token'] = token;
    }

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout)
      });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      const code = timedOut ? 'timeout' : 'mod_unreachable';
      this.lastError = `${code}: ${err.message}`;
      throw new ToolError(
        code,
        `mod request ${method} ${path} failed: ${err.message} (is the game running with the netease-mc-link mod on ${this.baseUrl()}?)`
      );
    }

    const text = await response.text().catch(() => '');
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ToolError(
          'mod_invalid_response',
          `mod returned non-JSON response (HTTP ${response.status}) from ${method} ${path}: ${text.slice(0, 200)}`
        );
      }
    }

    if (!response.ok) {
      const error = payload && payload.error && typeof payload.error === 'object' ? payload.error : null;
      const statusMap = {
        401: 'mod_unauthorized',
        403: 'mod_unauthorized',
        404: 'mod_not_found',
        405: 'mod_not_supported',
        501: 'mod_not_supported'
      };
      // Auth failures always get a stable bridge code; otherwise prefer the
      // mod-provided error code (e.g. block_not_loaded) so callers see the cause.
      const code =
        statusMap[response.status] && (response.status === 401 || response.status === 403)
          ? statusMap[response.status]
          : error && error.code
            ? String(error.code)
            : statusMap[response.status] || (response.status >= 500 ? 'mod_server_error' : 'mod_http_error');
      const message =
        error && error.message ? String(error.message) : `mod HTTP ${response.status} for ${method} ${path}`;
      throw new ToolError(code, message);
    }

    if (payload && payload.ok === false) {
      const error = payload.error && typeof payload.error === 'object' ? payload.error : {};
      throw new ToolError(String(error.code || 'mod_error'), String(error.message || 'mod reported an error'));
    }
    return payload || {};
  }

  /**
   * Some tools have no dedicated mod endpoint: try `/action` first and, when the
   * mod answers `unsupported_action` (v1 of the mod only implements the
   * tp|give|setblock|summon|time|weather|gamemode|effect|kill verbs), fall back
   * to the equivalent vanilla command through `/command`. This keeps the MCP
   * tool contract stable while tolerating an older in-game mod build.
   */
  async actionWithFallback(body, fallbackCommand) {
    try {
      return await this.request('POST', '/action', { body });
    } catch (err) {
      const code = err && err.code;
      const retryable =
        code === 'unsupported_action' ||
        code === 'not_found' ||
        code === 'mod_not_found' ||
        code === 'mod_not_supported';
      if (!retryable || !fallbackCommand) throw err;
      const result = await this.request('POST', '/command', { body: { command: fallbackCommand } });
      return { ...result, action: body.type, fallback: 'command', command: fallbackCommand };
    }
  }

  async health() {
    return this.request('GET', '/health', { auth: false, timeoutMs: HEALTH_TIMEOUT_MS });
  }

  async ensureConnected() {
    this.requireToken();
    if (this.healthCache && Date.now() - this.healthCache.at < HEALTH_CACHE_MS) return;
    const health = await this.health();
    this.healthCache = { at: Date.now(), health };
    this.lastError = null;
  }

  close() {
    /* stateless HTTP client */
  }

  async fetchState() {
    return this.request('GET', '/state');
  }

  /* --------------------------------------------------------------------- */
  /* Tools                                                                  */
  /* --------------------------------------------------------------------- */

  async mc_status() {
    let connected = false;
    let mod = null;
    let player = null;
    let lastError = null;
    if (!this.token()) {
      lastError = 'missing_token: set the DSH_MC_TOKEN environment variable';
    }
    try {
      const health = await this.health();
      connected = true;
      mod = { url: this.baseUrl(), version: health.mod || null, mc: health.mc || null };
      if (!this.token()) lastError = 'missing_token: set the DSH_MC_TOKEN environment variable';
    } catch (err) {
      lastError = `${err.code || 'mod_unreachable'}: ${err.message}`;
    }
    if (connected && this.token()) {
      try {
        const state = await this.fetchState();
        player = { name: state.player && state.player.name ? state.player.name : null };
      } catch {
        /* status must not fail because /state failed */
      }
    }
    return normalize.status({
      mode: 'mod',
      connected,
      server: null,
      mod,
      player,
      policy: this.config.policy,
      uptimeMs: Date.now() - this.startedAt,
      lastError
    });
  }

  async mc_state() {
    const payload = await this.fetchState();
    return normalize.state({ player: payload.player || {}, world: payload.world || {} });
  }

  async mc_players() {
    const payload = await this.fetchState();
    return normalize.players(payload.players || []);
  }

  async mc_inventory(args = {}) {
    const payload = await this.request('GET', '/inventory', {
      query: { includeEmpty: args.includeEmpty === true ? 'true' : undefined }
    });
    // The real mod returns two aliases (`inventory` and `slots`); accept both.
    const items = Array.isArray(payload.inventory)
      ? payload.inventory
      : Array.isArray(payload.slots)
        ? payload.slots
        : Array.isArray(payload.items)
          ? payload.items
          : [];
    return normalize.inventory(items);
  }

  async mc_nearby_entities(args = {}) {
    const payload = await this.request('GET', '/entities', {
      query: {
        radius: Number.isFinite(args.radius) ? args.radius : undefined,
        type: args.type,
        limit: Number.isFinite(args.limit) ? args.limit : undefined
      }
    });
    return normalize.entities(payload.entities || []);
  }

  async mc_nearby_blocks(args = {}) {
    const payload = await this.request('GET', '/blocks', {
      query: {
        radius: Number.isFinite(args.radius) ? args.radius : undefined,
        block: args.block,
        limit: Number.isFinite(args.limit) ? args.limit : undefined
      }
    });
    return normalize.blocks(payload.blocks || []);
  }

  async mc_block(args = {}) {
    const { x, y, z } = args;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new ToolError('invalid_arguments', 'mc_block requires numeric x, y and z');
    }
    const payload = await this.request('GET', '/block', { query: { x, y, z } });
    // Real mod shape: {ok:true, block:{id,properties,solid,...}, blockEntity:{id,type}|null}
    const info = payload.block && typeof payload.block === 'object' ? payload.block : payload;
    const blockEntity = info.blockEntity !== undefined ? info.blockEntity : payload.blockEntity;
    return normalize.block({
      x: Number.isFinite(info.x) ? info.x : x,
      y: Number.isFinite(info.y) ? info.y : y,
      z: Number.isFinite(info.z) ? info.z : z,
      name: info.name || info.id || null,
      displayName: info.displayName || null,
      properties: info.properties || {},
      solid: typeof info.solid === 'boolean' ? info.solid : null,
      blockEntity: blockEntity || null
    });
  }

  async mc_move(args = {}) {
    const hasCoordinates = Number.isFinite(args.x) || Number.isFinite(args.z);
    if (args.stop !== true && !args.player && !args.lookAt && !hasCoordinates) {
      throw new ToolError(
        'invalid_arguments',
        'mc_move needs coordinates (x/z), a player name, lookAt, or stop=true'
      );
    }
    const before = await this.fetchState();
    const from = positionFrom(before.player);
    const body = { type: 'move' };
    if (args.stop === true) body.stop = true;
    if (Number.isFinite(args.x)) body.x = args.x;
    if (Number.isFinite(args.y)) body.y = args.y;
    if (Number.isFinite(args.z)) body.z = args.z;
    if (args.player) body.player = String(args.player);
    if (args.lookAt) body.lookAt = { x: args.lookAt.x, y: args.lookAt.y, z: args.lookAt.z };
    if (Number.isFinite(args.timeoutMs)) body.timeoutMs = args.timeoutMs;

    // No "move" verb in the v1 mod API: fall back to /tp, including look direction.
    let fallback = null;
    const playerName = before.player && before.player.name ? before.player.name : null;
    if (playerName && args.stop !== true) {
      if (args.player) {
        fallback = `tp ${playerName} ${String(args.player)}`;
      } else if (hasCoordinates) {
        const x = Number.isFinite(args.x) ? args.x : from.x;
        const y = Number.isFinite(args.y) ? args.y : from.y;
        const z = Number.isFinite(args.z) ? args.z : from.z;
        fallback = `tp ${playerName} ${x} ${y} ${z}`;
      } else if (args.lookAt) {
        const eyeY = Number.isFinite(from.y) ? from.y + 1.62 : 64;
        const dx = Number(args.lookAt.x) - Number(from.x || 0);
        const dy = Number(args.lookAt.y) - eyeY;
        const dz = Number(args.lookAt.z) - Number(from.z || 0);
        const horizontal = Math.sqrt(dx * dx + dz * dz) || 1e-6;
        const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
        const pitch = (-Math.atan2(dy, horizontal) * 180) / Math.PI;
        fallback = `tp ${playerName} ~ ~ ~ ${yaw.toFixed(3)} ${pitch.toFixed(3)}`;
      }
    }

    const result = await this.actionWithFallback(body, fallback);
    let to = null;
    if (result.player && typeof result.player === 'object') {
      to = positionFrom(result.player);
    } else if (result.position && typeof result.position === 'object') {
      to = positionFrom(result.position);
    } else {
      const after = await this.fetchState();
      to = positionFrom(after.player);
    }

    let target = null;
    if (args.player) target = result.target || null;
    else if (Number.isFinite(args.x) || Number.isFinite(args.z)) {
      target = {
        x: Number.isFinite(args.x) ? args.x : from.x,
        y: Number.isFinite(args.y) ? args.y : from.y,
        z: Number.isFinite(args.z) ? args.z : from.z
      };
    } else if (args.lookAt) {
      target = { x: args.lookAt.x, y: args.lookAt.y, z: args.lookAt.z };
    }
    return normalize.move({ from, to, target });
  }

  async mc_mine(args = {}) {
    const body = { type: 'mine' };
    if (Number.isFinite(args.x)) body.x = args.x;
    if (Number.isFinite(args.y)) body.y = args.y;
    if (Number.isFinite(args.z)) body.z = args.z;
    if (args.block) body.block = String(args.block);
    if (Number.isFinite(args.count)) body.count = args.count;

    // v1 mod API has no "mine": destroy the target block with /setblock ... air destroy.
    const mineFallback =
      Number.isFinite(args.x) && Number.isFinite(args.y) && Number.isFinite(args.z)
        ? `setblock ${args.x} ${args.y} ${args.z} air destroy`
        : null;

    const result = await this.actionWithFallback(body, mineFallback);
    let mined = Array.isArray(result.mined) ? result.mined : [];
    if (mined.length === 0 && Number.isFinite(args.x) && Number.isFinite(args.y) && Number.isFinite(args.z)) {
      const block = await this.mc_block({ x: args.x, y: args.y, z: args.z });
      mined = [{ x: args.x, y: args.y, z: args.z, name: block.block.name }];
    }
    return normalize.mine({
      mined: mined.map((entry) => ({
        x: entry.x,
        y: entry.y,
        z: entry.z,
        name: normalize.stripNamespace(entry.name || entry.block || '')
      })),
      count: Number.isFinite(result.count) ? result.count : undefined
    });
  }

  async mc_place(args = {}) {
    const { x, y, z } = args;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new ToolError('invalid_arguments', 'mc_place requires numeric x, y and z');
    }
    const body = { type: 'place', x, y, z };
    if (args.item) body.item = String(args.item);
    // v1 mod API has no "place": fall back to /setblock with the requested block id.
    const rawBlock = String(args.item || body.item || 'minecraft:stone');
    const blockId = rawBlock.includes(':') ? rawBlock : `minecraft:${rawBlock}`;
    const result = await this.actionWithFallback(body, `setblock ${x} ${y} ${z} ${blockId}`);
    let name = result.placed && result.placed.name ? result.placed.name : result.block ? result.block : null;
    if (!name) {
      try {
        const block = await this.mc_block({ x, y, z });
        name = block.block.name;
      } catch {
        /* best effort only */
      }
    }
    return normalize.place({
      placed: { x, y, z, name: normalize.stripNamespace(name || '') },
      item: args.item || normalize.stripNamespace(name || '') || null
    });
  }

  async mc_use(args = {}) {
    const body = { type: 'use' };
    if (args.item) body.item = String(args.item);
    if (args.offhand === true) body.offhand = true;
    let result;
    try {
      result = await this.request('POST', '/action', { body });
    } catch (err) {
      const code = err && err.code;
      if (code === 'unsupported_action' || code === 'not_found' || code === 'mod_not_found' || code === 'mod_not_supported') {        throw new ToolError(
          'unsupported_in_mod_mode',
          'mc_use has no equivalent in the v1 in-game mod; use mc_command (e.g. "effect give <player> ...") or switch mode=bot'
        );
      }
      throw err;
    }
    return normalize.use({
      item: result.item || args.item || null,
      offhand: args.offhand === true || result.offhand === true,
      action: result.action || 'use'
    });
  }

  async mc_attack(args = {}) {
    const body = { type: 'attack', nearest: args.nearest !== false };
    if (Number.isFinite(args.entityId)) body.entityId = args.entityId;
    // v1 mod API has no "attack": damage the nearest non-player entity.
    const result = await this.actionWithFallback(
      body,
      'damage @e[type=!player,limit=1,sort=nearest] 5'
    );
    const entity = result.entity || result.attacked || {};
    return normalize.attack({
      entity: {
        id: Number.isFinite(entity.id) ? entity.id : Number.isFinite(args.entityId) ? args.entityId : null,
        name: entity.name || result.name || null
      }
    });
  }

  async mc_chat(args = {}) {
    const isRead = args.read === true || (args.read === undefined && args.message === undefined);
    if (isRead) {
      const limit = Number.isFinite(args.limit) ? Math.min(100, Math.max(1, Math.trunc(args.limit))) : 20;
      try {
        const payload = await this.request('GET', '/chat', { query: { limit } });
        return normalize.chatMessages(payload.messages || []);
      } catch (err) {
        const code = err && err.code;
        if (
          code === 'not_found' ||
          code === 'mod_not_found' ||
          code === 'mod_not_supported' ||
          code === 'method_not_allowed'
        ) {
          // The v1 mod captures no chat history; report an empty list instead of failing.
          const empty = normalize.chatMessages([]);
          empty.note = 'the v1 in-game mod does not capture chat history; use mode=bot to read chat';
          return empty;
        }
        throw err;
      }
    }
    const message = String(args.message ?? '').slice(0, 256);
    if (!message) throw new ToolError('invalid_arguments', 'mc_chat needs a message to send (or read=true to read chat)');
    await this.request('POST', '/chat', { body: { message } });
    return normalize.chatSent({ message });
  }

  async mc_command(args = {}) {
    const command = String(args.command ?? '').replace(/^\/+/, '').trim();
    if (!command) throw new ToolError('invalid_arguments', 'mc_command requires a command without the leading slash');
    const payload = await this.request('POST', '/command', { body: { command } });
    return normalize.command({ command, output: payload.output || payload.result || [] });
  }
}

module.exports = { ModChannel };
