const FollowPlugin = require('../../../src/plugins/follow');

jest.mock('mineflayer-pathfinder', () => ({
  pathfinder: jest.fn(),
  goals: {
    GoalFollow: jest.fn(function(entity, distance) {
      this.entity = entity;
      this.distance = distance;
    }),
  },
}));

describe('FollowPlugin', () => {
  let plugin;
  let mockBot;
  let mockEntity;

  beforeEach(() => {
    mockEntity = { position: { x: 100, y: 64, z: 200 } };
    mockBot = {
      pathfinder: {
        setGoal: jest.fn(),
      },
    };
    plugin = new FollowPlugin(mockBot);
  });

  afterEach(() => {
    plugin.stop();
  });

  describe('setTarget', () => {
    it('sets a target and starts pathfinding', () => {
      plugin.setTarget(mockEntity, 3);
      expect(plugin.target).toBe(mockEntity);
      expect(plugin.following).toBe(true);
      expect(mockBot.pathfinder.setGoal).toHaveBeenCalled();
    });

    it('stops if given null entity', () => {
      const stopSpy = jest.spyOn(plugin, 'stop');
      plugin.setTarget(null);
      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('stops following and clears goal', () => {
      plugin.setTarget(mockEntity);
      expect(plugin.following).toBe(true);
      plugin.stop();
      expect(plugin.following).toBe(false);
      expect(plugin.target).toBeNull();
      expect(mockBot.pathfinder.setGoal).toHaveBeenLastCalledWith(null);
    });

    it('clears the tick interval', () => {
      jest.useFakeTimers();
      plugin.setTarget(mockEntity, 2);
      plugin.stop();
      // After stop, interval should be cleared - no more setGoal calls
      const callsBefore = mockBot.pathfinder.setGoal.mock.calls.length;
      jest.advanceTimersByTime(3000);
      expect(mockBot.pathfinder.setGoal.mock.calls.length).toBe(callsBefore);
      jest.useRealTimers();
    });
  });
});

