import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';
import { syntheticPng } from '../../qa-lab/e2e/support/lab.mjs';

test('the support/upload PNG fixture has complete chunks, valid CRCs and decodable RGB scanlines', () => {
  const png = syntheticPng();
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const compressed = []; let width, height, ended = false;
  for (let offset = 8; offset < png.length;) {
    assert.ok(offset + 12 <= png.length, 'complete chunk header and checksum');
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    const end = offset + 8 + size;
    assert.ok(end + 4 <= png.length, `${type} payload is complete`);
    assert.equal(crc32(png.subarray(offset + 4, end)), png.readUInt32BE(end), `${type} checksum`);
    if (type === 'IHDR') {
      width = png.readUInt32BE(offset + 8); height = png.readUInt32BE(offset + 12);
      assert.deepEqual([...png.subarray(offset + 16, end)], [8, 2, 0, 0, 0], '8-bit RGB with standard compression and no interlace');
    }
    if (type === 'IDAT') compressed.push(png.subarray(offset + 8, end));
    if (type === 'IEND') { ended = true; assert.equal(end + 4, png.length); }
    offset = end + 4;
  }
  assert.ok(ended); assert.equal(width, 16); assert.equal(height, 16);
  const pixels = inflateSync(Buffer.concat(compressed));
  assert.equal(pixels.length, height * (1 + width * 3));
  for (let y = 0; y < height; y++) assert.equal(pixels[y * (1 + width * 3)], 0, 'each row uses the unfiltered RGB scanline format');
});
