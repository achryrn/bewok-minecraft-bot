'use strict';
/**
 * llm.js — pluggable LLM client used by every agent in the bot.
 *
 * Currently supports the Claude Code CLI (the deployment's canonical brain),
 * spawned per query via cmd.exe (Windows deployment). Every other agent
 * (planner, reflector, executor analysis) talks to the model through this one
 * class so retries, timeouts and JSON extraction are centralized.
 *
 * Robustness features:
 *   - hard timeout on the subprocess,
 *   - retry loop for malformed / missing JSON,
 *   - tolerant JSON extraction (markdown fences, trailing prose, CLI envelope),
 *   - pluggable provider hooks so a different model backend can be dropped in.
 */

const { spawn } = require('child_process');

class LLMClient {
  /**
   * @param {object} config - full bot config; brain section drives behavior
   *   config.brain: { provider, claudePath, timeoutMs, maxRetries, temperature }
   */
  constructor(config = {}) {
    const brainCfg = (config && config.brain) || {};
    this.provider = brainCfg.provider || 'claude';
    this.claudePath = brainCfg.claudePath || (config && config.claudePath) || 'claude';
    this.timeoutMs = brainCfg.timeoutMs || 30000;
    this.maxRetries = brainCfg.maxRetries !== undefined ? brainCfg.maxRetries : 2;
    this.debug = !!(config && config.debug);
  }

  /**
   * Ask the model for free text.
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @returns {Promise<string>} the model's text
   */
  async complete(systemPrompt, userPrompt) {
    const prompt = `${systemPrompt}

${userPrompt}`;
    return this._withRetry(() => this._runModel(prompt), {
      label: 'llm.complete',
      validate: (text) => text && text.trim().length > 0,
    });
  }

  /**
   * Ask the model for a JSON object (with retries + tolerant parsing).
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {Function} [validate] - optional validator for the parsed object
   * @returns {Promise<object>}
   */
  async completeJSON(systemPrompt, userPrompt, validate) {
    const instruction = 'Reply with a single JSON object only. No markdown fences, no commentary outside the JSON.';
    const prompt = `${systemPrompt}

${userPrompt}

${instruction}`;
    return this._withRetry(() => this._runModel(prompt), {
      label: 'llm.completeJSON',
      validate: (text) => {
        const parsed = this.extractJSON(text);
        if (!parsed) return false;
        if (validate && typeof validate === 'function') {
          try { return validate(parsed); } catch (_) { return false; }
        }
        return true;
      },
      transform: (text) => this.extractJSON(text),
    });
  }

  /* ───── Model runners ───── */

  async _runModel(prompt) {
    if (this.provider === 'claude') return this._runClaude(prompt);
    if (this.provider === 'debug') return this._runDebug(prompt);
    // Unknown provider — fall back to claude CLI rather than failing hard
    return this._runClaude(prompt);
  }

  /**
   * Spawn the Claude Code CLI once and return its printed output.
   * Windows deployment uses: claude --no-session-persistence --print --output-format json
   */
  _runClaude(prompt) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn('cmd.exe', ['/c', `${this.claudePath} --no-session-persistence --print --output-format json`], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(err);
        return;
      }

      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        reject(new Error('LLM timeout'));
      }, this.timeoutMs);

      let stdout = '';
      let stderr = '';
      child.stdin.write(prompt);
      child.stdin.end();

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`LLM exited with code ${code}: ${stderr.slice(0, 300)}`));
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          reject(new Error('LLM returned empty output'));
          return;
        }
        resolve(this._unwrapClaudeEnvelope(trimmed));
      });
    });
  }

  /**
   * The CLI with --output-format json wraps the model output in a JSON envelope
   * ({"type":"result",...,"result":"<model text>",...}). Unwrap it; if the raw
   * output is already plain model text/JSON, return it untouched.
   */
  _unwrapClaudeEnvelope(output) {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.result === 'string') {
          if (parsed.is_error || parsed.subtype === 'error') {
            throw new Error(`LLM reported error: ${parsed.result.slice(0, 200)}`);
          }
          return parsed.result;
        }
        // Already a plain action/envelope object — serialize back so callers see JSON text
        if (parsed.action || parsed.plan || parsed.reply !== undefined) {
          return output;
        }
      }
      return output;
    } catch (err) {
      if (err.message && err.message.startsWith('LLM reported error')) throw err;
      // Not JSON — treat as plain model text
      return output;
    }
  }

  /** Deterministic debug provider for tests/CI: echoes a canned response. */
  _runDebug(prompt) {
    return Promise.resolve('{"action":"chat","args":{"message":"Debug mode thinking."}}');
  }

  /* ───── Retry / extraction ───── */

  async _withRetry(runFn, { label, validate, transform }) {
    let lastErr = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const text = await runFn();
        if (validate && !validate(text)) {
          throw new Error(`${label}: output failed validation (attempt ${attempt + 1})`);
        }
        return transform ? transform(text) : text;
      } catch (err) {
        lastErr = err;
        if (this.debug) console.log(`[llm] ${label} attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
    }
    throw new Error(`${label} failed after ${this.maxRetries + 1} attempts: ${lastErr ? lastErr.message : 'unknown'}`);
  }

  /**
   * Robust JSON extraction from model output:
   *   1. strip markdown fences,
   *   2. if the whole trimmed string parses, return it,
   *   3. find the first balanced { ... } span and parse it,
   *   4. fail with null.
   * @param {string} text
   * @returns {object|null}
   */
  extractJSON(text) {
    if (!text || typeof text !== 'string') return null;
    let cleaned = text.trim();

    // Strip markdown code fences
    const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/;
    const fenceMatch = cleaned.match(fenceRegex);
    if (fenceMatch) cleaned = fenceMatch[1].trim();

    try {
      const parsed = JSON.parse(cleaned);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      // fall through to span extraction
    }

    // Find first balanced { ... } block
    const start = cleaned.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(cleaned.slice(start, i + 1));
            return parsed && typeof parsed === 'object' ? parsed : null;
          } catch (_) {
            return null;
          }
        }
      }
    }
    return null;
  }
}

module.exports = LLMClient;
