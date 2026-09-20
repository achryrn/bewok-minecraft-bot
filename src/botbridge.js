const EventEmitter = require('events');

/**
 * BotBridgeChannel — JS-side handler for the botbridge Forge mod's custom channel.
 *
 * Communicates with the server-side botbridge mod on FML channel `botbridge:main`.
 * Uses the Forge SimpleChannel wire format:
 *   - [varInt packetId][packet-specific data]
 *   - ID 0: OreScanRequest  (client → server)
 *   - ID 1: OreScanResponse (server → client)
 *
 * Wire format for each packet:
 *   OreScanRequest:  [varInt 0][utf8 oreId][int x][int y][int z][varInt radius]
 *   OreScanResponse: [varInt 1][varInt count][(int x, int y, int z) × count]
 *
 * utf8 is FriendlyByteBuf.writeUtf: varInt length prefix + UTF-8 bytes.
 * int is 32-bit signed big-endian.
 * varInt is Minecraft-style variable-length integer.
 */
class BotBridgeChannel extends EventEmitter {
  constructor(bot) {
    super();
    this.bot = bot;
    this._ready = false;
    this._pendingRequest = null;
    this._setup();
  }

  _setup() {
    const client = this.bot._client;
    if (!client) {
      console.log('[botbridge] No client available — deferring setup');
      return;
    }

    // Listen for custom_payload packets on the botbridge channel
    client.on('custom_payload', (packet) => {
      if (packet.channel !== 'botbridge:main') return;
      try {
        this._handlePacket(packet.data);
      } catch (err) {
        console.log('[botbridge] Error handling packet:', err.message);
      }
    });

    this._ready = true;
    console.log('[botbridge] Channel handler ready');
  }

  /**
   * Send an ore scan request to the server.
   * @param {string} oreId - Resource location of the ore (e.g. "minecraft:iron_ore")
   * @param {number} centerX
   * @param {number} centerY
   * @param {number} centerZ
   * @param {number} radius - Scan radius in blocks (clamped to server config max)
   * @returns {Promise<Array<{x:number, y:number, z:number}>>} Array of ore positions
   */
  requestOreScan(oreId, centerX, centerY, centerZ, radius) {
    return new Promise((resolve, reject) => {
      if (!this._ready) {
        reject(new Error('BotBridge channel not ready'));
        return;
      }

      // Prevent concurrent requests
      if (this._pendingRequest) {
        reject(new Error('Ore scan already in progress'));
        return;
      }

      const timeout = setTimeout(() => {
        this._pendingRequest = null;
        reject(new Error('Ore scan timed out'));
      }, 10000);

      this._pendingRequest = (positions) => {
        clearTimeout(timeout);
        resolve(positions);
      };

      try {
        const data = this._encodeRequest(oreId, centerX, centerY, centerZ, radius);
        this.bot._client.write('custom_payload', {
          channel: 'botbridge:main',
          data: data,
        });
        console.log(`[botbridge] Sent ore scan request: ${oreId} @ (${centerX}, ${centerY}, ${centerZ}) r=${radius}`);
      } catch (err) {
        clearTimeout(timeout);
        this._pendingRequest = null;
        reject(err);
      }
    });
  }

  /* ───── Packet handling ───── */

  _handlePacket(rawBuf) {
    const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);

    if (buf.length < 1) return;

    const packetId = this._readVarInt(buf, 0);
    if (packetId === null) return;

    let offset = packetId.bytes;

    if (packetId.value === 1) {
      // OreScanResponse
      const positions = this._decodeResponse(buf, offset);
      if (positions === null) return;

      console.log(`[botbridge] Received ore scan response: ${positions.length} positions`);

      if (this._pendingRequest) {
        const cb = this._pendingRequest;
        this._pendingRequest = null;
        cb(positions);
      }
    }
  }

  _decodeResponse(buf, startOffset) {
    const countResult = this._readVarInt(buf, startOffset);
    if (countResult === null) return null;

    const count = countResult.value;
    let offset = startOffset + countResult.bytes;
    const positions = [];

    for (let i = 0; i < count; i++) {
      if (offset + 12 > buf.length) return null; // Need 3 ints (12 bytes)
      const x = buf.readInt32BE(offset);
      const y = buf.readInt32BE(offset + 4);
      const z = buf.readInt32BE(offset + 8);
      positions.push({ x, y, z });
      offset += 12;
    }

    return positions;
  }

  /* ───── Encoding ───── */

  _encodeRequest(oreId, centerX, centerY, centerZ, radius) {
    // Packet ID 0 (varInt) + utf8 string + 3 ints + varInt radius
    const oreIdBuf = Buffer.from(oreId, 'utf8');
    const idBuf = this._writeVarInt(0);
    const oreLenBuf = this._writeVarInt(oreIdBuf.length);
    const radiusBuf = this._writeVarInt(radius);

    const totalLen = idBuf.length + oreLenBuf.length + oreIdBuf.length + 12 + radiusBuf.length;
    const buf = Buffer.alloc(totalLen);

    let offset = 0;
    idBuf.copy(buf, offset); offset += idBuf.length;
    oreLenBuf.copy(buf, offset); offset += oreLenBuf.length;
    oreIdBuf.copy(buf, offset); offset += oreIdBuf.length;
    buf.writeInt32BE(centerX, offset); offset += 4;
    buf.writeInt32BE(centerY, offset); offset += 4;
    buf.writeInt32BE(centerZ, offset); offset += 4;
    radiusBuf.copy(buf, offset); offset += radiusBuf.length;

    return buf;
  }

  /* ───── VarInt helpers ───── */

  _readVarInt(buf, offset) {
    let value = 0;
    let shift = 0;
    let bytes = 0;

    while (bytes < 5) {
      if (offset + bytes >= buf.length) return null;
      const b = buf[offset + bytes];
      value |= (b & 0x7F) << shift;
      bytes++;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }

    return { value, bytes };
  }

  _writeVarInt(value) {
    const bytes = [];
    while (true) {
      if ((value & ~0x7F) === 0) {
        bytes.push(value);
        return Buffer.from(bytes);
      }
      bytes.push((value & 0x7F) | 0x80);
      value >>>= 7;
    }
  }
}

module.exports = BotBridgeChannel;
