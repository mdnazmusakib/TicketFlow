import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileStorage } from '../../domain/uploads/FileStorage';
import { IMAGE_KEY_PATTERN } from '../../domain/uploads/images';

/**
 * Local-disk storage. Only server-generated keys (<uuid>.<ext>) are accepted,
 * and every resolved path must stay inside the root directory, so user input
 * can never reach `..`, absolute paths or other files.
 */
export class LocalFileStorage implements FileStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string | null {
    if (!IMAGE_KEY_PATTERN.test(key)) return null;
    const full = path.resolve(this.root, key);
    return path.dirname(full) === this.root ? full : null;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    if (!full) throw new Error('Invalid storage key');
    await mkdir(this.root, { recursive: true });
    // 'wx': never overwrite an existing file.
    await writeFile(full, data, { flag: 'wx', mode: 0o640 });
  }

  async get(key: string): Promise<Buffer | null> {
    const full = this.resolve(key);
    if (!full) return null;
    try {
      return await readFile(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    const full = this.resolve(key);
    if (full) await rm(full, { force: true });
  }
}
