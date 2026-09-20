const EventEmitter = require('events');
const { autoVersionForge } = require('minecraft-protocol-forge');

class ForgeHandler extends EventEmitter {
  constructor(bot, config) {
    super();
    this.bot = bot;
    this.config = config;
    this.handshakeComplete = false;
    this.handshakeFailed = false;
    this.failCount = 0;
    this._setup = false;
  }

  static isForgeServer(pingResult) {
    if (!pingResult) return false;

    if (pingResult.modinfo && Array.isArray(pingResult.modinfo.modList)) {
      const hasForge = pingResult.modinfo.modList.some(
        mod => mod.modid && mod.modid.toLowerCase().includes('forge')
      );
      if (hasForge) return true;
    }

    if (pingResult.forgeData) return true;
    if (pingResult.description && typeof pingResult.description === 'string') {
      if (pingResult.description.includes('FML') || pingResult.description.includes('forge')) return true;
    }

    return false;
  }

  static detectForgeFromServerListPing(pingResponse) {
    return ForgeHandler.isForgeServer(pingResponse);
  }

  setup() {
    if (this._setup) return;
    this._setup = true;

    const client = this.bot._client;
    if (!client) {
      this.handshakeFailed = true;
      this.emit('error', new Error('No underlying client available for forge handshake'));
      return;
    }

    // Set FML3 marker BEFORE autoVersionForge pings.
    // autoVersionForge may set it too late for the Handshake packet.
    client.tagHost = '\0FML3\0';

    // Install FML3 handler directly - autoVersionForge won't ping if version is set.
    // Do NOT pass channels or registries - let forgeHandshake3 mirror the server's data
    const forgeHandshake3 = require('minecraft-protocol-forge/src/client/forgeHandshake3');
    forgeHandshake3(client, { forgeMods: [] });

    // forgeHandshake3 only answers login_plugin_request packets on the
    // 'fml:loginwrapper' channel. Any other login-phase plugin channel
    // (SkinRestorer, ModernFix, etc. on this server) is logged and silently
    // dropped, with no login_plugin_response ever sent. The Minecraft login
    // protocol requires a response to every login_plugin_request - omitting
    // one desyncs the server's sequential index tracking for the handshake,
    // producing "Recieved unexpected index N in client reply" server-side.
    // This mirrors node-minecraft-protocol's own default handler (removed
    // above) for every channel forgeHandshake3 does not own.
    client.on('login_plugin_request', (packet) => {
    console.log('[forge-debug] login_plugin_request received:', {
      messageId: packet.messageId,
      channel: packet.channel,
      dataLength: packet.data ? packet.data.length : 0
    });
    if (packet.channel !== 'fml:loginwrapper') {
        client.write('login_plugin_response', { messageId: packet.messageId });
      }
    });

    // When minecraft-protocol receives LoginSuccess, the handshake is done.
    // Remove the fml:loginwrapper handler to stop responding to post-login
    // login_plugin_request packets from other mods (PlasmoVoice, SkinRestorer, etc.)
    // which cause "unexpected index" errors on the server.
    client.once('login_success', () => {
      this.failCount = 0;
      this.handshakeComplete = true;
      console.log('[forge] FML3 handshake complete');
      this.emit('complete');

      // Remove the FML3 login_plugin_request handler - no longer needed
      try {
        const fmlHandler = client.listeners('login_plugin_request')
          .find(fn => fn.name === 'onFmlLoginPluginRequest');
        if (fmlHandler) {
          client.removeListener('login_plugin_request', fmlHandler);
          console.log('[forge] Removed post-login FML3 handler');
        }
      } catch (_) { /* best effort */ }
    });

    client.on('error', (err) => {
      if (err.message && (err.message.includes('FML') || err.message.includes('forge') || err.message.includes('handshake'))) {
        this._handleHandshakeFailure(err);
      }
    });
  }

  _handleHandshakeFailure(err) {
    this.failCount++;
    this.handshakeFailed = true;

    console.warn('[warn] Forge handshake failed - retrying connection');
    if (this.config.debug) {
      console.log(`[forge] FML error: ${err.message}`);
    }

    if (this.failCount >= 3) {
      console.error('[error] Forge handshake failed 3 times - the server may require specific mods');
      console.error('[error] Stopping reconnect attempts');
      this.emit('permanentFailure');
    }

    this.emit('error', err);
  }

  waitForHandshake(timeoutMs = 15000) {
    return new Promise((resolve) => {
      if (this.handshakeComplete) return resolve(true);
      if (this.handshakeFailed) return resolve(false);

      const timeout = setTimeout(() => {
        resolve(false);
      }, timeoutMs);

      this.once('complete', () => {
        clearTimeout(timeout);
        resolve(true);
      });

      this.once('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }
}

module.exports = ForgeHandler;