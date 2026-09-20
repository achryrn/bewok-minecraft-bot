const fs = require('fs');
const path = require('path');

/**
 * ConfigManager - runtime configuration with disk persistence.
 * Supports in-game slash commands to modify bot settings.
 */

// Keys that require a restart to take effect
const RESTART_KEYS = ['host', 'port', 'username', 'auth', 'version'];

// Keys that accept boolean values
const BOOLEAN_KEYS = [
  'reconnect', 'chatCommands', 'autoEat', 'debug',
  'navigation.allowDigging', 'navigation.allowPlacing',
  'survival.autoEngageHostiles', 'survival.autoEat',
  'mining.avoidLowDurability', 'mining.strictAdjacencyCheck',
  'mining.allowLavaAdjacentMining', 'mining.preferVeinMining',
  'crafting.autoPlaceCraftingTable',
];

// Keys that accept integer values
const INTEGER_KEYS = [
  'port', 'reconnectDelay', 'maxReconnectAttempts',
  'autoEatThreshold', 'followDistance', 'viewDistance',
  'navigation.stuckTimeoutMs', 'navigation.maxRecoveryAttempts',
  'survival.engageRadius', 'survival.fleeHealthThreshold',
  'survival.eatThreshold',
  'mining.minDurability', 'mining.maxSafeFallBlocks',
  'mining.stripMineSpacing',
  'crafting.loopPollIntervalMs',
  'brainTimeout',
];

// Keys that accept string values
const STRING_KEYS = [
  'survival.fleeStrategy',
  'claudePath',
];

// Keys that accept string values (array-like, comma-separated in chat)
const ARRAY_KEYS = ['triggerWords'];

// All known keys with their types
const KEY_TYPES = {};
for (const k of RESTART_KEYS) KEY_TYPES[k] = 'restart';
for (const k of BOOLEAN_KEYS) KEY_TYPES[k] = 'boolean';
for (const k of INTEGER_KEYS) KEY_TYPES[k] = 'integer';
for (const k of STRING_KEYS) KEY_TYPES[k] = 'string';
for (const k of ARRAY_KEYS) KEY_TYPES[k] = 'array';

class ConfigManager {
  constructor(configPath) {
    this.configPath = configPath || path.join(process.cwd(), 'config.json');
    this.runtimeOverrides = {};
  }

  /**
   * Get current config value (runtime override > file config).
   * @param {string} key
   * @param {object} baseConfig - the loaded config to fall back to
   * @returns {*}
   */
  get(key, baseConfig) {
    if (this.runtimeOverrides.hasOwnProperty(key)) {
      return this.runtimeOverrides[key];
    }
    return baseConfig ? baseConfig[key] : undefined;
  }

  /**
   * Set a config value at runtime. Returns {success, message, needsRestart}.
   * @param {string} key
   * @param {string} valueStr - raw string from chat input
   * @returns {{success: boolean, message: string, needsRestart: boolean, key: string, value: *}}
   */
  set(key, valueStr) {
    if (!key) {
      return { success: false, message: 'Usage: /config set <key> <value>' };
    }

    const keyLower = key.toLowerCase();
    const knownKeys = Object.keys(KEY_TYPES);

    if (!knownKeys.includes(keyLower)) {
      return {
        success: false,
        message: `Unknown key: ${keyLower}. Valid keys: ${knownKeys.join(', ')}`,
      };
    }

    const keyType = KEY_TYPES[keyLower];
    let parsedValue;

    // Parse the value based on its type
    switch (keyType) {
      case 'boolean': {
        const v = valueStr.toLowerCase().trim();
        if (!['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(v)) {
          return { success: false, message: `${keyLower} must be true/false (or yes/no, on/off, 1/0)` };
        }
        parsedValue = ['true', '1', 'yes', 'on'].includes(v);
        break;
      }

      case 'integer': {
        const n = parseInt(valueStr, 10);
        if (isNaN(n)) {
          return { success: false, message: `${keyLower} must be an integer, got: ${valueStr}` };
        }
        if (keyLower === 'port' && (n < 1 || n > 65535)) {
          return { success: false, message: 'port must be between 1 and 65535' };
        }
        if (keyLower === 'reconnectDelay' && n < 100) {
          return { success: false, message: 'reconnectDelay must be >= 100ms' };
        }
        if (keyLower === 'maxReconnectAttempts' && n < 0) {
          return { success: false, message: 'maxReconnectAttempts must be >= 0' };
        }
        if (keyLower === 'followDistance' && n < 0) {
          return { success: false, message: 'followDistance must be >= 0' };
        }
        parsedValue = n;
        break;
      }

      case 'string': {
        parsedValue = valueStr.trim();
        if (parsedValue.length === 0) {
          return { success: false, message: `${keyLower} cannot be empty` };
        }
        break;
      }

      case 'array': {
        // Parse comma-separated values into array
        parsedValue = valueStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
        if (parsedValue.length === 0) {
          return { success: false, message: `${keyLower} must be a comma-separated list` };
        }
        break;
      }

      case 'restart': {
        // For restart-required keys, treat as string
        parsedValue = valueStr.trim();
        if (parsedValue.length === 0) {
          return { success: false, message: `${keyLower} cannot be empty` };
        }
        break;
      }

      default:
        parsedValue = valueStr.trim();
    }

    this.runtimeOverrides[keyLower] = parsedValue;

    const needsRestart = RESTART_KEYS.includes(keyLower);
    const displayValue = Array.isArray(parsedValue) ? parsedValue.join(', ') : String(parsedValue);

    return {
      success: true,
      message: needsRestart
        ? `${keyLower} = ${displayValue} (takes effect after restart)`
        : `${keyLower} = ${displayValue} (applied)`,
      needsRestart,
      key: keyLower,
      value: parsedValue,
    };
  }

  /**
   * Apply pending runtime overrides to a config object (mutates it).
   * @param {object} config
   */
  applyTo(config) {
    for (const [key, value] of Object.entries(this.runtimeOverrides)) {
      config[key] = value;
    }
    return config;
  }

  /**
   * Persist current config to disk (merges runtime overrides into file).
   * @param {object} baseConfig - current config object
   */
  save(baseConfig) {
    try {
      const toSave = { ...baseConfig, ...this.runtimeOverrides };
      fs.writeFileSync(this.configPath, JSON.stringify(toSave, null, 2), 'utf8');
      return { success: true, message: 'Config saved to disk' };
    } catch (err) {
      return { success: false, message: `Failed to save: ${err.message}` };
    }
  }

  /**
   * Get all runtime overrides.
   */
  getOverrides() {
    return { ...this.runtimeOverrides };
  }

  /**
   * List all keys with their current values and types.
   * @param {object} baseConfig
   */
  list(baseConfig) {
    const keys = Object.keys(KEY_TYPES).sort();
    return keys.map(key => {
      const current = this.get(key, baseConfig);
      const type = KEY_TYPES[key];
      const needsRestart = RESTART_KEYS.includes(key);
      return {
        key,
        value: Array.isArray(current) ? current.join(', ') : String(current),
        type,
        needsRestart,
      };
    });
  }

  /**
   * Reset all runtime overrides back to file config values.
   */
  reset() {
    this.runtimeOverrides = {};
  }
}

module.exports = { ConfigManager, KEY_TYPES, RESTART_KEYS };
