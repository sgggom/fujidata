'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { inspect } = require('../metadata-reader.js');

// Minimal classic TIFF with IFD0 -> EXIF IFD -> MakerNote.
function fixture({ little = true, note = Buffer.from('FUJIFILM\0test'), maker = true } = {}) {
  const b = new Uint8Array(128);
  const v = new DataView(b.buffer);
  b.set(little ? [0x49, 0x49] : [0x4d, 0x4d]);
  const u16 = (p, n) => v.setUint16(p, n, little);
  const u32 = (p, n) => v.setUint32(p, n, little);
  u16(2, 42); u32(4, 8);
  u16(8, 1); u16(10, 0x8769); u16(12, 4); u32(14, 1); u32(18, 32); u32(22, 0);
  u16(32, maker ? 1 : 0);
  if (maker) {
    u16(34, 0x927c); u16(36, 7); u32(38, note.length);
    if (note.length <= 4) b.set(note, 42);
    else { u32(42, 64); b.set(note, 64); }
    u32(46, 0);
  } else u32(34, 0);
  return { b, v, u16, u32, note };
}
const segment = (marker, payload) => Buffer.concat([Buffer.from([255, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
const exif = b => segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), b]));
const jpeg = (...segments) => Buffer.concat([Buffer.from([255, 216]), ...segments, Buffer.from([255, 217])]);

for (const little of [true, false]) {
  test(`${little ? 'LE' : 'BE'} TIFF extracts raw MakerNote and exact offset`, () => {
    const { b, note } = fixture({ little });
    const r = inspect(b.buffer);
    assert.equal(r.container, 'TIFF'); assert.equal(r.status, 'found');
    assert.equal(r.exifFound, true); assert.equal(r.makerNoteOffset, 64);
    assert.deepEqual(Buffer.from(r.makerNote), note); assert.deepEqual(r.warnings, []);
  });
}

test('JPEG ignores XMP APP1, then parses multiple EXIF APP1 segments', () => {
  const b = jpeg(segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0FUJIFILM')), exif(fixture({ maker: false }).b), exif(fixture().b));
  const r = inspect(b);
  assert.equal(r.container, 'JPEG'); assert.equal(r.status, 'found');
  assert.deepEqual(Buffer.from(r.makerNote), fixture().note);
  assert.deepEqual(b.subarray(r.makerNoteOffset, r.makerNoteOffset + r.makerNote.length), Buffer.from(r.makerNote));
});

test('JPEG accepts fill bytes, TEM and restart standalone markers', () => {
  const prefix = Buffer.from([255, 255, 1, 255, 208, 255]);
  const b = jpeg(prefix, exif(fixture().b));
  assert.equal(inspect(b).status, 'found');
});

test('DataView, Uint8Array and Buffer slices preserve nonzero input offsets', () => {
  const raw = jpeg(exif(fixture().b));
  const outer = new Uint8Array(raw.length + 27); outer.set(raw, 13);
  for (const input of [new DataView(outer.buffer, 13, raw.length), new Uint8Array(outer.buffer, 13, raw.length), Buffer.from(outer.buffer, 13, raw.length)]) {
    const r = inspect(input);
    assert.equal(r.status, 'found'); assert.equal(r.makerNoteOffset, 76);
    assert.deepEqual(Buffer.from(r.makerNote), fixture().note);
  }
});

test('non-Fuji MakerNote is returned for caller signature checks, including inline data', () => {
  for (const note of [Buffer.from('OTHER CAMERA'), Buffer.from([1, 2, 3])]) {
    const r = inspect(fixture({ note }).b);
    assert.equal(r.status, 'found'); assert.deepEqual(Buffer.from(r.makerNote), note);
    assert.equal(r.makerNoteOffset, note.length <= 4 ? 42 : 64);
  }
});

test('complete TIFF/JPEG without MakerNote returns absent', () => {
  for (const input of [fixture({ maker: false }).b, jpeg(exif(fixture({ maker: false }).b)), jpeg(segment(0xe1, Buffer.from('XMP FUJIFILM')))]) {
    const r = inspect(input);
    assert.equal(r.status, 'absent'); assert.equal(r.makerNote, null); assert.equal(r.makerNoteOffset, null);
  }
  assert.equal(inspect(jpeg()).exifFound, false);
});

test('follows next-IFD and SubIFDs chains', () => {
  const f = fixture();
  f.u16(10, 0x014a); // SubIFDs rather than Exif pointer.
  assert.equal(inspect(f.b).status, 'found');
  f.u16(8, 0); f.u32(10, 32); // Root has no entries, next IFD at 32.
  assert.equal(inspect(f.b).status, 'found');
});

test('SubIFDs array traversal is bounded and resolves out-of-line pointer arrays', () => {
  const f = fixture();
  f.u16(10, 0x014a); f.u32(14, 2); f.u32(18, 90);
  f.u32(90, 32); f.u32(94, 104); f.u16(104, 0); f.u32(106, 0);
  assert.equal(inspect(f.b).status, 'found');
  f.u32(14, 129);
  assert.equal(inspect(f.b).status, 'malformed');
});

test('malformed offsets, huge counts, truncated directories and invalid headers cannot report absent', () => {
  const variants = [
    f => f.u32(4, 1000),
    f => f.u16(8, 65535),
    f => f.u32(18, 127),
    f => f.u32(42, 125),
    f => f.u32(38, 0xffffffff),
    f => f.u32(38, 0),
    f => f.u16(36, 99),
    f => f.u16(2, 43),
    f => f.u32(4, 0),
    f => f.u32(18, 4)
  ];
  for (const mutate of variants) {
    const f = fixture(); mutate(f);
    const r = inspect(f.b);
    assert.equal(r.status, 'malformed'); assert.ok(r.warnings.length);
  }
  for (const input of [new Uint8Array([73, 73]), fixture().b.subarray(0, 47), jpeg(exif(Buffer.from([73, 73])))]) assert.equal(inspect(input).status, 'malformed');
});

test('cycles and traversal limits terminate with malformed', () => {
  const f = fixture({ maker: false }); f.u32(34, 8);
  assert.equal(inspect(f.b).status, 'malformed');
  const b = new Uint8Array(8 + 6 * 130); const v = new DataView(b.buffer);
  b.set([73, 73, 42, 0, 8, 0, 0, 0]);
  for (let i = 0; i < 129; i++) v.setUint32(8 + i * 6 + 2, 8 + (i + 1) * 6, true);
  assert.equal(inspect(b).status, 'malformed');
});

test('any malformed EXIF segment prevents absent even if another APP1 is valid', () => {
  const r = inspect(jpeg(exif(Buffer.from('bad')), exif(fixture({ maker: false }).b)));
  assert.equal(r.status, 'malformed'); assert.equal(r.exifFound, true);
});

test('malformation remains visible even when another segment contains a valid MakerNote', () => {
  const r = inspect(jpeg(exif(Buffer.from('bad')), exif(fixture().b)));
  assert.equal(r.status, 'malformed'); assert.ok(r.makerNote);
});

test('stops at SOS and never accepts fake EXIF or FUJIFILM signatures in image data', () => {
  const b = Buffer.concat([Buffer.from([255, 216]), segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), exif(fixture().b)]);
  const r = inspect(b);
  assert.equal(r.status, 'absent'); assert.equal(r.exifFound, false); assert.equal(r.makerNote, null);
});

test('JPEG structural corruption is malformed, not absent', () => {
  for (const b of [Buffer.from([255, 216]), Buffer.from([255, 216, 255]), Buffer.from([255, 216, 1]), Buffer.from([255, 216, 255, 225, 0, 1]), Buffer.from([255, 216, 255, 225, 0, 20]), Buffer.from([255, 216, 255, 218]), Buffer.from([255, 216, 255, 0])]) {
    assert.equal(inspect(b).status, 'malformed');
  }
});

test('HEIC, PNG, RAF and arbitrary data remain unsupported rather than absent', () => {
  for (const input of [Buffer.from('\0\0\0\x18ftypheic'), Buffer.from([137, 80, 78, 71]), Buffer.from('FUJIFILMCCD-RAW'), new Uint8Array(), null, 'JPEG']) {
    const r = inspect(input);
    assert.equal(r.status, 'unsupported'); assert.equal(r.container, 'unsupported');
    assert.equal(r.exifFound, false); assert.equal(r.makerNote, null);
  }
});

test('browser UMD exposes FujiMetadata without CommonJS globals', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../metadata-reader.js'), 'utf8'), context);
  assert.equal(typeof context.FujiMetadata.inspect, 'function');
  assert.equal(vm.runInContext('FujiMetadata.inspect(new Uint8Array([255,216,255,217])).status', context), 'absent');
});
