'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { runDeepSeekAgent } = require('../src/agent/deepseek');
const { makeConfig } = require('./helpers/config');
const { createLogger } = require('../src/logger');

const quietLogger = createLogger({ level: 'silent' });

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

/**
 * Mock OpenAI-compatible /chat/completions endpoint.
 * Scripted `responses` are consumed in order; each may carry `__httpStatus`.
 */
function startMockOpenAI(responses) {
  const requests = [];
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
      sendJson(response, 404, { error: { message: 'not found' } });
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = { __invalid: true };
      }
      requests.push({ headers: request.headers, body });
      const scripted = responses.length > 0 ? responses.shift() : { choices: [{ message: { content: 'fallback done', tool_calls: [] } }] };
      if (scripted.__httpStatus) {
        sendJson(response, scripted.__httpStatus, { error: { message: 'upstream boom' } });
        return;
      }
      setTimeout(() => sendJson(response, 200, scripted), 5);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () =>
          new Promise((done) => {
            try {
              server.closeAllConnections();
            } catch {
              /* older node */
            }
            server.close(() => done());
          })
      });
    });
  });
}

function toolCallResponse(id, name, args) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
        }
      }
    ]
  };
}

function finalResponse(content) {
  return { choices: [{ message: { role: 'assistant', content, tool_calls: [] } }], usage: { total_tokens: 42 } };
}

function fakeExecutor(handler) {
  const calls = [];
  return {
    calls,
    async execute(name, args) {
      calls.push({ name, args });
      if (handler) return handler(name, args);
      return { ok: true, tool: name, args };
    },
    async close() {}
  };
}

function agentConfig(overrides = {}) {
  return makeConfig(Object.assign({ agent: { maxSteps: 10, temperature: 0.1 } }, overrides));
}

test('agent loop executes tool calls and stops on the final answer', async () => {
  const mock = await startMockOpenAI([
    toolCallResponse('call_1', 'mc_state', {}),
    toolCallResponse('call_2', 'mc_chat', { message: 'hi from agent' }),
    finalResponse('All done: state inspected and chat sent.')
  ]);
  const executor = fakeExecutor();
  const controller = new AbortController();
  try {
    const report = await runDeepSeekAgent({
      config: agentConfig({ agent: { baseUrl: mock.url } }),
      executor,
      env: { DEEPSEEK_API_KEY: 'sk-test-key' },
      goal: 'say hi',
      maxSteps: 5,
      logger: quietLogger,
      signal: controller.signal
    });

    assert.equal(report.ok, true);
    assert.equal(report.finalAnswer, 'All done: state inspected and chat sent.');
    assert.equal(report.steps, 3);
    assert.equal(report.toolCalls.length, 2);
    assert.equal(report.toolCalls[0].name, 'mc_state');
    assert.equal(report.toolCalls[1].name, 'mc_chat');
    assert.deepEqual(report.toolCalls[1].args, { message: 'hi from agent' });
    assert.equal(report.usage.total_tokens, 42);

    // initial mc_state seed + the two scripted tool calls
    assert.deepEqual(executor.calls.map((call) => call.name), ['mc_state', 'mc_state', 'mc_chat']);

    assert.equal(mock.requests.length, 3);
    assert.equal(mock.requests[0].headers.authorization, 'Bearer sk-test-key');
    assert.equal(mock.requests[0].body.model, 'deepseek-chat');
    assert.equal(mock.requests[0].body.stream, false);
    assert.ok(Array.isArray(mock.requests[0].body.tools));
    assert.equal(mock.requests[0].body.tools.length, 14);
    assert.equal(mock.requests[0].body.tools[0].type, 'function');
    assert.equal(mock.requests[1].body.messages[0].role, 'system');
    const toolMessage = mock.requests[1].body.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage, 'tool result must be fed back to the model');
    assert.equal(toolMessage.tool_call_id, 'call_1');
    assert.equal(JSON.parse(toolMessage.content).ok, true);
  } finally {
    await mock.close();
  }
});

test('agent dry-run plans tool calls without executing them', async () => {
  const mock = await startMockOpenAI([
    toolCallResponse('call_1', 'mc_move', { x: 10, y: 64, z: 10 })
  ]);
  const executor = fakeExecutor();
  try {
    const report = await runDeepSeekAgent({
      config: agentConfig({ agent: { baseUrl: mock.url } }),
      executor,
      env: { DEEPSEEK_API_KEY: 'sk-test-key' },
      goal: 'walk east',
      maxSteps: 5,
      dryRun: true,
      logger: quietLogger
    });
    assert.equal(report.ok, true);
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.plan, [{ name: 'mc_move', args: { x: 10, y: 64, z: 10 } }]);
    // only the initial state snapshot was executed
    assert.deepEqual(executor.calls.map((call) => call.name), ['mc_state']);
  } finally {
    await mock.close();
  }
});

test('agent honours maxSteps', async () => {
  const mock = await startMockOpenAI([
    toolCallResponse('c1', 'mc_state', {}),
    toolCallResponse('c2', 'mc_state', {}),
    toolCallResponse('c3', 'mc_state', {}),
    finalResponse('unreachable')
  ]);
  const executor = fakeExecutor();
  try {
    const report = await runDeepSeekAgent({
      config: agentConfig({ agent: { baseUrl: mock.url } }),
      executor,
      env: { DEEPSEEK_API_KEY: 'sk-test-key' },
      goal: 'loop forever',
      maxSteps: 2,
      logger: quietLogger
    });
    assert.equal(report.ok, true);
    assert.equal(report.stoppedReason, 'max_steps');
    assert.equal(report.steps, 2);
    assert.equal(report.toolCalls.length, 2);
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
  }
});

test('agent reports missing API key before any network call', async () => {
  const executor = fakeExecutor();
  await assert.rejects(
    () =>
      runDeepSeekAgent({
        config: agentConfig(),
        executor,
        env: {},
        goal: 'do something',
        logger: quietLogger
      }),
    (err) => err.code === 'missing_api_key'
  );
});

test('agent reports missing goal', async () => {
  const executor = fakeExecutor();
  await assert.rejects(
    () =>
      runDeepSeekAgent({
        config: agentConfig(),
        executor,
        env: { DEEPSEEK_API_KEY: 'sk-test-key' },
        goal: '   ',
        logger: quietLogger
      }),
    (err) => err.code === 'missing_goal'
  );
});

test('agent maps DeepSeek HTTP errors to deepseek_api_error', async () => {
  const mock = await startMockOpenAI([{ __httpStatus: 500 }]);
  const executor = fakeExecutor();
  try {
    await assert.rejects(
      () =>
        runDeepSeekAgent({
          config: agentConfig({ agent: { baseUrl: mock.url } }),
          executor,
          env: { DEEPSEEK_API_KEY: 'sk-test-key' },
          goal: 'fail',
          logger: quietLogger
        }),
      (err) => err.code === 'deepseek_api_error'
    );
  } finally {
    await mock.close();
  }
});

test('agent survives invalid tool_call arguments and reports them to the model', async () => {
  const invalidArgsResponse = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'bad', type: 'function', function: { name: 'mc_move', arguments: 'not-json' } }]
        }
      }
    ]
  };
  const mock = await startMockOpenAI([invalidArgsResponse, finalResponse('recovered')]);
  const executor = fakeExecutor();
  try {
    const report = await runDeepSeekAgent({
      config: agentConfig({ agent: { baseUrl: mock.url } }),
      executor,
      env: { DEEPSEEK_API_KEY: 'sk-test-key' },
      goal: 'bad call',
      logger: quietLogger
    });
    assert.equal(report.ok, true);
    assert.equal(report.finalAnswer, 'recovered');
    assert.equal(report.toolCalls[0].result.error.code, 'invalid_arguments');
    // only the initial seed ran on the executor
    assert.deepEqual(executor.calls.map((call) => call.name), ['mc_state']);
  } finally {
    await mock.close();
  }
});

test('agent stops immediately when the signal is already aborted', async () => {
  const executor = fakeExecutor();
  const controller = new AbortController();
  controller.abort();
  const report = await runDeepSeekAgent({
    config: agentConfig({ agent: { baseUrl: 'http://127.0.0.1:1' } }),
    executor,
    env: { DEEPSEEK_API_KEY: 'sk-test-key' },
    goal: 'aborted run',
    logger: quietLogger,
    signal: controller.signal
  });
  assert.equal(report.ok, true);
  assert.equal(report.aborted, true);
});
