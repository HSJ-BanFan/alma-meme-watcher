import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { activate, deactivate } from '../main.js';
import { lookup } from '../src/store/radar.js';
import { temporaryRadar } from './helpers.mjs';

const root = resolve(import.meta.dirname, '..');
const video = JSON.parse(readFileSync(new URL('./fixtures/BV1hNWm6mEkz.json', import.meta.url), 'utf8'));
const [seed] = JSON.parse(readFileSync(new URL('../data/seed-memes.json', import.meta.url), 'utf8'));

async function register(dbPath) {
  const registered = [];
  await activate({
    logger: { info() {} },
    tools: { register: (id, descriptor) => { registered.push({ id, ...descriptor }); return { dispose() {} }; } },
  }, { dbPath });
  return registered;
}

test('manifest.json is valid and declares the three tool IDs', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'alma-meme-watcher');
  assert.equal(manifest.main, 'main.js');
  assert.deepEqual(manifest.contributes.tools.map((tool) => tool.id).sort(), ['meme_watch_lookup', 'meme_watch_status', 'meme_watch_sync']);
});

test('main.js registers the declared tool IDs and missing-db status remains read-only', async (t) => {
  const dbPath = temporaryRadar(t);
  t.after(deactivate);
  const registered = await register(dbPath);
  assert.deepEqual(registered.map((tool) => tool.id).sort(), ['meme_watch_lookup', 'meme_watch_status', 'meme_watch_sync']);
  const res = await registered.find((tool) => tool.id === 'meme_watch_status').execute();
  assert.deepEqual(res, {
    ok: true,
    targetMid: '94510621',
    status: 'ready_not_synced',
    terms: 0,
    candidates: 0,
    eligible: 0,
    last_sync: null,
    live_watching: false,
    audio_transcription: false,
  });
  assert.equal(existsSync(dbPath), false);
});

test('registered handlers sync the real fixture, retrieve aliases and report an unchanged replay', async (t) => {
  const dbPath = temporaryRadar(t);
  t.after(deactivate);
  const registered = await register(dbPath);
  const sync = registered.find((tool) => tool.id === 'meme_watch_sync');
  const status = registered.find((tool) => tool.id === 'meme_watch_status');
  const first = await sync.execute({ video });
  assert.equal(first.ok, true);
  assert.deepEqual([first.inserted, first.updated, first.unchanged], [1, 0, 0]);
  assert.equal(first.entries[0].term, seed.term);
  assert.equal(first.entries[0].source_url, seed.source_url);
  assert.doesNotMatch(first.entries[0].meaning, /双手|上下/);
  for (const alias of seed.aliases) assert.equal(lookup(alias, { dbPath })[0].term, seed.term);
  const stored = await status.execute();
  assert.equal(stored.status, 'synced');
  assert.deepEqual([stored.terms, stored.candidates, stored.eligible], [1, 0, 1]);
  assert.equal(stored.last_sync.source_url, video.source_url);
  assert.equal(Number.isFinite(stored.last_sync.applied_at), true);
  const replay = await sync.execute({ video });
  assert.deepEqual([replay.inserted, replay.updated, replay.unchanged], [0, 0, 1]);
  assert.equal(replay.entries[0].last_seen, first.entries[0].last_seen);
  assert.deepEqual((await status.execute()).last_sync, stored.last_sync);
});

test('the sync tool accepts Agent entries without transcript and rejects mismatched sources or types', async (t) => {
  const dbPath = temporaryRadar(t);
  t.after(deactivate);
  const registered = await register(dbPath);
  const sync = registered.find((tool) => tool.id === 'meme_watch_sync');
  const suppliedVideo = { source_url: 'https://www.bilibili.com/video/BV2abcdefghK', bvid: 'BV2abcdefghK', aid: '123456789012345678' };
  const supplied = { ...seed, meaning: '由 Agent 核实并提供的中文释义。', origin: '由 Agent 核实的叙述性出处。', source_url: suppliedVideo.source_url };
  const result = await sync.execute({ video: suppliedVideo, entries: [supplied] });
  assert.equal(result.ok, true);
  assert.equal(lookup('Kipfel逗人', { dbPath })[0].meaning, supplied.meaning);
  assert.equal(result.entries[0].published_at, seed.published_at);
  const before = await registered.find((tool) => tool.id === 'meme_watch_status').execute();
  for (const [entries, code] of [[[{ ...supplied, confidence: '0.8' }], 'INVALID_ENTRY'], [[{ ...supplied, source_url: video.source_url }], 'SOURCE_MISMATCH'], [[], 'INVALID_BATCH']]) {
    const failed = await sync.execute({ video: suppliedVideo, entries });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, code);
    assert.equal(typeof failed.message, 'string');
    assert.equal(Object.hasOwn(failed, 'inserted'), false);
  }
  assert.deepEqual(await registered.find((tool) => tool.id === 'meme_watch_status').execute(), before);
});

test('invalid sync input returns coded failure without creating the supplied temporary database', async (t) => {
  const dbPath = temporaryRadar(t);
  t.after(deactivate);
  const sync = (await register(dbPath)).find((tool) => tool.id === 'meme_watch_sync');
  for (const [input, code] of [[undefined, 'INVALID_VIDEO'], [{ video: { ...video, raw_transcript_ja: '' } }, 'UNSUPPORTED_TRANSCRIPT'], [{ video: { ...video, source_url: 'https://example.org/video' } }, 'INVALID_SOURCE_URL']]) {
    const failed = await sync.execute(input);
    assert.equal(failed.ok, false);
    assert.equal(failed.code, code);
    assert.equal(typeof failed.message, 'string');
  }
  assert.equal(existsSync(dbPath), false);
});

test('database failures are tool failures, not success summaries or empty status', async (t) => {
  const dbPath = temporaryRadar(t);
  t.after(deactivate);
  const registered = await register(dbPath);
  const sync = registered.find((tool) => tool.id === 'meme_watch_sync');
  const status = registered.find((tool) => tool.id === 'meme_watch_status');
  const original = await sync.execute({ video });
  const before = await status.execute();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TRIGGER deny_review BEFORE INSERT ON term_reviews BEGIN SELECT RAISE(ABORT, 'tool sync denied'); END");
  } finally {
    db.close();
  }
  const failed = await sync.execute({ video, entries: [{ ...seed, meaning: '新的明确释义。' }] });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'DATABASE_ERROR');
  assert.match(failed.message, /tool sync denied/);
  assert.equal(Object.hasOwn(failed, 'updated'), false);
  assert.equal(lookup(seed.term, { dbPath })[0].meaning, original.entries[0].meaning);
  assert.deepEqual(await status.execute(), before);
  const corruptPath = temporaryRadar(t);
  writeFileSync(corruptPath, 'not SQLite');
  const corruptTools = await register(corruptPath);
  for (const id of ['meme_watch_status', 'meme_watch_sync']) {
    const error = await corruptTools.find((tool) => tool.id === id).execute({ video });
    assert.equal(error.ok, false);
    assert.equal(error.code, 'DATABASE_ERROR');
    assert.equal(Object.hasOwn(error, 'terms'), false);
  }
});
