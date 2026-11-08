'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const {
  PROTOCOL_VERSION,
  loadConfig,
  validateModeReadiness,
  resolveModToken,
  resolveAgentApiKey,
  redactConfig
} = require('./config');
const { createLogger } = require('./logger');
const { Executor } = require('./executor');
const { startMcpServer } = require('./index');
const { runDeepSeekAgent } = require('./agent/deepseek');
const { ToolError } = require('./errors');

const COMMANDS = new Set(['serve', 'agent', 'doctor', 'probe']);

const HELP = `dsh-netease-mc bridge (MCP server + DeepSeek agent)

Usage:
  node src/index.js [serve] [options]          MCP server over stdio (NDJSON JSON-RPC)
  node src/index.js agent --goal "<text>"      autonomous DeepSeek loop
  node src/index.js doctor                     print config/channel diagnostics (JSON)
  node src/index.js probe [--range 49152-49210] scan localhost TCP ports (LAN discovery)

Options:
  --config <path>     config file (default: DSH_MC_CONFIG, ./dsh-mc.config.json, ~/.dsh-mc/config.json)
  --mode bot|mod      override config.mode
  --host <host>       override bot.host (serve/agent/probe)
  --port <port>       override bot.port (serve/agent/probe)
  --goal <text>       agent goal (or pass the goal as positional text)
  --max-steps <n>     agent step limit (default config.agent.maxSteps)
  --dry-run           agent: print the planned tool calls, execute nothing
  --verbose           debug logging to stderr
  --help, -h          this help

Environment:
  DSH_MC_CONFIG       config file path
  DSH_MC_TOKEN        mod HTTP token (required for mode=mod; never read from the config file)
  DEEPSEEK_API_KEY    DeepSeek API key (agent mode only)

MCP transport: newline-delimited JSON-RPC 2.0 on stdin/stdout, protocol ${PROTOCOL_VERSION}.
Logs go to stderr only; stdout is reserved for JSON-RPC.`;

function parseInteger(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArgs(argv) {
  const opts = {
    command: 'serve',
    configPath: null,
    goal: null,
    maxSteps: null,
    dryRun: false,
    verbose: false,
    help: false,
    mode: null,
    host: null,
    port: null,
    ports: null,
    range: null,
    positional: []
  };
  const args = [...argv];
  const first = args[0];
  if (first && !first.startsWith('-')) {
    args.shift();
    if (COMMANDS.has(first)) opts.command = first;
    else opts.positional.push(first);
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      i += 1;
      return args[i];
    };
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--config') {
      opts.configPath = next();
    } else if (arg.startsWith('--config=')) {
      opts.configPath = arg.slice('--config='.length);
    } else if (arg === '--goal') {
      opts.goal = next();
    } else if (arg.startsWith('--goal=')) {
      opts.goal = arg.slice('--goal='.length);
    } else if (arg === '--max-steps') {
      opts.maxSteps = parseInteger(next());
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--verbose') {
      opts.verbose = true;
    } else if (arg === '--mode') {
      opts.mode = next();
    } else if (arg === '--host') {
      opts.host = next();
    } else if (arg === '--port') {
      opts.port = parseInteger(next());
    } else if (arg === '--ports') {
      opts.ports = next();
    } else if (arg === '--range') {
      opts.range = next();
    } else if (arg.startsWith('--')) {
      // ignore unknown flags (forward compatibility)
    } else {
      opts.positional.push(arg);
    }
  }
  return opts;
}

function buildLogger(config, opts) {
  const level = opts.verbose ? 'debug' : (config.log && config.log.level) || 'info';
  const logger = createLogger({ level, file: (config.log && config.log.file) || '', prefix: 'dsh-mc' });
  for (const warning of opts.configWarnings || []) logger.warn(warning);
  return logger;
}

/** require.resolve probe that never throws. */
function tryResolvePackage(request, paths) {
  try {
    return require.resolve(request, { paths });
  } catch {
    return null;
  }
}

function packageVersion(packageJsonPath) {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version || null;
  } catch {
    return null;
  }
}

function tcpProbe(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (open, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ port, open, ms: Date.now() - startedAt, error: error || null });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, null));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (err) => finish(false, err.code || err.message));
  });
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function resolveProbePorts(opts, config) {
  const ports = new Set();
  if (Number.isInteger(opts.port)) ports.add(opts.port);
  if (opts.ports) {
    for (const part of String(opts.ports).split(',')) {
      const port = parseInteger(part);
      if (port) ports.add(port);
    }
  }
  if (opts.range) {
    const match = /^(\d+)-(\d+)$/.exec(String(opts.range).trim());
    if (!match) throw new ToolError('invalid_arguments', `--range must look like 49152-49210, got "${opts.range}"`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!(end >= start) || end - start > 20000) {
      throw new ToolError('invalid_arguments', '--range must be ascending and span at most 20000 ports');
    }
    for (let port = start; port <= end; port += 1) ports.add(port);
  }
  if (ports.size === 0) {
    const configured = Number(config.bot && config.bot.port);
    if (Number.isInteger(configured) && configured > 0) ports.add(configured);
    ports.add(25565);
  }
  return [...ports].sort((a, b) => a - b);
}

function applyOverrides(config, opts) {
  if (opts.mode) config.mode = opts.mode;
  if (opts.host) config.bot.host = opts.host;
  if (Number.isInteger(opts.port)) config.bot.port = opts.port;
  if (config.mode !== 'bot' && config.mode !== 'mod') {
    throw new ToolError('invalid_config', `mode must be "bot" or "mod", got "${config.mode}"`);
  }
  return config;
}

function loadForCli(opts) {
  const argv = opts.configPath ? ['--config', opts.configPath] : process.argv.slice(2);
  const loaded = loadConfig({ argv, env: process.env, cwd: process.cwd() });
  applyOverrides(loaded.config, opts);
  return loaded;
}

/* ------------------------------------------------------------------------- */
/* Commands                                                                  */
/* ------------------------------------------------------------------------- */

async function runServe(config, opts) {
  const logger = buildLogger(config, opts);
  for (const problem of validateModeReadiness(config, process.env)) logger.warn('configuration problem', problem);
  const executor = new Executor({ config, env: process.env, logger });
  const server = startMcpServer({ config, logger, executor });
  logger.info('MCP server ready', {
    transport: 'stdio-ndjson',
    protocol: PROTOCOL_VERSION,
    mode: config.mode,
    tools: 14
  });

  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    void server.close();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { message: String(err && err.message), stack: err && err.stack });
  });
  process.on('unhandledRejection', (err) => {
    logger.error('unhandled rejection', { message: String((err && err.message) || err) });
  });

  const code = await server.closed;
  logger.close();
  return typeof code === 'number' ? code : 0;
}

async function runAgentCommand(config, opts) {
  const logger = buildLogger(config, opts);
  const goal = opts.goal || opts.positional.join(' ').trim();
  if (!goal) {
    process.stderr.write('agent: missing goal. Usage: node src/index.js agent --goal "mine 3 oak logs"\n');
    return 2;
  }
  if (!resolveAgentApiKey(config, process.env)) {
    process.stderr.write(
      `agent: missing API key. Set the ${(config.agent && config.agent.apiKeyEnv) || 'DEEPSEEK_API_KEY'} environment variable.\n`
    );
    return 2;
  }
  const executor = new Executor({ config, env: process.env, logger });
  const controller = new AbortController();
  let interrupted = false;
  process.once('SIGINT', () => {
    interrupted = true;
    logger.warn('SIGINT received: aborting agent loop and disconnecting');
    controller.abort();
  });

  let report;
  try {
    report = await runDeepSeekAgent({
      config,
      executor,
      env: process.env,
      goal,
      maxSteps: opts.maxSteps,
      dryRun: opts.dryRun,
      logger,
      signal: controller.signal
    });
  } catch (err) {
    const message = err instanceof ToolError ? `${err.code}: ${err.message}` : String((err && err.message) || err);
    process.stderr.write(`agent error: ${message}\n`);
    report = { ok: false, error: { code: err && err.code ? err.code : 'agent_error', message } };
  } finally {
    await executor.close();
    logger.close();
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.ok) return 1;
  if (interrupted || report.aborted) return 130;
  return 0;
}

async function runDoctor(config, configPath, source, warnings, opts) {
  const logger = buildLogger(config, opts);
  const bridgeDir = path.join(__dirname, '..');
  const mineflayerPath = tryResolvePackage('mineflayer', [bridgeDir]);
  const minecraftDataPath = tryResolvePackage('minecraft-data/package.json', [bridgeDir]);
  const problems = validateModeReadiness(config, process.env);

  const report = {
    ok: problems.length === 0,
    node: process.version,
    platform: process.platform,
    cwd: process.cwd(),
    configPath,
    configSource: source,
    warnings,
    config: redactConfig(config, process.env),
    modeReadiness: problems,
    nodeModules: {
      mineflayer: { installed: !!mineflayerPath, path: mineflayerPath || null },
      minecraftData: minecraftDataPath ? { installed: true, version: packageVersion(minecraftDataPath) } : { installed: false }
    },
    secrets: {
      modTokenPresent: !!resolveModToken(process.env),
      agentApiKeyPresent: !!resolveAgentApiKey(config, process.env)
    },
    channelProbe: null
  };

  if (config.mode === 'mod') {
    const url = String((config.mod && config.mod.url) || '').replace(/\/+$/, '') + '/health';
    const startedAt = Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      report.channelProbe = {
        type: 'mod-health',
        url,
        reachable: response.ok,
        httpStatus: response.status,
        ms: Date.now() - startedAt,
        payload,
        tokenPresent: !!resolveModToken(process.env)
      };
    } catch (err) {
      report.channelProbe = {
        type: 'mod-health',
        url,
        reachable: false,
        ms: Date.now() - startedAt,
        error: String((err && err.message) || err)
      };
    }
  } else {
    const probe = await tcpProbe(config.bot.host, config.bot.port, 3000);
    report.channelProbe = {
      type: 'bot-tcp',
      host: config.bot.host,
      port: config.bot.port,
      reachable: probe.open,
      ms: probe.ms,
      error: probe.error
    };
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report.ok ? 0 : 3;
}

async function runProbe(config, opts) {
  const host = opts.host || (config.bot && config.bot.host) || '127.0.0.1';
  const ports = resolveProbePorts(opts, config);
  const startedAt = Date.now();
  const results = await mapWithConcurrency(ports, 64, (port) => tcpProbe(host, port, 400));
  const openPorts = results.filter((entry) => entry.open).map((entry) => ({ port: entry.port, ms: entry.ms }));
  const report = {
    ok: true,
    host,
    scanned: ports.length,
    ms: Date.now() - startedAt,
    openPorts,
    hint:
      'TCP-only scan. Minecraft LAN worlds use a random port (usually 49152-65535); pass --range to scan a window, then use the open port as bot.port.'
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (opts.command === 'probe') {
    // probe only needs the bot section; still load config for defaults/overrides
    const loaded = loadForCli(opts);
    return runProbe(loaded.config, opts);
  }
  let loaded;
  try {
    loaded = loadForCli(opts);
  } catch (err) {
    process.stderr.write(`config error: ${(err && err.message) || err}\n`);
    return 2;
  }
  const { config, configPath, source, warnings } = loaded;
  opts.configWarnings = warnings;

  switch (opts.command) {
    case 'serve':
      return runServe(config, opts);
    case 'agent':
      return runAgentCommand(config, opts);
    case 'doctor':
      return runDoctor(config, configPath, source, warnings, opts);
    case 'probe':
      return runProbe(config, opts);
    default:
      process.stderr.write(`unknown command: ${opts.command}\n`);
      return 2;
  }
}

module.exports = { main, parseArgs, HELP, resolveProbePorts, tcpProbe };
