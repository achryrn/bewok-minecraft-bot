'use strict';
const { loadConfig, validateConfig } = require('./src/config');
const BotManager = require('./src/bot');

const SMOKE = process.argv.includes('--smoke');

async function main() {
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error('[error] Configuration error:');
    errors.forEach((e) => console.error('[error]   ' + e));
    process.exit(1);
  }

  console.log('[bot] minecraft-bot v1.1 — ' + (config.auth === 'offline' ? 'offline/cracked mode' : config.auth + ' auth') +
    (config.versionAutoDetect ? ' | version: auto-detect' : ' | version: ' + (config.version || 'auto')) +
    ' | target: ' + config.host + ':' + config.port);

  // Smoke mode: validate config + server ping, then exit. Used by the launcher
  // self-check and for quick diagnostics without connecting.
  if (SMOKE) {
    try {
      const { detectServerVersion, resolveBotVersion } = require('./src/versioning');
      const start = Date.now();
      const detection = await detectServerVersion(config.host, config.port, 6000);
      const resolved = resolveBotVersion(config, detection);
      console.log('[smoke] ping ' + (Date.now() - start) + 'ms — ' +
        (detection.rawVersion ? 'server reports "' + detection.rawVersion + '"' : 'server ping: ' + (detection.error || 'no version info')) +
        ' → connect with version: ' + String(resolved.version) + ' (source: ' + resolved.source + ')');
      console.log('[smoke] config OK, launcher OK.');
      process.exit(0);
    } catch (err) {
      console.error('[smoke] check failed:', err.message);
      process.exit(2);
    }
  }

  const bot = new BotManager(config);

  process.on('SIGINT', async () => {
    console.log('[bot] Shutting down...');
    await bot.stop();
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    // Suppress protodef errors from modded server custom_payload packets
    if (err && err.message && (err.message.includes('unexpected tag') || err.message.includes('Read error'))) {
      return;
    }
    console.error('[error] Uncaught exception:', err.message);
  });

  process.on('unhandledRejection', (err) => {
    if (err && err.message && (err.message.includes('unexpected tag') || err.message.includes('Read error'))) {
      return;
    }
    console.error('[error] Unhandled rejection:', err && err.message);
  });

  try {
    await bot.start();
  } catch (err) {
    console.error('[error] Failed to start bot:', err.message);
    process.exit(1);
  }
}

main();
