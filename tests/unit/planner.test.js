const { normalizePlan, buildSystemPrompt, buildUserPrompt, KNOWN_ACTIONS } = require('../../src/planner');
const PlannerAgent = require('../../src/planner').PlannerAgent;

describe('planner.js', () => {
  describe('normalizePlan', () => {
    it('accepts legacy single-action format', () => {
      const out = normalizePlan({ action: 'mine', args: { block: 'oak_log', count: 4 } });
      expect(out.plan).toEqual([{ action: 'mine', args: { block: 'oak_log', count: 4 } }]);
      expect(out.reply).toBe('');
    });

    it('converts legacy chat action to reply', () => {
      const out = normalizePlan({ action: 'chat', args: { message: 'hello!' } });
      expect(out.reply).toBe('hello!');
      expect(out.plan).toEqual([]);
    });

    it('accepts envelope format', () => {
      const raw = {
        reply: 'On it!',
        think: 'private',
        plan: [{ action: 'move', args: { x: 1, y: 2, z: 3 } }, { action: 'mine', args: { block: 'dirt', count: 8 } }],
        remember: [{ type: 'lesson', text: 'watch for lava' }],
      };
      const out = normalizePlan(raw);
      expect(out.reply).toBe('On it!');
      expect(out.plan).toHaveLength(2);
      expect(out.remember).toHaveLength(1);
    });

    it('drops unknown actions', () => {
      const out = normalizePlan({ plan: [{ action: 'fly', args: {} }, { action: 'wait', args: { seconds: 1 } }] });
      expect(out.plan).toEqual([{ action: 'wait', args: { seconds: 1 } }]);
    });

    it('handles garbage', () => {
      expect(normalizePlan(null).plan).toEqual([]);
      expect(normalizePlan('nope').plan).toEqual([]);
      expect(normalizePlan({}).plan).toEqual([]);
    });
  });

  describe('buildSystemPrompt', () => {
    it('mentions offline servers when auth is offline', () => {
      const p = buildSystemPrompt({ auth: 'offline', persona: { name: 'Rex' } });
      expect(p).toContain('Rex');
      expect(p).toContain('offline-mode');
    });

    it('includes the action guide', () => {
      const p = buildSystemPrompt({});
      expect(p).toContain('findore');
      expect(p).toContain('JSON');
    });
  });

  describe('buildUserPrompt', () => {
    it('includes player, intent and serialized context', () => {
      const p = buildUserPrompt('Alex', 'mine some stone', { health: 20, position: { x: 1, y: 2, z: 3 } }, 'history...');
      expect(p).toContain('Alex');
      expect(p).toContain('mine some stone');
      expect(p).toContain('"health": 20');
    });
  });

  describe('PlannerAgent', () => {
    it('normalizes model output through llm', async () => {
      const llm = { completeJSON: jest.fn().mockResolvedValue({ reply: 'done', plan: [{ action: 'status', args: {} }] }) };
      const agent = new PlannerAgent({}, llm);
      const out = await agent.plan('Alex', 'status?', { health: 20 }, '');
      expect(out.reply).toBe('done');
      expect(out.plan[0].action).toBe('status');
    });

    it('passes through legacy action output', async () => {
      const llm = { completeJSON: jest.fn().mockResolvedValue({ action: 'chat', args: { message: 'yo' } }) };
      const agent = new PlannerAgent({}, llm);
      const out = await agent.plan('Alex', 'hi', {}, '');
      expect(out.reply).toBe('yo');
    });
  });
});
