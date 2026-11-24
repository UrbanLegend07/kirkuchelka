/**
 * Tiny persistence for data that must survive a server restart
 * (unsent match results, last known ratings). One JSON file per store.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export class JsonFileStore {
  constructor(filePath) {
    this.filePath = filePath;
    /** Writes run one after another, two writes never touch the file at the same time. */
    this.writeQueue = Promise.resolve();
  }

  /** Returns the saved value, or `defaultValue` when the file does not exist or is broken. */
  async read(defaultValue) {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[storage] could not read ${this.filePath}, starting empty:`, error.message);
      }
      return defaultValue;
    }
  }

  /** Writes to a temporary file first and then renames it, so a crash never leaves half a file. */
  write(value) {
    const content = JSON.stringify(value, null, 2);
    const writeTask = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await fs.writeFile(temporaryPath, content);
      await fs.rename(temporaryPath, this.filePath);
    });
    this.writeQueue = writeTask.catch(() => {});
    return writeTask;
  }
}

/** Same interface without a file, used in tests. */
export class MemoryStore {
  constructor(initialValue) {
    this.value = initialValue;
  }

  async read(defaultValue) {
    return this.value === undefined ? defaultValue : structuredClone(this.value);
  }

  async write(value) {
    this.value = structuredClone(value);
  }
}
