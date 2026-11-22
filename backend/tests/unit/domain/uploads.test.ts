import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectImageKind, mimeForKey } from '../../../src/domain/uploads/images';
import { LocalFileStorage } from '../../../src/infrastructure/storage/LocalFileStorage';
import { EventBannerService } from '../../../src/services/events/EventBannerService';
import { images } from '../../helpers/imageFixtures';

const KEY = '0b3f6c1e-8a2d-4c5b-9e7f-1a2b3c4d5e6f.png';

describe('image content detection', () => {
  it('recognises JPEG, PNG and WebP by their bytes', () => {
    expect(detectImageKind(images.jpeg)).toBe('jpeg');
    expect(detectImageKind(images.png)).toBe('png');
    expect(detectImageKind(images.webp)).toBe('webp');
  });

  it('rejects truncated or spoofed content', () => {
    expect(detectImageKind(Buffer.alloc(4))).toBeNull();
    expect(detectImageKind(images.jpeg.subarray(0, 20))).toBeNull(); // no end-of-image marker
    const badPng = Buffer.from(images.png);
    badPng.write('XXXX', 12, 'latin1');
    expect(detectImageKind(badPng)).toBeNull();
    const badWebp = Buffer.from(images.webp);
    badWebp.writeUInt32LE(9999, 4); // RIFF size does not match the data
    expect(detectImageKind(badWebp)).toBeNull();
    expect(detectImageKind(Buffer.from('GIF89a'.padEnd(32, '\0')))).toBeNull();
    expect(detectImageKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });

  it('maps only server-generated keys to a content type', () => {
    expect(mimeForKey(KEY)).toBe('image/png');
    expect(mimeForKey(KEY.replace('.png', '.webp'))).toBe('image/webp');
    expect(mimeForKey('../x.png')).toBeNull();
    expect(mimeForKey(KEY.replace('.png', '.svg'))).toBeNull();
  });

  it('validate() enforces size, allowed type and declared/detected agreement', () => {
    const ok = { buffer: images.png, mimetype: 'image/png', size: images.png.length };
    expect(EventBannerService.validate(ok)).toBe('png');
    expect(() => EventBannerService.validate({ ...ok, size: 3 * 1024 * 1024 })).toThrow('2 MB');
    expect(() => EventBannerService.validate({ ...ok, mimetype: 'image/gif' })).toThrow(
      'Only JPEG, PNG and WebP',
    );
    expect(() => EventBannerService.validate({ ...ok, mimetype: 'image/webp' })).toThrow(
      'not a valid',
    );
  });
});

describe('LocalFileStorage', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tf-store-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('stores, reads and removes server-generated keys', async () => {
    const storage = new LocalFileStorage(root);
    await storage.put(KEY, images.png);
    expect(readdirSync(root)).toEqual([KEY]);
    expect(await storage.get(KEY)).toEqual(images.png);
    await expect(storage.put(KEY, images.png)).rejects.toThrow(); // never overwrites
    await storage.remove(KEY);
    await storage.remove(KEY); // idempotent
    expect(await storage.get(KEY)).toBeNull();
  });

  it('refuses traversal and arbitrary names', async () => {
    writeFileSync(path.join(root, 'secret.txt'), 'top secret');
    const storage = new LocalFileStorage(path.join(root, 'images'));
    for (const key of [
      '../secret.txt',
      '..\\secret.txt',
      '/etc/passwd',
      'secret.txt',
      `../${KEY}`,
    ]) {
      expect(await storage.get(key)).toBeNull();
      await expect(storage.put(key, Buffer.from('x'))).rejects.toThrow('Invalid storage key');
      await storage.remove(key);
    }
    expect(readdirSync(root)).toEqual(['secret.txt']);
  });
});
