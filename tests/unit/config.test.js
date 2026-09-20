const fs = require('fs');
const path = require('path');
const os = require('os');

// Mock fs before requiring config
jest.mock('fs');

const { loadConfig, validateConfig, DEFAULT_CONFIG } = require('../../src/config');

describe('config.js', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('DEFAULT_CONFIG', () => {
    it('has all expected default values', () => {
      expect(DEFAULT_CONFIG).toEqual({
        host: 'localhost',
        port: 25565,
        username: 'TestBot',
        password: '',
        auth: 'offline',
        version: false,
        reconnect: true,
        reconnectDelay: 5000,
        maxReconnectAttempts: 10,
        chatCommands: true,
        autoEat: true,
        autoEatThreshold: 14,
        followDistance: 2,
        viewDistance: 'normal',
        debug: false,
        triggerWords: ['bot', 'hey bot', '!bot', 'bewok'],
        taskStatePath: './data/task-state.json',
        versionAutoDetect: true,
        ui: { welcome: true, maxLineLength: 220 },
        brain: {
          provider: 'claude',
          claudePath: 'claude',
          timeoutMs: 30000,
          maxRetries: 2,
          historySize: 8,
        },
        memory: { enabled: true, path: './data/memory.json', maxLessons: 300 },
        retry: { defaultRetries: 2, retryDelayMs: 1200 },
        persona: { name: 'a wandering adventurer', serverType: 'cracked' },
      });
    });
  });

  describe('loadConfig', () => {
    it('returns default config when no file found and no env vars', () => {
      fs.existsSync.mockReturnValue(false);
      const config = loadConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('loads config from a specified path', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ host: 'example.com', username: 'TestBot' }));

      const config = loadConfig('/custom/path/config.json');
      expect(config.host).toBe('example.com');
      expect(config.username).toBe('TestBot');
      expect(config.port).toBe(DEFAULT_CONFIG.port);
    });

    it('searches candidate paths when no path given', () => {
      // First two candidates return false, third returns true (sets configPath),
      // fourth confirms configPath for the line-36 check,
      // fifth confirms configPath for the line-44 read check
      fs.existsSync
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ username: 'FoundBot' }));

      const config = loadConfig();
      expect(config.username).toBe('FoundBot');
    });

    it('uses MINECRAFT_BOT_CONFIG env var as fallback', () => {
      const envPath = '/env/config.json';
      process.env.MINECRAFT_BOT_CONFIG = envPath;
      // Candidate path checks all fail (3), then env var path check (1), then read check (1)
      fs.existsSync
        .mockReturnValueOnce(false) // cwd/config.json
        .mockReturnValueOnce(false) // cwd/bot-config.json
        .mockReturnValueOnce(false) // __dirname/../config.json
        .mockReturnValueOnce(true)  // env var path
        .mockReturnValueOnce(true); // read check
      fs.readFileSync.mockReturnValue(JSON.stringify({ host: 'env.example.com' }));

      const config = loadConfig();
      expect(config.host).toBe('env.example.com');
      delete process.env.MINECRAFT_BOT_CONFIG;
    });

    it('applies env var overrides', () => {
      process.env.MC_HOST = 'env.host.com';
      process.env.MC_PORT = '12345';
      process.env.MC_USERNAME = 'EnvBot';
      process.env.MC_RECONNECT = 'false';
      process.env.MC_DEBUG = 'true';

      fs.existsSync.mockReturnValue(false);
      const config = loadConfig();

      expect(config.host).toBe('env.host.com');
      expect(config.port).toBe(12345);
      expect(config.username).toBe('EnvBot');
      expect(config.reconnect).toBe(false);
      expect(config.debug).toBe(true);

      delete process.env.MC_HOST;
      delete process.env.MC_PORT;
      delete process.env.MC_USERNAME;
      delete process.env.MC_RECONNECT;
      delete process.env.MC_DEBUG;
    });

    it('handles invalid JSON gracefully with warning', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('not valid json');
      // spy on console.warn
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const config = loadConfig('/bad/config.json');
      expect(warnSpy).toHaveBeenCalled();
      expect(config).toEqual(DEFAULT_CONFIG);

      warnSpy.mockRestore();
    });
  });

  describe('validateConfig', () => {
    it('returns no errors for valid config', () => {
      const errors = validateConfig(DEFAULT_CONFIG);
      expect(errors).toHaveLength(0);
    });

    it('errors on empty or non-string host', () => {
      expect(validateConfig({ ...DEFAULT_CONFIG, host: '' })).toContain('host must be a non-empty string');
      expect(validateConfig({ ...DEFAULT_CONFIG, host: 123 })).toContain('host must be a non-empty string');
    });

    it('errors on invalid port', () => {
      expect(validateConfig({ ...DEFAULT_CONFIG, port: 0 })).toContain('port must be an integer 1-65535');
      expect(validateConfig({ ...DEFAULT_CONFIG, port: 70000 })).toContain('port must be an integer 1-65535');
      expect(validateConfig({ ...DEFAULT_CONFIG, port: 'abc' })).toContain('port must be an integer 1-65535');
    });

    it('errors on empty or non-string username', () => {
      expect(validateConfig({ ...DEFAULT_CONFIG, username: '' })).toContain('username must be a non-empty string');
      expect(validateConfig({ ...DEFAULT_CONFIG, username: {} })).toContain('username must be a non-empty string');
    });

    it('errors on reconnectDelay < 100', () => {
      expect(validateConfig({ ...DEFAULT_CONFIG, reconnectDelay: 50 })).toContain('reconnectDelay must be >= 100ms');
    });

    it('errors on negative maxReconnectAttempts', () => {
      expect(validateConfig({ ...DEFAULT_CONFIG, maxReconnectAttempts: -1 })).toContain('maxReconnectAttempts must be >= 0');
    });

    it('errors on negative followDistance', () => {
      expect(validateConfig({ ...DEFAULT_CONFIG, followDistance: -5 })).toContain('followDistance must be >= 0');
    });
  });
});

