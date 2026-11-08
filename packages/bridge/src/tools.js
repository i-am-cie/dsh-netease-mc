'use strict';

/**
 * Tool registry: the single source of truth shared by the MCP server
 * (tools/list) and the autonomous agent (OpenAI `tools` parameter).
 *
 * Tool names, parameters and semantics follow ARCHITECTURE.md §4 exactly.
 * `mc_agent` is intentionally NOT a tool (the agent loop lives in the bridge CLI).
 */

const NUMBER = (description, opts = {}) => Object.assign({ type: 'number', description }, opts);
const STRING = (description, opts = {}) => Object.assign({ type: 'string', description }, opts);
const BOOLEAN = (description) => ({ type: 'boolean', description });
const OBJECT = (description, properties, required) => ({
  type: 'object',
  description,
  properties,
  required,
  additionalProperties: false
});

const TOOLS = Object.freeze([
  {
    name: 'mc_status',
    description:
      'Bridge status: selected channel (bot/mod), connection state, target server or mod version, player name and permission policy. Safe to call at any time; never blocks on a missing server.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'mc_state',
    description:
      'Current player state: position, yaw/pitch (degrees), health, food, gamemode, dimension, experience level and world time/weather/difficulty.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'mc_players',
    description: 'Online players with their positions and health.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'mc_inventory',
    description: 'Player inventory slots. Set includeEmpty=true to list empty slots too.',
    inputSchema: {
      type: 'object',
      properties: { includeEmpty: BOOLEAN('Include empty inventory slots (default false).') },
      additionalProperties: false
    }
  },
  {
    name: 'mc_nearby_entities',
    description: 'Nearby entities (mobs, players, items, ...) with id, name, type, position and distance. Excludes the bot itself.',
    inputSchema: {
      type: 'object',
      properties: {
        radius: NUMBER('Search radius in blocks (default 16, max 128).', { minimum: 1, maximum: 128 }),
        limit: NUMBER('Maximum number of entities (default 20, max 100).', { minimum: 1, maximum: 100 }),
        type: STRING('Only include entities matching this type or name (e.g. "zombie", "player").')
      },
      additionalProperties: false
    }
  },
  {
    name: 'mc_nearby_blocks',
    description: 'Nearby blocks, optionally filtered by block name, sorted by distance ascending.',
    inputSchema: {
      type: 'object',
      properties: {
        radius: NUMBER('Search radius in blocks (default 16, max 128).', { minimum: 1, maximum: 128 }),
        block: STRING('Block name filter, e.g. "minecraft:oak_log" or "oak_log".'),
        limit: NUMBER('Maximum number of blocks (default 10, max 100).', { minimum: 1, maximum: 100 })
      },
      additionalProperties: false
    }
  },
  {
    name: 'mc_block',
    description: 'Information about the single block at the given coordinates (name, properties, solidity, block entity).',
    inputSchema: {
      type: 'object',
      properties: {
        x: NUMBER('Block X coordinate.'),
        y: NUMBER('Block Y coordinate.'),
        z: NUMBER('Block Z coordinate.')
      },
      required: ['x', 'y', 'z'],
      additionalProperties: false
    }
  },
  {
    name: 'mc_move',
    description:
      'Move the player: walk to coordinates (x/z, optional y), walk to another player, look at a point, or stop moving. At most one target mode per call. Uses pathfinding with a timeout (default 30s, override with timeoutMs).',
    inputSchema: {
      type: 'object',
      properties: {
        x: NUMBER('Target X coordinate.'),
        y: NUMBER('Target Y coordinate (optional; keeps current height when omitted).'),
        z: NUMBER('Target Z coordinate.'),
        player: STRING('Walk to this online player.'),
        lookAt: OBJECT('Only look at this point instead of walking.', {
          x: NUMBER('X coordinate to look at.'),
          y: NUMBER('Y coordinate to look at.'),
          z: NUMBER('Z coordinate to look at.')
        }, ['x', 'y', 'z']),
        stop: BOOLEAN('Stop the current movement.'),
        timeoutMs: NUMBER('Movement timeout in milliseconds (default 30000, max 120000).', { minimum: 1000, maximum: 120000 })
      },
      additionalProperties: false
    }
  },
  {
    name: 'mc_mine',
    description:
      'Mine a block at coordinates or the nearest block matching a name. count mines up to N matching blocks (block-name mode only).',
    inputSchema: {
      type: 'object',
      properties: {
        x: NUMBER('Block X coordinate.'),
        y: NUMBER('Block Y coordinate.'),
        z: NUMBER('Block Z coordinate.'),
        block: STRING('Block name to search for, e.g. "minecraft:oak_log" or "oak_log".'),
        count: NUMBER('How many matching blocks to mine (default 1, max 64).', { minimum: 1, maximum: 64 })
      },
      additionalProperties: false
    }
  },
  {
    name: 'mc_place',
    description: 'Place a block from the hotbar/inventory at the given (air) coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        x: NUMBER('Target block X coordinate.'),
        y: NUMBER('Target block Y coordinate.'),
        z: NUMBER('Target block Z coordinate.'),
        item: STRING('Inventory item to place, e.g. "oak_planks". Defaults to the held item.')
      },
      required: ['x', 'y', 'z'],
      additionalProperties: false
    }
  },
  {
    name: 'mc_use',
    description: 'Use, equip or eat an inventory item (right click). Optionally in the off hand.',
    inputSchema: {
      type: 'object',
      properties: {
        item: STRING('Inventory item to use, e.g. "golden_apple" or "diamond_sword".'),
        offhand: BOOLEAN('Use the off hand (default false).')
      },
      additionalProperties: false
    }
  },
  {
    name: 'mc_attack',
    description: 'Attack an entity by entity id, or the nearest attackable entity.',
    inputSchema: {
      type: 'object',
      properties: {
        entityId: NUMBER('Entity id from mc_nearby_entities.', { minimum: 0 }),
        nearest: BOOLEAN('Attack the nearest entity (default true when entityId is omitted).')
      },
      additionalProperties: false
    }
  },
  {
    name: 'mc_chat',
    description:
      'Send a chat message (message) or read recent chat history (read=true, limit defaults to 20). Reading requires no message; sending requires a message.',
    inputSchema: {
      type: 'object',
      properties: {
        message: STRING('Chat message to send (max 256 characters).'),
        read: BOOLEAN('Read recent chat history instead of sending.'),
        limit: NUMBER('Number of recent chat messages to read (default 20, max 100).', { minimum: 1, maximum: 100 })
      },
      additionalProperties: false
    }
  },
  {
    name: 'mc_command',
    description:
      'Execute a server command with console/operator permission (mod channel only; requires the command without a leading slash). The bot channel always returns unsupported_in_bot_mode.',
    inputSchema: {
      type: 'object',
      properties: { command: STRING('Command to execute, without the leading slash (e.g. "time set day").') },
      required: ['command'],
      additionalProperties: false
    }
  }
]);

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

const READ_TOOLS = new Set([
  'mc_status',
  'mc_state',
  'mc_players',
  'mc_inventory',
  'mc_nearby_entities',
  'mc_nearby_blocks',
  'mc_block'
]);

/** MCP tool timeout in ms (ARCHITECTURE.md §4: read 10s, write 35s, command 15s). */
function toolTimeoutMs(name) {
  if (name === 'mc_command') return 15000;
  if (READ_TOOLS.has(name)) return 10000;
  return 35000;
}

const TOOL_TIMEOUTS = Object.freeze(
  Object.fromEntries(TOOLS.map((tool) => [tool.name, toolTimeoutMs(tool.name)]))
);

function getTool(name) {
  return TOOL_BY_NAME.get(name) || null;
}

function getToolNames() {
  return TOOLS.map((tool) => tool.name);
}

/** OpenAI / DeepSeek Chat Completions `tools` parameter. */
function toOpenAITools() {
  return TOOLS.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
  }));
}

function typeMatches(expected, value) {
  switch (expected) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return true;
  }
}

function validateValue(path, schema, value) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type && !typeMatches(schema.type, value)) {
    return `${path} must be of type ${schema.type}`;
  }
  if (schema.type === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be <= ${schema.maximum}`;
  }
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    for (const required of schema.required || []) {
      if (value[required] === undefined) return `${path}.${required} is required`;
      const nested = validateValue(`${path}.${required}`, (schema.properties || {})[required], value[required]);
      if (nested) return nested;
    }
    for (const [key, nestedSchema] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) {
        const nested = validateValue(`${path}.${key}`, nestedSchema, value[key]);
        if (nested) return nested;
      }
    }
  }
  return null;
}

/**
 * Validate and lightly coerce tool arguments against the registry schema.
 * Unknown extra keys are ignored for forward compatibility. Numeric strings
 * are coerced to numbers so LLM tool calls with quoted coordinates still work.
 *
 * @returns {{ok:true,args:object} | {ok:false,message:string}}
 */
function validateAndCoerceArgs(name, rawArgs) {
  const tool = getTool(name);
  if (!tool) return { ok: false, message: `unknown tool: ${name}` };
  let args = rawArgs;
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, message: 'arguments must be a JSON object' };
  }

  const schema = tool.inputSchema;
  const properties = schema.properties || {};
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    if (!propSchema) continue; // ignore unknown fields
    let coerced = value;
    if (propSchema.type === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      coerced = Number(value);
    }
    if (propSchema.type === 'boolean' && (value === 'true' || value === 'false')) {
      coerced = value === 'true';
    }
    out[key] = coerced;
  }

  for (const required of schema.required || []) {
    if (out[required] === undefined) return { ok: false, message: `${required} is required for ${name}` };
  }

  for (const [key, value] of Object.entries(out)) {
    const problem = validateValue(key, properties[key], value);
    if (problem) return { ok: false, message: problem };
  }

  return { ok: true, args: out };
}

module.exports = {
  TOOLS,
  TOOL_TIMEOUTS,
  READ_TOOLS,
  toolTimeoutMs,
  getTool,
  getToolNames,
  toOpenAITools,
  validateAndCoerceArgs
};
