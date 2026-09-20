const fs = require('fs');
const path = require('path');

// Read zip file manually using built-in zlib
const zlib = require('zlib');
const { Transform } = require('stream');

// Actually, let's just use the local and central directory headers
// Simple approach: read file as buffer and find class names
const buf = fs.readFileSync('./botbridge-1.0.0.jar');

// Find all local file headers
// ZIP local file header signature: 0x04034b50
let offset = 0;
const entries = [];
while (offset < buf.length - 30) {
  if (buf.readUInt32LE(offset) !== 0x04034b50) break;
  const compressionMethod = buf.readUInt16LE(offset + 8);
  const fileNameLength = buf.readUInt16LE(offset + 26);
  const extraFieldLength = buf.readUInt16LE(offset + 28);
  const fileName = buf.slice(offset + 30, offset + 30 + fileNameLength).toString('utf8');
  entries.push({ name: fileName, compressed: compressionMethod !== 0 });
  const dataOffset = 30 + fileNameLength + extraFieldLength;
  offset += dataOffset;
  if (compressionMethod === 0) {
    const compSize = buf.readUInt32LE(offset - dataOffset + 18);
    offset += compSize;
  } else {
    // skip compressed data
    const compSize = buf.readUInt32LE(offset - dataOffset + 18);
    offset += compSize;
  }
}
entries.forEach(e => console.log(e.name));
