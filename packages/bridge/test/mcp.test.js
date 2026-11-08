'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const { startMockModServer } = require('./helpers/mock-mod-server');

const BRIDGE_DIR = path.join(__dirname, '..');
const INDEX_JS = path.join(BRIDGE_DIR, 'src', 'index.js');
const EXPECTED_TOOLS = [
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

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeConfig(dir, value) {
  const file = path.join(dir, 'dsh-mc.config.json');
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
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

function startBridge({ configPath, env }) {
  const child = spawn(process.execPath, [INDEX_JS, 'serve', '--config', configPath], {
    cwd: BRIDGE_DIR,
    env: Object.assign({}, process.env, { DSH_MC_CONFIG: '', DSH_MC_TOKEN: '' }, env || {}),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const client = {
    child,
    stdoutMessages: [],
    parseErrors: [],
    stderr: '',
    pending: new Map(),
    nextId: 1,
    buffer: '',
    exited: null
  };
  client.exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    client.stderr += chunk;
  });
  child.stdout.on('data', (chunk) => {
    client.buffer += chunk;
    for (;;) {
      const index = client.buffer.indexOf('\n');
      if (index < 0) break;
      const line = client.buffer.slice(0, index);
      client.buffer = client.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        client.parseErrors.push(line);
        continue;
      }
      client.stdoutMessages.push(message);
      if (message && Object.prototype.hasOwnProperty.call(message, 'id') && client.pending.has(message.id)) {
        const entry = client.pending.get(message.id);
        clearTimeout(entry.timer);
        client.pending.delete(message.id);
        entry.resolve(message);
      }
    }
  });

  client.sendRaw = (text) => child.stdin.write(text);
  client.request = (method, params, timeoutMs = 10000) => {
    const id = client.nextId;
    client.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (id ${id}); stderr=${client.stderr.slice(-800)}`));
      }, timeoutMs);
      client.pending.set(id, { resolve, timer });
      client.sendRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  client.notify = (method, params) => client.sendRaw(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  client.endStdin = () => child.stdin.end();
  client.kill = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };
  return client;
}

async function closeAndAssertExit(client, timeoutMs = 8000) {
  client.endStdin();
  const result = await Promise.race([
    client.exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`bridge did not exit; stderr=${client.stderr.slice(-800)}`)), timeoutMs))
  ]);
  assert.equal(result.code, 0, `bridge should exit cleanly, got ${JSON.stringify(result)}; stderr=${client.stderr.slice(-800)}`);
}

test('MCP over NDJSON: initialize, tools/list, tools/call, errors, shutdown', async () => {
  const mock = await startMockModServer();
  const dir = tempDir('dsh-mc-mcp-');
  const configPath = writeConfig(dir, {
    mode: 'mod',
    mod: { url: mock.url, timeoutMs: 2000 },
    log: { level: 'info' }
  });
  const client = startBridge({ configPath, env: { DSH_MC_TOKEN: mock.token } });
  try {
    const initialize = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-test', version: '0.0.0' }
    });
    assert.equal(initialize.jsonrpc, '2.0');
    assert.equal(initialize.result.protocolVersion, '2025-06-18');
    assert.equal(initialize.result.serverInfo.name, 'dsh-netease-mc-bridge');
    assert.equal(initialize.result.capabilities.tools.listChanged, false);
    assert.ok(initialize.result.instructions.includes('mc_status'));

    client.notify('notifications/initialized', {});

    const ping = await client.request('ping', {});
    assert.deepEqual(ping.result, {});

    const tools = await client.request('tools/list', {});
    assert.deepEqual(tools.result.tools.map((tool) => tool.name), EXPECTED_TOOLS);
    for (const tool of tools.result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(typeof tool.description, 'string');
    }

    const status = await client.request('tools/call', { name: 'mc_status', arguments: {} });
    assert.equal(status.result.isError, false);
    assert.equal(status.result.content[0].type, 'text');
    assert.equal(JSON.parse(status.result.content[0].text).ok, true);
    assert.equal(status.result.structuredContent.ok, true);
    assert.equal(status.result.structuredContent.mode, 'mod');
    assert.equal(status.result.structuredContent.connected, true);

    const state = await client.request('tools/call', { name: 'mc_state', arguments: {} });
    assert.equal(state.result.isError, false);
    assert.equal(state.result.structuredContent.player.name, 'DeepSeek');

    const unknown = await client.request('tools/call', { name: 'mc_fly', arguments: {} });
    assert.equal(unknown.result.isError, true);
    assert.equal(unknown.result.structuredContent.error.code, 'unknown_tool');

    const badArgs = await client.request('tools/call', { name: 'mc_block', arguments: { x: 1 } });
    assert.equal(badArgs.result.isError, true);
    assert.equal(badArgs.result.structuredContent.error.code, 'invalid_arguments');

    const resources = await client.request('resources/list', {});
    assert.deepEqual(resources.result, { resources: [] });
    const prompts = await client.request('prompts/list', {});
    assert.deepEqual(prompts.result, { prompts: [] });

    const unknownMethod = await client.request('tools/nope', {});
    assert.equal(unknownMethod.error.code, -32601);

    client.sendRaw('{ this is not json }\n');
    const afterParseError = await client.request('ping', {});
    assert.deepEqual(afterParseError.result, {});
    const parseError = client.stdoutMessages.find((message) => message.error && message.error.code === -32700);
    assert.ok(parseError, 'parse errors must return JSON-RPC -32700');
    assert.equal(parseError.id, null);

    // stdout must contain JSON-RPC only, one object per line
    assert.deepEqual(client.parseErrors, []);
    for (const message of client.stdoutMessages) {
      assert.equal(message.jsonrpc, '2.0');
    }
    assert.ok(client.stderr.length > 0, 'diagnostics should go to stderr');

    await closeAndAssertExit(client);
  } finally {
    client.kill();
    await mock.close().catch(() => {});
  }
});

test('probe process works in bot mode without connecting and exits cleanly', async () => {
  const port = await freePort();
  const dir = tempDir('dsh-mc-probe-');
  const configPath = writeConfig(dir, {
    mode: 'bot',
    bot: { host: '127.0.0.1', port, connectTimeoutMs: 2000 },
    log: { level: 'error' }
  });
  const client = startBridge({ configPath, env: {} });
  try {
    const initialize = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-probe', version: '0.0.0' } });
    assert.equal(initialize.result.protocolVersion, '2025-06-18');
    const tools = await client.request('tools/list', {});
    assert.equal(tools.result.tools.length, 14);
    // nothing should have tried to join the server just to list tools
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(!client.stderr.includes('bot connecting'), 'tools/list must not connect the bot');
    await closeAndAssertExit(client);
  } finally {
    client.kill();
  }
});

