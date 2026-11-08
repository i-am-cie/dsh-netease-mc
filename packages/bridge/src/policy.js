'use strict';

/**
 * Permission gate (ARCHITECTURE.md §3): every tool call passes through this
 * check before the channel is touched. Denied calls return a structured error
 * instead of silently degrading (e.g. never fake `mc_command` success).
 */

const DENIED_CODE = 'operation_not_allowed';

/** Tool -> policy capability. Chat/move/attack have special cases in requiredCapabilities(). */
const TOOL_CAPABILITY = Object.freeze({
  mc_status: 'allowRead',
  mc_state: 'allowRead',
  mc_players: 'allowRead',
  mc_inventory: 'allowRead',
  mc_nearby_entities: 'allowRead',
  mc_nearby_blocks: 'allowRead',
  mc_block: 'allowRead',
  mc_move: 'allowMove',
  mc_mine: 'allowWorldWrite',
  mc_place: 'allowWorldWrite',
  mc_use: 'allowWorldWrite',
  mc_attack: 'allowAttack',
  mc_chat: 'allowChat',
  mc_command: 'allowCommands'
});

/**
 * @param {object} policy config.policy
 * @param {string} toolName
 * @param {object} [args]
 * @returns {string[]} capabilities that must be true
 */
function requiredCapabilities(policy, toolName, args = {}) {
  if (toolName === 'mc_chat') {
    // Reading chat is a read tool; sending is a chat tool.
    const isRead = args.read === true || (args.read === undefined && args.message === undefined);
    return [isRead ? 'allowRead' : 'allowChat'];
  }
  const capability = TOOL_CAPABILITY[toolName];
  return capability ? [capability] : [];
}

/**
 * Check a tool call against the policy.
 * @returns {null | {ok:false,error:{code:string,message:string}}}
 */
function checkPolicy(policy, toolName, args = {}) {
  const effective = policy || {};
  const capabilities = requiredCapabilities(effective, toolName, args);
  for (const capability of capabilities) {
    if (effective[capability] === false) {
      return {
        ok: false,
        error: {
          code: DENIED_CODE,
          message: `${toolName} is disabled by policy (${capability}=false); update the bridge config to allow it`
        }
      };
    }
  }
  return null;
}

module.exports = { TOOL_CAPABILITY, DENIED_CODE, requiredCapabilities, checkPolicy };
