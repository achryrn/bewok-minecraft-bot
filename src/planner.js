'use strict';
/**
 * planner.js - the "decides what to do" agent.
 *
 * The planner receives the bot's FULL live context (see context.js), its memory,
 * recent conversation and the player's natural-language request, and returns a
 * plan: what to say + an ordered list of {action, args} steps.
 *
 * Personality of the planner (per requirements):
 *   - decisive: picks the most sensible interpretation when ambiguous and acts,
 *   - direct: minimal chatter, action over words,
 *   - smart: chooses the right tool/action for the request,
 *   - interactive: acknowledges, asks a quick question only when truly stuck,
 *   - long tasks: emits multi-step plans with progress callouts.
 *
 * It accepts both the legacy single-action format ({action,args}) and the new
 * envelope format ({reply, think, plan, remember}), so older prompts/configs
 * keep working.
 */

const KNOWN_ACTIONS = new Set([
  'chat', 'move', 'mine', 'gather', 'follow', 'stop', 'attack', 'craft', 'drop',
  'come', 'status', 'findore', 'explore', 'build', 'chain', 'equip', 'cycle',
  'remember', 'recall', 'wait', 'jump', 'sprint', 'sneak', 'greet',
]);

const ACTION_GUIDE = [
  'Available actions (use sparingly; one or few per plan):',
  '- chat        {message} - say something in chat (the only way you speak)',
  '- move        {x, y, z} - walk to a position',
  '- mine        {block, count?} - dig N of a block (alias gather)',
  '- follow      {player} - follow a player around',
  '- stop        {} - halt everything',
  '- attack      {target} - attack a mob/player by name (e.g. "zombie")',
  '- craft       {item, count?} - craft an item you have ingredients for',
  '- drop        {item, count?} - throw away items',
  '- come        {player} - walk over to the player',
  '- status      {} - announce your health/position/task',
  '- findore     {ore, radius?} - locate ore via server-side botbridge scan',
  '- explore     {direction?} - walk in a direction and scout',
  '- build       {shape, material, width, length?, height?} - build platform/wall/cube/pillar',
  '- chain       {steps: [{action, args}]} - run several actions in order',
  '- equip       {item} - hold an item (e.g. sword, pickaxe)',
  '- cycle       {} - swap hotbar slot',
  '- remember    {text} - store a lesson/fact into long-term memory',
  '- recall      {topic?} - read long-term memory and report',
  '- wait        {seconds?} - pause briefly',
  '- jump/sprint/sneak - movement toggles',
].join('\n');

function buildSystemPrompt(config) {
  const personaName = (config && config.persona && config.persona.name) || 'an adventurer';
  const serverType = (config && config.auth === 'offline') ? 'a crack/offline-mode server' : 'the server';
  return [
    'You are ' + personaName + ', a real Minecraft player currently connected to ' + serverType + '. You are NOT an AI chatbot running outside the game: you live inside the world, you can feel the sun on your skin, hear the wind, smell the dirt. Everything in the "CONTEXT" section below is your actual, live experience right now - your health, your hunger, the blocks around you, the mobs you can see. Reason and reply as the character would: first person, present tense, concrete, no meta talk about being a bot or an AI model.',
    '',
    'RULES',
    '1. Decisive: when the player request is ambiguous, choose the most sensible interpretation, announce your assumption in reply, and act. Never stall on questions you can answer yourself.',
    '2. Direct: act first, explain briefly. Players on a server want quick, helpful results.',
    '3. Failsafe: if an action would be unsafe (digging into lava, attacking a much stronger mob at low health), pick a safer alternative or say why not.',
    '4. Retry-minded: if something in a long plan fails, your reflection agent learns; do not repeat known-failure patterns (check MEMORY lessons).',
    '5. Multi-step: long requests (build a house, gather a stack) become ordered plan steps.',
    '6. You always see live values in CONTEXT - inventory is what you actually carry; never claim you have items that are not listed.',
    '7. Reply JSON ONLY, no extra prose outside the JSON object.',
    '8. Professional tone: reply as a helpful, competent player. First person, plain ASCII text only, and never use emojis, emoticons, or decorative symbols.',
    '',
    'OUTPUT FORMAT (always one JSON object):',
    '{',
    '  "reply": "what you say in chat right now (\\\"\\\" if you act silently)",',
    '  "think": "a short private reasoning line (never shown to players)",',
    '  "plan": [ {"action": "...", "args": {...}} ],',
    '  "remember": [ {"type": "lesson|fact|location", "text"?: "...", "fact"?: ["key","value"], "location"?: ["type","x","y","z","quality"]} ]',
    '}',
    'Legacy single-action format still accepted: {"action":"...","args":{...}}.',
    ACTION_GUIDE,
  ].join('\n');
}

function buildUserPrompt(playerName, intent, ctx, historyStr) {
  let ctxJson = '{}';
  try { ctxJson = JSON.stringify(ctx, null, 2); } catch (_) {}
  return 'Recent conversation:\n' + (historyStr || '(none)') +
    '\n\nPlayer ' + playerName + ' says: ' + intent +
    '\n\nLIVE CONTEXT (this is reality right now):\n' + ctxJson;
}

/**
 * Normalize a raw model response into a planner result.
 * Accepts: legacy {action,args} or envelope {reply, plan, remember}.
 * Unknown actions are dropped (failsafe) but remembered so the bot can learn.
 * @param {object} raw
 * @returns {{reply: string, plan: Array<{action:string,args:object}>, remember: Array<object>}}
 */
function normalizePlan(raw) {
  const result = { reply: '', plan: [], remember: [] };
  if (!raw || typeof raw !== 'object') return result;

  // Legacy single-action
  if (raw.action && typeof raw.action === 'string') {
    if (raw.action === 'chat' && raw.args && raw.args.message) {
      result.reply = String(raw.args.message);
    } else {
      result.plan.push({ action: raw.action, args: raw.args || {} });
    }
    return result;
  }

  if (typeof raw.reply === 'string') result.reply = raw.reply;
  if (Array.isArray(raw.remember)) result.remember = raw.remember;

  if (Array.isArray(raw.plan)) {
    for (const step of raw.plan) {
      if (!step || typeof step !== 'object' || typeof step.action !== 'string') continue;
      if (!KNOWN_ACTIONS.has(step.action)) continue;
      result.plan.push({ action: step.action, args: step.args && typeof step.args === 'object' ? step.args : {} });
    }
  }
  return result;
}

class PlannerAgent {
  /**
   * @param {object} config - bot config
   * @param {LLMClient} llm
   */
  constructor(config, llm) {
    this.config = config;
    this.llm = llm;
    this.systemPrompt = buildSystemPrompt(config);
  }

  /**
   * Decide what the bot says and does.
   * @param {string} playerName
   * @param {string} intent
   * @param {object} ctx - full context from context.js
   * @param {string} historyStr
   * @returns {Promise<{reply: string, plan: Array, remember: Array, raw: *}>}
   */
  async plan(playerName, intent, ctx, historyStr) {
    const userPrompt = buildUserPrompt(playerName, intent, ctx, historyStr);
    let raw;
    try {
      raw = await this.llm.completeJSON(this.systemPrompt, userPrompt, (parsed) => {
        return !!(parsed && (parsed.action || Array.isArray(parsed.plan) || typeof parsed.reply === 'string'));
      });
    } catch (err) {
      throw new Error('Planner failed: ' + err.message);
    }
    const normalized = normalizePlan(raw);
    return { ...normalized, raw };
  }
}

module.exports = { PlannerAgent, normalizePlan, buildSystemPrompt, buildUserPrompt, KNOWN_ACTIONS };
