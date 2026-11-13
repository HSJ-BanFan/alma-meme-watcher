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

function withDatabase(dbPath, write, operation) {
  let db;
  let transaction = false;
  try {
    if (!write) {
      try {
        statSync(dbPath);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
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
      db.exec(schema);
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
  const rows = db.prepare(`SELECT t.*, ${reviewColumns}, ${metaColumns} FROM terms t
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

function eligible(entry, now) {
  return ['accepted', 'local_reference'].includes(entry.review_status) && entry.confidence >= 0.7
    && (entry.ttl_days <= 0 || entry.last_seen + entry.ttl_days * 86400 > now);
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

export function lookup(text, { dbPath = defaultDbPath, now = Date.now() / 1000, limit = 3 } = {}) {
  options(dbPath, now);
  if (typeof text !== 'string' || !Number.isInteger(limit) || limit < 0) fail('INVALID_OPTIONS', '查询文本必须是字符串，limit 必须是非负整数。');
  const query = identity(text);
  return withDatabase(dbPath, false, (db) => currentEntries(db)
    .filter((entry) => query && eligible(entry, now))
    .map((entry) => {
      const term = identity(entry.term);
      const aliases = entry.aliases.map(identity);
      const rank = term === query ? 0 : aliases.includes(query) ? 1 : contains(query, term) ? 2 : aliases.some((alias) => contains(query, alias)) ? 3 : 4;
      return { entry, rank };
    })
    .filter((hit) => hit.rank < 4)
    .sort((a, b) => a.rank - b.rank || b.entry.heat - a.entry.heat || b.entry.last_seen - a.entry.last_seen || compare(identity(a.entry.term), identity(b.entry.term)))
    .slice(0, limit)
    .map((hit) => hit.entry)) ?? [];
}

export function radarStatus({ dbPath = defaultDbPath, now = Date.now() / 1000 } = {}) {
  options(dbPath, now);
  const empty = { terms: 0, candidates: 0, eligible: 0, last_sync: null, live_watching: false, audio_transcription: false };
  return withDatabase(dbPath, false, (db) => {
    const tables = tableNames(db);
    const count = (table) => tables.has(table) ? db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n : 0;
    const last = tables.has('watcher_sync_versions')
      ? db.prepare('SELECT source_url,applied_at FROM watcher_sync_versions ORDER BY applied_at DESC,source_url,term,fingerprint LIMIT 1').get() : null;
    return { ...empty, terms: count('terms'), candidates: count('candidates'), eligible: currentEntries(db, tables).filter((entry) => eligible(entry, now)).length, last_sync: last ? { source_url: last.source_url, applied_at: last.applied_at } : null };
  }) ?? empty;
}
