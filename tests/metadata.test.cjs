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
const ctx = vm.createContext({ document: { getElementById: element, addEventListener() {} }, console, ArrayBuffer, Uint8Array, DataView });
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
