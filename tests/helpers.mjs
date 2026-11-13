import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function temporaryRadar(t) {
  const directory = mkdtempSync(join(tmpdir(), 'meme-watcher-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'meme_radar.db');
}
