'use strict';
/**
 * versioning.js — flexible version hopping.
 *
 * Detects the Minecraft version a server is actually running (via server-list
 * ping) instead of relying on a hardcoded "version" in config.json. This makes
 * the bot able to hop between servers of different versions (1.8 – 1.21+),
 * which matters a lot on cracked/offline server networks that host wildly
 * different versions behind one IP.
 *
 * Detection pipeline:
 *   1. mc.ping the server (TCP handshake + status) → { version: {name, protocol}, ... }.
 *   2. Extract the raw version string (handles "Requires MC 1.20.1" etc.).
 *   3. Normalize against minecraft-data's supported versions.
 *   4. Fall back to the configured version when the ping is unavailable,
 *      fails, or reports something unsupported.
 */

const mc = require('minecraft-protocol');

/** Version strings we treat as "unknown / auto" — pass through to detection. */
const FALSY_VERSIONS = new Set(['', 'auto', 'detect', 'latest', 'false', '?']);

/** Disambiguation for common ambiguous server strings (x.y → last x.y.z). */
const ALIAS_MAP = {
  '1.20': '1.20.1',
  '1.20.0': '1.20.1',
  '1.19': '1.19.4',
  '1.19.0': '1.19.4',
  '1.18': '1.18.2',
  '1.17': '1.17.1',
  '1.16': '1.16.5',
  '1.15': '1.15.2',
  '1.14': '1.14.4',
  '1.13': '1.13.2',
  '1.12': '1.12.2',
  '1.11': '1.11.2',
  '1.10': '1.10.2',
  '1.9': '1.9.4',
  '1.8': '1.8.9',
};

/**
 * Extract a clean, normalized MC version from any raw server string.
 * @param {string|undefined} raw e.g. "1.20.1", "Requires MC 1.20.1", "1.20.2", "Paper 1.20.1", "1.20.1-Fabric 0.15.11"
 * @returns {string|null} normalized version or null when nothing parseable
 */
function normalizeVersion(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (FALSY_VERSIONS.has(s.toLowerCase())) return null;

  // Scan tokens for an x.y / x.y.z shape (server MOTD or version line)
  const tokens = s.split(/[\s\-_]+/);
  let candidate = null;
  for (const tok of tokens) {
    const m = tok.match(/^\d{1,2}\.\d{1,2}(\.\d{1,2})?$/);
    if (m) { candidate = tok; break; }
    const m2 = tok.match(/^mc(\d{1,2}\.\d{1,2}(\.\d{1,2})?)$/i);
    if (m2) { candidate = m2[1]; break; }
    const m3 = tok.match(/^\d{1,2}\.\d{1,2}(\.\d{1,2})?.*$/);
    if (m3) {
      const inner = tok.match(/\d{1,2}\.\d{1,2}(\.\d{1,2})?/);
      if (inner) { candidate = inner[0]; break; }
    }
  }
  if (!candidate) return null;

  return ALIAS_MAP[candidate] || candidate;
}

/** Simple x.y.z string comparator. */
function compareVersions(a, b) {
  const pa = (a || '').split('.').map(Number);
  const pb = (b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * Clamp a version to the nearest supported minecraft-data PC version.
 * @param {string} version
 * @param {string[]|null} supportedVersions - optional override (tests)
 */
function closestSupportedVersion(version, supportedVersions) {
  let versions = supportedVersions;
  if (!versions) {
    try {
      const mcData = require('minecraft-data');
      versions = mcData && mcData.versions && mcData.versions.pc
        ? mcData.versions.pc.map(v => v.minecraftVersion)
        : [];
    } catch (_) {
      versions = [];
    }
  }
  if (!versions || versions.length === 0) return version || null;
  if (versions.includes(version)) return version;

  // Try major-version floor: e.g. 1.20.2 → highest supported 1.20.x
  const major = version.split('.').slice(0, 2).join('.');
  const sameMajor = versions.filter(v => v.startsWith(major + '.') || v === major);
  if (sameMajor.length > 0) {
    return sameMajor.sort(compareVersions).pop();
  }

  // Nearest supported below the requested version
  const below = versions.filter(v => compareVersions(v, version) <= 0);
  if (below.length > 0) return below.sort(compareVersions).pop();

  return versions
    .slice()
    .sort((a, b) => Math.abs(compareVersions(a, version)) - Math.abs(compareVersions(b, version)))[0] || version;
}

/**
 * Ping a server and extract version info.
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<{version: string|null, protocol: number|null, forgeData: object|null, latencyMs: number|null, rawVersion: string|null, error: string|null}>}
 */
function detectServerVersion(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ version: null, protocol: null, forgeData: null, latencyMs: null, rawVersion: null, error: 'timeout' });
    }, timeoutMs);

    try {
      mc.ping({ host, port, timeout: timeoutMs }, (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err || !result) {
          resolve({ version: null, protocol: null, forgeData: null, latencyMs: null, rawVersion: null, error: err ? err.message : 'no response' });
          return;
        }
        const raw = (result.version && result.version.name) || null;
        resolve({
          version: normalizeVersion(raw),
          protocol: result.version ? result.version.protocol : null,
          forgeData: result.forgeData || null,
          latencyMs: typeof result.latencyMs === 'number' ? result.latencyMs : null,
          rawVersion: raw,
          error: null,
        });
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ version: null, protocol: null, forgeData: null, latencyMs: null, rawVersion: null, error: err.message });
    }
  });
}

/**
 * Decide the bot version to connect with.
 * Resolution order:
 *   1. explicit configured version when versionAutoDetect is disabled,
 *   2. detected version clamped to a supported one,
 *   3. configured version as fallback,
 *   4. false → let mineflayer resolve (recommended only when sure).
 *
 * @param {object} config
 * @param {object} detection - output of detectServerVersion()
 * @returns {{version: string|false, source: string, detection: object}}
 */
function resolveBotVersion(config, detection) {
  const configured = config && config.version ? String(config.version) : null;
  const autoEnabled = config ? config.versionAutoDetect !== false : true;

  if (configured && !autoEnabled) {
    return { version: configured, source: 'config', detection };
  }

  if (autoEnabled && detection && detection.version) {
    const supported = closestSupportedVersion(detection.version);
    if (supported) {
      return { version: supported, source: 'detected', detection };
    }
  }

  if (configured) {
    return { version: configured, source: 'config-fallback', detection };
  }

  return { version: false, source: 'auto-unsupported', detection };
}

module.exports = {
  normalizeVersion,
  closestSupportedVersion,
  compareVersions,
  detectServerVersion,
  resolveBotVersion,
  ALIAS_MAP,
};
