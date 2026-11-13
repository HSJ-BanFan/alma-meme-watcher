import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compileVideo } from '../src/compiler/schema.js';
import { syncEntries, lookup, radarStatus, patchAvoidWhen, patchEntryContent, attachEntryMetadata } from '../src/store/radar.js';
import { temporaryRadar } from './helpers.mjs';

const video = JSON.parse(readFileSync(new URL('./fixtures/BV1hNWm6mEkz.json', import.meta.url), 'utf8'));
const [seed] = JSON.parse(readFileSync(new URL('../data/seed-memes.json', import.meta.url), 'utf8'));
const [compiled] = compileVideo(video);
const failsWith = (code) => (error) => error.code === code;
const oldTables = ['terms', 'candidates', 'search_cache', 'term_reviews', 'candidate_reviews'];
const allTables = [...oldTables, 'watcher_entry_meta', 'watcher_sync_versions'];
const legacySchema = `
create table if not exists terms (
  term text primary key, aliases text not null default '', meaning text not null,
  example text not null default '', origin text not null default '', tags text not null default '',
  first_seen real not null, last_seen real not null, heat integer not null default 1,
  confidence real not null default 0.5, ttl_days integer not null default 30,
  source text not null default ''
);
create table if not exists candidates (
  id integer primary key autoincrement, term text not null, context text not null default '',
  link_id text not null default '', seen_at real not null, count integer not null default 1,
  unique(term, link_id)
);
create table if not exists search_cache (
  query text primary key, summary text not null, source_url text not null default '',
  fetched_at real not null, ttl_seconds integer not null default 86400
);
create table if not exists term_reviews (
  term text primary key, status text not null, reviewed_at real not null,
  source_url text not null default '', actor text not null default 'local_tool'
);
create table if not exists candidate_reviews (
  term text primary key, verdict text not null, reason text not null default '',
  reviewed_at real not null, source_url text not null default '', actor text not null default 'local_tool'
);
create index if not exists idx_terms_heat on terms(heat desc, last_seen desc);
create index if not exists idx_candidates_seen on candidates(seen_at desc);
`;

function database(dbPath, operation) {
  const db = new DatabaseSync(dbPath);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function snapshot(dbPath) {
  return database(dbPath, (db) => Object.fromEntries(allTables.map((table) => [
    table,
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      ? db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all().map((row) => ({ ...row })) : null,
  ])));
}

function entry(term, extra = {}) {
  return { ...compiled, term, aliases: [], meaning: `${term}的明确释义。`, ...extra };
}

function legacyTerm(db, term, extra = {}) {
  const row = { aliases: '', meaning: '旧版定义', example: '旧例子', origin: '旧出处', tags: '旧标签', first_seen: 1, last_seen: 1001, heat: 7, confidence: 0.8, ttl_days: 90, source: 'legacy', status: 'accepted', source_url: 'https://example.org/reference', ...extra };
  db.prepare('INSERT INTO terms VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(term, row.aliases, row.meaning, row.example, row.origin, row.tags, row.first_seen, row.last_seen, row.heat, row.confidence, row.ttl_days, row.source);
  db.prepare('INSERT INTO term_reviews VALUES (?,?,?,?,?)').run(term, row.status, 5, row.source_url, 'human_review');
}

test('an already-correct avoid_when returns unchanged while another writer holds the database', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('Alpha', { avoid_when: '已修正的禁忌。' })], { dbPath, now: 100 });
  const blocker = new DatabaseSync(dbPath);
  blocker.exec('BEGIN IMMEDIATE');
  try {
    let result;
    try {
      const report = patchAvoidWhen([{ term: 'Alpha', expectedAvoidWhen: '旧禁忌', avoidWhen: '已修正的禁忌。' }], { dbPath, authorizedCanonicalTerms: ['Alpha'] });
      result = [report.updated, report.unchanged, report.conflicted];
    } catch (error) {
      result = { error: error.code, cause: error.cause?.message };
    }
    assert.deepEqual(result, [0, 1, 0]);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }
});

test('avoid_when maintenance changes only the approved metadata field', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('Alpha', { avoid_when: '旧Alpha' }), entry('Beta', { avoid_when: '旧Beta' }), entry('Keep')], { dbPath, now: 100 });
  const before = snapshot(dbPath);
  const patches = ['Alpha', 'Beta'].map((term) => ({ term, expectedAvoidWhen: `旧${term}`, avoidWhen: `新${term}禁忌。` }));
  const report = patchAvoidWhen(patches, { dbPath, now: 200, authorizedCanonicalTerms: ['Alpha', 'Beta'] });
  assert.deepEqual([report.updated, report.unchanged, report.conflicted], [2, 0, 0]);
  assert.deepEqual(report.entries.map(({ term, status }) => [term, status]), [['Alpha', 'updated'], ['Beta', 'updated']]);
  const expected = structuredClone(before);
  for (const row of expected.watcher_entry_meta) if (row.term !== 'Keep') row.avoid_when = `新${row.term}禁忌。`;
  assert.deepEqual(snapshot(dbPath), expected);
});

test('avoid_when replay returns unchanged without executing UPDATE', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('Alpha', { avoid_when: '旧Alpha' })], { dbPath, now: 100 });
  const patches = [{ term: 'Alpha', expectedAvoidWhen: '旧Alpha', avoidWhen: '新Alpha禁忌。' }];
  const opts = { dbPath, authorizedCanonicalTerms: ['Alpha'] };
  patchAvoidWhen(patches, opts);
  database(dbPath, (db) => db.exec("CREATE TRIGGER refuse_repeat BEFORE UPDATE ON watcher_entry_meta BEGIN SELECT RAISE(ABORT,'unexpected replay UPDATE'); END;"));
  const before = snapshot(dbPath);
  const report = patchAvoidWhen(patches, opts);
  assert.deepEqual([report.updated, report.unchanged, report.conflicted], [0, 1, 0]);
  assert.deepEqual(snapshot(dbPath), before);
});

test('avoid_when drift and missing rows are reported without inserts or overwrites', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('Alpha', { avoid_when: '人工修订' }), entry('Beta', { avoid_when: '旧Beta' })], { dbPath, now: 100 });
  database(dbPath, (db) => db.prepare('DELETE FROM watcher_entry_meta WHERE term=?').run('Beta'));
  const before = snapshot(dbPath);
  const patches = ['Alpha', 'Beta', 'Missing'].map((term) => ({ term, expectedAvoidWhen: `旧${term}`, avoidWhen: `新${term}禁忌。` }));
  const report = patchAvoidWhen(patches, { dbPath, authorizedCanonicalTerms: ['Alpha', 'Beta', 'Missing'] });
  assert.deepEqual([report.updated, report.unchanged, report.conflicted], [0, 0, 3]);
  assert.deepEqual(report.entries.map(({ reason }) => reason), ['stale_avoid_when', 'missing_metadata', 'missing_term']);
  assert.deepEqual(snapshot(dbPath), before);
});

test('avoid_when patches refuse aliases and ambiguous canonical identities', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('Canonical', { aliases: ['Alias'] }), entry('Other')], { dbPath, now: 100 });
  const patch = { term: 'Alias', expectedAvoidWhen: compiled.avoid_when, avoidWhen: '新的禁忌。' };
  let before = snapshot(dbPath);
  let report = patchAvoidWhen([patch], { dbPath, authorizedCanonicalTerms: ['Alias'] });
  assert.equal(report.entries[0].reason, 'not_canonical');
  assert.deepEqual(snapshot(dbPath), before);
  database(dbPath, (db) => db.prepare('UPDATE terms SET aliases=? WHERE term=?').run('alias', 'Other'));
  before = snapshot(dbPath);
  report = patchAvoidWhen([{ ...patch, term: 'Canonical' }], { dbPath, authorizedCanonicalTerms: ['Canonical'] });
  assert.equal(report.entries[0].reason, 'ambiguous_identity');
  assert.deepEqual(snapshot(dbPath), before);
});

test('invalid avoid_when patches are rejected before creating any database or directory', (t) => {
  const dbPath = join(dirname(temporaryRadar(t)), 'not-created', 'radar.db');
  const patch = { term: 'Alpha', expectedAvoidWhen: '旧禁忌', avoidWhen: '新禁忌。' };
  const cases = [
    [[], ['Alpha']],
    [Array.from({ length: 51 }, (_, n) => ({ ...patch, term: `term${n}` })), Array.from({ length: 51 }, (_, n) => `term${n}`)],
    [[patch, { ...patch, term: 'alpha' }], ['Alpha', 'alpha']],
    [[{ ...patch, avoidWhen: '' }], ['Alpha']],
    [[{ ...patch, expectedAvoidWhen: null }], ['Alpha']],
    [[{ ...patch, usage_context: '禁止修改此字段' }], ['Alpha']],
    [[{ ...patch, term: 'Unauthorized' }], ['Alpha']],
    [[patch], []],
  ];
  for (const [patches, authorizedCanonicalTerms] of cases) {
    assert.throws(() => patchAvoidWhen(patches, { dbPath, authorizedCanonicalTerms }), (error) => ['INVALID_BATCH', 'INVALID_OPTIONS'].includes(error.code));
    assert.equal(existsSync(dirname(dbPath)), false);
  }
});

test('avoid_when maintenance refuses a missing database instead of creating one', (t) => {
  const dbPath = temporaryRadar(t);
  assert.throws(() => patchAvoidWhen([{ term: 'Alpha', expectedAvoidWhen: '', avoidWhen: '新禁忌。' }], { dbPath, authorizedCanonicalTerms: ['Alpha'] }), failsWith('DATABASE_ERROR'));
  assert.equal(existsSync(dbPath), false);
});

test('avoid_when maintenance does not bootstrap tables in an existing partial schema', (t) => {
  const dbPath = temporaryRadar(t);
  database(dbPath, (db) => {
    db.exec(legacySchema);
    db.exec("CREATE TABLE watcher_entry_meta (term TEXT PRIMARY KEY, usage_context TEXT NOT NULL DEFAULT '', avoid_when TEXT NOT NULL DEFAULT '', published_at TEXT)");
    legacyTerm(db, 'Alpha');
    db.prepare('INSERT INTO watcher_entry_meta VALUES (?,?,?,?)').run('Alpha', '保持原场景', '旧禁忌', '2026-11-13');
  });
  const before = snapshot(dbPath);
  patchAvoidWhen([{ term: 'Alpha', expectedAvoidWhen: '旧禁忌', avoidWhen: '新禁忌。' }], { dbPath, authorizedCanonicalTerms: ['Alpha'] });
  const expected = structuredClone(before);
  expected.watcher_entry_meta[0].avoid_when = '新禁忌。';
  assert.deepEqual(snapshot(dbPath), expected);
  assert.equal(snapshot(dbPath).watcher_sync_versions, null);
});

test('a second avoid_when write error rolls the entire batch back and preserves its cause', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('Alpha', { avoid_when: '旧Alpha' }), entry('Beta', { avoid_when: '旧Beta' })], { dbPath, now: 100 });
  database(dbPath, (db) => db.exec(`CREATE TABLE write_probe (n INTEGER); INSERT INTO write_probe VALUES (0);
    CREATE TRIGGER fail_second BEFORE UPDATE ON watcher_entry_meta BEGIN
      UPDATE write_probe SET n=n+1;
      SELECT CASE WHEN (SELECT n FROM write_probe)=2 THEN RAISE(ABORT,'forced_meta_failure') END;
    END;`));
  const before = snapshot(dbPath);
  const patches = ['Alpha', 'Beta'].map((term) => ({ term, expectedAvoidWhen: `旧${term}`, avoidWhen: `新${term}禁忌。` }));
  assert.throws(() => patchAvoidWhen(patches, { dbPath, authorizedCanonicalTerms: ['Alpha', 'Beta'] }), (error) => error.code === 'DATABASE_ERROR' && error.cause?.message.includes('forced_meta_failure'));
  assert.deepEqual(snapshot(dbPath), before);
  assert.equal(database(dbPath, (db) => db.prepare('SELECT n FROM write_probe').get().n), 0);
});

test('content maintenance changes only meaning, origin and usage_context', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([
    entry('Alpha', { origin: '旧Alpha出处', usage_context: '旧Alpha场景' }),
    entry('Beta', { origin: '旧Beta出处', usage_context: '旧Beta场景' }),
    entry('Keep'),
  ], { dbPath, now: 100 });
  const before = snapshot(dbPath);
  const patches = ['Alpha', 'Beta'].map((term) => ({
    term,
    expectedMeaning: `${term}的明确释义。`,
    expectedOrigin: `旧${term}出处`,
    expectedUsageContext: `旧${term}场景`,
    meaning: `新${term}释义。`,
    origin: `新${term}出处`,
    usageContext: `新${term}场景`,
  }));
  const report = patchEntryContent(patches, { dbPath, now: 200, authorizedCanonicalTerms: ['Alpha', 'Beta'] });
  assert.deepEqual([report.updated, report.unchanged, report.conflicted], [2, 0, 0]);
  assert.deepEqual(report.entries.map(({ term, status }) => [term, status]), [['Alpha', 'updated'], ['Beta', 'updated']]);
  const expected = structuredClone(before);
  for (const row of expected.terms) if (row.term !== 'Keep') {
    row.meaning = `新${row.term}释义。`;
    row.origin = `新${row.term}出处`;
  }
  for (const row of expected.watcher_entry_meta) if (row.term !== 'Keep') row.usage_context = `新${row.term}场景`;
  assert.deepEqual(snapshot(dbPath), expected);
});

test('content maintenance can update usage_context alone without touching terms', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('Alpha', { origin: '旧Alpha出处', usage_context: '旧Alpha场景' })], { dbPath, now: 100 });
  database(dbPath, (db) => db.exec("CREATE TRIGGER refuse_term_write BEFORE UPDATE ON terms BEGIN SELECT RAISE(ABORT,'unexpected terms UPDATE'); END;"));
  const termsBefore = snapshot(dbPath).terms;
  const report = patchEntryContent([{
    term: 'Alpha',
    expectedMeaning: 'Alpha的明确释义。',
    expectedOrigin: '旧Alpha出处',
    expectedUsageContext: '旧Alpha场景',
    meaning: 'Alpha的明确释义。',
    origin: '旧Alpha出处',
    usageContext: '新Alpha场景。',
  }], { dbPath, authorizedCanonicalTerms: ['Alpha'] });
  assert.deepEqual([report.updated, report.unchanged, report.conflicted], [1, 0, 0]);
  const after = snapshot(dbPath);
  assert.deepEqual(after.terms, termsBefore);
  assert.equal(after.watcher_entry_meta.find((row) => row.term === 'Alpha').usage_context, '新Alpha场景。');
});

test('content replay returns unchanged without executing UPDATE', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('Alpha', { origin: '旧Alpha出处', usage_context: '旧Alpha场景' })], { dbPath, now: 100 });
  const patches = [{
    term: 'Alpha',
    expectedMeaning: 'Alpha的明确释义。',
    expectedOrigin: '旧Alpha出处',
    expectedUsageContext: '旧Alpha场景',
    meaning: '新Alpha释义。',
    origin: '新Alpha出处',
    usageContext: '新Alpha场景',
  }];
  const opts = { dbPath, authorizedCanonicalTerms: ['Alpha'] };
  patchEntryContent(patches, opts);
  database(dbPath, (db) => {
    db.exec("CREATE TRIGGER refuse_term_repeat BEFORE UPDATE ON terms BEGIN SELECT RAISE(ABORT,'unexpected terms UPDATE'); END;");
    db.exec("CREATE TRIGGER refuse_meta_repeat BEFORE UPDATE ON watcher_entry_meta BEGIN SELECT RAISE(ABORT,'unexpected meta UPDATE'); END;");
  });
  const before = snapshot(dbPath);
  const report = patchEntryContent(patches, opts);
  assert.deepEqual([report.updated, report.unchanged, report.conflicted], [0, 1, 0]);
  assert.deepEqual(snapshot(dbPath), before);
});

test('content drift and missing rows are reported without inserts or overwrites', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([
    entry('Alpha', { origin: '旧Alpha出处', usage_context: '旧Alpha场景' }),
    entry('Beta', { origin: '旧Beta出处', usage_context: '旧Beta场景' }),
  ], { dbPath, now: 100 });
  database(dbPath, (db) => {
    db.prepare('UPDATE terms SET meaning=? WHERE term=?').run('人工修订', 'Alpha');
    db.prepare('DELETE FROM watcher_entry_meta WHERE term=?').run('Beta');
  });
  const before = snapshot(dbPath);
  const patches = ['Alpha', 'Beta', 'Missing'].map((term) => ({
    term,
    expectedMeaning: `${term}的明确释义。`,
    expectedOrigin: `旧${term}出处`,
    expectedUsageContext: `旧${term}场景`,
    meaning: `新${term}释义。`,
    origin: `新${term}出处`,
    usageContext: `新${term}场景`,
  }));
  const report = patchEntryContent(patches, { dbPath, authorizedCanonicalTerms: ['Alpha', 'Beta', 'Missing'] });
  assert.deepEqual([report.updated, report.unchanged, report.conflicted], [0, 0, 3]);
  assert.deepEqual(report.entries.map(({ reason }) => reason), ['stale_content', 'missing_metadata', 'missing_term']);
  assert.deepEqual(snapshot(dbPath), before);
});

test('content patches refuse aliases and ambiguous canonical identities', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('Canonical', { aliases: ['Alias'] }), entry('Other')], { dbPath, now: 100 });
  const patch = {
    term: 'Alias',
    expectedMeaning: compiled.meaning,
    expectedOrigin: compiled.origin,
    expectedUsageContext: compiled.usage_context,
    meaning: '新的释义。',
    origin: '新的出处。',
    usageContext: '新的场景。',
  };
  let before = snapshot(dbPath);
  let report = patchEntryContent([patch], { dbPath, authorizedCanonicalTerms: ['Alias'] });
  assert.equal(report.entries[0].reason, 'not_canonical');
  assert.deepEqual(snapshot(dbPath), before);
  database(dbPath, (db) => db.prepare('UPDATE terms SET aliases=? WHERE term=?').run('alias', 'Other'));
  before = snapshot(dbPath);
  report = patchEntryContent([{ ...patch, term: 'Canonical' }], { dbPath, authorizedCanonicalTerms: ['Canonical'] });
  assert.equal(report.entries[0].reason, 'ambiguous_identity');
  assert.deepEqual(snapshot(dbPath), before);
});

test('invalid content patches are rejected before creating any database or directory', (t) => {
  const dbPath = join(dirname(temporaryRadar(t)), 'not-created-content', 'radar.db');
  const patch = {
    term: 'Alpha',
    expectedMeaning: '旧释义',
    expectedOrigin: '旧出处',
    expectedUsageContext: '旧场景',
    meaning: '新释义。',
    origin: '新出处。',
    usageContext: '新场景。',
  };
  const cases = [
    [[], ['Alpha']],
    [Array.from({ length: 51 }, (_, n) => ({ ...patch, term: `term${n}` })), Array.from({ length: 51 }, (_, n) => `term${n}`)],
    [[patch, { ...patch, term: 'alpha' }], ['Alpha', 'alpha']],
    [[{ ...patch, meaning: '   ' }], ['Alpha']],
    [[{ ...patch, usageContext: '' }], ['Alpha']],
    [[{ ...patch, expectedOrigin: null }], ['Alpha']],
    [[{ ...patch, avoid_when: '禁止修改此字段' }], ['Alpha']],
    [[{ ...patch, term: 'Unauthorized' }], ['Alpha']],
    [[patch], []],
  ];
  for (const [patches, authorizedCanonicalTerms] of cases) {
    assert.throws(() => patchEntryContent(patches, { dbPath, authorizedCanonicalTerms }), (error) => ['INVALID_BATCH', 'INVALID_OPTIONS'].includes(error.code));
    assert.equal(existsSync(dirname(dbPath)), false);
  }
});

test('content maintenance refuses a missing database instead of creating one', (t) => {
  const dbPath = temporaryRadar(t);
  const patch = {
    term: 'Alpha',
    expectedMeaning: '',
    expectedOrigin: '',
    expectedUsageContext: '',
    meaning: '新释义。',
    origin: '新出处。',
    usageContext: '新场景。',
  };
  assert.throws(() => patchEntryContent([patch], { dbPath, authorizedCanonicalTerms: ['Alpha'] }), failsWith('DATABASE_ERROR'));
  assert.equal(existsSync(dbPath), false);
});

test('content maintenance does not bootstrap tables in an existing partial schema', (t) => {
  const dbPath = temporaryRadar(t);
  database(dbPath, (db) => {
    db.exec(legacySchema);
    db.exec("CREATE TABLE watcher_entry_meta (term TEXT PRIMARY KEY, usage_context TEXT NOT NULL DEFAULT '', avoid_when TEXT NOT NULL DEFAULT '', published_at TEXT)");
    legacyTerm(db, 'Alpha');
    db.prepare('INSERT INTO watcher_entry_meta VALUES (?,?,?,?)').run('Alpha', '保持原场景', '旧禁忌', '2026-11-13');
  });
  const before = snapshot(dbPath);
  patchEntryContent([{
    term: 'Alpha',
    expectedMeaning: '旧版定义',
    expectedOrigin: '旧出处',
    expectedUsageContext: '保持原场景',
    meaning: '新释义。',
    origin: '新出处。',
    usageContext: '新场景。',
  }], { dbPath, authorizedCanonicalTerms: ['Alpha'] });
  const expected = structuredClone(before);
  expected.terms[0].meaning = '新释义。';
  expected.terms[0].origin = '新出处。';
  expected.watcher_entry_meta[0].usage_context = '新场景。';
  assert.deepEqual(snapshot(dbPath), expected);
  assert.equal(snapshot(dbPath).watcher_sync_versions, null);
});

test('a second content write error rolls the entire batch back and preserves its cause', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([
    entry('Alpha', { origin: '旧Alpha出处', usage_context: '旧Alpha场景' }),
    entry('Beta', { origin: '旧Beta出处', usage_context: '旧Beta场景' }),
  ], { dbPath, now: 100 });
  database(dbPath, (db) => db.exec(`CREATE TABLE write_probe (n INTEGER); INSERT INTO write_probe VALUES (0);
    CREATE TRIGGER fail_second BEFORE UPDATE ON watcher_entry_meta BEGIN
      UPDATE write_probe SET n=n+1;
      SELECT CASE WHEN (SELECT n FROM write_probe)=2 THEN RAISE(ABORT,'forced_content_failure') END;
    END;`));
  const before = snapshot(dbPath);
  const patches = ['Alpha', 'Beta'].map((term) => ({
    term,
    expectedMeaning: `${term}的明确释义。`,
    expectedOrigin: `旧${term}出处`,
    expectedUsageContext: `旧${term}场景`,
    meaning: `新${term}释义。`,
    origin: `新${term}出处`,
    usageContext: `新${term}场景`,
  }));
  assert.throws(() => patchEntryContent(patches, { dbPath, authorizedCanonicalTerms: ['Alpha', 'Beta'] }), (error) => error.code === 'DATABASE_ERROR' && error.cause?.message.includes('forced_content_failure'));
  assert.deepEqual(snapshot(dbPath), before);
  assert.equal(database(dbPath, (db) => db.prepare('SELECT n FROM write_probe').get().n), 0);
});

test('an already-correct content patch returns unchanged while another writer holds the database', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('Alpha', { origin: '新出处', usage_context: '新场景', meaning: '新释义。' })], { dbPath, now: 100 });
  const blocker = new DatabaseSync(dbPath);
  blocker.exec('BEGIN IMMEDIATE');
  try {
    const report = patchEntryContent([{
      term: 'Alpha',
      expectedMeaning: '旧释义',
      expectedOrigin: '旧出处',
      expectedUsageContext: '旧场景',
      meaning: '新释义。',
      origin: '新出处',
      usageContext: '新场景',
    }], { dbPath, authorizedCanonicalTerms: ['Alpha'] });
    assert.deepEqual([report.updated, report.unchanged, report.conflicted], [0, 1, 0]);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }
});

test('metadata attachment inserts a row only for terms that lack one', (t) => {
  const dbPath = temporaryRadar(t);
  database(dbPath, (db) => {
    db.exec(legacySchema);
    db.exec("CREATE TABLE watcher_entry_meta (term TEXT PRIMARY KEY, usage_context TEXT NOT NULL DEFAULT '', avoid_when TEXT NOT NULL DEFAULT '', published_at TEXT)");
    legacyTerm(db, 'Alpha');
    legacyTerm(db, 'Beta');
    db.prepare('INSERT INTO watcher_entry_meta VALUES (?,?,?,?)').run('Beta', '已有场景', '已有禁忌', '2026-01-01');
  });
  const before = snapshot(dbPath);
  const report = attachEntryMetadata([{ term: 'Alpha', usageContext: '新场景。', avoidWhen: '新禁忌。' }], { dbPath, authorizedCanonicalTerms: ['Alpha'] });
  assert.deepEqual([report.inserted, report.unchanged, report.conflicted], [1, 0, 0]);
  const after = snapshot(dbPath);
  assert.deepEqual(after.terms, before.terms);
  assert.deepEqual(after.term_reviews, before.term_reviews);
  assert.deepEqual(after.watcher_sync_versions, null);
  assert.deepEqual(after.watcher_entry_meta.find((row) => row.term === 'Beta'), before.watcher_entry_meta.find((row) => row.term === 'Beta'));
  assert.deepEqual(after.watcher_entry_meta.find((row) => row.term === 'Alpha'), { term: 'Alpha', usage_context: '新场景。', avoid_when: '新禁忌。', published_at: null });
});

test('metadata attachment replay performs no insert', (t) => {
  const dbPath = temporaryRadar(t);
  database(dbPath, (db) => {
    db.exec(legacySchema);
    db.exec("CREATE TABLE watcher_entry_meta (term TEXT PRIMARY KEY, usage_context TEXT NOT NULL DEFAULT '', avoid_when TEXT NOT NULL DEFAULT '', published_at TEXT)");
    legacyTerm(db, 'Alpha');
  });
  const records = [{ term: 'Alpha', usageContext: '新场景。', avoidWhen: '新禁忌。' }];
  attachEntryMetadata(records, { dbPath, authorizedCanonicalTerms: ['Alpha'] });
  database(dbPath, (db) => db.exec("CREATE TRIGGER refuse_meta_insert BEFORE INSERT ON watcher_entry_meta BEGIN SELECT RAISE(ABORT,'unexpected meta INSERT'); END;"));
  const before = snapshot(dbPath);
  const report = attachEntryMetadata(records, { dbPath, authorizedCanonicalTerms: ['Alpha'] });
  assert.deepEqual([report.inserted, report.unchanged, report.conflicted], [0, 1, 0]);
  assert.deepEqual(snapshot(dbPath), before);
});

test('metadata attachment never overwrites an existing row', (t) => {
  const dbPath = temporaryRadar(t);
  database(dbPath, (db) => {
    db.exec(legacySchema);
    db.exec("CREATE TABLE watcher_entry_meta (term TEXT PRIMARY KEY, usage_context TEXT NOT NULL DEFAULT '', avoid_when TEXT NOT NULL DEFAULT '', published_at TEXT)");
    legacyTerm(db, 'Alpha');
    db.prepare('INSERT INTO watcher_entry_meta VALUES (?,?,?,?)').run('Alpha', '人工场景', '人工禁忌', null);
  });
  const before = snapshot(dbPath);
  const report = attachEntryMetadata([{ term: 'Alpha', usageContext: '新场景。', avoidWhen: '新禁忌。' }], { dbPath, authorizedCanonicalTerms: ['Alpha'] });
  assert.equal(report.entries[0].reason, 'existing_metadata');
  assert.deepEqual(snapshot(dbPath), before);
});

test('metadata attachment refuses aliases, ambiguous identities and unknown terms', (t) => {
  const dbPath = temporaryRadar(t);
  database(dbPath, (db) => {
    db.exec(legacySchema);
    db.exec("CREATE TABLE watcher_entry_meta (term TEXT PRIMARY KEY, usage_context TEXT NOT NULL DEFAULT '', avoid_when TEXT NOT NULL DEFAULT '', published_at TEXT)");
    legacyTerm(db, 'Canonical', { aliases: 'AliasOnly' });
    legacyTerm(db, 'AmbiguousA', { aliases: 'Ambiguous' });
    legacyTerm(db, 'AmbiguousB', { aliases: 'ambiguous' });
  });
  const before = snapshot(dbPath);
  const records = ['AliasOnly', 'Ambiguous', 'Missing'].map((term) => ({ term, usageContext: '新场景。', avoidWhen: '新禁忌。' }));
  const report = attachEntryMetadata(records, { dbPath, authorizedCanonicalTerms: ['AliasOnly', 'Ambiguous', 'Missing'] });
  assert.deepEqual([report.inserted, report.unchanged, report.conflicted], [0, 0, 3]);
  assert.deepEqual(report.entries.map(({ reason }) => reason), ['not_canonical', 'ambiguous_identity', 'missing_term']);
  assert.deepEqual(snapshot(dbPath), before);
});

test('invalid metadata records are rejected before creating any database or directory', (t) => {
  const dbPath = join(dirname(temporaryRadar(t)), 'not-created-attach', 'radar.db');
  const record = { term: 'Alpha', usageContext: '新场景。', avoidWhen: '新禁忌。' };
  const cases = [
    [[], ['Alpha']],
    [Array.from({ length: 51 }, (_, n) => ({ ...record, term: `term${n}` })), Array.from({ length: 51 }, (_, n) => `term${n}`)],
    [[record, { ...record, term: 'alpha' }], ['Alpha', 'alpha']],
    [[{ ...record, usageContext: '  ' }], ['Alpha']],
    [[{ ...record, avoidWhen: '' }], ['Alpha']],
    [[{ ...record, expectedUsageContext: '' }], ['Alpha']],
    [[{ ...record, term: 'Unauthorized' }], ['Alpha']],
    [[record], []],
  ];
  for (const [records, authorizedCanonicalTerms] of cases) {
    assert.throws(() => attachEntryMetadata(records, { dbPath, authorizedCanonicalTerms }), (error) => ['INVALID_BATCH', 'INVALID_OPTIONS'].includes(error.code));
    assert.equal(existsSync(dirname(dbPath)), false);
  }
});

test('metadata attachment refuses a missing database and never bootstraps tables', (t) => {
  const missing = temporaryRadar(t);
  assert.throws(() => attachEntryMetadata([{ term: 'Alpha', usageContext: '新场景。', avoidWhen: '新禁忌。' }], { dbPath: missing, authorizedCanonicalTerms: ['Alpha'] }), failsWith('DATABASE_ERROR'));
  assert.equal(existsSync(missing), false);
  const partial = temporaryRadar(t);
  database(partial, (db) => {
    db.exec(legacySchema);
    legacyTerm(db, 'Alpha');
  });
  const before = snapshot(partial);
  assert.throws(() => attachEntryMetadata([{ term: 'Alpha', usageContext: '新场景。', avoidWhen: '新禁忌。' }], { dbPath: partial, authorizedCanonicalTerms: ['Alpha'] }), failsWith('DATABASE_ERROR'));
  assert.deepEqual(snapshot(partial), before);
});

test('a second metadata insert error rolls the whole batch back', (t) => {
  const dbPath = temporaryRadar(t);
  database(dbPath, (db) => {
    db.exec(legacySchema);
    db.exec("CREATE TABLE watcher_entry_meta (term TEXT PRIMARY KEY, usage_context TEXT NOT NULL DEFAULT '', avoid_when TEXT NOT NULL DEFAULT '', published_at TEXT)");
    legacyTerm(db, 'Alpha');
    legacyTerm(db, 'Beta');
    db.exec(`CREATE TABLE insert_probe (n INTEGER); INSERT INTO insert_probe VALUES (0);
      CREATE TRIGGER fail_second_insert BEFORE INSERT ON watcher_entry_meta BEGIN
        UPDATE insert_probe SET n=n+1;
        SELECT CASE WHEN (SELECT n FROM insert_probe)=2 THEN RAISE(ABORT,'forced_attach_failure') END;
      END;`);
  });
  const before = snapshot(dbPath);
  const records = ['Alpha', 'Beta'].map((term) => ({ term, usageContext: '新场景。', avoidWhen: '新禁忌。' }));
  assert.throws(() => attachEntryMetadata(records, { dbPath, authorizedCanonicalTerms: ['Alpha', 'Beta'] }), (error) => error.code === 'DATABASE_ERROR' && error.cause?.message.includes('forced_attach_failure'));
  assert.deepEqual(snapshot(dbPath), before);
  assert.equal(database(dbPath, (db) => db.prepare('SELECT n FROM insert_probe').get().n), 0);
});

test('the real compiled sample round-trips through a reopened SQLite file and every gold alias', (t) => {
  const dbPath = temporaryRadar(t);
  const input = { ...compiled, published_at: seed.published_at };
  const report = syncEntries([input], { dbPath, now: 1000 });
  assert.deepEqual([report.inserted, report.updated, report.unchanged], [1, 0, 0]);
  assert.equal(report.entries[0].term, seed.term);
  for (const query of [seed.term, ...seed.aliases]) {
    const [hit] = lookup(query, { dbPath, now: 1001 });
    for (const field of Object.keys(input)) assert.deepEqual(hit[field], input[field], field);
    assert.equal(hit.term, seed.term);
    assert.equal(hit.review_status, 'local_reference');
    assert.equal(hit.review_actor, 'meme_watcher:machine');
    assert.equal(hit.reviewed_at, 1000);
    assert.equal(hit.first_seen, 1000);
    assert.equal(hit.last_seen, 1000);
  }
  const rows = snapshot(dbPath);
  assert.equal(rows.terms.length, 1);
  assert.equal(rows.term_reviews.length, 1);
  assert.equal(rows.candidates.length, 0);
  assert.equal(rows.terms[0].aliases.startsWith('['), false);
  assert.equal(rows.terms[0].origin, compiled.origin);
  assert.equal(rows.term_reviews[0].source_url, seed.source_url);
  database(dbPath, (db) => {
    assert.deepEqual(db.prepare('PRAGMA table_info(watcher_entry_meta)').all().map((row) => row.name), ['term', 'usage_context', 'avoid_when', 'published_at']);
    assert.deepEqual(db.prepare('PRAGMA table_info(watcher_sync_versions)').all().map((row) => row.name), ['term', 'source_url', 'fingerprint', 'applied_at', 'previous_review_json']);
  });
  const status = radarStatus({ dbPath, now: 1001 });
  assert.deepEqual([status.terms, status.candidates, status.eligible], [1, 0, 1]);
  assert.deepEqual(status.last_sync, { source_url: seed.source_url, applied_at: 1000 });
  assert.equal(status.live_watching, false);
  assert.equal(status.audio_transcription, false);
});

test('legacy columns, constraints, positional inserts and unrelated rows survive a watcher update', (t) => {
  const dbPath = temporaryRadar(t);
  const before = database(dbPath, (db) => {
    db.exec(legacySchema);
    legacyTerm(db, '旧 canonical', { aliases: 'Kipfel，Old alias;另一个别名', source: 'MEMORY.md', heat: 19, first_seen: 11 });
    legacyTerm(db, '无关词条');
    db.prepare('INSERT INTO candidate_reviews VALUES (?,?,?,?,?,?)').run('无关词条', 'accepted', '保留人工说明', 12, 'https://example.org/reference', 'human');
    db.prepare('INSERT INTO search_cache VALUES (?,?,?,?,?)').run('old query', 'old summary', 'https://example.org/cache', 10, 60);
    return Object.fromEntries(oldTables.map((table) => [table, db.prepare(`PRAGMA table_info(${table})`).all().map((row) => ({ ...row }))]));
  });
  const report = syncEntries([entry('kipfel', { aliases: ['新别名'], meaning: '更新的定义', origin: '新的叙述性出处' })], { dbPath, now: 100 });
  assert.deepEqual([report.inserted, report.updated, report.unchanged], [0, 1, 0]);
  const [hit] = lookup('新别名', { dbPath, now: 101 });
  assert.equal(hit.term, '旧 canonical');
  assert.deepEqual(hit.aliases, ['Kipfel', 'Old alias', '另一个别名', '新别名']);
  assert.deepEqual([hit.first_seen, hit.heat, hit.example, hit.tags], [11, 19, '旧例子', '旧标签']);
  assert.equal(hit.origin, '新的叙述性出处');
  assert.equal(hit.source, 'meme_watcher');
  assert.equal(hit.review_status, 'local_reference');
  assert.equal(hit.source_url, video.source_url);
  const rows = snapshot(dbPath);
  assert.equal(rows.terms.find((row) => row.term === '无关词条').meaning, '旧版定义');
  assert.equal(rows.term_reviews.find((row) => row.term === '无关词条').actor, 'human_review');
  assert.equal(rows.candidate_reviews[0].reason, '保留人工说明');
  assert.equal(rows.search_cache[0].summary, 'old summary');
  assert.deepEqual(JSON.parse(rows.watcher_sync_versions[0].previous_review_json), { status: 'accepted', reviewed_at: 5, source_url: 'https://example.org/reference', actor: 'human_review' });
  database(dbPath, (db) => {
    for (const table of oldTables) assert.deepEqual(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => ({ ...row })), before[table], table);
    db.prepare('INSERT INTO term_reviews VALUES (?,?,?,?,?)').run('positional', 'accepted', 100, video.source_url, 'python');
    db.prepare('INSERT INTO candidate_reviews VALUES (?,?,?,?,?,?)').run('positional', 'rejected', '原契约', 100, '', 'python');
    db.prepare('INSERT INTO search_cache VALUES (?,?,?,?,?)').run('positional', 'summary', '', 100, 30);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('idx_terms_heat','idx_candidates_seen')").get().n, 2);
    assert.throws(() => db.prepare('INSERT INTO candidates (term,link_id,seen_at) VALUES (?,?,NULL)').run('bad', '123'));
    db.prepare('INSERT INTO candidates (term,link_id,seen_at) VALUES (?,?,?)').run('unique', '123', 100);
    assert.throws(() => db.prepare('INSERT INTO candidates (term,link_id,seen_at) VALUES (?,?,?)').run('unique', '123', 100));
  });
});

test('connected same-batch aliases choose a deterministic new canonical and count once', (t) => {
  const dbPath = temporaryRadar(t);
  const otherPath = temporaryRadar(t);
  const batch = [entry('Z label', { aliases: ['共同别名'], meaning: '相同定义' }), entry('A label', { aliases: ['共同别名', '另一别名'], meaning: '相同定义' })];
  const report = syncEntries(batch, { dbPath, now: 100 });
  const reversed = syncEntries([...batch].reverse(), { dbPath: otherPath, now: 100 });
  assert.deepEqual([report.inserted, report.updated, report.unchanged], [1, 0, 0]);
  assert.equal(report.entries[0].term, 'A label');
  assert.deepEqual(report.entries[0].aliases, reversed.entries[0].aliases);
  assert.ok(report.entries[0].aliases.includes('Z label'));
  assert.equal(lookup('Z label', { dbPath, now: 101 })[0].term, 'A label');
  assert.equal(snapshot(dbPath).watcher_sync_versions.length, 2);
});

test('old canonical remains stable across existing-alias connections, casing and NFC identity', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('Stable', { aliases: ['Left', 'Right', 'Café'] })], { dbPath, now: 100 });
  const report = syncEntries([
    entry('left', { aliases: ['新左'], meaning: '同一个更新定义' }),
    entry('RIGHT', { aliases: ['新右'], meaning: '同一个更新定义' }),
    entry('Café', { aliases: [], meaning: '同一个更新定义' }),
  ], { dbPath, now: 200 });
  assert.deepEqual([report.inserted, report.updated, report.unchanged], [0, 1, 0]);
  assert.equal(report.entries[0].term, 'Stable');
  assert.deepEqual(report.entries[0].aliases, ['Left', 'Right', 'Café', '新右', '新左']);
  assert.equal(lookup('Café', { dbPath, now: 201 })[0].term, 'Stable');
  const next = syncEntries([entry('Stable', { aliases: [], meaning: '再次更新', origin: '', usage_context: '', avoid_when: '' })], { dbPath, now: 300 });
  assert.equal(next.entries[0].origin, compiled.origin);
  assert.equal(next.entries[0].usage_context, compiled.usage_context);
  assert.equal(next.entries[0].avoid_when, compiled.avoid_when);
  assert.equal(next.entries[0].first_seen, 100);
});

test('bridging two old terms is ambiguous even with an exact hit or inactive old rows', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('A old', { aliases: ['left'] }), entry('B old', { aliases: ['right'] })], { dbPath, now: 100 });
  database(dbPath, (db) => {
    db.prepare('UPDATE terms SET confidence=0.1,last_seen=0,ttl_days=1 WHERE term=?').run('B old');
    db.prepare('UPDATE term_reviews SET status=? WHERE term=?').run('source_missing', 'B old');
  });
  let before = snapshot(dbPath);
  assert.throws(() => syncEntries([entry('Fresh'), entry('A old', { aliases: ['right'] })], { dbPath, now: 200 }), failsWith('AMBIGUOUS_IDENTITY'));
  assert.deepEqual(snapshot(dbPath), before);
  database(dbPath, (db) => db.prepare('UPDATE terms SET aliases=? WHERE term=?').run('LEFT', 'B old'));
  before = snapshot(dbPath);
  assert.throws(() => syncEntries([entry('A old')], { dbPath, now: 300 }), failsWith('AMBIGUOUS_IDENTITY'));
  assert.deepEqual(snapshot(dbPath), before);
});

test('conflicting material in a connected batch rejects all entries rather than choosing a winner', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('Unrelated')], { dbPath, now: 100 });
  const before = snapshot(dbPath);
  for (const difference of [{ meaning: '不同定义' }, { usage_context: '不同语境' }, { source_url: 'https://www.bilibili.com/video/av42' }, { published_at: '2026-11-09' }]) {
    assert.throws(() => syncEntries([entry('Fresh'), entry('A new', { aliases: ['shared'], meaning: '同一定义' }), entry('B new', { aliases: ['shared'], meaning: '同一定义', ...difference })], { dbPath, now: 200 }), failsWith('CONTENT_CONFLICT'));
    assert.deepEqual(snapshot(dbPath), before);
  }
});

test('invalid batches are parsed before any writer or directory is created', (t) => {
  const dbPath = join(dirname(temporaryRadar(t)), 'not-created', 'radar.db');
  for (const batch of [[], null, [entry('A'), entry('B', { meaning: '' })], [entry('A'), entry('B', { confidence: 2 })], [entry('A'), entry('B', { source_url: 'https://example.org/video' })]]) {
    assert.throws(() => syncEntries(batch, { dbPath, now: 100 }));
    assert.equal(existsSync(dirname(dbPath)), false);
  }
});

test('a new term spelling that cannot become delimiter-text aliases rejects the whole merge', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('Stable')], { dbPath, now: 100 });
  const before = snapshot(dbPath);
  assert.throws(() => syncEntries([entry('Fresh'), entry('A/B', { aliases: ['Stable'] })], { dbPath, now: 200 }), failsWith('UNREPRESENTABLE_ALIAS'));
  assert.deepEqual(snapshot(dbPath), before);
});

test('candidate cleanup removes only exact normalized identities and never writes review verdicts', (t) => {
  const dbPath = temporaryRadar(t);
  database(dbPath, (db) => {
    db.exec(legacySchema);
    for (const term of ['Canonical', ' ALIAS ', 'Café', 'Alias in a sentence', 'Unrelated']) db.prepare('INSERT INTO candidates (term,link_id,seen_at) VALUES (?,?,?)').run(term, '123', 10);
    db.prepare('INSERT INTO candidate_reviews VALUES (?,?,?,?,?,?)').run('alias', 'accepted', '人工确认保留', 9, video.source_url, 'human');
  });
  const input = entry('Canonical', { aliases: ['Alias', 'Café'] });
  syncEntries([input], { dbPath, now: 100 });
  const rows = snapshot(dbPath);
  assert.deepEqual(rows.candidates.map((row) => row.term).sort(), ['Alias in a sentence', 'Unrelated']);
  assert.equal(rows.candidate_reviews[0].reason, '人工确认保留');
  assert.equal(rows.candidate_reviews[0].actor, 'human');
  database(dbPath, (db) => db.prepare('INSERT INTO candidates (term,link_id,seen_at) VALUES (?,?,?)').run('Alias', '456', 150));
  const before = snapshot(dbPath);
  assert.equal(syncEntries([input], { dbPath, now: 200 }).unchanged, 1);
  assert.deepEqual(snapshot(dbPath), before);
});

test('an explicitly rejected identity refuses a new batch and replay without overwriting human notes', (t) => {
  const dbPath = temporaryRadar(t);
  const input = entry('Canonical', { aliases: ['Blocked'] });
  syncEntries([input], { dbPath, now: 100 });
  database(dbPath, (db) => db.prepare('INSERT INTO candidate_reviews VALUES (?,?,?,?,?,?)').run(' blocked ', 'rejected', '人工拒绝，不应覆盖', 150, '', 'human'));
  const before = snapshot(dbPath);
  assert.throws(() => syncEntries([input], { dbPath, now: 200 }), failsWith('REVIEW_CONFLICT'));
  assert.throws(() => syncEntries([entry('Fresh'), entry('Blocked', { meaning: '试图覆盖' })], { dbPath, now: 200 }), failsWith('REVIEW_CONFLICT'));
  assert.deepEqual(snapshot(dbPath), before);
});

test('accepted replay and A-B-A retain the latest definition, review, metadata and TTL clocks', (t) => {
  const dbPath = temporaryRadar(t);
  const a = entry('Canonical', { aliases: ['Kipfel'], meaning: '版本 A', published_at: '2026-11-09' });
  syncEntries([a], { dbPath, now: 100 });
  database(dbPath, (db) => db.prepare('UPDATE term_reviews SET status=?,reviewed_at=?,actor=? WHERE term=?').run('accepted', 150, 'human', 'Canonical'));
  const accepted = snapshot(dbPath);
  const replay = syncEntries([a], { dbPath, now: 200 });
  assert.deepEqual([replay.inserted, replay.updated, replay.unchanged], [0, 0, 1]);
  assert.equal(replay.entries[0].review_status, 'accepted');
  assert.equal(replay.entries[0].review_actor, 'human');
  assert.deepEqual(snapshot(dbPath), accepted);
  const b = { ...a, meaning: '版本 B', aliases: ['Kipfel', 'New alias'], usage_context: '最新语境', avoid_when: '最新建议' };
  delete b.published_at;
  assert.equal(syncEntries([b], { dbPath, now: 300 }).updated, 1);
  const latest = snapshot(dbPath);
  const oldReplay = syncEntries([a], { dbPath, now: 400 });
  assert.equal(oldReplay.unchanged, 1);
  assert.equal(oldReplay.entries[0].meaning, '版本 B');
  assert.equal(oldReplay.entries[0].last_seen, 300);
  assert.equal(oldReplay.entries[0].published_at, '2026-11-09');
  assert.deepEqual(snapshot(dbPath), latest);
  assert.deepEqual(radarStatus({ dbPath, now: 400 }).last_sync, { source_url: video.source_url, applied_at: 300 });
  assert.equal(latest.watcher_sync_versions.length, 2);
  assert.equal(JSON.parse(latest.watcher_sync_versions.find((row) => row.applied_at === 300).previous_review_json).actor, 'human');
  database(dbPath, (db) => {
    db.prepare('UPDATE terms SET meaning=?,origin=?,source=?,confidence=? WHERE term=?').run('Python 当前释义', 'https://example.org/new', 'web_review', 0.9, 'Canonical');
    db.prepare('UPDATE term_reviews SET status=?,source_url=?,actor=?,reviewed_at=? WHERE term=?').run('accepted', 'https://example.org/new', 'python_tool', 500, 'Canonical');
  });
  const external = snapshot(dbPath);
  const [hit] = lookup('Kipfel', { dbPath, now: 501 });
  assert.equal(hit.meaning, 'Python 当前释义');
  assert.equal(hit.origin, 'https://example.org/new');
  assert.equal(hit.source_url, 'https://example.org/new');
  assert.equal(hit.review_actor, 'python_tool');
  assert.equal(hit.usage_context, '最新语境');
  assert.equal(syncEntries([a], { dbPath, now: 600 }).entries[0].meaning, 'Python 当前释义');
  assert.deepEqual(snapshot(dbPath), external);
});

test('fingerprints use normalized supplied aliases, not clock or aliases later added by legacy writers', (t) => {
  const dbPath = temporaryRadar(t);
  const input = entry('Canonical', { aliases: ['Kipfel', 'Café'], meaning: '明确释义' });
  syncEntries([input], { dbPath, now: 100 });
  database(dbPath, (db) => db.prepare('UPDATE terms SET aliases=? WHERE term=?').run('Kipfel,Café,Legacy added', 'Canonical'));
  const before = snapshot(dbPath);
  const replay = syncEntries([{ ...input, term: ' canonical ', aliases: ['Café', ' KIPFEL ', 'Kipfel'], meaning: ' 明确释义 ' }], { dbPath, now: 200 });
  assert.equal(replay.unchanged, 1);
  assert.deepEqual(snapshot(dbPath), before);
  assert.equal(syncEntries([{ ...input, aliases: [...input.aliases, 'New supplied'] }], { dbPath, now: 300 }).updated, 1);
  assert.ok(lookup('New supplied', { dbPath, now: 301 })[0].aliases.includes('Legacy added'));
});

test('new video evidence updates the current source but replay of the older source does not revert it', (t) => {
  const dbPath = temporaryRadar(t);
  const original = entry('Canonical', { aliases: ['Alias'] });
  syncEntries([original], { dbPath, now: 100 });
  const newer = { ...original, source_url: 'https://www.bilibili.com/video/av42' };
  const updated = syncEntries([newer], { dbPath, now: 200 });
  assert.equal(updated.updated, 1);
  assert.equal(updated.entries[0].source_url, newer.source_url);
  assert.equal(updated.entries[0].first_seen, 100);
  assert.equal(updated.entries[0].last_seen, 200);
  const before = snapshot(dbPath);
  const replay = syncEntries([original], { dbPath, now: 300 });
  assert.equal(replay.unchanged, 1);
  assert.equal(lookup('Alias', { dbPath, now: 301 })[0].source_url, newer.source_url);
  assert.deepEqual(radarStatus({ dbPath, now: 301 }).last_sync, { source_url: newer.source_url, applied_at: 200 });
  assert.deepEqual(snapshot(dbPath), before);
});

test('versions whose canonical was externally deleted refuse resurrection, including an alias-only replay', (t) => {
  const dbPath = temporaryRadar(t);
  syncEntries([entry('Canonical', { aliases: ['Alias'] })], { dbPath, now: 100 });
  const aliasInput = entry('Alias', { meaning: '后续版本' });
  syncEntries([aliasInput], { dbPath, now: 200 });
  database(dbPath, (db) => db.prepare('DELETE FROM terms WHERE term=?').run('Canonical'));
  const before = snapshot(dbPath);
  assert.throws(() => syncEntries([aliasInput], { dbPath, now: 300 }), failsWith('STALE_VERSION'));
  assert.throws(() => syncEntries([entry('Canonical')], { dbPath, now: 300 }), failsWith('STALE_VERSION'));
  assert.deepEqual(snapshot(dbPath), before);
});

test('SQLite review and metadata failure triggers roll back the complete batch and candidate cleanup', (t) => {
  for (const [table, verdict] of [['term_reviews', 'ABORT'], ['watcher_entry_meta', 'ABORT'], ['term_reviews', 'ROLLBACK'], ['watcher_entry_meta', 'ROLLBACK']]) {
    const dbPath = temporaryRadar(t);
    syncEntries([entry('Old')], { dbPath, now: 100 });
    database(dbPath, (db) => {
      for (const term of ['A new', 'Z fail']) db.prepare('INSERT INTO candidates (term,link_id,seen_at) VALUES (?,?,?)').run(term, '123', 150);
      db.exec(`CREATE TRIGGER forced_failure BEFORE INSERT ON ${table} WHEN NEW.term='Z fail' BEGIN SELECT RAISE(${verdict}, 'forced ${table} failure'); END`);
    });
    const before = snapshot(dbPath);
    assert.throws(() => syncEntries([entry('A new'), entry('Z fail')], { dbPath, now: 200 }), (error) => error.code === 'DATABASE_ERROR' && error.message.includes(`forced ${table} failure`));
    assert.deepEqual(snapshot(dbPath), before, table);
    assert.deepEqual(radarStatus({ dbPath, now: 201 }).last_sync, { source_url: video.source_url, applied_at: 100 });
    assert.equal(lookup('A new', { dbPath, now: 201 }).length, 0);
  }
});

test('missing reads never create a database, while corrupt existing files fail honestly', (t) => {
  const dbPath = join(dirname(temporaryRadar(t)), 'not-created', 'radar.db');
  assert.deepEqual(lookup('unknown', { dbPath, now: 100 }), []);
  const status = radarStatus({ dbPath, now: 100 });
  assert.deepEqual([status.terms, status.candidates, status.eligible, status.last_sync], [0, 0, 0, null]);
  assert.equal(existsSync(dirname(dbPath)), false);
  const corruptPath = temporaryRadar(t);
  writeFileSync(corruptPath, 'not a SQLite database');
  assert.throws(() => lookup('unknown', { dbPath: corruptPath, now: 100 }), failsWith('DATABASE_ERROR'));
  assert.throws(() => radarStatus({ dbPath: corruptPath, now: 100 }), failsWith('DATABASE_ERROR'));
});

test('legacy-only reads admit current reviews, enforce 0.7 and seconds TTL, and respect ASCII word boundaries', (t) => {
  const dbPath = temporaryRadar(t);
  database(dbPath, (db) => {
    db.exec(legacySchema);
    legacyTerm(db, '存量词', { aliases: 'Kipfel，旧别名', confidence: 0.7, last_seen: 1001, ttl_days: 1, heat: 20 });
    legacyTerm(db, '不失效', { ttl_days: 0, last_seen: 0, source: 'MEMORY.md', status: 'local_reference', source_url: '' });
    legacyTerm(db, '未审词', { status: 'source_missing' });
    legacyTerm(db, '无 review', { status: 'unreviewed_legacy' });
    legacyTerm(db, '低置信', { confidence: 0.69 });
    legacyTerm(db, '刚好过期', { ttl_days: 1, last_seen: 1000 });
    db.prepare('INSERT INTO candidates (term,link_id,seen_at) VALUES (?,?,?)').run('pending', '123', 10);
  });
  const before = snapshot(dbPath);
  const [hit] = lookup('评论区可以用 KIPFEL 吗？', { dbPath, now: 87400.25 });
  assert.equal(hit.term, '存量词');
  assert.equal(hit.meaning, '旧版定义');
  assert.equal(hit.source_url, 'https://example.org/reference');
  assert.equal(hit.usage_context, '');
  assert.deepEqual(lookup('Kipfeler', { dbPath, now: 87400.25 }), []);
  assert.deepEqual(lookup('myKipfel', { dbPath, now: 87400.25 }), []);
  assert.equal(lookup('大家觉得存量词如何', { dbPath, now: 87400.25 })[0].term, '存量词');
  for (const term of ['未审词', '无 review', '低置信', '刚好过期']) assert.deepEqual(lookup(term, { dbPath, now: 87400.25 }), []);
  assert.equal(lookup('刚好过期', { dbPath, now: 87399.999 }).length, 1);
  assert.equal(lookup('刚好过期', { dbPath, now: 87400 }).length, 0);
  assert.equal(lookup('不失效', { dbPath, now: 87400.25 })[0].source, 'MEMORY.md');
  assert.equal(lookup('存量词 不失效', { dbPath, now: 87400.25, limit: 1 }).length, 1);
  const status = radarStatus({ dbPath, now: 87400.25 });
  assert.deepEqual([status.terms, status.candidates, status.eligible, status.last_sync], [6, 1, 2, null]);
  assert.deepEqual(snapshot(dbPath), before);
});
