'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  host: 'localhost',
  port: 25565,
  username: 'TestBot',
  password: '',
  auth: 'offline',               // 'offline' = cracked/offline-mode servers (primary target)
  version: false,                // '1.20.1' to pin, false = auto-detect server version
  versionAutoDetect: true,       // ping the server first and hop to its version
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
  ui: {
    welcome: true,               // send a short welcome line on spawn
    maxLineLength: 220,
  },
  brain: {
    provider: 'claude',          // model backend (claude CLI on Windows deployment)
    claudePath: 'claude',
    timeoutMs: 30000,
    maxRetries: 2,               // LLM JSON retries
    historySize: 8,
  },
  memory: {
    enabled: true,               // durable self-improvement memory
    path: './data/memory.json',
    maxLessons: 300,
  },
  retry: {
    defaultRetries: 2,           // action-level retries before giving up
    retryDelayMs: 1200,
  },
  persona: {
    name: 'a wandering adventurer', // persona used in the planner system prompt
    serverType: 'cracked',
  },
};

function loadConfig(configPath) {
  if (!configPath) {
    const candidates = [
      path.join(process.cwd(), 'config.json'),
      path.join(process.cwd(), 'bot-config.json'),
      path.join(__dirname, '..', 'config.json'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        configPath = candidate;
        break;
      }
    }
  }

  if (!configPath || !fs.existsSync(configPath)) {
    if (process.env.MINECRAFT_BOT_CONFIG) {
      configPath = process.env.MINECRAFT_BOT_CONFIG;
    }
  }

  let config = deepMerge({}, DEFAULT_CONFIG);

  if (configPath && fs.existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config = deepMerge(config, fileConfig);
    } catch (err) {
      console.warn(`Failed to parse config at ${configPath}:`, err.message);
    }
  }

  // Environment variable overrides
  if (process.env.MC_HOST) config.host = process.env.MC_HOST;
  if (process.env.MC_PORT) config.port = parseInt(process.env.MC_PORT, 10);
  if (process.env.MC_USERNAME) config.username = process.env.MC_USERNAME;
  if (process.env.MC_PASSWORD) config.password = process.env.MC_PASSWORD;
  if (process.env.MC_VERSION) config.version = process.env.MC_VERSION;
  if (process.env.MC_AUTH) config.auth = process.env.MC_AUTH;
  if (process.env.MC_RECONNECT !== undefined) config.reconnect = process.env.MC_RECONNECT === 'true';
  if (process.env.MC_DEBUG) config.debug = process.env.MC_DEBUG === 'true';
  if (process.env.MC_VERSION_AUTO === '0') config.versionAutoDetect = false;
  if (process.env.MC_TRIGGERS) config.triggerWords = process.env.MC_TRIGGERS.split(',').map((s) => s.trim());

  return config;
}

/** Shallow-ish deep merge for nested sections (ui/brain/memory/retry/persona). */
function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function validateConfig(config) {
  const errors = [];
  if (!config.host || typeof config.host !== 'string') errors.push('host must be a non-empty string');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) errors.push('port must be an integer 1-65535');
  if (!config.username || typeof config.username !== 'string') errors.push('username must be a non-empty string');
  if (config.reconnectDelay < 100) errors.push('reconnectDelay must be >= 100ms');
  if (config.maxReconnectAttempts < 0) errors.push('maxReconnectAttempts must be >= 0');
  if (config.followDistance < 0) errors.push('followDistance must be >= 0');
  if (config.brain && config.brain.maxRetries !== undefined && config.brain.maxRetries < 0) errors.push('brain.maxRetries must be >= 0');
  if (config.retry && config.retry.defaultRetries !== undefined && config.retry.defaultRetries < 0) errors.push('retry.defaultRetries must be >= 0');
  return errors;
}

module.exports = { loadConfig, validateConfig, DEFAULT_CONFIG, deepMerge };
