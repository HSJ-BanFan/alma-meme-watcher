import { createHash } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseMemeEntry } from '../compiler/schema.js';

const defaultDbPath = join(homedir(), '.config', 'alma', 'state', 'meme_radar.db');
const identity = (value) => value.normalize('NFC').trim().toLowerCase();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const decodeAliases = (value) => value.split(/[,，;；|/]/u).map((alias) => alias.trim()).filter(Boolean);
const materialFields = ['meaning', 'usage_context', 'avoid_when', 'origin', 'source_url', 'ttl_days', 'confidence', 'published_at'];
const domainCodes = new Set(['INVALID_OPTIONS', 'AMBIGUOUS_IDENTITY', 'CONTENT_CONFLICT', 'UNREPRESENTABLE_ALIAS', 'REVIEW_CONFLICT', 'STALE_VERSION']);

const schema = `
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
create table if not exists watcher_entry_meta (
  term text primary key, usage_context text not null default '',
  avoid_when text not null default '', published_at text
);
create table if not exists watcher_sync_versions (
  term text not null, source_url text not null, fingerprint text not null,
  applied_at real not null, previous_review_json text,
  primary key (term, source_url, fingerprint)
);
`;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function options(dbPath, now) {
  if (typeof dbPath !== 'string' || !dbPath.trim() || typeof now !== 'number' || !Number.isFinite(now) || now < 0) {
    fail('INVALID_OPTIONS', 'dbPath 必须是非空路径，now 必须是非负 Unix 秒数。');
  }
}

function withDatabase(dbPath, write, operation, initialize = true) {
  let db;
  let transaction = false;
  try {
    if (!write || !initialize) {
      try {
        statSync(dbPath);
      } catch (error) {
        if (!write && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
        throw error;
      }
    } else {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    db = new DatabaseSync(dbPath, { readOnly: !write });
    db.exec('PRAGMA busy_timeout = 5000');
    if (write) {
      db.exec('BEGIN IMMEDIATE');
      transaction = true;
      if (initialize) db.exec(schema);
    }
    const result = operation(db);
    if (write) {
      db.exec('COMMIT');
      transaction = false;
    }
    return result;
  } catch (error) {
    if (transaction) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        error = new AggregateError([error, rollbackError], error.message);
      }
    }
    if (domainCodes.has(error.code)) throw error;
    throw Object.assign(new Error(`SQLite 操作失败：${error.message}`, { cause: error }), { code: 'DATABASE_ERROR' });
  } finally {
    db?.close();
  }
}

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
}

function currentEntries(db, tables = tableNames(db)) {
  if (!tables.has('terms')) return [];
  const hasReviews = tables.has('term_reviews');
  const hasMeta = tables.has('watcher_entry_meta');
  const reviewColumns = hasReviews ? 'r.status AS review_status, r.reviewed_at, r.source_url, r.actor AS review_actor' : "'unreviewed_legacy' AS review_status, NULL AS reviewed_at, '' AS source_url, NULL AS review_actor";
  const metaColumns = hasMeta ? 'm.usage_context, m.avoid_when, m.published_at' : "'' AS usage_context, '' AS avoid_when, NULL AS published_at";
  const rows = db.prepare(`SELECT t.term, t.aliases, t.meaning, t.example, t.origin, t.tags,
    t.first_seen, t.last_seen, t.heat, t.confidence, t.ttl_days, t.source, ${reviewColumns}, ${metaColumns} FROM terms t
    ${hasReviews ? 'LEFT JOIN term_reviews r ON r.term=t.term' : ''}
    ${hasMeta ? 'LEFT JOIN watcher_entry_meta m ON m.term=t.term' : ''}`).all();
  return rows.map((row) => ({
    term: row.term,
    aliases: decodeAliases(row.aliases),
    meaning: row.meaning,
    usage_context: row.usage_context ?? '',
    avoid_when: row.avoid_when ?? '',
    origin: row.origin,
    source_url: row.source_url ?? '',
    ttl_days: row.ttl_days,
    confidence: row.confidence,
    ...(row.published_at ? { published_at: row.published_at } : {}),
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    heat: row.heat,
    example: row.example,
    tags: row.tags,
    source: row.source,
    review_status: row.review_status ?? 'unreviewed_legacy',
    reviewed_at: row.reviewed_at ?? null,
    review_actor: row.review_actor ?? null,
  }));
}

function connectedComponents(existing, incoming) {
  const nodes = [...existing.map((entry) => ({ kind: 'existing', entry })), ...incoming.map((entry) => ({ kind: 'incoming', entry }))];
  const parent = nodes.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const byIdentity = new Map();
  nodes.forEach(({ entry }, index) => {
    for (const value of [entry.term, ...entry.aliases]) {
      const key = identity(value);
      if (byIdentity.has(key)) parent[find(index)] = find(byIdentity.get(key));
      else byIdentity.set(key, index);
    }
  });
  const groups = new Map();
  nodes.forEach((node, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, { existing: [], incoming: [] });
    groups.get(root)[node.kind].push(node.entry);
  });
  return [...groups.values()].filter((group) => group.incoming.length);
}

function material(entry) {
  return materialFields.map((field) => typeof entry[field] === 'string' ? entry[field].normalize('NFC') : entry[field] ?? null);
}

function fingerprint(entry, canonical) {
  return createHash('sha256').update(JSON.stringify({
    canonical: identity(canonical),
    term: identity(entry.term),
    aliases: entry.aliases.map(identity).sort(),
    material: material(entry),
  })).digest('hex');
}

const versionKey = (term, source, hash) => JSON.stringify([term, source, hash]);

function mergedAliases(canonical, existing, incoming) {
  const seen = new Set([identity(canonical)]);
  const aliases = [];
  const ordered = [...incoming].sort((a, b) => compare(a.term, b.term));
  for (const alias of [...(existing?.aliases ?? []), ...ordered.flatMap((entry) => [entry.term, ...entry.aliases])]) {
    const key = identity(alias);
    if (seen.has(key)) continue;
    if (/[,，;；|/\r\n\0]/u.test(alias)) fail('UNREPRESENTABLE_ALIAS', `词条拼写 ${alias} 无法安全保存为旧格式别名。`);
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}

function syncPlan(db, incoming) {
  const existing = currentEntries(db);
  const byTerm = new Map(existing.map((entry) => [entry.term, entry]));
  const versions = db.prepare('SELECT term,source_url,fingerprint FROM watcher_sync_versions').all();
  const known = new Set(versions.map((version) => versionKey(version.term, version.source_url, version.fingerprint)));
  for (const version of versions) {
    if (byTerm.has(version.term)) continue;
    if (incoming.some((entry) => [entry.term, ...entry.aliases].some((value) => identity(value) === identity(version.term))
      || (entry.source_url === version.source_url && fingerprint(entry, version.term) === version.fingerprint))) {
      fail('STALE_VERSION', `版本记录的 canonical ${version.term} 已被外部删除，拒绝自动恢复。`);
    }
  }
  const rejected = new Set(db.prepare("SELECT term FROM candidate_reviews WHERE verdict='rejected'").all().map((row) => identity(row.term)));
  const plans = connectedComponents(existing, incoming).map((component) => {
    if (component.existing.length > 1) fail('AMBIGUOUS_IDENTITY', '一个身份连接分量触及多个旧 canonical，整批拒绝。');
    const old = component.existing[0];
    const canonical = old?.term ?? component.incoming.map((entry) => entry.term).sort((a, b) => compare(identity(a), identity(b)) || compare(a, b))[0];
    const entry = component.incoming[0];
    const content = JSON.stringify(material(entry));
    if (component.incoming.some((other) => JSON.stringify(material(other)) !== content)) fail('CONTENT_CONFLICT', `同一身份 ${canonical} 的批内非别名字段冲突。`);
    const aliases = mergedAliases(canonical, old, component.incoming);
    const keys = new Set([canonical, ...aliases].map(identity));
    if ([...keys].some((key) => rejected.has(key))) fail('REVIEW_CONFLICT', `身份 ${canonical} 有人工拒绝记录，不能自动覆盖。`);
    const hashes = [...new Set(component.incoming.map((item) => fingerprint(item, canonical)))];
    const newHashes = hashes.filter((hash) => !known.has(versionKey(canonical, entry.source_url, hash)));
    return { canonical, old, entry, aliases, keys, newHashes, action: newHashes.length ? old ? 'updated' : 'inserted' : 'unchanged' };
  });
  return plans.sort((a, b) => compare(identity(a.canonical), identity(b.canonical)) || compare(a.canonical, b.canonical));
}

export function syncEntries(entries, { dbPath = defaultDbPath, now = Date.now() / 1000 } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) fail('INVALID_BATCH', '同步需要非空 MemeEntry 数组。');
  const incoming = entries.map(parseMemeEntry);
  options(dbPath, now);
  return withDatabase(dbPath, true, (db) => {
    const plans = syncPlan(db, incoming);
    const writeTerm = db.prepare(`INSERT INTO terms
      (term,aliases,meaning,example,origin,tags,first_seen,last_seen,heat,confidence,ttl_days,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(term) DO UPDATE SET
      aliases=excluded.aliases,meaning=excluded.meaning,origin=excluded.origin,last_seen=excluded.last_seen,
      confidence=excluded.confidence,ttl_days=excluded.ttl_days,source=excluded.source`);
    const writeReview = db.prepare(`INSERT INTO term_reviews (term,status,reviewed_at,source_url,actor)
      VALUES (?,?,?,?,?) ON CONFLICT(term) DO UPDATE SET
      status=excluded.status,reviewed_at=excluded.reviewed_at,source_url=excluded.source_url,actor=excluded.actor`);
    const writeMeta = db.prepare(`INSERT INTO watcher_entry_meta (term,usage_context,avoid_when,published_at)
      VALUES (?,?,?,?) ON CONFLICT(term) DO UPDATE SET
      usage_context=excluded.usage_context,avoid_when=excluded.avoid_when,published_at=excluded.published_at`);
    const writeVersion = db.prepare('INSERT INTO watcher_sync_versions (term,source_url,fingerprint,applied_at,previous_review_json) VALUES (?,?,?,?,?)');
    const candidates = db.prepare('SELECT id,term FROM candidates').all();
    const deleteCandidate = db.prepare('DELETE FROM candidates WHERE id=?');
    const report = { inserted: 0, updated: 0, unchanged: 0, entries: [] };
    for (const plan of plans) {
      report[plan.action]++;
      if (plan.action === 'unchanged') continue;
      const { canonical, old, entry, aliases } = plan;
      writeTerm.run(canonical, aliases.join(','), entry.meaning, old?.example ?? '', entry.origin || old?.origin || '', old?.tags ?? '', old?.first_seen ?? now, now, old?.heat ?? 1, entry.confidence, entry.ttl_days, 'meme_watcher');
      writeReview.run(canonical, 'local_reference', now, entry.source_url, 'meme_watcher:machine');
      writeMeta.run(canonical, entry.usage_context || old?.usage_context || '', entry.avoid_when || old?.avoid_when || '', entry.published_at ?? old?.published_at ?? null);
      const previousReview = old?.reviewed_at !== null && old?.reviewed_at !== undefined
        ? JSON.stringify({ status: old.review_status, reviewed_at: old.reviewed_at, source_url: old.source_url, actor: old.review_actor }) : null;
      plan.newHashes.forEach((hash, index) => writeVersion.run(canonical, entry.source_url, hash, now, index === 0 ? previousReview : null));
      for (const candidate of candidates) {
        if (plan.keys.has(identity(candidate.term))) deleteCandidate.run(candidate.id);
      }
    }
    const persisted = new Map(currentEntries(db).map((entry) => [entry.term, entry]));
    report.entries = plans.map((plan) => persisted.get(plan.canonical));
    return report;
  });
}

export function patchAvoidWhen(patches, { dbPath = defaultDbPath, authorizedCanonicalTerms, now = Date.now() / 1000 } = {}) {
  options(dbPath, now);
  if (!Array.isArray(patches) || patches.length === 0 || patches.length > 50) fail('INVALID_BATCH', '禁忌维护每批必须包含 1 至 50 条。');
  if (!Array.isArray(authorizedCanonicalTerms) || authorizedCanonicalTerms.length === 0
    || authorizedCanonicalTerms.some((term) => typeof term !== 'string' || !term.trim())) {
    fail('INVALID_OPTIONS', '禁忌维护必须提供明确授权的 canonical 词条列表。');
  }
  const authorized = new Set(authorizedCanonicalTerms);
  const seen = new Set();
  for (const patch of patches) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)
      || Object.keys(patch).length !== 3 || !['term', 'expectedAvoidWhen', 'avoidWhen'].every((field) => Object.hasOwn(patch, field))
      || typeof patch.term !== 'string' || !patch.term.trim() || patch.term !== patch.term.trim()
      || typeof patch.expectedAvoidWhen !== 'string' || typeof patch.avoidWhen !== 'string' || !patch.avoidWhen.trim()
      || patch.avoidWhen.includes('\0')) fail('INVALID_BATCH', '禁忌维护只接受 term、expectedAvoidWhen 和非空 avoidWhen 字符串。');
    const key = identity(patch.term);
    if (seen.has(key)) fail('INVALID_BATCH', '禁忌维护批次包含重复身份。');
    if (!authorized.has(patch.term)) fail('INVALID_BATCH', `词条 ${patch.term} 未在本批授权列表中。`);
    seen.add(key);
  }
  const inspect = (db, write) => {
    const tables = tableNames(db);
    if (!tables.has('terms') || !tables.has('watcher_entry_meta')) fail('DATABASE_ERROR', '禁忌维护需要已有词条及元数据表。');
    const existing = db.prepare('SELECT term,aliases FROM terms').all().map(({ term, aliases }) => ({ term, aliases: decodeAliases(aliases) }));
    const components = connectedComponents(existing, patches.map(({ term }) => ({ term, aliases: [] })));
    const byTerm = new Map(components.flatMap((component) => component.incoming.map((entry) => [entry.term, component])));
    const readMeta = db.prepare('SELECT avoid_when FROM watcher_entry_meta WHERE term=?');
    const update = write ? db.prepare('UPDATE watcher_entry_meta SET avoid_when=? WHERE term=? AND avoid_when=?') : null;
    return patches.map((patch) => {
      const component = byTerm.get(patch.term);
      const conflict = (reason) => ({ term: patch.term, status: 'conflict', reason });
      if (component.existing.length > 1) return conflict('ambiguous_identity');
      if (component.existing.length === 0) return conflict('missing_term');
      if (component.existing[0].term !== patch.term) return conflict('not_canonical');
      const meta = readMeta.get(patch.term);
      if (!meta) return conflict('missing_metadata');
      if (meta.avoid_when === patch.avoidWhen) return { term: patch.term, status: 'unchanged' };
      if (meta.avoid_when !== patch.expectedAvoidWhen) return conflict('stale_avoid_when');
      if (!write) return { term: patch.term, status: 'pending' };
      if (Number(update.run(patch.avoidWhen, patch.term, patch.expectedAvoidWhen).changes) !== 1) {
        fail('STALE_VERSION', `词条 ${patch.term} 的禁忌维护未能更新唯一预期行。`);
      }
      return { term: patch.term, status: 'updated' };
    });
  };
  const report = (entries) => ({
    updated: entries.filter(({ status }) => status === 'updated').length,
    unchanged: entries.filter(({ status }) => status === 'unchanged').length,
    conflicted: entries.filter(({ status }) => status === 'conflict').length,
    entries,
  });
  const current = withDatabase(dbPath, false, (db) => {
    db.exec('BEGIN');
    try { return inspect(db, false); } finally { db.exec('ROLLBACK'); }
  });
  if (current === null) fail('DATABASE_ERROR', '禁忌维护需要已有数据库，不能自动创建。');
  if (!current.some(({ status }) => status === 'pending')) return report(current);
  return withDatabase(dbPath, true, (db) => report(inspect(db, true)), false);
}

export function patchEntryContent(patches, { dbPath = defaultDbPath, authorizedCanonicalTerms, now = Date.now() / 1000 } = {}) {
  options(dbPath, now);
  if (!Array.isArray(patches) || patches.length === 0 || patches.length > 50) fail('INVALID_BATCH', '内容维护每批必须包含 1 至 50 条。');
  if (!Array.isArray(authorizedCanonicalTerms) || authorizedCanonicalTerms.length === 0
    || authorizedCanonicalTerms.some((term) => typeof term !== 'string' || !term.trim())) {
    fail('INVALID_OPTIONS', '内容维护必须提供明确授权的 canonical 词条列表。');
  }
  const authorized = new Set(authorizedCanonicalTerms);
  const seen = new Set();
  const fields = ['term', 'expectedMeaning', 'expectedOrigin', 'expectedUsageContext', 'meaning', 'origin', 'usageContext'];
  for (const patch of patches) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)
      || Object.keys(patch).length !== fields.length || !fields.every((field) => Object.hasOwn(patch, field))
      || typeof patch.term !== 'string' || !patch.term.trim() || patch.term !== patch.term.trim()
      || fields.slice(1).some((field) => typeof patch[field] !== 'string')
      || !patch.meaning.trim() || !patch.usageContext.trim()
      || [patch.meaning, patch.origin, patch.usageContext].some((value) => value.includes('\0'))) {
      fail('INVALID_BATCH', '内容维护只接受 term、三个期望值和三个新值字符串；释义与适用语境不能为空。');
    }
    const key = identity(patch.term);
    if (seen.has(key)) fail('INVALID_BATCH', '内容维护批次包含重复身份。');
    if (!authorized.has(patch.term)) fail('INVALID_BATCH', `词条 ${patch.term} 未在本批授权列表中。`);
    seen.add(key);
  }
  const inspect = (db, write) => {
    const tables = tableNames(db);
    if (!tables.has('terms') || !tables.has('watcher_entry_meta')) fail('DATABASE_ERROR', '内容维护需要已有词条及元数据表。');
    const existing = db.prepare('SELECT term,aliases FROM terms').all().map(({ term, aliases }) => ({ term, aliases: decodeAliases(aliases) }));
    const components = connectedComponents(existing, patches.map(({ term }) => ({ term, aliases: [] })));
    const byTerm = new Map(components.flatMap((component) => component.incoming.map((entry) => [entry.term, component])));
    const readTerm = db.prepare('SELECT meaning,origin FROM terms WHERE term=?');
    const readMeta = db.prepare('SELECT usage_context FROM watcher_entry_meta WHERE term=?');
    const updateTerm = write ? db.prepare('UPDATE terms SET meaning=?, origin=? WHERE term=? AND meaning=? AND origin=?') : null;
    const updateMeta = write ? db.prepare('UPDATE watcher_entry_meta SET usage_context=? WHERE term=? AND usage_context=?') : null;
    return patches.map((patch) => {
      const component = byTerm.get(patch.term);
      const conflict = (reason) => ({ term: patch.term, status: 'conflict', reason });
      if (component.existing.length > 1) return conflict('ambiguous_identity');
      if (component.existing.length === 0) return conflict('missing_term');
      if (component.existing[0].term !== patch.term) return conflict('not_canonical');
      const term = readTerm.get(patch.term);
      const meta = readMeta.get(patch.term);
      if (!term || !meta) return conflict('missing_metadata');
      if (term.meaning === patch.meaning && term.origin === patch.origin && meta.usage_context === patch.usageContext) return { term: patch.term, status: 'unchanged' };
      if (term.meaning !== patch.expectedMeaning || term.origin !== patch.expectedOrigin || meta.usage_context !== patch.expectedUsageContext) return conflict('stale_content');
      if (!write) return { term: patch.term, status: 'pending' };
      if (term.meaning !== patch.meaning || term.origin !== patch.origin) {
        if (Number(updateTerm.run(patch.meaning, patch.origin, patch.term, patch.expectedMeaning, patch.expectedOrigin).changes) !== 1) {
          fail('STALE_VERSION', `词条 ${patch.term} 的内容维护未能更新唯一预期行。`);
        }
      }
      if (meta.usage_context !== patch.usageContext) {
        if (Number(updateMeta.run(patch.usageContext, patch.term, patch.expectedUsageContext).changes) !== 1) {
          fail('STALE_VERSION', `词条 ${patch.term} 的适用语境维护未能更新唯一预期行。`);
        }
      }
      return { term: patch.term, status: 'updated' };
    });
  };
  const report = (entries) => ({
    updated: entries.filter(({ status }) => status === 'updated').length,
    unchanged: entries.filter(({ status }) => status === 'unchanged').length,
    conflicted: entries.filter(({ status }) => status === 'conflict').length,
    entries,
  });
  const current = withDatabase(dbPath, false, (db) => {
    db.exec('BEGIN');
    try { return inspect(db, false); } finally { db.exec('ROLLBACK'); }
  });
  if (current === null) fail('DATABASE_ERROR', '内容维护需要已有数据库，不能自动创建。');
  if (!current.some(({ status }) => status === 'pending')) return report(current);
  return withDatabase(dbPath, true, (db) => report(inspect(db, true)), false);
}

export function attachEntryMetadata(records, { dbPath = defaultDbPath, authorizedCanonicalTerms, now = Date.now() / 1000 } = {}) {
  options(dbPath, now);
  if (!Array.isArray(records) || records.length === 0 || records.length > 50) fail('INVALID_BATCH', '元数据补齐每批必须包含 1 至 50 条。');
  if (!Array.isArray(authorizedCanonicalTerms) || authorizedCanonicalTerms.length === 0
    || authorizedCanonicalTerms.some((term) => typeof term !== 'string' || !term.trim())) {
    fail('INVALID_OPTIONS', '元数据补齐必须提供明确授权的 canonical 词条列表。');
  }
  const authorized = new Set(authorizedCanonicalTerms);
  const seen = new Set();
  const fields = ['term', 'usageContext', 'avoidWhen'];
  for (const record of records) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).length !== fields.length || !fields.every((field) => Object.hasOwn(record, field))
      || typeof record.term !== 'string' || !record.term.trim() || record.term !== record.term.trim()
      || typeof record.usageContext !== 'string' || typeof record.avoidWhen !== 'string'
      || !record.usageContext.trim() || !record.avoidWhen.trim()
      || record.usageContext.includes('\0') || record.avoidWhen.includes('\0')) {
      fail('INVALID_BATCH', '元数据补齐只接受 term、非空 usageContext 和非空 avoidWhen 字符串。');
    }
    const key = identity(record.term);
    if (seen.has(key)) fail('INVALID_BATCH', '元数据补齐批次包含重复身份。');
    if (!authorized.has(record.term)) fail('INVALID_BATCH', `词条 ${record.term} 未在本批授权列表中。`);
    seen.add(key);
  }
  const inspect = (db, write) => {
    const tables = tableNames(db);
    if (!tables.has('terms') || !tables.has('watcher_entry_meta')) fail('DATABASE_ERROR', '元数据补齐需要已有词条及元数据表。');
    const existing = db.prepare('SELECT term,aliases FROM terms').all().map(({ term, aliases }) => ({ term, aliases: decodeAliases(aliases) }));
    const components = connectedComponents(existing, records.map(({ term }) => ({ term, aliases: [] })));
    const byTerm = new Map(components.flatMap((component) => component.incoming.map((entry) => [entry.term, component])));
    const readMeta = db.prepare('SELECT usage_context,avoid_when FROM watcher_entry_meta WHERE term=?');
    const insert = write ? db.prepare('INSERT INTO watcher_entry_meta (term,usage_context,avoid_when,published_at) VALUES (?,?,?,NULL)') : null;
    return records.map((record) => {
      const component = byTerm.get(record.term);
      const conflict = (reason) => ({ term: record.term, status: 'conflict', reason });
      if (component.existing.length > 1) return conflict('ambiguous_identity');
      if (component.existing.length === 0) return conflict('missing_term');
      if (component.existing[0].term !== record.term) return conflict('not_canonical');
      const meta = readMeta.get(record.term);
      if (meta) {
        return meta.usage_context === record.usageContext && meta.avoid_when === record.avoidWhen
          ? { term: record.term, status: 'unchanged' }
          : conflict('existing_metadata');
      }
      if (!write) return { term: record.term, status: 'pending' };
      if (Number(insert.run(record.term, record.usageContext, record.avoidWhen).changes) !== 1) {
        fail('STALE_VERSION', `词条 ${record.term} 的元数据补齐未能插入唯一行。`);
      }
      return { term: record.term, status: 'inserted' };
    });
  };
  const report = (entries) => ({
    inserted: entries.filter(({ status }) => status === 'inserted').length,
    unchanged: entries.filter(({ status }) => status === 'unchanged').length,
    conflicted: entries.filter(({ status }) => status === 'conflict').length,
    entries,
  });
  const current = withDatabase(dbPath, false, (db) => {
    db.exec('BEGIN');
    try { return inspect(db, false); } finally { db.exec('ROLLBACK'); }
  });
  if (current === null) fail('DATABASE_ERROR', '元数据补齐需要已有数据库，不能自动创建。');
  if (!current.some(({ status }) => status === 'pending')) return report(current);
  return withDatabase(dbPath, true, (db) => report(inspect(db, true)), false);
}

function eligibility(entry, now) {
  if (!['accepted', 'local_reference'].includes(entry.review_status) || !(entry.confidence >= 0.7)) return null;
  if (entry.ttl_days <= 0) return { days_left: null };
  const remaining = entry.last_seen + entry.ttl_days * 86400 - now;
  return remaining > 0 ? { days_left: Math.ceil(remaining / 86400) } : null;
}

function contains(text, key) {
  let start = text.indexOf(key);
  const asciiWord = (character) => character !== undefined && /[a-z0-9_]/.test(character);
  while (start !== -1) {
    const end = start + key.length;
    if ((!asciiWord(key[0]) || !asciiWord(text[start - 1]))
      && (!asciiWord(key.at(-1)) || !asciiWord(text[end]))) return true;
    start = text.indexOf(key, start + 1);
  }
  return false;
}

function matchKeys(entry, query) {
  const seen = new Set();
  const matched_keys = [];
  let rank = null;
  for (const [index, value] of [entry.term, ...entry.aliases].entries()) {
    const key = identity(value);
    if (seen.has(key)) continue;
    seen.add(key);
    const exact = key === query;
    if (!exact && !contains(query, key)) continue;
    matched_keys.push(value);
    const keyRank = index === 0 ? exact ? 0 : 2 : exact ? 1 : 3;
    rank = rank === null ? keyRank : Math.min(rank, keyRank);
  }
  return rank === null ? null : { rank, matched_keys };
}

function selectHits(entries, text, now, limit) {
  const query = identity(text);
  if (!query || limit === 0) return [];
  const hits = [];
  for (const entry of entries) {
    const lifetime = eligibility(entry, now);
    if (lifetime === null) continue;
    const match = matchKeys(entry, query);
    if (match !== null) hits.push({ entry, ...match, days_left: lifetime.days_left });
  }
  return hits
    .sort((a, b) => a.rank - b.rank || b.entry.heat - a.entry.heat || b.entry.last_seen - a.entry.last_seen || compare(identity(a.entry.term), identity(b.entry.term)))
    .slice(0, limit);
}

function validateReadEntry(entry) {
  const strings = ['term', 'meaning', 'usage_context', 'avoid_when', 'origin', 'source_url', 'review_status'];
  const numbers = ['confidence', 'ttl_days', 'last_seen', 'heat'];
  if (strings.some((field) => typeof entry[field] !== 'string')
    || !Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== 'string')
    || numbers.some((field) => typeof entry[field] !== 'number' || !Number.isFinite(entry[field]))) {
    fail('DATABASE_ERROR', '词库包含无法读取的词条字段。');
  }
}

function projectCard({ entry, matched_keys, days_left }) {
  if (days_left !== null && (!Number.isInteger(days_left) || days_left <= 0)) {
    fail('DATABASE_ERROR', '词库包含无法读取的词条有效期。');
  }
  return {
    term: entry.term,
    meaning: entry.meaning,
    usage_context: entry.usage_context,
    avoid_when: entry.avoid_when,
    origin: entry.origin,
    source_url: entry.source_url,
    aliases: entry.aliases,
    matched_keys,
    confidence: entry.confidence,
    days_left,
  };
}

export function lookupCards(text, { dbPath = defaultDbPath, now = Date.now() / 1000, limit = 3 } = {}) {
  options(dbPath, now);
  if (typeof text !== 'string' || !Number.isSafeInteger(limit) || limit < 0) fail('INVALID_OPTIONS', '查询文本必须是字符串，limit 必须是非负安全整数。');
  const cards = withDatabase(dbPath, false, (db) => {
    db.exec('BEGIN');
    try {
      const tables = tableNames(db);
      if (!tables.has('terms')) fail('DATABASE_ERROR', '词库缺少 terms 表。');
      const entries = currentEntries(db, tables);
      entries.forEach(validateReadEntry);
      return selectHits(entries, text, now, limit).map(projectCard);
    } finally {
      db.exec('ROLLBACK');
    }
  });
  if (cards === null) fail('DATABASE_UNAVAILABLE', '词库不可用。');
  return cards;
}

export function lookup(text, { dbPath = defaultDbPath, now = Date.now() / 1000, limit = 3 } = {}) {
  options(dbPath, now);
  if (typeof text !== 'string' || !Number.isInteger(limit) || limit < 0) fail('INVALID_OPTIONS', '查询文本必须是字符串，limit 必须是非负整数。');
  return withDatabase(dbPath, false, (db) => selectHits(currentEntries(db), text, now, limit).map((hit) => hit.entry)) ?? [];
}

export function radarStatus({ dbPath = defaultDbPath, now = Date.now() / 1000 } = {}) {
  options(dbPath, now);
  const empty = { terms: 0, candidates: 0, eligible: 0, last_sync: null, live_watching: false, audio_transcription: false };
  return withDatabase(dbPath, false, (db) => {
    const tables = tableNames(db);
    const count = (table) => tables.has(table) ? db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n : 0;
    const last = tables.has('watcher_sync_versions')
      ? db.prepare('SELECT source_url,applied_at FROM watcher_sync_versions ORDER BY applied_at DESC,source_url,term,fingerprint LIMIT 1').get() : null;
    return { ...empty, terms: count('terms'), candidates: count('candidates'), eligible: currentEntries(db, tables).filter((entry) => eligibility(entry, now) !== null).length, last_sync: last ? { source_url: last.source_url, applied_at: last.applied_at } : null };
  }) ?? empty;
}
