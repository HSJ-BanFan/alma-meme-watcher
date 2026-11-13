import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lookupCards, lookup, radarStatus, syncEntries } from '../src/store/radar.js';
import { temporaryRadar } from './helpers.mjs';

const cliPath = fileURLToPath(new URL('../scripts/lookup.mjs', import.meta.url));
const sample = JSON.parse(readFileSync(new URL('../data/seed-memes.json', import.meta.url), 'utf8'))
  .find((entry) => entry.term === '结过婚我也认');
const stringFields = ['term', 'meaning', 'usage_context', 'avoid_when', 'origin', 'source_url'];
const cardFields = [...stringFields, 'aliases', 'matched_keys', 'confidence', 'days_left'].sort();
const termColumns = [
  'term TEXT PRIMARY KEY', "aliases TEXT NOT NULL DEFAULT ''", 'meaning TEXT NOT NULL',
  "example TEXT NOT NULL DEFAULT ''", "origin TEXT NOT NULL DEFAULT ''", "tags TEXT NOT NULL DEFAULT ''",
  'first_seen REAL NOT NULL', 'last_seen REAL NOT NULL', 'heat INTEGER NOT NULL DEFAULT 1',
  'confidence REAL NOT NULL DEFAULT 0.5', 'ttl_days INTEGER NOT NULL DEFAULT 30', "source TEXT NOT NULL DEFAULT ''",
];
const queryVariants = [
  ['--text', 'Broken'], ['--text', ''], ['--text', 'Broken', '--limit', '0'], ['--text', '', '--limit', '0'],
];
const failsWith = (code) => (error) => error.code === code;

function fixtureDatabase(dbPath, operation) {
  const db = new DatabaseSync(dbPath);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function legacyFixture(dbPath, entries = [], { reviews = true, metadata = false } = {}) {
  fixtureDatabase(dbPath, (db) => {
    db.exec(`CREATE TABLE terms (${termColumns.join(',')})`);
    if (reviews) db.exec(`CREATE TABLE term_reviews (
      term TEXT PRIMARY KEY, status TEXT NOT NULL, reviewed_at REAL NOT NULL,
      source_url TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT 'local_tool')`);
    if (metadata) db.exec(`CREATE TABLE watcher_entry_meta (
      term TEXT PRIMARY KEY, usage_context TEXT, avoid_when TEXT, published_at TEXT)`);
    const insertTerm = db.prepare('INSERT INTO terms VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertReview = reviews ? db.prepare('INSERT INTO term_reviews VALUES (?,?,?,?,?)') : null;
    const insertMeta = metadata ? db.prepare('INSERT INTO watcher_entry_meta VALUES (?,?,?,?)') : null;
    for (const entry of entries) {
      const row = {
        aliases: '', meaning: '旧版定义', example: '旧例子', origin: '旧出处', tags: '',
        first_seen: 1, last_seen: 1000, heat: 1, confidence: 0.8, ttl_days: 0, source: 'legacy',
        review_status: 'accepted', source_url: '', usage_context: '', avoid_when: '', ...entry,
      };
      insertTerm.run(row.term, row.aliases, row.meaning, row.example, row.origin, row.tags,
        row.first_seen, row.last_seen, row.heat, row.confidence, row.ttl_days, row.source);
      if (insertReview && row.review_status !== null) insertReview.run(row.term, row.review_status, 1000, row.source_url, 'human');
      if (insertMeta && row.metadata !== false) insertMeta.run(row.term, row.usage_context, row.avoid_when, row.published_at ?? null);
    }
  });
}

function snapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let state;
  try {
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all().map((row) => ({ ...row }));
    const rows = Object.fromEntries(schema.filter((row) => row.type === 'table').map(({ name }) => [
      name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all().map((row) => ({ ...row })),
    ]));
    state = { schema, rows, schema_version: db.prepare('PRAGMA schema_version').get().schema_version };
  } finally {
    db.close();
  }
  return { ...state, bytes: readFileSync(dbPath) };
}

function invokeCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd, timeout: 20000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function assertCard(card) {
  assert.deepEqual(Object.keys(card).sort(), cardFields);
  for (const field of stringFields) assert.equal(typeof card[field], 'string', field);
  for (const field of ['aliases', 'matched_keys']) {
    assert.equal(Array.isArray(card[field]), true, field);
    assert.equal(card[field].every((key) => typeof key === 'string'), true, field);
  }
  assert.equal(typeof card.confidence, 'number');
  assert.equal(Number.isFinite(card.confidence), true);
  assert.equal(card.days_left === null || (Number.isInteger(card.days_left) && card.days_left > 0), true);
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(result.stdout, `${JSON.stringify(payload)}\n`);
  assert.deepEqual(Object.keys(payload), ['terms']);
  assert.equal(Array.isArray(payload.terms), true);
  payload.terms.forEach(assertCard);
  return payload.terms;
}

function failure(result, code, exit = 1) {
  assert.equal(result.status, exit, result.stderr);
  assert.equal(result.stdout, '');
  const payload = JSON.parse(result.stderr);
  assert.equal(result.stderr, `${JSON.stringify(payload)}\n`);
  assert.deepEqual(Object.keys(payload), ['error']);
  assert.deepEqual(Object.keys(payload.error).sort(), ['code', 'message']);
  assert.equal(payload.error.code, code);
  assert.equal(typeof payload.error.message, 'string');
  assert.ok(payload.error.message.trim());
  assert.doesNotMatch(payload.error.message, /[\\/\r\n]/u);
}

function watcherEntry(term, extra = {}) {
  return { ...sample, term, aliases: [], meaning: `${term}的明确释义。`, ...extra };
}

test('cards normalize NFC, case and whitespace and share canonical and alias ASCII boundaries', (t) => {
  const dbPath = temporaryRadar(t);
  legacyFixture(dbPath, [{ term: 'Café', aliases: 'Kipfel，旧别名;Café' }, { term: 'CPU' }]);
  const before = snapshot(dbPath);
  const [canonical] = lookupCards(' \tCAFÉ\n ', { dbPath, now: 1001 });
  assert.equal(canonical.term, 'Café');
  assert.deepEqual(canonical.matched_keys, ['Café']);
  const query = '评论区先写 myKipfel，再写 KIPFEL！';
  const [alias] = lookupCards(query, { dbPath, now: 1001 });
  assert.deepEqual(alias.matched_keys, ['Kipfel']);
  assert.equal(lookup(query, { dbPath, now: 1001 })[0].term, 'Café');
  assert.deepEqual(lookupCards('前面 myCPU，后面 CPU！', { dbPath, now: 1001 })[0].matched_keys, ['CPU']);
  for (const text of ['myKipfel', 'Kipfeler', '_kipfel', 'kipfel_', '2Kipfel', 'Kipfel2',
    'myCPU', 'CPU2', '_CPU', 'CPU_', '2CPU', '旧版定义']) {
    assert.deepEqual(lookupCards(text, { dbPath, now: 1001 }), [], text);
    assert.deepEqual(lookup(text, { dbPath, now: 1001 }), [], text);
  }
  assert.deepEqual(snapshot(dbPath), before);
});

test('matched keys retain canonical then decoded alias spelling and deduplicate normalized identities', (t) => {
  const dbPath = temporaryRadar(t);
  const term = 'Café';
  legacyFixture(dbPath, [{ term, aliases: `CAFÉ，Other;OTHER|旧别名/${term},other2` }]);
  const [card] = lookupCards('CAFÉ Other 旧别名 other2', { dbPath, now: 1001 });
  assert.deepEqual(card.matched_keys, [term, 'Other', '旧别名', 'other2']);
  assert.deepEqual(card.aliases, ['CAFÉ', 'Other', 'OTHER', '旧别名', term, 'other2']);
  assertCard(card);
});

test('an exact alias does not reorder matching canonical and substring alias keys', (t) => {
  const dbPath = temporaryRadar(t);
  legacyFixture(dbPath, [{ term: '短', aliases: '短名,名,短' }]);
  const [card] = lookupCards('短名', { dbPath, now: 1001 });
  assert.deepEqual(card.matched_keys, ['短', '短名', '名']);
  assert.deepEqual(card.aliases, ['短名', '名', '短']);
});

test('card ranks retain lookup parity and exact, alias, heat, last-seen and canonical tie ordering', (t) => {
  const dbPath = temporaryRadar(t);
  legacyFixture(dbPath, [
    { term: '大梗名字', heat: 1, last_seen: 0 },
    { term: '别名完整', aliases: '大梗名字', heat: 999, last_seen: 900 },
    { term: '大梗', heat: 20, last_seen: 100 },
    { term: '梗名字', heat: 10, last_seen: 300 },
    { term: '梗名', heat: 10, last_seen: 200 },
    { term: '名字', heat: 10, last_seen: 200 },
    { term: '仅别名', aliases: '梗', heat: 9999, last_seen: 1000 },
  ]);
  const expected = ['大梗名字', '别名完整', '大梗', '梗名字', '名字', '梗名', '仅别名'];
  for (const limit of [0, 1, 3, 7, 20]) {
    const options = { dbPath, now: 1001, limit };
    assert.deepEqual(lookupCards('大梗名字', options).map((card) => card.term), expected.slice(0, limit));
    assert.deepEqual(lookup('大梗名字', options).map((entry) => entry.term), expected.slice(0, limit));
  }
  assert.deepEqual(lookupCards('大梗名字', { dbPath, now: 1001 }).map((card) => card.term), expected.slice(0, 3));
});

test('card and status eligibility preserve reviews, the 0.7 threshold and legacy numeric confidence', (t) => {
  const dbPath = temporaryRadar(t);
  legacyFixture(dbPath, [
    { term: 'Accepted', confidence: 0.7 },
    { term: 'Reference', confidence: 1.2, review_status: 'local_reference' },
    { term: 'Rejected', review_status: 'rejected' },
    { term: 'Missing', review_status: 'source_missing' },
    { term: 'Legacy', review_status: 'unreviewed_legacy' },
    { term: 'Low', confidence: 0.69999 },
    { term: 'Unreviewed', review_status: null },
  ]);
  const before = snapshot(dbPath);
  const text = 'Accepted Reference Rejected Missing Legacy Low Unreviewed';
  const options = { dbPath, now: 1001, limit: 10 };
  assert.deepEqual(lookupCards(text, options).map((card) => card.term), ['Accepted', 'Reference']);
  assert.deepEqual(lookup(text, options).map((entry) => entry.term), ['Accepted', 'Reference']);
  assert.equal(radarStatus(options).eligible, 2);
  assert.deepEqual(snapshot(dbPath), before);
});

test('positive TTL uses injected seconds and ceil days before, at and after expiry', (t) => {
  const dbPath = temporaryRadar(t);
  legacyFixture(dbPath, [{ term: 'Timed', last_seen: 1000, ttl_days: 2 }]);
  const before = snapshot(dbPath);
  const expiry = 1000 + 2 * 86400;
  for (const [now, days] of [
    [1000, 2], [expiry - 86400 - 0.25, 2], [expiry - 86400, 1], [expiry - 0.25, 1], [expiry, null], [expiry + 0.25, null],
  ]) {
    const cards = lookupCards('Timed', { dbPath, now });
    assert.equal(cards.length, days === null ? 0 : 1, String(now));
    if (days !== null) assert.equal(cards[0].days_left, days, String(now));
    assert.equal(lookup('Timed', { dbPath, now }).length, cards.length);
    assert.equal(radarStatus({ dbPath, now }).eligible, cards.length);
  }
  assert.deepEqual(snapshot(dbPath), before);
});

test('fractional numeric TTL returns one remaining day and expires at the same instant', (t) => {
  const dbPath = temporaryRadar(t);
  legacyFixture(dbPath, [{ term: 'Fractional', last_seen: 1000, ttl_days: 0.25 }]);
  const expiry = 1000 + 0.25 * 86400;
  assert.equal(lookupCards('Fractional', { dbPath, now: expiry - 0.125 * 86400 })[0].days_left, 1);
  assert.deepEqual(lookupCards('Fractional', { dbPath, now: expiry }), []);
  assert.equal(radarStatus({ dbPath, now: expiry }).eligible, 0);
});

test('zero and negative TTL remain eligible indefinitely with null days-left', (t) => {
  const dbPath = temporaryRadar(t);
  legacyFixture(dbPath, [{ term: 'Zero', ttl_days: 0, last_seen: 0 }, { term: 'Negative', ttl_days: -10.5, last_seen: 0 }]);
  const options = { dbPath, now: 1e12 };
  assert.deepEqual(lookupCards('Zero Negative', options).map((card) => [card.term, card.days_left]), [['Negative', null], ['Zero', null]]);
  assert.equal(lookup('Zero Negative', options).length, 2);
  assert.equal(radarStatus(options).eligible, 2);
});

test('the strict store read validates missing databases and keeps legacy missing-file and missing-table results', (t) => {
  const dbPath = join(dirname(temporaryRadar(t)), 'not-created', 'radar.db');
  assert.throws(() => lookupCards('', { dbPath, now: 1000, limit: 0 }), failsWith('DATABASE_UNAVAILABLE'));
  assert.deepEqual(lookup('anything', { dbPath, now: 1000 }), []);
  assert.deepEqual(radarStatus({ dbPath, now: 1000 }), {
    terms: 0, candidates: 0, eligible: 0, last_sync: null, live_watching: false, audio_transcription: false,
  });
  assert.equal(existsSync(dirname(dbPath)), false);
  const missingTable = temporaryRadar(t);
  fixtureDatabase(missingTable, (db) => db.exec('CREATE TABLE unrelated (value TEXT)'));
  const before = snapshot(missingTable);
  assert.throws(() => lookupCards('', { dbPath: missingTable, now: 1000, limit: 0 }), failsWith('DATABASE_ERROR'));
  assert.deepEqual(lookup('anything', { dbPath: missingTable, now: 1000 }), []);
  assert.equal(radarStatus({ dbPath: missingTable, now: 1000 }).terms, 0);
  assert.deepEqual(snapshot(missingTable), before);
});

test('the CLI returns exactly ten typed fields for the 玉芬啊玉芬 alias without changing stored data', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([sample], { dbPath, now: Date.now() / 1000 });
  const before = snapshot(dbPath);
  const cards = success(invokeCli(['--db', dbPath, '--text', '玉芬啊玉芬']));
  assert.deepEqual(cards, [{
    term: '结过婚我也认', meaning: sample.meaning, usage_context: sample.usage_context, avoid_when: sample.avoid_when,
    origin: sample.origin, source_url: sample.source_url, aliases: sample.aliases,
    matched_keys: ['玉芬啊玉芬'], confidence: 0.95, days_left: 90,
  }]);
  assert.deepEqual(snapshot(dbPath), before);
});

test('a schema-valid empty database succeeds for no-hit, empty text and zero limit', (t) => {
  const dbPath = temporaryRadar(t);
  legacyFixture(dbPath, [], { reviews: false });
  const before = snapshot(dbPath);
  for (const args of queryVariants) {
    const result = invokeCli(['--db', dbPath, ...args]);
    assert.deepEqual(success(result), []);
    assert.equal(result.stdout, '{"terms":[]}\n');
    assert.deepEqual(snapshot(dbPath), before);
  }
});

test('a populated database succeeds with no hits, empty or whitespace text and zero limit', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([sample], { dbPath, now: Date.now() / 1000 });
  const before = snapshot(dbPath);
  for (const args of [
    ['--text', '词库外文本完全没有'], ['--text', ''], ['--text', ' \t\n '],
    ['--text', '玉芬啊玉芬', '--limit', '0'], ['--text=--literal'],
  ]) {
    const result = invokeCli(['--db', dbPath, ...args]);
    assert.deepEqual(success(result), []);
    assert.equal(result.stdout, '{"terms":[]}\n');
    assert.deepEqual(snapshot(dbPath), before);
  }
});

test('legacy cards retain empty context and source defaults without inventing compiler fields', (t) => {
  const dbPath = temporaryRadar(t);
  legacyFixture(dbPath, [{
    term: '结过婚我也认', aliases: sample.aliases.join(','), origin: '记忆中的出处', review_status: 'local_reference',
  }]);
  const before = snapshot(dbPath);
  assert.deepEqual(success(invokeCli(['--db', dbPath, '--text', '玉芬啊玉芬'])), [{
    term: '结过婚我也认', meaning: '旧版定义', usage_context: '', avoid_when: '', origin: '记忆中的出处',
    source_url: '', aliases: sample.aliases, matched_keys: ['玉芬啊玉芬'], confidence: 0.8, days_left: null,
  }]);
  assert.deepEqual(snapshot(dbPath), before);
});

test('absent reviews stay unreviewed and absent joined metadata rows stay empty', (t) => {
  const unreviewed = temporaryRadar(t);
  legacyFixture(unreviewed, [{ term: 'Legacy' }], { reviews: false });
  const before = snapshot(unreviewed);
  assert.deepEqual(success(invokeCli(['--db', unreviewed, '--text', 'Legacy'])), []);
  assert.deepEqual(snapshot(unreviewed), before);
  const missingMetadata = temporaryRadar(t);
  legacyFixture(missingMetadata, [{ term: 'Legacy', metadata: false }], { metadata: true });
  const [card] = success(invokeCli(['--db', missingMetadata, '--text', 'Legacy']));
  assert.equal(card.usage_context, '');
  assert.equal(card.avoid_when, '');
  assert.equal(card.source_url, '');
});

test('the CLI defaults to three cards and accepts zero, explicit safe limits and equals options', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries(['A', 'B', 'C', 'D'].map((term) => watcherEntry(term)), { dbPath, now: Date.now() / 1000 });
  const before = snapshot(dbPath);
  const text = 'A B C D';
  assert.deepEqual(success(invokeCli(['--db', dbPath, '--text', text])).map((card) => card.term), ['A', 'B', 'C']);
  for (const limit of ['0', '1', '2', '4', '0002', '9007199254740991']) {
    const cards = success(invokeCli(['--db', dbPath, '--text', text, '--limit', limit]));
    assert.deepEqual(cards.map((card) => card.term), ['A', 'B', 'C', 'D'].slice(0, Number(limit)), limit);
    assert.deepEqual(snapshot(dbPath), before);
  }
  assert.deepEqual(success(invokeCli([`--db=${dbPath}`, `--text=${text}`, '--limit=2'])).map((card) => card.term), ['A', 'B']);
  assert.deepEqual(snapshot(dbPath), before);
});

test('the absolute CLI path works from an unrelated cwd with a database filename containing spaces', (t) => {
  const dbPath = join(dirname(temporaryRadar(t)), 'dictionary with spaces.db');
  const cwd = dirname(temporaryRadar(t));
  syncEntries([sample], { dbPath, now: Date.now() / 1000 });
  const before = snapshot(dbPath);
  assert.equal(success(invokeCli(['--text', '玉芬啊玉芬', '--db', dbPath], cwd))[0].term, '结过婚我也认');
  assert.deepEqual(snapshot(dbPath), before);
});

test('missing databases fail for normal, empty and zero-limit queries without creating missing parents', (t) => {
  const dbPath = temporaryRadar(t);
  const nestedPath = join(dirname(dbPath), 'not-created', 'radar.db');
  for (const path of [dbPath, nestedPath]) {
    for (const args of queryVariants) failure(invokeCli(['--db', path, ...args]), 'DATABASE_UNAVAILABLE');
    assert.equal(existsSync(path), false);
  }
  assert.equal(existsSync(dirname(nestedPath)), false);
  failure(invokeCli(['--db', nestedPath, '--limit', '1']), 'INVALID_ARGUMENTS', 2);
  assert.equal(existsSync(dirname(nestedPath)), false);
});

test('corrupt database bytes fail for normal, empty and zero-limit queries and remain unchanged', (t) => {
  const dbPath = temporaryRadar(t);
  writeFileSync(dbPath, 'not a SQLite database');
  const before = readFileSync(dbPath);
  for (const args of queryVariants) {
    failure(invokeCli(['--db', dbPath, ...args]), 'DATABASE_ERROR');
    assert.deepEqual(readFileSync(dbPath), before);
  }
});

test('a database without terms fails for normal, empty and zero-limit queries without changing unrelated rows', (t) => {
  const dbPath = temporaryRadar(t);
  fixtureDatabase(dbPath, (db) => {
    db.exec('CREATE TABLE unrelated (value TEXT)');
    db.prepare('INSERT INTO unrelated VALUES (?)').run('keep this row');
  });
  const before = snapshot(dbPath);
  for (const args of queryVariants) {
    failure(invokeCli(['--db', dbPath, ...args]), 'DATABASE_ERROR');
    assert.deepEqual(snapshot(dbPath), before);
  }
});

for (const omitted of termColumns.map((column) => column.split(' ')[0])) {
  test(`an empty terms schema missing ${omitted} fails even for empty text and zero limit`, (t) => {
    const dbPath = temporaryRadar(t);
    fixtureDatabase(dbPath, (db) => db.exec(`CREATE TABLE terms (${termColumns.filter((column) => !column.startsWith(`${omitted} `)).join(',')})`));
    const before = snapshot(dbPath);
    for (const args of queryVariants) {
      failure(invokeCli(['--db', dbPath, ...args]), 'DATABASE_ERROR');
      assert.deepEqual(snapshot(dbPath), before);
    }
  });
}

for (const table of ['term_reviews', 'watcher_entry_meta']) {
  test(`an empty malformed optional ${table} table fails without schema repair`, (t) => {
    const dbPath = temporaryRadar(t);
    legacyFixture(dbPath, [], { reviews: false });
    fixtureDatabase(dbPath, (db) => db.exec(`CREATE TABLE ${table} (term TEXT PRIMARY KEY)`));
    const before = snapshot(dbPath);
    for (const args of queryVariants) {
      failure(invokeCli(['--db', dbPath, ...args]), 'DATABASE_ERROR');
      assert.deepEqual(snapshot(dbPath), before);
    }
  });
}

for (const [name, extra, metadata] of [
  ['term', { term: Buffer.from('Broken') }],
  ['aliases', { aliases: Buffer.from('Alias') }],
  ['meaning', { meaning: Buffer.from('meaning') }],
  ['origin', { origin: Buffer.from('origin') }],
  ['usage_context', { usage_context: Buffer.from('context') }, true],
  ['avoid_when', { avoid_when: Buffer.from('avoid') }, true],
  ['source_url', { source_url: Buffer.from('source') }],
  ['confidence text', { confidence: 'not-a-number' }],
  ['confidence infinity', { confidence: Infinity }],
  ['last_seen', { last_seen: 'not-a-number' }],
  ['heat', { heat: 'not-a-number' }],
  ['ttl_days text', { ttl_days: 'not-a-number' }],
  ['ttl_days infinity', { ttl_days: Infinity }],
  ['review status', { review_status: Buffer.from('accepted') }],
]) {
  test(`unreadable stored ${name} fails instead of omitting or coercing JSON fields`, (t) => {
    const dbPath = temporaryRadar(t);
    legacyFixture(dbPath, [{ term: 'Broken', ...extra }], { metadata });
    const before = snapshot(dbPath);
    for (const args of queryVariants) {
      failure(invokeCli(['--db', dbPath, ...args]), 'DATABASE_ERROR');
      assert.deepEqual(snapshot(dbPath), before);
    }
  });
}

test('a returned lifetime that overflows cannot serialize as null', (t) => {
  const dbPath = temporaryRadar(t);
  legacyFixture(dbPath, [{ term: 'Broken', last_seen: Number.MAX_VALUE, ttl_days: Number.MAX_VALUE }]);
  const before = snapshot(dbPath);
  failure(invokeCli(['--db', dbPath, '--text', 'Broken']), 'DATABASE_ERROR');
  assert.deepEqual(snapshot(dbPath), before);
});

test('argument failures use stderr JSON and exit two without touching a valid database', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([sample], { dbPath, now: Date.now() / 1000 });
  const before = snapshot(dbPath);
  const prefix = ['--db', dbPath];
  const cases = [
    prefix, [...prefix, '--text'], [...prefix, '--text', 'x', 'positional'],
    [...prefix, '--text', 'x', '--unknown', 'y'], [...prefix, '--text', 'x', '--now', '0'],
    [...prefix, '--text', 'x', '--text', 'y'], [...prefix, '--text', 'x', '--text=y'],
    [...prefix, '--text', 'x', '--db', dbPath], [...prefix, '--text', 'x', `--db=${dbPath}`],
    [...prefix, '--text', 'x', '--limit', '1', '--limit=2'], [...prefix, '--text', 'x', '--limit'],
    [...prefix, '--text', 'x', '--'], [...prefix, '-t', 'x'],
    ['--text', 'x', '--db'], ['--text', 'x', '--db', ''], ['--text', 'x', '--db', ' \t '],
    ...['', '-1', '-0', '1.2', 'NaN', 'Infinity', '+1', '1e2', '0x2', '1_000', ' 1', '1 ',
      '9007199254740992', '99999999999999999999999'].map((limit) => [...prefix, '--text', 'x', `--limit=${limit}`]),
  ];
  for (const args of cases) {
    failure(invokeCli(args), 'INVALID_ARGUMENTS', 2);
    assert.deepEqual(snapshot(dbPath), before);
  }
});

test('unexpected non-database failures return sanitized INTERNAL_ERROR without stdout', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([sample], { dbPath, now: Date.now() / 1000 });
  const before = snapshot(dbPath);
  const script = `
    import { runCli } from ${JSON.stringify(pathToFileURL(cliPath).href)};
    process.stdout.write = () => { throw new Error('/private/not-for-output'); };
    process.exitCode = runCli(${JSON.stringify(['--db', dbPath, '--text', '玉芬啊玉芬'])});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  failure(result, 'INTERNAL_ERROR');
  assert.deepEqual(snapshot(dbPath), before);
});

test('invalid store options fail before reading or creating the supplied database path', (t) => {
  const dbPath = join(dirname(temporaryRadar(t)), 'not-created', 'radar.db');
  for (const [text, extra] of [
    [null, {}], ['x', { limit: -1 }], ['x', { limit: 1.5 }], ['x', { limit: Number.MAX_SAFE_INTEGER + 1 }],
    ['x', { now: NaN }], ['x', { now: -1 }],
  ]) assert.throws(() => lookupCards(text, { dbPath, now: 1000, ...extra }), failsWith('INVALID_OPTIONS'));
  assert.equal(existsSync(dirname(dbPath)), false);
});
