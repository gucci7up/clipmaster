/**
 * Lectura mínima de archivos TrueType/OpenType: comprueba la firma y obtiene el nombre de familia
 * de la tabla `name`, que es el que libass usa para encontrar la fuente al renderizar.
 */

const SIGNATURES = [0x00010000, 0x4f54544f /* OTTO */, 0x74727565 /* true */];

export function fontExtension(buf: Buffer): 'ttf' | 'otf' | null {
  if (buf.length < 12) return null;
  const sig = buf.readUInt32BE(0);
  if (!SIGNATURES.includes(sig)) return null;
  return sig === 0x4f54544f ? 'otf' : 'ttf';
}

export function fontFamily(buf: Buffer): string | null {
  try {
    const numTables = buf.readUInt16BE(4);
    let nameOffset = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (buf.toString('latin1', rec, rec + 4) === 'name') nameOffset = buf.readUInt32BE(rec + 8);
    }
    if (nameOffset < 0) return null;
    const count = buf.readUInt16BE(nameOffset + 2);
    const strings = nameOffset + buf.readUInt16BE(nameOffset + 4);
    // Prioridad: familia tipográfica (16) sobre familia (1); Windows Unicode sobre Macintosh.
    let best: { rank: number; value: string } | null = null;
    for (let i = 0; i < count; i++) {
      const rec = nameOffset + 6 + i * 12;
      const platform = buf.readUInt16BE(rec);
      const nameId = buf.readUInt16BE(rec + 6);
      if (nameId !== 1 && nameId !== 16) continue;
      const len = buf.readUInt16BE(rec + 8);
      const off = strings + buf.readUInt16BE(rec + 10);
      if (off + len > buf.length) continue;
      let value: string;
      if (platform === 3 || platform === 0) {
        if (len % 2) continue;
        const raw = Buffer.from(buf.subarray(off, off + len));
        raw.swap16();
        value = raw.toString('utf16le');
      } else if (platform === 1) {
        value = buf.toString('latin1', off, off + len);
      } else continue;
      const rank = (nameId === 16 ? 2 : 0) + (platform === 1 ? 0 : 1);
      if (!best || rank > best.rank) best = { rank, value };
    }
    const clean = best?.value.replace(/[\u0000-\u001f,{}\\]/g, '').trim();
    return clean ? clean.slice(0, 80) : null;
  } catch {
    return null;
  }
}
