/** Keep the exact captured inputs independently of the temporary upload files. */
import { copyFile, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseCapture } from '../backend/src/capture.ts';
import { artifactDirectory } from './artifacts.mjs';

/** Write one validated capture into an empty destination directory. */
export async function writeCaptureSnapshot(target, captured) {
  const capture = parseCapture(captured.capture);
  await mkdir(target);
  for (const name of [capture.source, ...capture.images.map(image => image.file)]) {
    const sources = captured.files.filter(path => basename(path) === name);
    if (sources.length !== 1) throw new Error(`Capture debug input missing or duplicated: ${name}`);
    await copyFile(sources[0], join(target, name));
  }
  await writeFile(join(target, 'capture.json'), `${JSON.stringify(capture, null, 2)}\n`, { flag: 'wx' });
  return capture;
}

/** Replace the dedicated capture directory; preserve the previous snapshot on ordinary failure. */
export async function saveCaptureDebug({ sessionId, captured, root }) {
  const parent = artifactDirectory(sessionId, root);
  const target = join(parent, 'capture');
  await mkdir(parent, { recursive: true });
  const lock = join(parent, '.capture.lock');
  await mkdir(lock);
  let staging, backup = false;
  try {
    staging = await mkdtemp(join(parent, '.capture-'));
    const next = join(staging, 'next');
    await writeCaptureSnapshot(next, captured);
    const existing = await lstat(target).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Capture debug path is not a regular directory: ${target}`);
      await rename(target, join(staging, 'previous'));
      backup = true;
    }
    try { await rename(next, target); }
    catch (error) {
      if (backup) {
        await rename(join(staging, 'previous'), target);
        backup = false;
      }
      throw error;
    }
    backup = false;
    return target;
  } finally {
    // If rollback itself fails, retain the previous directory for recovery.
    if (staging && !backup) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
