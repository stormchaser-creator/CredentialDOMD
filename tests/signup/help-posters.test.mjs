// Signup review 2026-10-07: /help/ loaded 1.67 MB of video posters (14 at
// 1920 x 1080, about 110 KB each) before anyone pressed play. They are the
// same frames at 960 x 540 now, still sharp on a phone at three times its
// width in CSS pixels, and the catalog's hashes follow them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadVideoCatalog } from '../../scripts/help-videos.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Width and height from a JPEG's start-of-frame segment.
function jpegSize(bytes) {
  assert.equal(bytes.readUInt16BE(0), 0xffd8, 'a JPEG');
  for (let at = 2; at < bytes.length;) {
    const marker = bytes.readUInt16BE(at), length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xffc0 && marker <= 0xffc3) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    at += 2 + length;
  }
  throw Error('no frame header');
}

test('every help video poster is 960 x 540 and small; together under 700 KB; the catalog verifies them', async () => {
  const catalog = await loadVideoCatalog(root); // checks every asset's hash
  let total = 0;
  for (const video of catalog.tutorials) {
    const bytes = await readFile(new URL(`../../landing/help-videos/${video.files.poster.file}`, import.meta.url));
    assert.deepEqual(jpegSize(bytes), { width: 960, height: 540 }, video.id);
    assert.ok(bytes.length <= 60 * 1024, `${video.id}: ${bytes.length} bytes`);
    assert.equal(video.files.poster.bytes, bytes.length);
    total += bytes.length;
  }
  assert.equal(catalog.tutorials.length, 14);
  assert.ok(total < 700 * 1024, `${total} bytes in all`);
});
