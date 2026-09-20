const {
  normalizeVersion,
  closestSupportedVersion,
  compareVersions,
  detectServerVersion,
  resolveBotVersion,
} = require('../../src/versioning');

jest.mock('minecraft-protocol', () => ({
  ping: jest.fn(),
}));
const mc = require('minecraft-protocol');

describe('versioning.js', () => {
  describe('normalizeVersion', () => {
    it('passes through plain versions', () => {
      expect(normalizeVersion('1.20.1')).toBe('1.20.1');
      expect(normalizeVersion('1.8.9')).toBe('1.8.9');
      expect(normalizeVersion('1.21.4')).toBe('1.21.4');
    });

    it('strips prefixes', () => {
      expect(normalizeVersion('Requires MC 1.20.1')).toBe('1.20.1');
      expect(normalizeVersion('Paper 1.20.1')).toBe('1.20.1');
      expect(normalizeVersion('1.20.1-Fabric 0.15.11')).toBe('1.20.1');
    });

    it('maps x.y aliases to last patch', () => {
      expect(normalizeVersion('1.20')).toBe('1.20.1');
      expect(normalizeVersion('1.19')).toBe('1.19.4');
      expect(normalizeVersion('1.16')).toBe('1.16.5');
    });

    it('returns null for garbage', () => {
      expect(normalizeVersion()).toBeNull();
      expect(normalizeVersion('funky')).toBeNull();
      expect(normalizeVersion('')).toBeNull();
      expect(normalizeVersion(42)).toBeNull();
    });
  });

  describe('compareVersions', () => {
    it('orders versions', () => {
      expect(compareVersions('1.20.1', '1.20.2')).toBeLessThan(0);
      expect(compareVersions('1.20.2', '1.20.1')).toBeGreaterThan(0);
      expect(compareVersions('1.20.1', '1.20.1')).toBe(0);
      expect(compareVersions('1.8.9', '1.20.4')).toBeLessThan(0);
      expect(compareVersions('1.21.4', '1.21.2')).toBeGreaterThan(0);
    });
  });

  describe('closestSupportedVersion', () => {
    const supported = ['1.8.9', '1.16.5', '1.18.2', '1.19.4', '1.20.1', '1.20.4', '1.21.1'];

    it('returns exact match', () => {
      expect(closestSupportedVersion('1.20.1', supported)).toBe('1.20.1');
    });

    it('picks highest supported same-major sibling', () => {
      expect(closestSupportedVersion('1.20.2', supported)).toBe('1.20.4');
      expect(closestSupportedVersion('1.19.1', supported)).toBe('1.19.4');
    });

    it('falls back to nearest below', () => {
      expect(closestSupportedVersion('1.21.4', supported)).toBe('1.21.1');
    });

    it('falls back to configured when no list', () => {
      expect(closestSupportedVersion('1.7.2', [])).toBe('1.7.2');
    });
  });

  describe('resolveBotVersion', () => {
    it('uses config version when auto-detect disabled', () => {
      const r = resolveBotVersion({ version: '1.20.1', versionAutoDetect: false }, { version: '1.16.5' });
      expect(r.version).toBe('1.20.1');
      expect(r.source).toBe('config');
    });

    it('uses detected version when auto-detect enabled', () => {
      const r = resolveBotVersion({ version: false, versionAutoDetect: true }, { version: '1.20.1' });
      expect(r.version).toBe('1.20.1');
      expect(r.source).toBe('detected');
    });

    it('falls back to configured version when detection fails', () => {
      const r = resolveBotVersion({ version: '1.20.1', versionAutoDetect: true }, { version: null, error: 'timeout' });
      expect(r.version).toBe('1.20.1');
      expect(r.source).toBe('config-fallback');
    });

    it('passes false through when nothing known', () => {
      const r = resolveBotVersion({ version: false, versionAutoDetect: true }, { version: null });
      expect(r.version).toBe(false);
    });
  });

  describe('detectServerVersion', () => {
    beforeEach(() => { jest.clearAllMocks(); });

    it('resolves version info from ping', async () => {
      mc.ping.mockImplementation((opts, cb) => {
        cb(null, { version: { name: 'Paper 1.20.1', protocol: 763 }, latencyMs: 12 });
      });
      const d = await detectServerVersion('host', 25565, 3000);
      expect(d.version).toBe('1.20.1');
      expect(d.protocol).toBe(763);
      expect(d.latencyMs).toBe(12);
      expect(d.error).toBeNull();
    });

    it('resolves error info when ping fails', async () => {
      mc.ping.mockImplementation((opts, cb) => {
        cb(new Error('ECONNREFUSED'), null);
      });
      const d = await detectServerVersion('host', 25565, 3000);
      expect(d.version).toBeNull();
      expect(d.error).toContain('ECONNREFUSED');
    });

    it('times out', async () => {
      mc.ping.mockImplementation(() => { /* never responds */ });
      const d = await detectServerVersion('host', 25565, 60);
      expect(d.version).toBeNull();
      expect(d.error).toBe('timeout');
    });
  });
});
