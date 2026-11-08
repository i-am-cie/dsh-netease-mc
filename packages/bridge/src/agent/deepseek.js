'use strict';

const { ToolError } = require('../errors');
const { toOpenAITools } = require('../tools');
const { resolveAgentApiKey } = require('../config');

const SYSTEM_PROMPT = [
  'You are an autonomous Minecraft agent. You control one player through tools.',
  'Work step by step: inspect the world first (mc_state, mc_players, mc_inventory, mc_nearby_*),',
  'then act with mc_move / mc_mine / mc_place / mc_use / mc_attack / mc_chat / mc_command.',
  'Respect failures: read the returned error code and adapt instead of repeating the same call blindly.',
  'When the goal is reached, stop calling tools and answer with a short final report (what you did, where you are, anything left).',
  'Never invent tool results. Coordinates are Minecraft block coordinates (numbers).'
].join(' ');

function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

function safeParseArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return undefined;
  }
}

async function callChatCompletions({ url, apiKey, body, fetchImpl, signal }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: signal || undefined
    });
  } catch (err) {
    if (signal && signal.aborted) throw new ToolError('aborted', 'agent loop aborted by user');
    throw new ToolError('deepseek_unreachable', `DeepSeek API request failed: ${err.message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new ToolError('deepseek_api_error', `DeepSeek API HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError('deepseek_invalid_response', `DeepSeek API returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Autonomous DeepSeek function-calling loop (ARCHITECTURE.md §6).
 *
 * - tools = MCP tool set (mc_agent excluded; it does not exist)
 * - policy gates and channel execution happen inside the injected Executor
 * - --dry-run: ask the model for a plan, print it, execute nothing
 * - AbortSignal (Ctrl+C in the CLI) stops between steps and cancels the HTTP call
 *
 * @returns {Promise<object>} run report
 */
async function runDeepSeekAgent({
  config,
  executor,
  env = process.env,
  goal,
  maxSteps,
  dryRun = false,
  logger,
  fetchImpl = globalThis.fetch,
  signal = null
}) {
  const agentCfg = (config && config.agent) || {};
  const apiKey = resolveAgentApiKey(config, env);
  if (!apiKey) {
    throw new ToolError(
      'missing_api_key',
      `the agent needs a DeepSeek API key: set the ${agentCfg.apiKeyEnv || 'DEEPSEEK_API_KEY'} environment variable`
    );
  }
  const goalText = typeof goal === 'string' ? goal.trim() : '';
  if (!goalText) throw new ToolError('missing_goal', 'the agent needs a goal, e.g. --goal "mine 3 oak logs"');

  const stepsLimit = Number.isFinite(Number(maxSteps)) && Number(maxSteps) > 0
    ? Math.floor(Number(maxSteps))
    : Number.isFinite(Number(agentCfg.maxSteps))
      ? Math.floor(Number(agentCfg.maxSteps))
      : 40;

  const url = chatCompletionsUrl(agentCfg.baseUrl);
  const tools = toOpenAITools();
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  // Seed the model with the current state (best effort; tools still enforce their own errors).
  let initialState = null;
  try {
    initialState = await executor.execute('mc_state', {});
  } catch (err) {
    initialState = { ok: false, error: { code: 'state_unavailable', message: String(err && err.message) } };
  }
  messages.push({
    role: 'user',
    content: `Goal: ${goalText}\nCurrent state: ${JSON.stringify(initialState)}`
  });

  const toolCalls = [];
  let step = 0;
  let usage = null;

  while (step < stepsLimit) {
    if (signal && signal.aborted) {
      return { ok: true, aborted: true, steps: step, toolCalls, finalAnswer: null, dryRun };
    }
    step += 1;

    const body = {
      model: agentCfg.model || 'deepseek-chat',
      messages,
      temperature: Number.isFinite(Number(agentCfg.temperature)) ? Number(agentCfg.temperature) : 0.3,
      stream: false,
      tools,
      tool_choice: 'auto'
    };
    if (logger) logger.info('agent request', { step, model: body.model, messages: messages.length });
    const response = await callChatCompletions({ url, apiKey, body, fetchImpl, signal });
    if (response && response.usage) usage = response.usage;

    const choice = Array.isArray(response.choices) ? response.choices[0] : null;
    const message = choice && choice.message ? choice.message : null;
    if (!message) throw new ToolError('deepseek_bad_response', 'DeepSeek API response has no choices[0].message');

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length === 0) {
      return {
        ok: true,
        steps: step,
        toolCalls,
        finalAnswer: typeof message.content === 'string' ? message.content : '',
        usage,
        dryRun
      };
    }

    if (dryRun) {
      const plan = calls.map((call) => ({
        name: call.function && call.function.name,
        args: safeParseArguments(call.function && call.function.arguments)
      }));
      return { ok: true, dryRun: true, steps: step, plan, toolCalls: plan, finalAnswer: null, usage };
    }

    messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls });

    for (const call of calls) {
      const name = call.function && call.function.name ? String(call.function.name) : '';
      const parsedArgs = safeParseArguments(call.function && call.function.arguments);
      let result;
      if (parsedArgs === undefined) {
        result = { ok: false, error: { code: 'invalid_arguments', message: `arguments for ${name} are not valid JSON` } };
      } else {
        result = await executor.execute(name, parsedArgs);
      }
      toolCalls.push({ step, name, args: parsedArgs === undefined ? null : parsedArgs, result });
      if (logger) logger.info('agent tool result', { step, tool: name, ok: result.ok === true, code: result.ok === true ? undefined : result.error && result.error.code });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result)
      });
      if (signal && signal.aborted) {
        return { ok: true, aborted: true, steps: step, toolCalls, finalAnswer: null, dryRun };
      }
    }
  }

  return { ok: true, stoppedReason: 'max_steps', steps: step, toolCalls, finalAnswer: null, usage, dryRun };
}

module.exports = { runDeepSeekAgent, SYSTEM_PROMPT, chatCompletionsUrl, safeParseArguments };
