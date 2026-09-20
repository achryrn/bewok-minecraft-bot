'use strict';
/**
 * executor.js - retry / failsafe wrapper around every bot action.
 *
 * Requirements driving this file:
 *   - "retry upon failure": every action gets a bounded, backoff retry loop,
 *   - "failsafe": failures are classified (stuck, no block, inventory full,
 *     no path, danger, timeout) and handled with the least harmful fallback,
 *   - "interactive": retries and failures surface progress to the player so
 *     the bot never silently hangs,
 *   - "decisive": if a retry still fails, the executor reports a clear outcome
 *     instead of leaving the task half-done with no message.
 */

class ActionError extends Error {
  /**
   * @param {string} message
   * @param {string} reason - one of classifyError()'s reason codes
   * @param {object} detail
   */
  constructor(message, reason, detail) {
    super(message);
    this.name = 'ActionError';
    this.reason = reason || 'unknown';
    this.detail = detail || {};
  }
}

const REASON_PATTERNS = [
  [/timeout|timed out/i, 'timeout'],
  [/no path|unreachable|cannot reach|noPath/i, 'no-path'],
  [/inventory (is )?full|no space|out of space/i, 'inventory-full'],
  [/no .+ found|not found|no more/i, 'no-block'],
  [/no .+ in (inventory|stock)|missing item|don't have|do not have/i, 'missing-item'],
  [/lava|on fire|burning/i, 'danger-lava'],
  [/dead|killed/i, 'dead'],
  [/stuck/i, 'stuck'],
  [/enoe?nt|spawn|not found: claude|brain offline|llm/i, 'brain-offline'],
];

class ActionExecutor {
  /**
   * @param {object} config - bot config
   * @param {Function} [say] - async (message) => void, used for progress updates
   */
  constructor(config, say) {
    this.config = config || {};
    this.say = say || (() => {});
    const retryCfg = this.config.retry || {};
    this.defaultRetries = retryCfg.defaultRetries !== undefined ? retryCfg.defaultRetries : 2;
    this.retryDelayMs = retryCfg.retryDelayMs !== undefined ? retryCfg.retryDelayMs : 1200;
  }

  /**
   * Classify an error into a stable reason code (for failsafe decisions).
   * @param {Error|string} err
   * @returns {string}
   */
  classifyError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const [pattern, reason] of REASON_PATTERNS) {
      if (pattern.test(msg)) return reason;
    }
    return 'unknown';
  }

  /**
   * Run a function with bounded retries + backoff.
   * @param {Function} runFn - () => Promise<any>
   * @param {object} [opts]
   * @param {number} [opts.maxRetries]
   * @param {number} [opts.delayMs]
   * @param {Function} [opts.shouldRetry] - (err) => boolean, default always true
   * @param {Function} [opts.onRetry] - (err, attempt) => void
   */
  async withRetry(runFn, opts) {
    const maxRetries = (opts && opts.maxRetries !== undefined) ? opts.maxRetries : this.defaultRetries;
    const delayMs = (opts && opts.delayMs) || this.retryDelayMs;
    const shouldRetry = (opts && opts.shouldRetry) || (() => true);
    const onRetry = (opts && opts.onRetry) || (() => {});

    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await runFn();
        if (attempt > 0 && lastErr) await this.say('Retry succeeded this time.');
        return result;
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries && shouldRetry(err)) {
          const delay = delayMs * Math.pow(2, attempt);
          await onRetry(err, attempt + 1);
          await new Promise((r) => setTimeout(r, delay));
        } else {
          break;
        }
      }
    }
    throw lastErr || new Error('Action failed');
  }

  /**
   * Run a promise factory with a hard deadline.
   * @param {Function} fn - () => Promise<any>
   * @param {number} ms
   */
  async withTimeout(fn, ms) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ActionError('Action timed out after ' + ms + 'ms', 'timeout', { ms })), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Execute an action with retry + classification + failsafe messaging.
   * @param {object} spec
   * @param {string} spec.action - action name
   * @param {object} spec.args
   * @param {Function} spec.execute - (args) => Promise<any>
   * @param {Function} [spec.onProgress] - (message) => void
   * @param {number} [spec.maxRetries]
   * @returns {Promise<{ok: boolean, action: string, attempts: number, error: ActionError|null}>}
   */
  async dispatch(spec) {
    const { action, args, execute } = spec;
    const onProgress = spec.onProgress || (() => {});
    const maxRetries = spec.maxRetries !== undefined ? spec.maxRetries : this.defaultRetries;
    let attempts = 0;
    try {
      const result = await this.withRetry(
        async () => {
          attempts++;
          return execute(args);
        },
        {
          maxRetries,
          onRetry: (err, attempt) => {
            const reason = this.classifyError(err);
            onProgress('Action "' + action + '" hiccup (' + attempt + '/' + (maxRetries + 1) + '): ' + reason + ' - retrying.');
          },
        }
      );
      return { ok: true, action, attempts, result };
    } catch (err) {
      const reason = this.classifyError(err);
      const wrapped = err instanceof ActionError ? err : new ActionError((err && err.message) || String(err), reason, { action });
      return { ok: false, action, attempts, error: wrapped };
    }
  }
}

module.exports = { ActionExecutor, ActionError, REASON_PATTERNS };
