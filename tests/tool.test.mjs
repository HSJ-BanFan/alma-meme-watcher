import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { activate, deactivate } from '../main.js';
import { syncEntries } from '../src/store/radar.js';
import { temporaryRadar } from './helpers.mjs';

const cliPath = fileURLToPath(new URL('../scripts/lookup.mjs', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const sample = {
  term: '样本梗', aliases: ['样本别名', 'Café'], meaning: '固定测试词义。',
  usage_context: '友好的评论区。', avoid_when: '严肃的求助场景。', origin: '固定测试出处。',
  source_url: 'https://www.bilibili.com/video/BV2abcdefghK', ttl_days: 0, confidence: 0.9,
};
const cardFields = [
  'term', 'meaning', 'usage_context', 'avoid_when', 'origin', 'source_url',
  'aliases', 'matched_keys', 'confidence', 'days_left',
].sort();

async function register(t, dbPath) {
  const calls = [];
  const disposed = [];
  const lifecycle = await activate({
    logger: { info() {} },
    tools: {
      register(...args) {
        calls.push(args);
        return { dispose() { disposed.push(args[0]); } };
      },
    },
  }, { dbPath });
  t.after(() => lifecycle?.dispose());
  return { calls, disposed, lifecycle, lookup: calls.find(([id]) => id === 'meme_watch_lookup')?.[1] };
}

function populate(dbPath) {
  syncEntries([sample, ...['A', 'B', 'C', 'D'].map((term) => ({
    ...sample, term, aliases: [], meaning: `${term} 的测试释义。`,
  }))], { dbPath, now: 1000 });
}

function termsSnapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM terms ORDER BY term').all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

function assertFailure(result, code) {
  assert.deepEqual(Object.keys(result).sort(), ['code', 'message', 'ok']);
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.trim());
  assert.equal(result.message.includes(fileURLToPath(new URL('..', import.meta.url))), false);
  assert.doesNotMatch(result.message, /Error:|[\\/\r\n]|secret-test-token/u);
}

test('tools register with two arguments, object schemas and exactly the manifest IDs', async (t) => {
  const { calls, lifecycle } = await register(t, temporaryRadar(t));
  for (const args of calls) {
    assert.equal(args.length, 2, 'ToolAPI requires register(id, descriptor)');
    const [id, descriptor] = args;
    assert.equal(typeof id, 'string');
    assert.equal(typeof descriptor.description, 'string');
    assert.equal(descriptor.parameters.type, 'object');
    assert.equal(typeof descriptor.execute, 'function');
  }
  assert.deepEqual(calls.map(([id]) => id).sort(), manifest.contributes.tools.map(({ id }) => id).sort());
  assert.deepEqual(calls.find(([id]) => id === 'meme_watch_lookup')[1].parameters, {
    type: 'object', additionalProperties: false, required: ['text'],
    properties: { text: { type: 'string' }, limit: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 3 } },
  });
  assert.equal(typeof lifecycle.dispose, 'function');
});

test('activation disposes its registrations once and the legacy deactivate export still cleans up', async (t) => {
  const first = await register(t, temporaryRadar(t));
  const second = await register(t, temporaryRadar(t));
  first.lifecycle.dispose();
  first.lifecycle.dispose();
  assert.deepEqual(first.disposed.sort(), first.calls.map(([id]) => id).sort());
  assert.deepEqual(second.disposed, []);
  await deactivate();
  await deactivate();
  assert.deepEqual(second.disposed.sort(), second.calls.map(([id]) => id).sort());
});

test('the lookup tool and absolute CLI return identical ten-field cards from a fixed temporary database', async (t) => {
  const dbPath = temporaryRadar(t);
  populate(dbPath);
  const before = termsSnapshot(dbPath);
  const { lookup } = await register(t, dbPath);
  for (const [text, limit] of [
    ['样本别名'], ['样本梗 CAFÉ', 3], ['A B C D'], ['A B C D', 2], ['A B C D', Number.MAX_SAFE_INTEGER],
  ]) {
    const input = { text, ...(limit === undefined ? {} : { limit }) };
    const args = [cliPath, `--text=${text}`, `--db=${dbPath}`, ...(limit === undefined ? [] : [`--limit=${limit}`])];
    const cli = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000, cwd: dirname(dbPath) });
    assert.equal(cli.error, undefined);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stderr, '');
    const result = await lookup.execute(input);
    assert.deepEqual(result, { ok: true, terms: JSON.parse(cli.stdout).terms });
    for (const card of result.terms) assert.deepEqual(Object.keys(card).sort(), cardFields);
    if (text === '样本别名') {
      assert.deepEqual(result.terms, [{
        term: sample.term, meaning: sample.meaning, usage_context: sample.usage_context,
        avoid_when: sample.avoid_when, origin: sample.origin, source_url: sample.source_url,
        aliases: sample.aliases, matched_keys: ['样本别名'], confidence: 0.9, days_left: null,
      }]);
    }
    if (text === 'A B C D' && limit === undefined) assert.deepEqual(result.terms.map(({ term }) => term), ['A', 'B', 'C']);
    assert.deepEqual(termsSnapshot(dbPath), before);
  }
});

test('no hits, empty or whitespace text and limit zero succeed without changing terms', async (t) => {
  const dbPath = temporaryRadar(t);
  populate(dbPath);
  const before = termsSnapshot(dbPath);
  const { lookup } = await register(t, dbPath);
  for (const input of [{ text: '词库外的内容' }, { text: '' }, { text: ' \t\n ' }, { text: '样本梗', limit: 0 }]) {
    assert.deepEqual(await lookup.execute(input), { ok: true, terms: [] });
    assert.deepEqual(termsSnapshot(dbPath), before);
  }
});

test('missing and corrupt databases are sanitized failures even for empty text or zero limit', async (t) => {
  const missing = join(dirname(temporaryRadar(t)), 'missing-parent', 'radar.db');
  const corrupt = temporaryRadar(t);
  const bytes = 'not a SQLite database';
  writeFileSync(corrupt, bytes);
  for (const [dbPath, code] of [[missing, 'DATABASE_UNAVAILABLE'], [corrupt, 'DATABASE_ERROR']]) {
    const { lookup } = await register(t, dbPath);
    for (const input of [{ text: '样本梗' }, { text: '' }, { text: '样本梗', limit: 0 }]) {
      assertFailure(await lookup.execute(input), code);
    }
  }
  assert.equal(existsSync(dirname(missing)), false);
  assert.equal(readFileSync(corrupt, 'utf8'), bytes);
});

test('invalid lookup arguments are rejected before calling the store and never create a database', async (t) => {
  const dbPath = join(dirname(temporaryRadar(t)), 'missing-parent', 'radar.db');
  const { lookup } = await register(t, dbPath);
  let storeCalls = 0;
  const clock = t.mock.method(Date, 'now', () => {
    storeCalls++;
    throw new Error('store must not be reached for invalid arguments');
  });
  const inputs = [
    undefined, null, [], {}, { text: null }, { text: 1 }, { text: false },
    ...[-1, 1.5, '3', undefined, null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
      .map((limit) => ({ text: '样本梗', limit })),
    { text: '样本梗', dbPath }, { text: '样本梗', now: 1000 },
  ];
  for (const input of inputs) assertFailure(await lookup.execute(input), 'INVALID_ARGUMENTS');
  clock.mock.restore();
  assert.equal(storeCalls, 0);
  assert.equal(existsSync(dbPath), false);
  assert.equal(existsSync(dirname(dbPath)), false);
});

test('store INVALID_OPTIONS maps to the public INVALID_ARGUMENTS code', async (t) => {
  const { lookup } = await register(t, '');
  assertFailure(await lookup.execute({ text: '样本梗' }), 'INVALID_ARGUMENTS');
});

test('unexpected lookup errors never expose paths, stack traces or secrets', async (t) => {
  const dbPath = temporaryRadar(t);
  const { lookup } = await register(t, dbPath);
  const clock = t.mock.method(Date, 'now', () => {
    throw new Error(`${dbPath} Error: secret-test-token`);
  });
  assertFailure(await lookup.execute({ text: '样本梗' }), 'INTERNAL_ERROR');
  clock.mock.restore();
  assert.equal(existsSync(dbPath), false);
});
