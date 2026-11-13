import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compileVideo } from '../src/compiler/schema.js';
import { syncEntries, lookup, radarStatus } from '../src/store/radar.js';
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
