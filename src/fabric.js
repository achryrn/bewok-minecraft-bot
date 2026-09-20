const EventEmitter = require('events');

class FabricHandler extends EventEmitter {
  constructor(bot, config) {
    super();
    this.bot = bot;
    this.config = config;
    this._setup = false;
  }

  static isFabricBrand(brandString) {
    if (typeof brandString !== 'string') return false;
    return brandString.toLowerCase().includes('fabric');
  }

  setup() {
    if (this._setup) return;
    this._setup = true;

    const client = this.bot._client;
    if (!client) {
      if (this.config.debug) {
        console.log('[fabric] No client available for Fabric detection');
      }
      return;
    }

    client.on('custom_payload', (packet) => {
      if (packet.channel === 'MC|Brand') {
        // MC|Brand packet: data is a VarInt-prefixed string
        // Skip the first byte (varint length prefix) and convert the rest to string
        const brand = packet.data ? packet.data.toString('utf8').slice(1) : '';
        if (FabricHandler.isFabricBrand(brand)) {
          console.log(`[fabric] Brand "${brand}" detected — no special handshake required`);
          this.emit('detected', brand);
        }
      }
    });
  }
}

module.exports = FabricHandler;