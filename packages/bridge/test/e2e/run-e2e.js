'use strict';

/**
 * End-to-end test: real Paper 1.21.8 server + real mineflayer bot channel.
 *
 * NOT part of `node --test` (name does not match test discovery patterns, and
 * the NODE_TEST_CONTEXT guard below makes it a no-op if it ever is).
 *
 * Usage:
 *   node test/e2e/run-e2e.js
 *   MC_SERVER_JAR="C:\path\to\paper-1.21.8.jar" node test/e2e/run-e2e.js
 *
 * Requires: JDK 22+ java in %JAVA_EXE% or the bundled path below, port 25565 free,
 * ~2 minutes (first Paper start may download libraries).
 *
 * Output: human readable log + test-run/e2e-results.json
 */

if (process.env.NODE_TEST_CONTEXT) {
  // The unit-test discovery must never launch a real Minecraft server.
  process.exit(0);
}

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const BRIDGE_DIR = path.resolve(__dirname, '..', '..');
const REPO_DIR = path.resolve(BRIDGE_DIR, '..', '..');
const SERVER_DIR = path.join(REPO_DIR, 'test-servers', 'server-1.21.8');
const RUN_DIR = path.join(REPO_DIR, 'test-run');
const PORT = 25565;
const BOT_NAME = 'DeepSeek';

const JAVA_EXE =
  process.env.JAVA_EXE || 'D:\\MCLDownload\\ext\\jre-v64-220420\\jdk22\\bin\\java.exe';
const SERVER_JAR =
  process.env.MC_SERVER_JAR || path.join(REPO_DIR, 'test-servers', 'paper-1.21.8-60.jar');

const results = [];
const logLines = [];
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  logLines.push(line);
  process.stdout.write(line + '\n');
}

function record(tool, args, result, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    tool,
    args: args === undefined ? null : args,
    ok: result && result.ok === true,
    code: result && result.ok === true ? null : result && result.error && result.error.code,
    result,
    ...extra
  };
  results.push(entry);
  log(`${tool} -> ${entry.ok ? 'OK' : 'FAIL ' + entry.code}`);
  return entry;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portOpen(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function downloadPaper() {
  fs.mkdirSync(path.dirname(SERVER_JAR), { recursive: true });
  log(`downloading Paper 1.21.8 server jar to ${SERVER_JAR}`);
  const builds = await (await fetch('https://fill.papermc.io/v3/projects/paper/versions/1.21.8/builds', { signal: AbortSignal.timeout(60000) })).json();
  const latest = builds[0];
  const url = latest.downloads['server:default'].url;
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`paper download HTTP ${response.status}`);
  fs.writeFileSync(SERVER_JAR, Buffer.from(await response.arrayBuffer()));
  log(`downloaded ${SERVER_JAR}`);
}

function writeServerProperties() {
  fs.mkdirSync(SERVER_DIR, { recursive: true });
  fs.writeFileSync(path.join(SERVER_DIR, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(
    path.join(SERVER_DIR, 'server.properties'),
    [
      'online-mode=false',
      `server-port=${PORT}`,
      'server-ip=127.0.0.1',
      'motd=dsh-netease-mc e2e',
      'max-players=8',
      'gamemode=survival',
      'difficulty=peaceful',
      'spawn-protection=0',
      'view-distance=4',
      'simulation-distance=4',
      'level-type=minecraft:flat',
      'generate-structures=false',
      'spawn-monsters=false',
      'allow-nether=false',
      'enable-status=true',
      'network-compression-threshold=256'
    ].join('\n') + '\n'
  );
}

function startServer() {
  const child = spawn(JAVA_EXE, ['-Xms512M', '-Xmx1024M', '-jar', SERVER_JAR, 'nogui'], {
    cwd: SERVER_DIR,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const output = [];
  const push = (chunk) => {
    const text = String(chunk);
    output.push(text);
    const logFile = path.join(RUN_DIR, 'server-e2e.log');
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.appendFileSync(logFile, text);
    for (const line of text.split(/\r?\n/)) {
      if (line.includes('Done (') || line.includes('ERROR') || line.includes('Exception')) {
        log(`[server] ${line.slice(0, 300)}`);
      }
    }
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start within 240s. tail:\n${output.join('').slice(-2000)}`)), 240000);
    const check = setInterval(() => {
      if (output.join('').includes('Done (')) {
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      }
    }, 500);
    child.once('exit', (code) => {
      clearInterval(check);
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
  return { child, ready, output };
}

function startBridgeClient() {
  const configPath = path.join(RUN_DIR, 'e2e-bridge-config.json');
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        mode: 'bot',
        bot: { host: '127.0.0.1', port: PORT, username: BOT_NAME, version: '1.21.8', auth: 'offline', connectTimeoutMs: 30000 },
        policy: {
          allowRead: true,
          allowMove: true,
          allowWorldWrite: true,
          allowCommands: true,
          allowChat: true,
          allowAttack: true
        },
        log: { level: 'info', file: path.join(RUN_DIR, 'e2e-bridge.log') }
      },
      null,
      2
    )
  );
  const child = spawn(process.execPath, [path.join(BRIDGE_DIR, 'src', 'index.js'), 'serve', '--config', configPath], {
    cwd: BRIDGE_DIR,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const client = { child, pending: new Map(), nextId: 1, buffer: '', stderr: '', messages: [] };
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
        continue;
      }
      client.messages.push(message);
      if (message.id !== undefined && client.pending.has(message.id)) {
        client.pending.get(message.id)(message);
        client.pending.delete(message.id);
      }
    }
  });
  client.request = (method, params, timeoutMs = 90000) => {
    const id = client.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      client.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  client.notify = (method, params) => client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  client.end = () => client.child.stdin.end();
  return client;
}

async function callTool(client, name, args) {
  const response = await client.request('tools/call', { name, arguments: args });
  const result = response.result.structuredContent;
  return record(name, args, { ...result, isError: response.result.isError }, { isError: response.result.isError });
}

async function main() {
  if (!fs.existsSync(JAVA_EXE)) throw new Error(`java not found: ${JAVA_EXE}`);
  if (!fs.existsSync(SERVER_JAR)) await downloadPaper();
  writeServerProperties();
  log(`starting Paper server on 127.0.0.1:${PORT} (java: ${JAVA_EXE})`);
  const server = startServer();
  let client = null;
  try {
    await server.ready;
    log('server is ready');
    client = startBridgeClient();
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    client.notify('notifications/initialized', {});
    const tools = await client.request('tools/list', {});
    log(`tools/list -> ${tools.result.tools.length} tools`);

    // 1. wait for the bot to join (mc_status is non-blocking)
    let status = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      status = await callTool(client, 'mc_status', {});
      if (status.ok && status.result.connected) break;
      await sleep(1000);
    }
    if (!status || !status.result.connected) throw new Error(`bot did not connect: ${JSON.stringify(status)}`);
    log(`connected as ${status.result.player && status.result.player.name}`);

    await sleep(500);
    server.child.stdin.write(`give ${BOT_NAME} oak_planks 16\n`);
    await sleep(1000);

    const state = await callTool(client, 'mc_state', {});
    const pos = state.result.player;
    const inv = await callTool(client, 'mc_inventory', {});
    const players = await callTool(client, 'mc_players', {});
    const below = await callTool(client, 'mc_block', { x: Math.floor(pos.x), y: Math.floor(pos.y) - 1, z: Math.floor(pos.z) });
    const nearby = await callTool(client, 'mc_nearby_blocks', { radius: 16, block: 'grass_block', limit: 8 });
    const entities = await callTool(client, 'mc_nearby_entities', { radius: 16 });

    // 2. move
    const moveTarget = { x: pos.x + 3, y: pos.y, z: pos.z };
    const moved = await callTool(client, 'mc_move', moveTarget);
    await sleep(300);
    const stateAfter = await callTool(client, 'mc_state', {});
    const moveDistance = Math.hypot(stateAfter.result.player.x - pos.x, stateAfter.result.player.z - pos.z);

    // 3. mine a nearby grass block, then verify it changed
    let mined = null;
    let mineVerify = null;
    if (nearby.ok && nearby.result.blocks.length > 0) {
      const target = nearby.result.blocks[0];
      mined = await callTool(client, 'mc_mine', { x: target.x, y: target.y, z: target.z });
      await sleep(500);
      mineVerify = await callTool(client, 'mc_block', { x: target.x, y: target.y, z: target.z });
    }

    // 4. place a block next to the player
    const placeX = Math.floor(stateAfter.result.player.x) + 2;
    const placeY = Math.floor(stateAfter.result.player.y);
    const placeZ = Math.floor(stateAfter.result.player.z);
    const placed = await callTool(client, 'mc_place', { x: placeX, y: placeY, z: placeZ, item: 'oak_planks' });
    const placeVerify = await callTool(client, 'mc_block', { x: placeX, y: placeY, z: placeZ });

    // 5. chat round-trip
    const sent = await callTool(client, 'mc_chat', { message: 'hello from dsh-netease-mc e2e' });
    await sleep(800);
    const read = await callTool(client, 'mc_chat', { read: true, limit: 10 });

    // 6. bot mode must reject mc_command
    const command = await callTool(client, 'mc_command', { command: 'time set day' });

    const checks = {
      statusConnected: status.result.connected === true,
      stateOk: state.ok === true && typeof state.result.player.x === 'number',
      inventoryHasPlanks: inv.ok === true && inv.result.items.some((item) => item.name === 'oak_planks'),
      blockBelowSolid: below.ok === true && below.result.block.name !== 'air',
      playersIncludesBot: players.ok === true && players.result.players.some((player) => player.name === BOT_NAME),
      nearbyBlocksOk: nearby.ok === true && nearby.result.blocks.length > 0,
      entitiesOk: entities.ok === true,
      moveOk: moved.ok === true && moveDistance > 1.5,
      mineOk: !!(mined && mined.ok === true),
      mineChanged: !!(mineVerify && mineVerify.ok === true && mineVerify.result.block.name !== 'grass_block'),
      placeOk: placed.ok === true,
      placeChanged: !!(placeVerify && placeVerify.ok === true && placeVerify.result.block.name === 'oak_planks'),
      chatSent: sent.ok === true,
      chatReadBack: read.ok === true && read.result.messages.some((message) => message.message.includes('e2e')),
      commandRejectedInBotMode: command.ok === false && command.code === 'unsupported_in_bot_mode'
    };
    log('checks: ' + JSON.stringify(checks, null, 2));
    const passed = Object.values(checks).filter(Boolean).length;
    const total = Object.keys(checks).length;
    log(`RESULT: ${passed}/${total} checks passed`);

    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RUN_DIR, 'e2e-results.json'),
      JSON.stringify({ ts: new Date().toISOString(), checks, passed, total, results }, null, 2)
    );
    fs.writeFileSync(path.join(RUN_DIR, 'e2e-run.log'), logLines.join('\n') + '\n');
    return passed === total ? 0 : 1;
  } finally {
    if (client) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
      try {
        client.child.kill();
      } catch {
        /* ignore */
      }
    }
    try {
      server.child.stdin.write('stop\n');
    } catch {
      /* ignore */
    }
    await Promise.race([
      new Promise((resolve) => server.child.once('exit', resolve)),
      sleep(20000)
    ]);
    try {
      server.child.kill();
    } catch {
      /* ignore */
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    log(`E2E FAILED: ${err && err.stack ? err.stack : err}`);
    try {
      fs.mkdirSync(RUN_DIR, { recursive: true });
      fs.writeFileSync(path.join(RUN_DIR, 'e2e-run.log'), logLines.join('\n') + '\n');
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  });
