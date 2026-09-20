const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const modsDir = path.join(process.cwd(), 'mods');

function* centralDir(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) return;
  let p = buf.readUInt32LE(eocd + 16);
  const total = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    yield { name: buf.toString('utf8', p + 46, p + 46 + nl), method: buf.readUInt16LE(p + 10), cSize: buf.readUInt32LE(p + 20), lhOff: buf.readUInt32LE(p + 42) };
    p += 46 + nl + el + cl;
  }
}

function readEntry(buf, lhOff, method, cSize) {
  const nl2 = buf.readUInt16LE(lhOff + 26), el2 = buf.readUInt16LE(lhOff + 28);
  let d = buf.slice(lhOff + 30 + nl2 + el2, lhOff + 30 + nl2 + el2 + cSize);
  if (method === 8) d = zlib.inflateRawSync(d);
  return d.toString('utf8');
}

const all = [];
for (const f of fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'))) {
  const buf = fs.readFileSync(path.join(modsDir, f));
  let tomlEntry = null, mfEntry = null;
  for (const e of centralDir(buf)) {
    if (e.name === 'META-INF/mods.toml') tomlEntry = e;
    if (e.name === 'META-INF/MANIFEST.MF') mfEntry = e;
  }
  if (!tomlEntry) continue;
  const toml = readEntry(buf, tomlEntry.lhOff, tomlEntry.method, tomlEntry.cSize);
  const sections = toml.split('\n[[mods]]');
  for (const section of sections) {
    let modId = null, version = null;
    for (const line of section.split('\n')) {
      const t = line.trim();
      if (t.startsWith('#') || t.startsWith('[')) continue;
      if (t.startsWith('modId')) {
        const m = t.match(/modId\s*=\s*"([^"]+)"/);
        if (m) modId = m[1];
      }
      if (t.startsWith('version')) {
        const v = t.match(/version\s*=\s*"([^"]+)"/);
        if (v) version = v[1];
      }
    }
    if (modId && version) {
      if (version.includes('${file.jarVersion}') && mfEntry) {
        const mf = readEntry(buf, mfEntry.lhOff, mfEntry.method, mfEntry.cSize);
        const mv = mf.match(/Implementation-Version:\s*(.+)/);
        if (mv) version = mv[1].trim();
      }
      if (version.includes('${file.jarVersion}')) {
        const fm = f.match(/-?([\d.]+[\w.+\-]*)\.jar/);
        if (fm) version = fm[1];
      }
      if (version.includes('${')) continue;
      all.push({ modId, version, source: f });
    }
  }
}

const seen = new Set();
const mods = all.filter(m => { if (seen.has(m.modId)) return false; seen.add(m.modId); return true; });

console.log('Found ' + mods.length + ' mods:');
mods.sort((a,b) => a.modId.localeCompare(b.modId));
mods.forEach(m => console.log('  ' + m.modId + ' @ ' + m.version));
fs.writeFileSync('mod-list.json', JSON.stringify(mods, null, 2));
console.log('Saved mod-list.json');
