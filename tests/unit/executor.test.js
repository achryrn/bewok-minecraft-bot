const { ActionExecutor, ActionError } = require('../../src/executor');

describe('executor.js', () => {
  let ex;
  beforeEach(() => {
    ex = new ActionExecutor({ retry: { defaultRetries: 2, retryDelayMs: 5 } }, jest.fn());
  });

  describe('classifyError', () => {
    it('classifies common failure modes', () => {
      expect(ex.classifyError(new Error('No path to goal'))).toBe('no-path');
      expect(ex.classifyError('timed out')).toBe('timeout');
      expect(ex.classifyError('Inventory is full')).toBe('inventory-full');
      expect(ex.classifyError('No iron_ore found')).toBe('no-block');
      expect(ex.classifyError('No oak_log in inventory')).toBe('missing-item');
      expect(ex.classifyError('stand in lava')).toBe('danger-lava');
      expect(ex.classifyError('spawn ENOENT')).toBe('brain-offline');
      expect(ex.classifyError('something weird')).toBe('unknown');
    });
  });

  describe('withRetry', () => {
    it('succeeds on first try', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      expect(await ex.withRetry(fn)).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries then succeeds', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('boom 1'))
        .mockRejectedValueOnce(new Error('boom 2'))
        .mockResolvedValue('finally');
      expect(await ex.withRetry(fn, { maxRetries: 3, delayMs: 1 })).toBe('finally');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('gives up after maxRetries', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('persistent'));
      await expect(ex.withRetry(fn, { maxRetries: 1, delayMs: 1 })).rejects.toThrow('persistent');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('respects shouldRetry guard', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('dont retry this'));
      await expect(ex.withRetry(fn, { maxRetries: 5, shouldRetry: () => false })).rejects.toThrow('dont retry this');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('withTimeout', () => {
    it('resolves when fn finishes', async () => {
      expect(await ex.withTimeout(async () => 'done', 100)).toBe('done');
    });

    it('rejects when fn hangs', async () => {
      await expect(ex.withTimeout(() => new Promise(() => {}), 10)).rejects.toThrow(/timed out/);
    });
  });

  describe('dispatch', () => {
    it('reports ok with result', async () => {
      const out = await ex.dispatch({ action: 'mine', args: {}, execute: async () => 'mined' });
      expect(out.ok).toBe(true);
      expect(out.result).toBe('mined');
      expect(out.attempts).toBe(1);
    });

    it('reports failure with classified error', async () => {
      const out = await ex.dispatch({
        action: 'move',
        args: {},
        maxRetries: 0,
        execute: async () => { throw new Error('No path to goal'); },
      });
      expect(out.ok).toBe(false);
      expect(out.error).toBeInstanceOf(ActionError);
      expect(out.error.reason).toBe('no-path');
    });

    it('calls onProgress during retries', async () => {
      const progress = jest.fn();
      let calls = 0;
      const out = await ex.dispatch({
        action: 'mine',
        args: {},
        maxRetries: 1,
        onProgress: progress,
        execute: async () => {
          calls++;
          if (calls < 2) throw new Error('transient');
          return true;
        },
      });
      expect(out.ok).toBe(true);
      expect(out.attempts).toBe(2);
      expect(progress).toHaveBeenCalled();
    });
  });
});
