import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  applyMaintenancePatches, applyMaintenanceReviews, lookup, maintenanceCandidates,
  previewMaintenanceReviews, syncEntries,
} from '../src/store/radar.js';
import { draftPatch, maintenanceDigest, maintenanceError, targetDigest } from '../src/maintenance/model.js';
import { createHttpGenerator, defaultMaintenanceModel } from '../src/maintenance/generator.js';
import {
  applyNormalizedImport, approveMaintenanceReport, backfillDrafts, previewNormalizedImport,
  readMaintenanceJson,
} from '../src/maintenance/workflows.js';

const sourceUrl = 'https://www.bilibili.com/video/av42';
const values = {
  usage_context: '熟人之间接续夸张的自嘲，语气轻松，不对陌生人作人身判断。',
  avoid_when: '涉及真实婚姻经历、当事人困扰或严肃求助时不要借这个词调侃。',
};
const entry = (term = '旧词', extra = {}) => ({
  term, aliases: ['旧别名'], meaning: '用夸张的认可表达自嘲，不是对真实经历作判断。',
  usage_context: '', avoid_when: '', origin: '保留已有出处叙述，不另行猜测。',
  source_url: sourceUrl, ttl_days: 1, confidence: 0.8, published_at: '2026-11-01', ...extra,
});
const failsWith = (code) => (error) => error.code === code;
const approve = (record) => ({ ...record, approval: 'approved' });
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'maintenance-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, dbPath: join(directory, 'radar.db') };
}

function database(dbPath, operation, readOnly = false) {
  const db = new DatabaseSync(dbPath, { readOnly });
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function snapshot(dbPath) {
  return database(dbPath, (db) => {
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all().map((row) => ({ ...row }));
    const data = Object.fromEntries(schema.filter((row) => row.type === 'table').map(({ name }) => [name,
      db.prepare(`SELECT * FROM ${quote(name)}`).all().map((row) => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ]));
    return { schema, data };
  }, true);
}

function seed(dbPath, entries = [entry()]) {
  syncEntries(entries, { dbPath, now: 100 });
}

function patches(dbPath, fields = ['usage_context', 'avoid_when']) {
  return maintenanceCandidates({ dbPath, fields }).flatMap((target) => target.fields.map((field) => draftPatch(target, field, values[field])));
}

function assertMetadataOnly(before, after, fields) {
  const expected = structuredClone(before);
  for (const row of expected.data.watcher_entry_meta) {
    for (const field of fields) row[field] = values[field];
  }
  assert.deepEqual(after, expected, 'Only the approved metadata fields may change.');
}

test('missing metadata rows reject redigested defaults outside the approved field', (t) => {
  for (const field of ['usage_context', 'human_note']) {
    const { dbPath } = temporary(t);
    seed(dbPath);
    database(dbPath, (db) => {
      db.exec("ALTER TABLE watcher_entry_meta ADD COLUMN human_note TEXT NOT NULL DEFAULT '原有默认备注'");
      db.prepare('DELETE FROM watcher_entry_meta WHERE term=?').run('旧词');
    });
    const [target] = maintenanceCandidates({ dbPath, fields: ['avoid_when'] });
    const forged = structuredClone(target);
    forged.expected.metadata_template[field] = '未经批准的额外字段内容不得由此记录写入。';
    forged.digest = targetDigest(forged);
    const before = snapshot(dbPath);
    const refused = applyMaintenancePatches([approve(draftPatch(forged, 'avoid_when', values.avoid_when))], { dbPath });
    assert.equal(refused.counts.conflict, 1, JSON.stringify({ report: refused,
      metadata: database(dbPath, (db) => db.prepare('SELECT * FROM watcher_entry_meta WHERE term=?').get('旧词'), true) }));
    assert.equal(refused.outcomes[0].reason, 'METADATA_TEMPLATE_CHANGED');
    assert.deepEqual(snapshot(dbPath), before);
    const applied = applyMaintenancePatches([approve(draftPatch(target, 'avoid_when', values.avoid_when))], { dbPath });
    assert.equal(applied.counts.updated, 1);
    const expected = structuredClone(before);
    expected.data.watcher_entry_meta = [{ term: '旧词', usage_context: '', avoid_when: values.avoid_when,
      published_at: null, human_note: '原有默认备注' }];
    assert.deepEqual(snapshot(dbPath), expected);
  }
});

test('candidates are readonly exact snapshots with empty-field, source and limit selection', (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath, [entry('A词'), entry('B词', { aliases: [], usage_context: '已有明确使用场景，不需要补写。' }), entry('C词', { aliases: [], usage_context: values.usage_context, avoid_when: values.avoid_when })]);
  database(dbPath, (db) => {
    db.prepare('UPDATE terms SET source=? WHERE term=?').run('memewiki_import', 'A词');
    db.prepare('INSERT INTO candidate_reviews VALUES (?,?,?,?,?,?)').run(' A词 ', 'accepted', '保留人工证据', 120, sourceUrl, 'human');
  });
  const before = snapshot(dbPath);
  const bytes = readFileSync(dbPath);
  const candidates = maintenanceCandidates({ dbPath, fields: ['avoid_when', 'usage_context'], source: 'memewiki_import', limit: 1 });
  assert.equal(candidates.length, 1);
  const [target] = candidates;
  assert.equal(target.canonical_term, 'A词');
  assert.deepEqual(target.source, { kind: 'memewiki_import', url: sourceUrl });
  assert.equal(target.review_status, 'local_reference');
  assert.deepEqual(target.fields, ['usage_context', 'avoid_when']);
  assert.deepEqual(target.evidence.aliases, ['旧别名']);
  assert.equal(target.evidence.meaning, entry().meaning);
  assert.equal(target.expected.term.last_seen, 100);
  assert.equal(target.expected.metadata.published_at, '2026-11-01');
  assert.equal(target.expected.candidate_reviews[0].reason, '保留人工证据');
  assert.equal(target.digest, targetDigest(target));
  assert.deepEqual(maintenanceCandidates({ dbPath, fields: ['usage_context'] }).map((item) => item.canonical_term), ['A词']);
  assert.deepEqual(maintenanceCandidates({ dbPath, fields: ['avoid_when'], limit: 0 }), []);
  for (const options of [{ fields: ['meaning'] }, { fields: [] }, { limit: -1 }, { limit: 1001 }, { source: '' }]) {
    assert.throws(() => maintenanceCandidates({ dbPath, ...options }), failsWith('INVALID_OPTIONS'));
  }
  assert.deepEqual(snapshot(dbPath), before);
  assert.deepEqual(readFileSync(dbPath), bytes);
});

test('missing, empty, corrupt and invalid databases are faults and are never created or repaired', (t) => {
  const { directory, dbPath } = temporary(t);
  const missing = join(directory, 'not-created', 'radar.db');
  assert.throws(() => maintenanceCandidates({ dbPath: missing }), failsWith('DATABASE_MISSING'));
  assert.equal(existsSync(join(directory, 'not-created')), false);
  assert.equal(applyMaintenancePatches([], { dbPath: missing }).error.code, 'DATABASE_MISSING');
  assert.equal(existsSync(missing), false);
  writeFileSync(dbPath, '');
  assert.throws(() => maintenanceCandidates({ dbPath }), failsWith('DATABASE_INVALID'));
  assert.equal(readFileSync(dbPath, 'utf8'), '');
  writeFileSync(dbPath, 'not a SQLite file containing a private failure marker');
  assert.throws(() => maintenanceCandidates({ dbPath }), (error) => error.code === 'DATABASE_ERROR' && !error.message.includes('private failure marker'));
  assert.equal(applyMaintenancePatches([], { dbPath }).error.code, 'DATABASE_ERROR');
  const invalid = join(directory, 'invalid.db');
  database(invalid, (db) => db.exec('CREATE TABLE unrelated (n INTEGER)'));
  const before = snapshot(invalid);
  assert.throws(() => maintenanceCandidates({ dbPath: invalid }), failsWith('DATABASE_INVALID'));
  assert.equal(applyMaintenanceReviews([], { dbPath: invalid }).error.code, 'DATABASE_INVALID');
  assert.deepEqual(snapshot(invalid), before);
  assert.throws(() => applyMaintenancePatches([]), failsWith('INVALID_OPTIONS'));
  assert.throws(() => applyMaintenanceReviews([]), failsWith('INVALID_OPTIONS'));
});

test('maintenance refuses composite canonical keys even on empty selection', (t) => {
  for (const [table, secondary] of [['terms', 'source'], ['term_reviews', 'source_url'], ['candidate_reviews', 'source_url'], ['watcher_entry_meta', 'published_at']]) {
    const { dbPath } = temporary(t);
    seed(dbPath);
    database(dbPath, (db) => {
      const sql = db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('table', table).sql;
      const composite = sql.replace(/term text primary key/iu, 'term text').replace(/\)\s*$/u, `, PRIMARY KEY (term, ${secondary}))`);
      db.exec(`DROP TABLE ${table}; ${composite}`);
      assert.deepEqual(db.prepare(`PRAGMA table_info(${table})`).all().filter((row) => row.pk).map((row) => row.name), ['term', secondary]);
    });
    const before = snapshot(dbPath);
    const report = applyMaintenancePatches([], { dbPath });
    assert.equal(report.error?.code, 'DATABASE_INVALID', table);
    assert.throws(() => maintenanceCandidates({ dbPath, limit: 0 }), failsWith('DATABASE_INVALID'));
    assert.equal(applyMaintenanceReviews([], { dbPath }).error.code, 'DATABASE_INVALID');
    assert.deepEqual(snapshot(dbPath), before);
  }
});

test('approved patches update only metadata, preserve TTL/review and replay both fields unchanged', (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath);
  const pending = patches(dbPath);
  const before = snapshot(dbPath);
  const refused = applyMaintenancePatches(pending, { dbPath, now: 500 });
  assert.deepEqual(refused.outcomes.map(({ status, reason }) => [status, reason]), [['rejected', 'APPROVAL_REQUIRED'], ['rejected', 'APPROVAL_REQUIRED']]);
  assert.deepEqual(snapshot(dbPath), before);
  const approved = pending.map(approve);
  const report = applyMaintenancePatches(approved, { dbPath, now: 100000 });
  assert.equal(report.counts.updated, 2);
  const after = snapshot(dbPath);
  assertMetadataOnly(before, after, ['usage_context', 'avoid_when']);
  assert.deepEqual(lookup('旧词', { dbPath, now: 100000 }), [], 'Metadata maintenance must not revive an expired term.');
  assert.equal(applyMaintenancePatches(approved, { dbPath, now: 200000 }).counts.unchanged, 2);
  assert.deepEqual(snapshot(dbPath), after);
});

test('Unicode canonical keys update metadata without false snapshot conflicts', (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath, [entry('😀词', { aliases: [] }), entry('Ｚ词', { aliases: [] })]);
  const approved = patches(dbPath, ['avoid_when']).map(approve);
  assert.equal(approved.length, 2);
  const before = snapshot(dbPath);
  const report = applyMaintenancePatches(approved, { dbPath, now: 500 });
  assert.deepEqual(report.outcomes.map(({ status, reason }) => [status, reason]), [['updated', 'FIELD_FILLED'], ['updated', 'FIELD_FILLED']]);
  const after = snapshot(dbPath);
  assertMetadataOnly(before, after, ['avoid_when']);
  assert.equal(applyMaintenancePatches(approved, { dbPath, now: 600 }).counts.unchanged, 2);
  assert.deepEqual(snapshot(dbPath), after);
});

test('already-filled and concurrently changed material is not overwritten', (t) => {
  for (const [sql, args, reason] of [
    ['UPDATE watcher_entry_meta SET avoid_when=? WHERE term=?', ['其他维护者已经写入的有效建议。', '旧词'], 'FIELD_NOT_EMPTY'],
    ['UPDATE watcher_entry_meta SET usage_context=? WHERE term=?', [values.usage_context, '旧词'], 'METADATA_CHANGED'],
    ['UPDATE term_reviews SET actor=? WHERE term=?', ['other-human', '旧词'], 'REVIEW_CHANGED'],
    ['UPDATE terms SET meaning=? WHERE term=?', ['新的释义必须重新审阅生成建议。', '旧词'], 'MEANING_CHANGED'],
    ['UPDATE terms SET source=? WHERE term=?', ['other_source', '旧词'], 'SOURCE_CHANGED'],
    ['UPDATE term_reviews SET source_url=? WHERE term=?', ['https://www.bilibili.com/video/av43', '旧词'], 'SOURCE_CHANGED'],
    ['UPDATE terms SET aliases=? WHERE term=?', ['新增别名', '旧词'], 'MATERIAL_CHANGED'],
    ['UPDATE terms SET heat=heat+1 WHERE term=?', ['旧词'], 'MATERIAL_CHANGED'],
    ['UPDATE terms SET ttl_days=ttl_days+1 WHERE term=?', ['旧词'], 'MATERIAL_CHANGED'],
  ]) {
    const { dbPath } = temporary(t);
    seed(dbPath);
    const approved = patches(dbPath, ['avoid_when']).map(approve);
    database(dbPath, (db) => db.prepare(sql).run(...args));
    const before = snapshot(dbPath);
    const report = applyMaintenancePatches(approved, { dbPath, now: 500 });
    assert.deepEqual([report.outcomes[0].status, report.outcomes[0].reason], ['conflict', reason]);
    assert.deepEqual(snapshot(dbPath), before);
  }
});

test('canonical and alias rejections in either review table refuse patches and remain readonly', (t) => {
  for (const [table, field, term] of [
    ['term_reviews', 'status', '旧词'], ['term_reviews', 'status', ' 旧别名 '],
    ['candidate_reviews', 'verdict', '旧词'], ['candidate_reviews', 'verdict', ' 旧别名 '],
  ]) {
    const { dbPath } = temporary(t);
    seed(dbPath);
    const approved = patches(dbPath, ['avoid_when']).map(approve);
    database(dbPath, (db) => {
      if (table === 'term_reviews') db.prepare('INSERT OR REPLACE INTO term_reviews VALUES (?,?,?,?,?)').run(term, 'rejected', 150, sourceUrl, 'human');
      else db.prepare('INSERT INTO candidate_reviews VALUES (?,?,?,?,?,?)').run(term, 'rejected', '明确拒绝，保留原记录', 150, sourceUrl, 'human');
    });
    const before = snapshot(dbPath);
    assert.deepEqual(maintenanceCandidates({ dbPath }), []);
    const report = applyMaintenancePatches(approved, { dbPath, now: 500 });
    assert.deepEqual([report.outcomes[0].status, report.outcomes[0].reason], ['rejected', 'IDENTITY_REJECTED'], `${table}.${field}`);
    assert.deepEqual(snapshot(dbPath), before);
  }
});

test('deleted terms never gain orphan metadata, even when the metadata table is absent', (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath);
  database(dbPath, (db) => db.exec('DROP TABLE watcher_entry_meta'));
  const approved = patches(dbPath, ['avoid_when']).map(approve);
  database(dbPath, (db) => db.prepare('DELETE FROM terms WHERE term=?').run('旧词'));
  const before = snapshot(dbPath);
  const report = applyMaintenancePatches(approved, { dbPath, now: 500 });
  assert.deepEqual([report.outcomes[0].status, report.outcomes[0].reason], ['deleted', 'TERM_DELETED']);
  assert.deepEqual(snapshot(dbPath), before);
  assert.equal(snapshot(dbPath).data.watcher_entry_meta, undefined);
});

test('all-refused operations do not initialize metadata or unrelated watcher/cache tables', (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath);
  database(dbPath, (db) => db.exec('DROP TABLE watcher_entry_meta; DROP TABLE watcher_sync_versions; DROP TABLE candidates; DROP TABLE search_cache;'));
  const pending = patches(dbPath, ['avoid_when']);
  const invalid = approve(structuredClone(pending[0]));
  invalid.target.expected.term.meaning = 'tampered snapshot';
  const before = snapshot(dbPath);
  const report = applyMaintenancePatches([...pending, invalid, { ...pending[0], approval: 'rejected' }], { dbPath, now: 500 });
  assert.deepEqual(report.outcomes.map(({ reason }) => reason), ['APPROVAL_REQUIRED', 'INVALID_TARGET', 'APPROVAL_REJECTED']);
  assert.deepEqual(snapshot(dbPath), before);
  assert.deepEqual(applyMaintenancePatches([], { dbPath }).outcomes, []);
  assert.deepEqual(snapshot(dbPath), before);
});

test('metadata inserts preserve additional column defaults and updates preserve full existing rows', (t) => {
  for (const removeRow of [false, true]) {
    const { dbPath } = temporary(t);
    seed(dbPath);
    database(dbPath, (db) => {
      db.exec("ALTER TABLE watcher_entry_meta ADD COLUMN human_note TEXT NOT NULL DEFAULT 'keep note'; ALTER TABLE watcher_entry_meta ADD COLUMN extra_blob BLOB DEFAULT X'1234';");
      if (removeRow) db.prepare('DELETE FROM watcher_entry_meta WHERE term=?').run('旧词');
      else db.prepare('UPDATE watcher_entry_meta SET human_note=? WHERE term=?').run('人工证据，不得改写', '旧词');
    });
    const approved = patches(dbPath, ['avoid_when']).map(approve);
    const before = snapshot(dbPath);
    const report = applyMaintenancePatches(approved, { dbPath, now: 500 });
    assert.equal(report.counts.updated, 1);
    const after = snapshot(dbPath);
    const row = after.data.watcher_entry_meta[0];
    assert.equal(row.human_note, removeRow ? 'keep note' : '人工证据，不得改写');
    assert.deepEqual([...row.extra_blob], [0x12, 0x34]);
    assert.equal(row.published_at, removeRow ? null : '2026-11-01');
    assert.deepEqual(after.data.terms, before.data.terms);
    assert.deepEqual(after.data.term_reviews, before.data.term_reviews);
    assert.equal(applyMaintenancePatches(approved, { dbPath, now: 600 }).counts.unchanged, 1);
    assert.deepEqual(snapshot(dbPath), after);
  }
});

test('legacy maintenance creates only its metadata table after an approved write and safely replays', (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath);
  database(dbPath, (db) => db.exec('DROP TABLE watcher_entry_meta; DROP TABLE watcher_sync_versions; DROP TABLE candidates; DROP TABLE search_cache;'));
  const approved = patches(dbPath, ['avoid_when']).map(approve);
  const before = snapshot(dbPath);
  assert.equal(applyMaintenancePatches(approved, { dbPath, now: 500 }).counts.updated, 1);
  const after = snapshot(dbPath);
  assert.deepEqual(after.schema.filter(({ name }) => name !== 'watcher_entry_meta' && name !== 'sqlite_autoindex_watcher_entry_meta_1'), before.schema);
  assert.equal(after.data.watcher_sync_versions, undefined);
  assert.equal(after.data.search_cache, undefined);
  assert.deepEqual(after.data.terms, before.data.terms);
  assert.equal(applyMaintenancePatches(approved, { dbPath, now: 600 }).counts.unchanged, 1);
  assert.deepEqual(snapshot(dbPath), after);
});

test('conflicting batches and exact snapshot tampering refuse writes', (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath);
  const [approved] = patches(dbPath, ['avoid_when']).map(approve);
  const before = snapshot(dbPath);
  const changedValue = { ...approved, value: '另一个不同的建议必须由操作员选择，不能按顺序覆盖。' };
  assert.equal(applyMaintenancePatches([approved, changedValue], { dbPath }).counts.conflict, 2);
  const changedSnapshot = structuredClone(approved);
  changedSnapshot.target.expected.term.tags = 'new snapshot';
  changedSnapshot.target.evidence.tags = 'new snapshot';
  changedSnapshot.target.digest = targetDigest(changedSnapshot.target);
  changedSnapshot.id = maintenanceDigest({ target: changedSnapshot.target.digest, field: changedSnapshot.field });
  assert.equal(applyMaintenancePatches([approved, changedSnapshot], { dbPath }).counts.conflict, 2);
  assert.deepEqual(snapshot(dbPath), before);
  const duplicated = applyMaintenancePatches([approved, approved], { dbPath });
  assert.deepEqual([duplicated.counts.updated, duplicated.counts.unchanged], [1, 1]);
});

test('metadata transaction failures roll back the entire batch without exposing trigger payloads', (t) => {
  for (const [removeRows, verdict] of [[false, 'ABORT'], [false, 'ROLLBACK'], [true, 'ABORT'], [true, 'ROLLBACK']]) {
    const { dbPath } = temporary(t);
    seed(dbPath, [entry('A词', { aliases: [] }), entry('Z词', { aliases: [] })]);
    database(dbPath, (db) => {
      if (removeRows) db.exec('DELETE FROM watcher_entry_meta');
      db.exec(`CREATE TRIGGER forced_maintenance_failure BEFORE ${removeRows ? 'INSERT' : 'UPDATE'} ON watcher_entry_meta WHEN NEW.term='Z词' BEGIN SELECT RAISE(${verdict}, 'secret-token /private/local/path'); END`);
    });
    const approved = patches(dbPath, ['avoid_when']).map(approve);
    const before = snapshot(dbPath);
    const report = applyMaintenancePatches(approved, { dbPath, now: 500 });
    assert.equal(report.counts.failed, 2);
    assert.equal(report.error.code, 'DATABASE_ERROR');
    assert.equal(report.outcomes[0].reason, 'TRANSACTION_ROLLED_BACK');
    assert.equal(JSON.stringify(report).includes('secret-token'), false);
    assert.equal(JSON.stringify(report).includes('/private/local/path'), false);
    assert.deepEqual(snapshot(dbPath), before);
  }
});

test('a deleting metadata trigger cannot commit an orphan or change protected term material', (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath);
  database(dbPath, (db) => {
    db.exec('DELETE FROM watcher_entry_meta');
    db.exec("CREATE TRIGGER delete_during_maintenance AFTER INSERT ON watcher_entry_meta BEGIN DELETE FROM terms WHERE term=NEW.term; END");
  });
  const approved = patches(dbPath, ['avoid_when']).map(approve);
  const before = snapshot(dbPath);
  assert.equal(applyMaintenancePatches(approved, { dbPath }).counts.failed, 1);
  assert.deepEqual(snapshot(dbPath), before);
});

test('maintenance lock waits are bounded and report a visible busy fault', (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath);
  const approved = patches(dbPath, ['avoid_when']).map(approve);
  const before = snapshot(dbPath);
  database(dbPath, (writer) => {
    writer.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    const report = applyMaintenancePatches(approved, { dbPath });
    assert.equal(report.error.code, 'DATABASE_BUSY');
    assert.equal(report.outcomes[0].reason, 'DATABASE_BUSY');
    assert.ok(Date.now() - started < 2000, 'A busy maintenance write must not wait indefinitely.');
    writer.exec('ROLLBACK');
  });
  assert.deepEqual(snapshot(dbPath), before);
});

test('review preview is separate from approval and review apply changes only review state', (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath);
  const before = snapshot(dbPath);
  const pending = previewMaintenanceReviews([{ term: ' 旧别名 ', status: 'accepted' }], { dbPath });
  assert.equal(pending[0].target.canonical_term, '旧词');
  assert.equal(pending[0].approval, 'pending');
  assert.deepEqual(snapshot(dbPath), before);
  assert.equal(applyMaintenanceReviews(pending, { dbPath, now: 500 }).outcomes[0].reason, 'APPROVAL_REQUIRED');
  const approved = pending.map(approve);
  assert.equal(applyMaintenanceReviews(approved, { dbPath, now: 500 }).counts.updated, 1);
  const expected = structuredClone(before);
  Object.assign(expected.data.term_reviews[0], { status: 'accepted', reviewed_at: 500, actor: 'maintenance:operator' });
  const after = snapshot(dbPath);
  assert.deepEqual(after, expected);
  assert.equal(applyMaintenanceReviews(approved, { dbPath, now: 600 }).counts.unchanged, 1);
  assert.deepEqual(snapshot(dbPath), after);
  assert.deepEqual(lookup('旧词', { dbPath, now: 100000 }), [], 'Explicit review must not refresh TTL.');
});

test('reviews preserve rejected canonical/alias decisions and reject stale source, meaning and metadata', (t) => {
  for (const change of ['canonical', 'alias', 'source', 'meaning', 'metadata']) {
    const { dbPath } = temporary(t);
    seed(dbPath);
    const approved = previewMaintenanceReviews([{ term: '旧词', status: 'accepted' }], { dbPath }).map(approve);
    database(dbPath, (db) => {
      if (change === 'canonical') db.prepare('UPDATE term_reviews SET status=? WHERE term=?').run('rejected', '旧词');
      if (change === 'alias') db.prepare('INSERT INTO candidate_reviews VALUES (?,?,?,?,?,?)').run('旧别名', 'rejected', '明确拒绝', 150, sourceUrl, 'human');
      if (change === 'source') db.prepare('UPDATE term_reviews SET source_url=? WHERE term=?').run('https://www.bilibili.com/video/av43', '旧词');
      if (change === 'meaning') db.prepare('UPDATE terms SET meaning=? WHERE term=?').run('新释义需要重新审阅', '旧词');
      if (change === 'metadata') db.prepare('UPDATE watcher_entry_meta SET usage_context=? WHERE term=?').run(values.usage_context, '旧词');
    });
    const before = snapshot(dbPath);
    const report = applyMaintenanceReviews(approved, { dbPath, now: 500 });
    assert.equal(report.outcomes[0].status, ['canonical', 'alias'].includes(change) ? 'rejected' : 'conflict');
    assert.deepEqual(snapshot(dbPath), before);
  }
  const { dbPath } = temporary(t);
  seed(dbPath);
  const approved = previewMaintenanceReviews([{ term: '旧词', status: 'rejected' }], { dbPath }).map(approve);
  assert.equal(applyMaintenanceReviews(approved, { dbPath, now: 500 }).counts.updated, 1);
  const rejected = snapshot(dbPath);
  assert.equal(applyMaintenanceReviews(approved, { dbPath, now: 600 }).counts.unchanged, 1);
  assert.deepEqual(snapshot(dbPath), rejected);
  const acceptRejected = previewMaintenanceReviews([{ term: '旧词', status: 'accepted' }], { dbPath }).map(approve);
  assert.equal(applyMaintenanceReviews(acceptRejected, { dbPath, now: 700 }).outcomes[0].reason, 'IDENTITY_REJECTED');
  assert.deepEqual(snapshot(dbPath), rejected);
});

test('review batches roll back on failure and legacy review never creates metadata tables', (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath, [entry('A词', { aliases: [] }), entry('Z词', { aliases: [] })]);
  database(dbPath, (db) => {
    db.exec('DROP TABLE watcher_entry_meta; DROP TABLE watcher_sync_versions; DROP TABLE candidates; DROP TABLE search_cache;');
    db.exec("CREATE TRIGGER forced_review_failure BEFORE UPDATE ON term_reviews WHEN NEW.term='Z词' BEGIN SELECT RAISE(ABORT, 'private review payload'); END");
  });
  const approved = previewMaintenanceReviews([{ term: 'A词', status: 'accepted' }, { term: 'Z词', status: 'accepted' }], { dbPath }).map(approve);
  const before = snapshot(dbPath);
  assert.equal(applyMaintenanceReviews(approved, { dbPath, now: 500 }).counts.failed, 2);
  assert.deepEqual(snapshot(dbPath), before);
  database(dbPath, (db) => db.exec('DROP TRIGGER forced_review_failure'));
  const ready = snapshot(dbPath);
  assert.equal(applyMaintenanceReviews(approved, { dbPath, now: 500 }).counts.updated, 2);
  const after = snapshot(dbPath);
  assert.deepEqual(after.schema, ready.schema);
  assert.equal(after.data.watcher_entry_meta, undefined);
  assert.deepEqual(after.data.terms, ready.data.terms);
});

test('normalized import validates before writes and preserves original alias/fingerprint replay behavior', (t) => {
  const { directory, dbPath } = temporary(t);
  const complete = entry('Canonical', { aliases: ['Café', 'ALIAS', 'alias'], ...values, source_url: 'http://m.bilibili.com/video/av42/?share=1' });
  const preview = previewNormalizedImport([complete]);
  assert.equal(preview.count, 1);
  assert.equal(preview.entries[0].source_url, sourceUrl);
  assert.deepEqual(preview.entries[0].aliases, ['Café', 'ALIAS']);
  assert.equal(existsSync(dbPath), false);
  assert.throws(() => applyNormalizedImport([complete], { dbPath, now: 100 }), failsWith('DATABASE_MISSING'));
  assert.equal(existsSync(dbPath), false);
  assert.equal(applyNormalizedImport([complete], { dbPath, now: 100, create: true }).inserted, 1);
  database(dbPath, (db) => db.prepare('UPDATE term_reviews SET status=?,actor=?,reviewed_at=? WHERE term=?').run('accepted', 'human', 150, 'Canonical'));
  const before = snapshot(dbPath);
  assert.equal(previewNormalizedImport([complete], { dbPath }).count, 1);
  assert.deepEqual(snapshot(dbPath), before);
  assert.equal(applyNormalizedImport([complete], { dbPath, now: 200 }).unchanged, 1);
  assert.deepEqual(snapshot(dbPath), before);
  const aliasEntry = { ...complete, term: 'Café', aliases: ['新别名'], meaning: '更新后的同一身份释义。' };
  const merged = applyNormalizedImport([aliasEntry], { dbPath, now: 300 });
  assert.equal(merged.updated, 1);
  assert.equal(merged.entries[0].term, 'Canonical');
  assert.ok(merged.entries[0].aliases.includes('新别名'));
  assert.equal(lookup('新别名', { dbPath, now: 301 })[0].term, 'Canonical');
  const latest = snapshot(dbPath);
  assert.equal(applyNormalizedImport([aliasEntry], { dbPath, now: 400 }).unchanged, 1);
  assert.deepEqual(snapshot(dbPath), latest);
  for (const invalid of [entry(), { ...complete, usage_context: ' ' }, { ...complete, avoid_when: '' }, { ...complete, source_url: 'https://example.org/meme' }, { ...complete, extra: 'not normalized' }]) {
    const missing = join(directory, 'not-created', 'radar.db');
    assert.throws(() => previewNormalizedImport([invalid]));
    assert.throws(() => applyNormalizedImport([invalid], { dbPath: missing, create: true }));
    assert.equal(existsSync(join(directory, 'not-created')), false);
  }
  const invalidDb = join(directory, 'invalid.db');
  database(invalidDb, (db) => db.exec('CREATE TABLE unrelated (n INTEGER)'));
  const invalidBefore = snapshot(invalidDb);
  assert.throws(() => applyNormalizedImport([complete], { dbPath: invalidDb, create: true }), failsWith('DATABASE_INVALID'));
  assert.deepEqual(snapshot(invalidDb), invalidBefore);
});

test('backfill generates outside transactions, checkpoints pending drafts and requires explicit approval before apply', async (t) => {
  const { directory, dbPath } = temporary(t);
  seed(dbPath);
  const before = snapshot(dbPath);
  const draftPath = join(directory, 'draft.json');
  const calls = [];
  const generator = async (target, field, { signal }) => {
    calls.push({ canonical_term: target.canonical_term, field, source: target.source });
    assert.equal(signal.aborted, false);
    database(dbPath, (writer) => { writer.exec('BEGIN IMMEDIATE'); writer.exec('ROLLBACK'); });
    const checkpoint = readMaintenanceJson(draftPath);
    assert.equal(checkpoint.patches.length, calls.length - 1, 'Each completed draft is durable before the next model attempt.');
    return { [field]: values[field] };
  };
  const report = await backfillDrafts({ dbPath, generator, draftPath, maxAttempts: 1 });
  assert.deepEqual(calls.map(({ field }) => field), ['usage_context', 'avoid_when']);
  assert.equal(report.patches.length, 2);
  assert.ok(report.patches.every((patch) => patch.approval === 'pending'));
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.unattempted, []);
  assert.deepEqual(readMaintenanceJson(draftPath), report);
  assert.deepEqual(snapshot(dbPath), before);
  assert.equal(applyMaintenancePatches(report.patches, { dbPath }).counts.rejected, 2);
  assert.throws(() => approveMaintenanceReport(report, []), failsWith('INVALID_APPROVAL_SELECTION'));
  const approved = approveMaintenanceReport(report, report.patches.map(({ id }) => id));
  assert.ok(approved.patches.every((patch) => patch.approval === 'approved'));
  assert.equal(applyMaintenancePatches(approved.patches, { dbPath, now: 500 }).counts.updated, 2);
  const after = snapshot(dbPath);
  assertMetadataOnly(before, after, ['usage_context', 'avoid_when']);
  assert.equal(applyMaintenancePatches(approved.patches, { dbPath, now: 600 }).counts.unchanged, 2);
  assert.deepEqual(snapshot(dbPath), after);
});

test('source or meaning changes during generation yield drafts that conditional apply refuses', async (t) => {
  for (const field of ['source_url', 'meaning']) {
    const { dbPath } = temporary(t);
    seed(dbPath);
    const report = await backfillDrafts({
      dbPath, fields: ['avoid_when'], maxAttempts: 1,
      generator: async () => {
        database(dbPath, (writer) => field === 'meaning'
          ? writer.prepare('UPDATE terms SET meaning=? WHERE term=?').run('并发更新的真实释义。', '旧词')
          : writer.prepare('UPDATE term_reviews SET source_url=? WHERE term=?').run('https://www.bilibili.com/video/av43', '旧词'));
        return { avoid_when: values.avoid_when };
      },
    });
    assert.equal(report.patches.length, 1);
    const before = snapshot(dbPath);
    const approved = approveMaintenanceReport(report, report.patches.map(({ id }) => id));
    const result = applyMaintenancePatches(approved.patches, { dbPath });
    assert.equal(result.outcomes[0].reason, field === 'meaning' ? 'MEANING_CHANGED' : 'SOURCE_CHANGED');
    assert.deepEqual(snapshot(dbPath), before);
  }
});

test('invalid, wrong-field, unbounded and placeholder generator outputs never become drafts', async (t) => {
  for (const output of [
    'not a JSON object', {}, { meaning: '不要改动释义这个字段。' }, { avoid_when: '' },
    { avoid_when: 'TODO placeholder content' }, { avoid_when: '待补充具体使用建议内容。' },
    { avoid_when: '重复重复重复重复重复' }, { avoid_when: '不应补写来源链接 https://example.org/private' },
    { avoid_when: '建议'.repeat(301) }, { avoid_when: '一段包含\u0000非法控制符的建议。' },
    { avoid_when: values.avoid_when, origin: 'fabricated origin' },
  ]) {
    const { dbPath } = temporary(t);
    seed(dbPath);
    const before = snapshot(dbPath);
    let attempts = 0;
    const report = await backfillDrafts({ dbPath, fields: ['avoid_when'], retryDelayMs: 0, maxAttempts: 2, generator: async () => { attempts++; return output; } });
    assert.equal(attempts, 2);
    assert.deepEqual(report.patches, []);
    assert.equal(report.failures[0].code, 'MODEL_OUTPUT_INVALID');
    assert.equal(report.failures[0].attempts, 2);
    assert.equal(report.attempt_failures.length, 2);
    assert.deepEqual(snapshot(dbPath), before);
  }
});

test('retries are finite, recovered attempt failures remain visible and unknown permanent errors do not retry', async (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath);
  let attempts = 0;
  const recovered = await backfillDrafts({
    dbPath, fields: ['avoid_when'], maxAttempts: 3, retryDelayMs: 0,
    generator: async () => {
      if (++attempts < 3) throw maintenanceError('MODEL_UNAVAILABLE', 'secret raw payload /private/local/path', true);
      return { avoid_when: values.avoid_when };
    },
  });
  assert.equal(attempts, 3);
  assert.equal(recovered.patches.length, 1);
  assert.deepEqual(recovered.failures, []);
  assert.equal(recovered.attempt_failures.length, 2);
  assert.equal(JSON.stringify(recovered).includes('secret raw payload'), false);
  assert.equal(JSON.stringify(recovered).includes('/private/local/path'), false);
  attempts = 0;
  const failed = await backfillDrafts({ dbPath, fields: ['avoid_when'], maxAttempts: 2, retryDelayMs: 0, generator: async () => { attempts++; throw maintenanceError('MODEL_RATE_LIMIT', 'Bearer fake-secret C:\\private\\failure', true); } });
  assert.equal(attempts, 2);
  assert.equal(failed.failures[0].attempts, 2);
  assert.equal(failed.failures[0].code, 'MODEL_RATE_LIMIT');
  assert.equal(JSON.stringify(failed).includes('fake-secret'), false);
  assert.equal(JSON.stringify(failed).includes('C:\\private'), false);
  attempts = 0;
  const permanent = await backfillDrafts({ dbPath, fields: ['avoid_when'], maxAttempts: 5, generator: async () => { attempts++; throw Object.assign(new Error('unknown secret failure'), { code: 'UNTRUSTED_FAILURE', retryable: true }); } });
  assert.equal(attempts, 1);
  assert.equal(permanent.failures[0].code, 'GENERATOR_FAILED');
  assert.equal(JSON.stringify(permanent).includes('unknown secret failure'), false);
});

test('the circuit counts consecutive failed items, resets after success and stops all remaining generation', async (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath, ['A词', 'B词', 'C词', 'D词', 'E词'].map((term) => entry(term, { aliases: [] })));
  const before = snapshot(dbPath);
  const calls = [];
  const report = await backfillDrafts({
    dbPath, fields: ['avoid_when'], maxAttempts: 2, circuitFailures: 2, retryDelayMs: 0,
    generator: async (target, field) => {
      calls.push(target.canonical_term);
      if (target.canonical_term !== 'B词') throw maintenanceError('MODEL_UNAVAILABLE', 'private service payload', true);
      return { [field]: values[field] };
    },
  });
  assert.deepEqual(calls, ['A词', 'A词', 'B词', 'C词', 'C词', 'D词', 'D词']);
  assert.equal(report.patches[0].target.canonical_term, 'B词');
  assert.deepEqual(report.failures.map(({ canonical_term }) => canonical_term), ['A词', 'C词', 'D词']);
  assert.deepEqual(report.circuit, { open: true, consecutive_failures: 2, threshold: 2 });
  assert.equal(report.stop_reason, 'CIRCUIT_OPEN');
  assert.deepEqual(report.unattempted.map(({ canonical_term, reason }) => [canonical_term, reason]), [['E词', 'CIRCUIT_OPEN']]);
  assert.deepEqual(snapshot(dbPath), before);
});

test('generator deadlines abort attempts, stop on the circuit and leave later items unattempted', async (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath, [entry('A词', { aliases: [] }), entry('B词', { aliases: [] })]);
  let attempts = 0;
  let aborts = 0;
  const report = await backfillDrafts({
    dbPath, fields: ['avoid_when'], timeoutMs: 5, maxAttempts: 2, circuitFailures: 1, retryDelayMs: 0,
    generator: async (target, field, { signal }) => {
      attempts++;
      signal.addEventListener('abort', () => { aborts++; }, { once: true });
      return new Promise(() => {});
    },
  });
  assert.equal(attempts, 2);
  assert.equal(aborts, 2);
  assert.equal(report.failures[0].code, 'MODEL_TIMEOUT');
  assert.deepEqual(report.unattempted.map(({ canonical_term }) => canonical_term), ['B词']);
  assert.deepEqual(report.patches, []);
});

test('missing configuration and missing evidence are explicit faults without any model calls', async (t) => {
  const { directory, dbPath } = temporary(t);
  seed(dbPath);
  const report = await backfillDrafts({ dbPath, fields: ['avoid_when'], runtime: { endpoint: '', token: '' }, draftPath: join(directory, 'config-failure.json') });
  assert.equal(report.error.code, 'GENERATOR_CONFIG');
  assert.equal(report.unattempted[0].reason, 'GENERATOR_CONFIG');
  assert.deepEqual(readMaintenanceJson(join(directory, 'config-failure.json')), report);
  database(dbPath, (db) => db.prepare('UPDATE term_reviews SET source_url=? WHERE term=?').run('', '旧词'));
  let calls = 0;
  const noEvidence = await backfillDrafts({ dbPath, fields: ['avoid_when'], generator: async () => { calls++; return { avoid_when: values.avoid_when }; } });
  assert.equal(calls, 0);
  assert.equal(noEvidence.failures[0].code, 'EVIDENCE_MISSING');
  assert.equal(noEvidence.failures[0].attempts, 0);
  assert.deepEqual(noEvidence.patches, []);
});

test('draft persistence never overwrites an existing database/report or concurrent operator edits', async (t) => {
  const { directory, dbPath } = temporary(t);
  seed(dbPath);
  const before = snapshot(dbPath);
  let calls = 0;
  await assert.rejects(backfillDrafts({ dbPath, draftPath: dbPath, generator: async () => { calls++; return { avoid_when: values.avoid_when }; } }), failsWith('REPORT_EXISTS'));
  assert.equal(calls, 0);
  assert.deepEqual(snapshot(dbPath), before);
  const draftPath = join(directory, 'operator-edited.json');
  await assert.rejects(backfillDrafts({
    dbPath, draftPath, fields: ['avoid_when'], maxAttempts: 1,
    generator: async () => { writeFileSync(draftPath, 'operator edited this active file'); return { avoid_when: values.avoid_when }; },
  }), failsWith('REPORT_CONFLICT'));
  assert.equal(readFileSync(draftPath, 'utf8'), 'operator edited this active file');
  assert.deepEqual(snapshot(dbPath), before);
  const rejected = { version: 1, kind: 'maintenance-drafts', patches: patches(dbPath, ['avoid_when']).map((patch) => ({ ...patch, approval: 'rejected' })) };
  assert.throws(() => approveMaintenanceReport(rejected, rejected.patches.map(({ id }) => id)), failsWith('APPROVAL_REJECTED'));
});

async function fakeModel(t, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ url: request.url, authorization: request.headers.authorization, body });
    handler(request, response, body, requests.length);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, token: 'test-only-token', requests };
}

function completion(response, content, finishReason = 'stop') {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }] }));
}

test('configured HTTP uses the bounded local-service contract with the exact default model and env override', async (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath);
  const before = snapshot(dbPath);
  const service = await fakeModel(t, (request, response) => completion(response, JSON.stringify({ avoid_when: values.avoid_when })));
  const defaultGenerator = createHttpGenerator({ endpoint: service.endpoint, token: service.token }, {});
  const report = await backfillDrafts({ dbPath, fields: ['avoid_when'], generator: defaultGenerator, maxAttempts: 1 });
  assert.equal(report.patches.length, 1);
  const [request] = service.requests;
  assert.equal(request.authorization, 'Bearer test-only-token');
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.body.model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(defaultMaintenanceModel, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(request.body.max_tokens, 800);
  const context = JSON.parse(request.body.messages[1].content);
  assert.equal(context.requested_field, 'avoid_when');
  assert.equal(context.term, '旧词');
  assert.equal(context.evidence.meaning, entry().meaning);
  assert.deepEqual(context.source, { kind: 'meme_watcher', url: sourceUrl });
  const envGenerator = createHttpGenerator({}, { MEME_MAINTENANCE_ENDPOINT: service.endpoint, MEME_MAINTENANCE_TOKEN: service.token, MEME_MAINTENANCE_MODEL: 'configured/deepseek-test-model' });
  const [target] = maintenanceCandidates({ dbPath, fields: ['avoid_when'] });
  await envGenerator(target, 'avoid_when');
  assert.equal(service.requests[1].body.model, 'configured/deepseek-test-model');
  assert.deepEqual(snapshot(dbPath), before);
});

test('HTTP rejects truncation, malformed response JSON, wrong fields, tool calls and placeholder output', async (t) => {
  const cases = [
    [(response) => completion(response, JSON.stringify({ avoid_when: values.avoid_when }), 'length'), 'MODEL_TRUNCATED'],
    [(response) => completion(response, '{"avoid_when":'), 'MODEL_OUTPUT_INVALID'],
    [(response) => completion(response, '```json\n{}\n```'), 'MODEL_OUTPUT_INVALID'],
    [(response) => completion(response, JSON.stringify({ usage_context: values.usage_context })), 'MODEL_OUTPUT_INVALID'],
    [(response) => completion(response, JSON.stringify({ avoid_when: 'TODO placeholder advice' })), 'MODEL_OUTPUT_INVALID'],
    [(response) => completion(response, JSON.stringify({ avoid_when: values.avoid_when, origin: 'invented' })), 'MODEL_OUTPUT_INVALID'],
    [(response) => { response.writeHead(200); response.end('not JSON /private/service/payload'); }, 'MODEL_RESPONSE_INVALID'],
    [(response) => { response.writeHead(200); response.end('x'.repeat(65537)); }, 'MODEL_RESPONSE_INVALID'],
    [(response) => { response.writeHead(200); response.end(JSON.stringify({ choices: [] })); }, 'MODEL_RESPONSE_INVALID'],
    [(response) => { response.writeHead(200); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ avoid_when: values.avoid_when }), tool_calls: [{ id: 'fake-tool' }] }, finish_reason: 'stop' }] })); }, 'MODEL_RESPONSE_INVALID'],
    [(response) => completion(response, JSON.stringify({ avoid_when: values.avoid_when }), null), 'MODEL_RESPONSE_INVALID'],
    [(response) => completion(response, JSON.stringify({ avoid_when: values.avoid_when }), 'content_filter'), 'MODEL_REFUSAL'],
    [(response) => { response.writeHead(200); response.end(JSON.stringify({ choices: [{ message: { role: 'user', content: JSON.stringify({ avoid_when: values.avoid_when }) }, finish_reason: 'stop' }] })); }, 'MODEL_RESPONSE_INVALID'],
    [(response) => { response.writeHead(200); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ avoid_when: values.avoid_when }), tool_calls: {} }, finish_reason: 'stop' }] })); }, 'MODEL_RESPONSE_INVALID'],
    [(response) => { response.writeHead(200); response.end(Buffer.concat([Buffer.from('{"choices":[{"message":{"role":"assistant","content":"'), Buffer.from([0xff]), Buffer.from('"},"finish_reason":"stop"}]}')])); }, 'MODEL_RESPONSE_INVALID'],
  ];
  for (const [respond, code] of cases) {
    const { dbPath } = temporary(t);
    seed(dbPath);
    const service = await fakeModel(t, (request, response) => respond(response));
    const report = await backfillDrafts({ dbPath, fields: ['avoid_when'], generator: createHttpGenerator({ endpoint: service.endpoint, token: service.token }, {}), maxAttempts: 1 });
    assert.deepEqual(report.patches, []);
    assert.equal(report.failures[0].code, code);
    assert.equal(JSON.stringify(report).includes('test-only-token'), false);
    assert.equal(JSON.stringify(report).includes('/private/service/payload'), false);
  }
});

test('HTTP retryable failures are bounded and permanent authentication/redirect failures stop future items', async (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath);
  const retryService = await fakeModel(t, (request, response, body, count) => {
    if (count < 3) { response.writeHead(count === 1 ? 429 : 503); response.end('private raw server payload'); }
    else completion(response, JSON.stringify({ avoid_when: values.avoid_when }));
  });
  const recovered = await backfillDrafts({ dbPath, fields: ['avoid_when'], generator: createHttpGenerator(retryService, {}), retryDelayMs: 0, maxAttempts: 3 });
  assert.equal(retryService.requests.length, 3);
  assert.equal(recovered.patches.length, 1);
  assert.deepEqual(recovered.attempt_failures.map(({ code }) => code), ['MODEL_RATE_LIMIT', 'MODEL_UNAVAILABLE']);
  assert.equal(JSON.stringify(recovered).includes('private raw server payload'), false);
  for (const [status, code] of [[401, 'MODEL_AUTH'], [403, 'MODEL_AUTH'], [400, 'MODEL_REQUEST'], [302, 'MODEL_REDIRECT']]) {
    const fixture = temporary(t);
    seed(fixture.dbPath, [entry('A词', { aliases: [] }), entry('B词', { aliases: [] })]);
    const service = await fakeModel(t, (request, response) => { response.writeHead(status, { Location: '/must-not-follow' }); response.end('Bearer test-only-token /private/auth/path'); });
    const report = await backfillDrafts({ dbPath: fixture.dbPath, fields: ['avoid_when'], generator: createHttpGenerator(service, {}), maxAttempts: 5 });
    assert.equal(service.requests.length, 1);
    assert.equal(report.failures[0].attempts, 1);
    assert.equal(report.failures[0].code, code);
    assert.equal(report.stop_reason, code);
    assert.deepEqual(report.unattempted.map(({ canonical_term }) => canonical_term), ['B词']);
    assert.equal(JSON.stringify(report).includes('/private/auth/path'), false);
    assert.equal(JSON.stringify(report).includes('test-only-token'), false);
  }
});

test('HTTP response reads have deadlines and invalid endpoint/token config fails before requests', async (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath);
  const service = await fakeModel(t, (request, response) => { response.writeHead(200); response.flushHeaders(); });
  const report = await backfillDrafts({ dbPath, fields: ['avoid_when'], generator: createHttpGenerator({ ...service, timeoutMs: 20 }, {}), timeoutMs: 50, maxAttempts: 1 });
  assert.equal(report.failures[0].code, 'MODEL_TIMEOUT');
  assert.deepEqual(report.patches, []);
  for (const config of [null, { endpoint: '', token: 'fake' }, { endpoint: 'http://non-loopback.invalid/chat', token: 'fake' }, { endpoint: service.endpoint, token: '' }, { endpoint: service.endpoint, token: 'fake\u0000invalid-header' }, { endpoint: 'https://fake:credentials@example.invalid/chat', token: 'fake' }]) {
    assert.throws(() => createHttpGenerator(config, {}), failsWith('GENERATOR_CONFIG'));
  }
  assert.equal(service.requests.length, 1);
});

const maintenanceCli = fileURLToPath(new URL('../scripts/maintenance.mjs', import.meta.url));
const exec = promisify(execFile);

async function runCli(args, { cwd, env = {} }) {
  const environment = { ...process.env };
  delete environment.MEME_MAINTENANCE_ENDPOINT;
  delete environment.MEME_MAINTENANCE_TOKEN;
  delete environment.MEME_MAINTENANCE_MODEL;
  Object.assign(environment, env);
  try {
    const result = await exec(process.execPath, ['--no-warnings', maintenanceCli, ...args], { cwd, env: environment, timeout: 10000, maxBuffer: 16777216 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('the real maintenance CLI runs normalized import and readonly inspect from another cwd', async (t) => {
  const { directory, dbPath } = temporary(t);
  const input = join(directory, 'normalized.json');
  writeFileSync(input, JSON.stringify([entry('CLI词', { ...values, aliases: ['CLI别名'] })]));
  const preview = await runCli(['import-preview', '--input', input], { cwd: directory });
  assert.equal(preview.code, 0);
  assert.equal(JSON.parse(preview.stdout).count, 1);
  assert.equal(existsSync(dbPath), false);
  const missing = await runCli(['import-apply', '--input', input, '--db', dbPath], { cwd: directory });
  assert.equal(missing.code, 2);
  assert.equal(missing.stdout, '');
  assert.equal(JSON.parse(missing.stderr).error.code, 'DATABASE_MISSING');
  assert.equal(existsSync(dbPath), false);
  const imported = await runCli(['import-apply', '--input', input, '--db', dbPath, '--create'], { cwd: directory });
  assert.equal(imported.code, 0);
  assert.equal(JSON.parse(imported.stdout).inserted, 1);
  const before = snapshot(dbPath);
  const replay = await runCli(['import-apply', '--input', input, '--db', dbPath], { cwd: directory });
  assert.equal(JSON.parse(replay.stdout).unchanged, 1);
  assert.deepEqual(snapshot(dbPath), before);
  const inspect = await runCli(['inspect', `--db=${dbPath}`], { cwd: directory });
  assert.equal(inspect.code, 0);
  assert.deepEqual(JSON.parse(inspect.stdout).targets, []);
  assert.deepEqual(snapshot(dbPath), before);
  const almaRoot = join(directory, 'alma-config-root');
  const rootDb = join(almaRoot, 'state', 'meme_radar.db');
  seed(rootDb);
  const rootBefore = snapshot(rootDb);
  const rootInspect = await runCli(['inspect', '--alma-home', almaRoot, '--fields', 'avoid_when'], { cwd: directory });
  assert.equal(rootInspect.code, 0);
  assert.equal(JSON.parse(rootInspect.stdout).targets[0].canonical_term, '旧词');
  assert.deepEqual(snapshot(rootDb), rootBefore);
});

test('real CLI draft, explicit approval, patch apply and review are separate portable operations', async (t) => {
  const { directory, dbPath } = temporary(t);
  seed(dbPath);
  const before = snapshot(dbPath);
  const service = await fakeModel(t, (request, response) => completion(response, JSON.stringify({ avoid_when: values.avoid_when })));
  const env = { MEME_MAINTENANCE_ENDPOINT: service.endpoint, MEME_MAINTENANCE_TOKEN: service.token };
  const draftFile = join(directory, 'draft.json');
  const approvedFile = join(directory, 'approved.json');
  const drafted = await runCli(['draft', '--db', dbPath, '--fields', 'avoid_when', '--out', draftFile, '--attempts', '1', '--timeout-ms', '1000'], { cwd: directory, env });
  assert.equal(drafted.code, 0);
  assert.equal(drafted.stderr, '');
  const report = JSON.parse(drafted.stdout);
  assert.equal(report.patches[0].approval, 'pending');
  assert.deepEqual(readMaintenanceJson(draftFile), report);
  assert.deepEqual(snapshot(dbPath), before);
  const refused = await runCli(['patch-apply', '--db', dbPath, '--approved-file', draftFile], { cwd: directory });
  assert.equal(refused.code, 2);
  assert.equal(JSON.parse(refused.stdout).outcomes[0].reason, 'APPROVAL_REQUIRED');
  assert.deepEqual(snapshot(dbPath), before);
  const approved = await runCli(['approve', '--draft-file', draftFile, '--ids', report.patches[0].id, '--out', approvedFile], { cwd: directory });
  assert.equal(approved.code, 0);
  assert.equal(readMaintenanceJson(approvedFile).patches[0].approval, 'approved');
  assert.deepEqual(snapshot(dbPath), before);
  const applied = await runCli(['patch-apply', '--approved-file', approvedFile, '--db', dbPath], { cwd: directory });
  assert.equal(applied.code, 0);
  assert.equal(JSON.parse(applied.stdout).counts.updated, 1);
  const afterPatch = snapshot(dbPath);
  assertMetadataOnly(before, afterPatch, ['avoid_when']);
  const replay = await runCli(['patch-apply', '--approved-file', approvedFile, '--db', dbPath], { cwd: directory });
  assert.equal(replay.code, 0);
  assert.equal(JSON.parse(replay.stdout).counts.unchanged, 1);
  assert.deepEqual(snapshot(dbPath), afterPatch);
  const requests = join(directory, 'review-requests.json');
  const reviewDraft = join(directory, 'review-preview.json');
  const reviewApproved = join(directory, 'review-approved.json');
  writeFileSync(requests, JSON.stringify([{ term: '旧别名', status: 'accepted' }]));
  const preview = await runCli(['review-preview', '--requests', requests, '--db', dbPath, '--out', reviewDraft], { cwd: directory });
  assert.equal(preview.code, 0);
  assert.equal(readMaintenanceJson(reviewDraft).reviews[0].approval, 'pending');
  assert.deepEqual(snapshot(dbPath), afterPatch);
  const reviewRefused = await runCli(['review-apply', '--approved-file', reviewDraft, '--db', dbPath], { cwd: directory });
  assert.equal(reviewRefused.code, 2);
  const reviewApproval = await runCli(['approve', '--draft-file', reviewDraft, '--ids', readMaintenanceJson(reviewDraft).reviews[0].id, '--out', reviewApproved], { cwd: directory });
  assert.equal(reviewApproval.code, 0);
  const reviewApplied = await runCli(['review-apply', '--approved-file', reviewApproved, '--db', dbPath], { cwd: directory });
  assert.equal(reviewApplied.code, 0);
  assert.equal(JSON.parse(reviewApplied.stdout).counts.updated, 1);
  const afterReview = snapshot(dbPath);
  assert.deepEqual(afterReview.data.terms, before.data.terms);
  assert.deepEqual(afterReview.data.watcher_entry_meta, afterPatch.data.watcher_entry_meta);
  const reviewReplay = await runCli(['review-apply', '--approved-file', reviewApproved, '--db', dbPath], { cwd: directory });
  assert.equal(JSON.parse(reviewReplay.stdout).counts.unchanged, 1);
  assert.deepEqual(snapshot(dbPath), afterReview);
  assert.equal(service.requests.length, 1, 'Apply and review commands never call the model.');
});

test('CLI rejects unsafe shortcuts, missing explicit write DBs and reports redacted configuration/input faults', async (t) => {
  const { directory, dbPath } = temporary(t);
  seed(dbPath);
  const before = snapshot(dbPath);
  const output = join(directory, 'not-created.json');
  for (const args of [
    ['draft', '--db', dbPath, '--out', output, '--apply'],
    ['draft', '--out', output], ['patch-apply', '--approved-file', 'fake.json'],
    ['import-apply', '--input', 'fake.json'], ['review-apply', '--approved-file', 'fake.json'],
    ['approve', '--draft-file', 'fake.json', '--out', output, '--all'],
  ]) {
    const result = await runCli(args, { cwd: directory });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(output), false);
    assert.equal(result.stderr.includes(directory), false);
  }
  const configFile = join(directory, 'config-fault.json');
  const configFault = await runCli(['draft', '--db', dbPath, '--fields', 'avoid_when', '--out', configFile], { cwd: directory });
  assert.equal(configFault.code, 2);
  assert.equal(JSON.parse(configFault.stdout).error.code, 'GENERATOR_CONFIG');
  assert.equal(readMaintenanceJson(configFile).unattempted.length, 1);
  const invalidInput = join(directory, 'private-input-name.json');
  writeFileSync(invalidInput, '{"secret-token":"raw broken payload"');
  const fault = await runCli(['import-preview', '--input', invalidInput], { cwd: directory });
  assert.equal(fault.code, 2);
  assert.equal(JSON.parse(fault.stderr).error.code, 'INVALID_JSON_FILE');
  assert.equal(fault.stderr.includes('private-input-name'), false);
  assert.equal(fault.stderr.includes('secret-token'), false);
  assert.deepEqual(snapshot(dbPath), before);
});

test('NFC/case alias rejection in either review table refuses metadata and accepted review', (t) => {
  for (const table of ['term_reviews', 'candidate_reviews']) {
    const { dbPath } = temporary(t);
    seed(dbPath, [entry('Stable', { aliases: ['Café'] })]);
    const approved = patches(dbPath, ['avoid_when']).map(approve);
    database(dbPath, (db) => {
      if (table === 'term_reviews') db.prepare('INSERT INTO term_reviews VALUES (?,?,?,?,?)').run(' CAFÉ ', 'rejected', 150, sourceUrl, 'human');
      else db.prepare('INSERT INTO candidate_reviews VALUES (?,?,?,?,?,?)').run(' CAFÉ ', 'rejected', '人工拒绝，保留别名决定', 150, sourceUrl, 'human');
    });
    const reviews = previewMaintenanceReviews([{ term: 'Stable', status: 'accepted' }], { dbPath }).map(approve);
    const before = snapshot(dbPath);
    assert.deepEqual(maintenanceCandidates({ dbPath }), []);
    assert.equal(applyMaintenancePatches(approved, { dbPath }).outcomes[0].reason, 'IDENTITY_REJECTED');
    assert.equal(applyMaintenanceReviews(reviews, { dbPath }).outcomes[0].reason, 'IDENTITY_REJECTED');
    assert.deepEqual(snapshot(dbPath), before);
  }
});

test('generated metadata columns and corrupt metadata values are faults rather than empty candidates', (t) => {
  for (const invalid of ['generated', 'blob']) {
    const { dbPath } = temporary(t);
    seed(dbPath);
    const approved = patches(dbPath, ['avoid_when']).map(approve);
    database(dbPath, (db) => {
      if (invalid === 'generated') db.exec('ALTER TABLE watcher_entry_meta ADD COLUMN derived TEXT GENERATED ALWAYS AS (usage_context) VIRTUAL');
      else db.prepare('UPDATE watcher_entry_meta SET avoid_when=? WHERE term=?').run(new Uint8Array([0x12]), '旧词');
    });
    const before = snapshot(dbPath);
    assert.throws(() => maintenanceCandidates({ dbPath, limit: 0 }), failsWith('DATABASE_INVALID'));
    assert.equal(applyMaintenancePatches(approved, { dbPath }).error.code, 'DATABASE_INVALID');
    assert.deepEqual(snapshot(dbPath), before);
  }
});

test('a human-receipt string cannot authorize a pending patch', (t) => {
  const { dbPath } = temporary(t);
  seed(dbPath);
  const [record] = patches(dbPath, ['avoid_when']);
  delete record.approval;
  record.human_receipt = 'claimed operator approval';
  const before = snapshot(dbPath);
  const report = applyMaintenancePatches([record], { dbPath });
  assert.deepEqual([report.outcomes[0].status, report.outcomes[0].reason], ['rejected', 'APPROVAL_REQUIRED']);
  assert.deepEqual(snapshot(dbPath), before);
});
