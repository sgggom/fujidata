/* Binary EXIF/MakerNote inspection. No decoding, network, or filesystem access. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FujiMetadata = factory();
}(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_IFDS = 128;
  var MAX_ENTRIES = 65536;
  var TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1,
    8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

  function inspect(input) {
    var result = { container: 'unsupported', status: 'unsupported', exifFound: false,
      makerNote: null, makerNoteOffset: null, warnings: [] };
    var bytes;
    if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else {
      result.warnings.push('Expected an ArrayBuffer or typed view.');
      return result;
    }
    var malformed = false;
    function fail(message) {
      malformed = true;
      result.warnings.push(message);
    }
    function finish() {
      result.status = malformed ? 'malformed' : result.makerNote ? 'found' : 'absent';
      return result;
    }
    function tiff(start, end) {
      var length = end - start;
      result.exifFound = true;
      if (length < 8) { fail('Truncated TIFF header.'); return; }
      var little = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
      var big = bytes[start] === 0x4d && bytes[start + 1] === 0x4d;
      if (!little && !big) { fail('Invalid TIFF byte order.'); return; }
      var view = new DataView(bytes.buffer, bytes.byteOffset + start, length);
      if (view.getUint16(2, little) !== 42) { fail('Invalid or unsupported TIFF magic (expected 42).'); return; }
      function fits(offset, size) {
        return Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= 0 && size >= 0 && offset <= length && size <= length - offset;
      }
      var first = view.getUint32(4, little);
      if (first < 8) { fail('Missing or invalid TIFF IFD0 offset.'); return; }
      var queue = [first];
      var seen = new Set();
      var entryBudget = MAX_ENTRIES;
      while (queue.length) {
        var offset = queue.pop();
        if (!offset) continue;
        if (seen.has(offset)) { fail('Repeated TIFF IFD offset (cycle or shared directory).'); continue; }
        if (seen.size >= MAX_IFDS) { fail('TIFF IFD traversal limit exceeded.'); return; }
        seen.add(offset);
        if (offset < 8 || !fits(offset, 2)) { fail('TIFF IFD offset is outside the metadata segment.'); continue; }
        var count = view.getUint16(offset, little);
        if (count > entryBudget) { fail('TIFF entry traversal limit exceeded.'); return; }
        entryBudget -= count;
        if (!fits(offset + 2, count * 12 + 4)) { fail('Truncated TIFF IFD entries or next-IFD pointer.'); continue; }
        for (var i = 0; i < count; i++) {
          var entry = offset + 2 + i * 12;
          var tag = view.getUint16(entry, little);
          var type = view.getUint16(entry + 2, little);
          var items = view.getUint32(entry + 4, little);
          var width = TYPE_SIZES[type];
          if (!width) { fail('Unsupported TIFF field type ' + type + '.'); continue; }
          var size = items * width;
          var valueOffset = size <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
          if (!fits(valueOffset, size) || (size > 4 && valueOffset < 8)) {
            fail('TIFF field payload is outside the metadata segment.'); continue;
          }
          if (tag === 0x927c) {
            if (size === 0) { fail('Empty MakerNote field.'); continue; }
            if (!result.makerNote) {
              result.makerNoteOffset = start + valueOffset;
              result.makerNote = bytes.subarray(start + valueOffset, start + valueOffset + size);
            } else result.warnings.push('Additional MakerNote field ignored.');
          }
          // Standard EXIF, SubIFDs, and interoperability child directories.
          if (tag === 0x8769 || tag === 0x014a || tag === 0xa005) {
            if ((type !== 4 && type !== 13) || !items || (tag !== 0x014a && items !== 1)) {
              fail('Invalid TIFF child-IFD pointer field.'); continue;
            }
            if (items > MAX_IFDS || queue.length + items > MAX_IFDS) {
              fail('TIFF child-IFD traversal limit exceeded.'); continue;
            }
            for (var p = 0; p < items; p++) queue.push(view.getUint32(valueOffset + p * 4, little));
          }
        }
        var next = view.getUint32(offset + 2 + count * 12, little);
        if (next) queue.push(next);
      }
    }

    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      result.container = 'JPEG';
      var position = 2;
      var terminated = false;
      while (position < bytes.length) {
        if (bytes[position] !== 0xff) { fail('Expected JPEG marker.'); break; }
        while (position < bytes.length && bytes[position] === 0xff) position++;
        if (position === bytes.length) { fail('Truncated JPEG marker.'); break; }
        var marker = bytes[position++];
        if (marker === 0xd9) { terminated = true; break; }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (marker === 0 || marker === 0xd8) { fail('Invalid JPEG marker before scan data.'); break; }
        if (position + 2 > bytes.length) { fail('Truncated JPEG segment length.'); break; }
        var segmentSize = (bytes[position] << 8) | bytes[position + 1];
        if (segmentSize < 2 || segmentSize > bytes.length - position) { fail('Invalid or truncated JPEG segment.'); break; }
        var end = position + segmentSize;
        var payload = position + 2;
        if (marker === 0xda) { terminated = true; break; } // Never inspect entropy-coded image data.
        if (marker === 0xe1 && end - payload >= 6 &&
            bytes[payload] === 0x45 && bytes[payload + 1] === 0x78 && bytes[payload + 2] === 0x69 &&
            bytes[payload + 3] === 0x66 && bytes[payload + 4] === 0 && bytes[payload + 5] === 0) {
          tiff(payload + 6, end);
        }
        position = end;
      }
      if (!terminated && !malformed) fail('JPEG ended before SOS or EOI.');
      return finish();
    }
    if (bytes.length >= 2 && ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d))) {
      result.container = 'TIFF';
      tiff(0, bytes.length);
      return finish();
    }
    return result;
  }

  return { inspect: inspect };
}));
