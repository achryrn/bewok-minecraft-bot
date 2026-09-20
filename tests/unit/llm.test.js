const LLMClient = require('../../src/llm');

jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const EE = require('events');
    const child = new EE();
    child.stdout = new EE();
    child.stderr = new EE();
    child.stdin = { write: jest.fn(), end: jest.fn() };
    child.kill = jest.fn();
    child.pid = 999;
    process.nextTick(() => {
      child.emit('close', 0);
    });
    return child;
  }),
}));
const { spawn } = require('child_process');

function makeChild(data, exitCode) {
  const EE = require('events');
  const child = new EE();
  child.stdout = new EE();
  child.stderr = new EE();
  child.stdin = { write: jest.fn(), end: jest.fn() };
  child.kill = jest.fn();
  process.nextTick(() => {
    if (data && child.stdout) child.stdout.emit('data', Buffer.from(data));
    child.emit('close', exitCode === undefined ? 0 : exitCode);
  });
  return child;
}

describe('LLMClient', () => {
  let llm;
  beforeEach(() => {
    jest.clearAllMocks();
    llm = new LLMClient({ debug: false, brain: { maxRetries: 1, timeoutMs: 2000 } });
  });

  describe('complete', () => {
    it('returns model text', async () => {
      spawn.mockReturnValue(makeChild('plain text'));
      expect(await llm.complete('sys', 'user')).toBe('plain text');
    });
  });

  describe('completeJSON', () => {
    it('parses plain JSON objects', async () => {
      spawn.mockReturnValue(makeChild('{"action":"chat","args":{"message":"hi"}}'));
      const out = await llm.completeJSON('sys', 'user');
      expect(out.action).toBe('chat');
    });

    it('unwraps claude CLI result envelope', async () => {
      const envelope = JSON.stringify({ type: 'result', subtype: 'success', result: '{"action":"move","args":{"x":1,"y":2,"z":3}}' });
      spawn.mockReturnValue(makeChild(envelope));
      const out = await llm.completeJSON('sys', 'user');
      expect(out.action).toBe('move');
    });

    it('strips markdown fences', async () => {
      const fenced = '\`\`\`json\n{"reply":"hello","plan":[]}\n\`\`\`';
      spawn.mockReturnValue(makeChild(fenced));
      const out = await llm.completeJSON('sys', 'user');
      expect(out.reply).toBe('hello');
    });

    it('extracts JSON from trailing prose', async () => {
      spawn.mockReturnValue(makeChild('Sure, here is the JSON: {"action":"status","args":{}} hope that helps!'));
      const out = await llm.completeJSON('sys', 'user');
      expect(out.action).toBe('status');
    });

    it('retries on invalid JSON then fails', async () => {
      spawn.mockImplementation(() => makeChild('not json at all'));
      await expect(llm.completeJSON('sys', 'user')).rejects.toThrow(/failed after/);
      expect(spawn).toHaveBeenCalledTimes(2); // initial + 1 retry (maxRetries=1)
    });

    it('retries on nonzero exit', async () => {
      spawn.mockImplementation(() => makeChild('', 1));
      await expect(llm.completeJSON('sys', 'user')).rejects.toThrow(/failed after/);
    });
  });

  describe('extractJSON', () => {
    it('handles null-ish inputs', () => {
      expect(llm.extractJSON(null)).toBeNull();
      expect(llm.extractJSON('')).toBeNull();
      expect(llm.extractJSON('no braces')).toBeNull();
    });
  });
});
