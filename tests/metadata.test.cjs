const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, { listeners: {}, clicks: 0, addEventListener(type, fn) { this.listeners[type] = fn; }, click() { this.clicks++; } });
  return elements.get(id);
}
const ctx = vm.createContext({
  document: { getElementById: element, addEventListener() {} },
  console, ArrayBuffer, Uint8Array, DataView, Blob,
  URL: { createObjectURL: () => 'blob:test' },
  FujiMetadata: require('../metadata-reader.js'),
  exifr: { parse: async () => ({}), thumbnailUrl: async () => null },
});
vm.runInContext(script, ctx);
function note() {
  const bytes = new Uint8Array(30);
  bytes.set(Buffer.from('FUJIFILM'));
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 12, true);
  view.setUint16(12, 1, true);
  view.setUint16(14, 0x1401, true);
  view.setUint16(16, 3, true);
  view.setUint32(18, 1, true);
  view.setUint16(22, 0x600, true);
  return bytes;
}
test('accepts top-level, translated, and numeric MakerNote layouts', () => {
  const bytes = note();
  for (const result of [{ makerNote: bytes }, { MakerNote: bytes }, { exif: { 37500: bytes } }, { exif: { MakerNote: bytes } }]) {
    assert.equal(ctx.getMakerNote(result), bytes);
    assert.equal(ctx.parseFujiMakerNote(ctx.getMakerNote(result))[0x1401], 0x600);
  }
});
test('accepts ArrayBuffer and offset DataView without losing byte offset', () => {
  assert.equal(ctx.parseFujiMakerNote(note().buffer)[0x1401], 0x600);
  const padded = new Uint8Array(60);
  padded.set(note(), 7);
  assert.equal(ctx.parseFujiMakerNote(new DataView(padded.buffer, 7, 30))[0x1401], 0x600);
});
test('rejects missing, invalid, and truncated headers safely', () => {
  for (const value of [null, {}, new Uint8Array(3), new Uint8Array(30)]) assert.equal(ctx.parseFujiMakerNote(value), null);
  const bytes = note();
  new DataView(bytes.buffer).setUint32(8, 1000, true);
  assert.equal(ctx.parseFujiMakerNote(bytes), null);
});
test('diagnostic distinguishes absent metadata from failed decoding', () => {
  const entry = { exif: { Make: 'FUJIFILM' }, fujiTags: {}, file: { size: 12345 } };
  assert.match(ctx.buildMetadataDiagnostic(entry), /不能直接判断原图数据已被移除/);
  entry.exif.makerNote = note();
  assert.match(ctx.buildMetadataDiagnostic(entry), /已读取 MakerNote，但未解码/);
  entry.fujiTags = { FilmMode: 0x600 };
  assert.doesNotMatch(ctx.buildMetadataDiagnostic(entry), /metadata-notice/);
  assert.match(ctx.buildMetadataDiagnostic(entry), /富士字段：1 项/);
});
test('document and photo buttons open separate pickers without recursive clicks', () => {
  element('chooseOriginal').listeners.click();
  element('choosePhoto').listeners.click();
  assert.equal(element('fileInput').clicks, 1);
  assert.equal(element('photoInput').clicks, 1);
  element('dropzone').listeners.click({ target: { closest: () => true } });
  assert.equal(element('fileInput').clicks, 1);
  element('dropzone').listeners.click({ target: { closest: () => null } });
  assert.equal(element('fileInput').clicks, 2);
});

function tiffFixture(makerNote = note(), little = true) {
  const bytes = new Uint8Array(64 + makerNote.length);
  const view = new DataView(bytes.buffer);
  bytes.set(little ? [73, 73] : [77, 77]);
  const u16 = (p, n) => view.setUint16(p, n, little);
  const u32 = (p, n) => view.setUint32(p, n, little);
  u16(2, 42); u32(4, 8);
  u16(8, 1); u16(10, 0x8769); u16(12, 4); u32(14, 1); u32(18, 26);
  u16(26, 1); u16(28, 0x927c); u16(30, 7); u32(32, makerNote.length); u32(36, 64);
  bytes.set(makerNote, 64);
  return bytes;
}
function jpegFixture(tiff) {
  return new Uint8Array(Buffer.concat([Buffer.from([255,216,255,225,(tiff.length + 8) >> 8,(tiff.length + 8) & 255]), Buffer.from('Exif\0\0'), tiff, Buffer.from([255,217])]));
}

test('recovers film simulation directly when exifr returns no MakerNote', async () => {
  for (const little of [true, false]) {
    const result = await ctx.readFujiMetadata(jpegFixture(tiffFixture(note(), little)), { Make: 'FUJIFILM' });
    assert.equal(result.fujiTags.FilmMode, 0x600);
    const d = result.metadataDiagnostic;
    assert.equal(d.decodeSource, 'direct');
    assert.equal(d.libraryMakerNoteBytes, 0);
    assert.equal(d.directMakerNoteBytes, 30);
    assert.equal(d.fujiSignature, true);
    assert.equal(d.directStatus, 'found');
    assert.match(d.makerNoteHeaderHex, /^46554a4946494c4d/);
  }
});

test('raw Blob file and RAF embedded JPEG share the direct fallback', async () => {
  const jpeg = jpegFixture(tiffFixture());
  const blob = new Blob([jpeg], { type: 'image/jpeg' });
  assert.equal((await ctx.readFujiMetadata(blob, {})).fujiTags.FilmMode, 0x600);
  const raf = new Uint8Array(120 + jpeg.length);
  raf.set(Buffer.from('FUJIFILMCCD-RAW '));
  raf.set(Buffer.from('X-T5'), 28);
  const view = new DataView(raf.buffer);
  view.setUint32(84, 120); view.setUint32(88, jpeg.length);
  raf.set(jpeg, 120);
  const result = await ctx.processRafFile(new Blob([raf]));
  assert.equal(result.fujiTags.FilmMode, 0x600);
  assert.equal(result.metadataDiagnostic.scope, 'RAF embedded JPEG');
});

test('a library exception does not block standard or byte-level fallback', async () => {
  const saved = ctx.exifr.parse;
  ctx.exifr.parse = async () => { throw new Error('mock parser failure'); };
  try {
    const bytes = jpegFixture(tiffFixture());
    const exif = await ctx.readStandardExif(bytes);
    assert.equal(Object.keys(exif).length, 0);
    const result = await ctx.readFujiMetadata(bytes, exif);
    assert.equal(result.fujiTags.FilmMode, 0x600);
    assert.equal(result.metadataDiagnostic.warnings.length, 1);
  } finally { ctx.exifr.parse = saved; }
});

test('unsupported format still decodes library MakerNote instead of claiming absence', async () => {
  const result = await ctx.readFujiMetadata(new Uint8Array([1,2,3]), { MakerNote: note() });
  assert.equal(result.fujiTags.FilmMode, 0x600);
  assert.equal(result.metadataDiagnostic.directStatus, 'unsupported');
  assert.equal(result.metadataDiagnostic.decodeSource, 'exifr');
});

test('distinguishes missing tag, malformed container, non-Fuji note and invalid Fuji note', async () => {
  const file = { size: 12345, type: 'image/jpeg' };
  const cases = [
    [new Uint8Array([255,216,255,217]), 'absent', 'missing', /未发现 MakerNote 标签/],
    [new Uint8Array([255,216,255,225,0,99]), 'malformed', 'missing', /无法确认是否缺失/],
    [tiffFixture(new Uint8Array(Buffer.from('OTHER CAMERA DATA'))), 'found', 'non-fuji', /不是 FUJIFILM 格式/],
    [tiffFixture(new Uint8Array(Buffer.from('FUJIFILM'))), 'found', 'invalid', /数据结构未能解码/],
  ];
  for (const [bytes, status, decoded, message] of cases) {
    const result = await ctx.readFujiMetadata(bytes, { Make: 'FUJIFILM' });
    assert.equal(result.metadataDiagnostic.directStatus, status);
    assert.equal(result.metadataDiagnostic.decodeStatus, decoded);
    assert.match(ctx.buildMetadataDiagnostic({ ...result, exif: { Make: 'FUJIFILM' }, file }), message);
  }
  const unsupported = await ctx.readFujiMetadata(new Uint8Array([137,80,78,71]), { Make: 'FUJIFILM' });
  assert.match(ctx.buildMetadataDiagnostic({ ...unsupported, exif: { Make: 'FUJIFILM' }, file }), /此格式暂不支持直接检查/);
});

test('exports byte inspection and decoding facts even when binary fields are excluded', async () => {
  const result = await ctx.readFujiMetadata(tiffFixture(), { Make: 'FUJIFILM' });
  const entry = { ...result, name: 'test.jpg', exif: { Make: 'FUJIFILM', MakerNote: note() }, file: { size: 100, type: 'image/jpeg' }, importSource: 'photo-library' };
  const exported = JSON.parse(JSON.stringify(ctx.buildExportData(entry)));
  assert.equal(exported.MakerNote, undefined);
  assert.equal(exported._fujifilmMakerNote.FilmMode, 0x600);
  assert.equal(exported._metadataDiagnostic.directStatus, 'found');
  assert.equal(exported._metadataDiagnostic.decodeSource, 'direct');
  assert.equal(exported._metadataDiagnostic.importSource, 'photo-library');
  assert.equal(exported._metadataDiagnostic.fileSize, 100);
  assert.equal(exported._metadataDiagnostic.directMakerNoteBytes, 30);
  assert.match(ctx.buildMetadataDiagnostic(entry), /原始字节回退恢复/);
  entry.file.type = '<img src=x onerror=alert(1)>';
  assert.doesNotMatch(ctx.buildMetadataDiagnostic(entry), /<img/);
});

test('exported note header matches the successful decoding source', async () => {
  const result = await ctx.readFujiMetadata(tiffFixture(new Uint8Array(Buffer.from('OTHER CAMERA DATA'))), { MakerNote: note() });
  assert.equal(result.metadataDiagnostic.decodeSource, 'exifr');
  assert.match(result.metadataDiagnostic.makerNoteHeaderHex, /^46554a4946494c4d/);
  assert.equal(result.fujiTags.FilmMode, 0x600);
});

test('rejects truncated Fuji directory and ignores field values outside note bounds', () => {
  const bytes = note();
  new DataView(bytes.buffer).setUint16(12, 100, true);
  assert.equal(ctx.parseFujiMakerNote(bytes), null);
  const badValue = note();
  new DataView(badValue.buffer).setUint32(18, 20, true);
  assert.equal(Object.keys(ctx.parseFujiMakerNote(badValue)).length, 0);
});
