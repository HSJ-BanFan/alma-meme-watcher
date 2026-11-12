import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { activate, deactivate } from '../main.js';

const root = resolve(import.meta.dirname, '..');

test('manifest.json is valid and declares required fields', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'alma-meme-watcher');
  assert.equal(manifest.main, 'main.js');
  assert.ok(Array.isArray(manifest.contributes?.tools));
  assert.ok(manifest.contributes.tools.length >= 1);
});

test('main.js exports activate and deactivate and registers tool', async () => {
  const registered = [];
  await activate({
    logger: { info() {} },
    tools: { register: (tool) => registered.push(tool) },
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, 'meme_watch_status');
  const res = await registered[0].execute();
  assert.equal(res.ok, true);
  assert.equal(res.targetMid, '94510621');
  await deactivate();
});
