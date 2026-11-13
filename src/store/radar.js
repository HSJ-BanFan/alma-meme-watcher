import { createHash } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseMemeEntry } from '../compiler/schema.js';
import {
  draftReview, maintenanceDigest, maintenanceFields, maintenanceReport,
  parseMaintenanceFields, parseMaintenancePatch, parseMaintenanceReview, targetDigest,
} from '../maintenance/model.js';

const defaultDbPath = join(homedir(), '.config', 'alma', 'state', 'meme_radar.db');
const identity = (value) => value.normalize('NFC').trim().toLowerCase();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const decodeAliases = (value) => value.split(/[,，;；|/]/u).map((alias) => alias.trim()).filter(Boolean);
const materialFields = ['meaning', 'usage_context', 'avoid_when', 'origin', 'source_url', 'ttl_days', 'confidence', 'published_at'];
const domainCodes = new Set(['INVALID_OPTIONS', 'AMBIGUOUS_IDENTITY', 'CONTENT_CONFLICT', 'UNREPRESENTABLE_ALIAS', 'REVIEW_CONFLICT', 'STALE_VERSION', 'DATABASE_MISSING', 'DATABASE_INVALID', 'DATABASE_BUSY', 'INVALID_REVIEW', 'TERM_NOT_FOUND']);
const metadataSchema = `create table if not exists watcher_entry_meta (
  term text primary key, usage_context text not null default '',
  avoid_when text not null default '', published_at text
);`;

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
${metadataSchema}
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

function withDatabase(dbPath, write, operation, { initialize = true, mustExist = false, busyTimeout = 5000 } = {}) {
  let db;
  let transaction = false;
  try {
    if (!write || mustExist) {
      try {
        const file = statSync(dbPath);
        if (mustExist && (!file.isFile() || !file.size)) fail('DATABASE_INVALID', 'The maintenance database must be a nonempty SQLite file.');
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
          if (mustExist) fail('DATABASE_MISSING', 'The maintenance database does not exist.');
          return null;
        }
        throw error;
      }
    } else {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    const path = write && mustExist ? `${pathToFileURL(dbPath).href}?mode=rw` : dbPath;
    db = new DatabaseSync(path, { readOnly: !write });
    db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
    if (write || mustExist) {
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      transaction = true;
      if (write && initialize) db.exec(schema);
    }
    const result = operation(db);
    if (transaction) {
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
    if (mustExist) {
      const cause = error instanceof AggregateError ? error.errors[0] : error;
      if (cause.errcode === 5 || cause.errcode === 6) fail('DATABASE_BUSY', 'The maintenance database is busy; retry after its writer is idle.');
      fail('DATABASE_ERROR', 'The maintenance database operation failed and no transaction was committed.');
    }
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
  return syncParsedEntries(incoming, dbPath, now);
}

function syncParsedEntries(incoming, dbPath, now, databaseOptions) {
  return withDatabase(dbPath, true, (db) => {
    if (databaseOptions?.mustExist) {
      maintenanceState(db);
      db.exec(schema);
    }
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
  }, databaseOptions);
}

export function syncMaintenanceEntries(entries, { dbPath, now = Date.now() / 1000, create = false } = {}) {
  options(dbPath, now);
  if (typeof create !== 'boolean' || !Array.isArray(entries) || !entries.length || entries.length > 1000) fail('INVALID_OPTIONS', 'Normalized import needs entries, an explicit database and a boolean create option.');
  const incoming = entries.map(parseMemeEntry);
  if (incoming.some((entry) => !entry.usage_context || !entry.avoid_when)) fail('INVALID_OPTIONS', 'Normalized import requires nonempty usage_context and avoid_when.');
  if (create) {
    try {
      statSync(dbPath);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return syncEntries(incoming, { dbPath, now });
      fail('DATABASE_ERROR', 'The import database could not be inspected.');
    }
  }
  return syncParsedEntries(incoming, dbPath, now, maintenanceDbOptions);
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

const maintenanceDbOptions = { initialize: false, mustExist: true, busyTimeout: 250 };
const maintenanceColumns = {
  terms: ['term', 'aliases', 'meaning', 'example', 'origin', 'tags', 'first_seen', 'last_seen', 'heat', 'confidence', 'ttl_days', 'source'],
  term_reviews: ['term', 'status', 'reviewed_at', 'source_url', 'actor'],
  candidate_reviews: ['term', 'verdict', 'reason', 'reviewed_at', 'source_url', 'actor'],
  watcher_entry_meta: ['term', ...maintenanceFields, 'published_at'],
};
const standardMetadataDescription = [
  { name: 'term', type: 'text', notnull: 0, default: null, pk: 1, hidden: 0 },
  { name: 'usage_context', type: 'text', notnull: 1, default: "''", pk: 0, hidden: 0 },
  { name: 'avoid_when', type: 'text', notnull: 1, default: "''", pk: 0, hidden: 0 },
  { name: 'published_at', type: 'text', notnull: 0, default: null, pk: 0, hidden: 0 },
];
const standardMetadataDigest = maintenanceDigest(standardMetadataDescription);
const quoteColumn = (name) => `"${name.replaceAll('"', '""')}"`;
const snapshotValue = (value) => value instanceof Uint8Array ? { sqlite_blob: Buffer.from(value).toString('hex') } : value;
const sqliteValue = (value) => value && typeof value === 'object' && Object.hasOwn(value, 'sqlite_blob') ? Buffer.from(value.sqlite_blob, 'hex') : value;
const snapshotRow = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, snapshotValue(value)]));
const rowsEqual = (a, b) => maintenanceDigest(a) === maintenanceDigest(b);
const identityKeys = (term) => new Set([term.term, ...decodeAliases(term.aliases)].map(identity));
const isRejected = (value) => value.trim().toLowerCase() === 'rejected';
const maintenanceRows = (db, table) => db.prepare(`SELECT * FROM ${table}`).all().map(snapshotRow).sort((a, b) => compare(a.term, b.term));

function maintenanceState(db) {
  const tables = tableNames(db);
  let metadataDescription = null;
  for (const [table, columns] of Object.entries(maintenanceColumns)) {
    if (table === 'watcher_entry_meta' && !tables.has(table)) continue;
    if (!tables.has(table)) fail('DATABASE_INVALID', 'The database is missing required maintenance tables.');
    const info = db.prepare(`PRAGMA table_xinfo(${table})`).all();
    if (columns.some((column) => !info.some((row) => row.name === column))
      || info.find((row) => row.name === 'term')?.pk !== 1 || info.some((row) => row.pk > 1)) {
      fail('DATABASE_INVALID', 'The database has an invalid maintenance table layout.');
    }
    if (table === 'watcher_entry_meta') {
      if (info.some((row) => row.hidden)) fail('DATABASE_INVALID', 'Generated metadata columns are not supported by maintenance.');
      metadataDescription = info.map((row) => ({ name: row.name, type: row.type.toLowerCase(), notnull: row.notnull, default: row.dflt_value, pk: row.pk, hidden: row.hidden }));
    }
  }
  const integrity = db.prepare('PRAGMA quick_check(1)').get();
  if (Object.values(integrity)[0] !== 'ok') fail('DATABASE_INVALID', 'The maintenance database failed its integrity check.');
  const terms = maintenanceRows(db, 'terms');
  const termReviews = maintenanceRows(db, 'term_reviews');
  const candidateReviews = maintenanceRows(db, 'candidate_reviews');
  const metadata = tables.has('watcher_entry_meta') ? maintenanceRows(db, 'watcher_entry_meta') : [];
  for (const term of terms) {
    if (['term', 'aliases', 'meaning', 'example', 'origin', 'tags', 'source'].some((field) => typeof term[field] !== 'string')
      || !term.term.trim() || !term.meaning.trim()
      || ['first_seen', 'last_seen', 'heat', 'confidence', 'ttl_days'].some((field) => typeof term[field] !== 'number' || !Number.isFinite(term[field]))) {
      fail('DATABASE_INVALID', 'The database contains invalid term material.');
    }
  }
  for (const [rows, verdict] of [[termReviews, 'status'], [candidateReviews, 'verdict']]) {
    for (const row of rows) {
      if (typeof row.term !== 'string' || typeof row[verdict] !== 'string'
        || typeof row.source_url !== 'string' || typeof row.actor !== 'string'
        || typeof row.reviewed_at !== 'number' || !Number.isFinite(row.reviewed_at)) {
        fail('DATABASE_INVALID', 'The database contains invalid review material.');
      }
    }
  }
  for (const row of metadata) {
    if (typeof row.term !== 'string' || maintenanceFields.some((field) => typeof row[field] !== 'string')
      || (row.published_at !== null && typeof row.published_at !== 'string')) {
      fail('DATABASE_INVALID', 'The database contains invalid metadata.');
    }
  }
  const template = metadataDescription
    ? Object.fromEntries(metadataDescription.map((column) => [column.name, snapshotValue(db.prepare(`SELECT ${column.default ?? 'NULL'} AS value`).get().value)]))
    : { term: null, usage_context: '', avoid_when: '', published_at: null };
  if (maintenanceFields.some((field) => typeof template[field] !== 'string')) {
    fail('DATABASE_INVALID', 'Empty metadata rows need text defaults for the maintained fields.');
  }
  const owners = new Map();
  for (const term of terms) {
    for (const key of identityKeys(term)) {
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(term.term);
    }
  }
  return {
    terms, termReviews, candidateReviews, owners, template,
    termsByName: new Map(terms.map((term) => [term.term, term])),
    metadataByName: new Map(metadata.map((row) => [row.term, row])),
    metadataSchema: metadataDescription ? maintenanceDigest(metadataDescription) : null,
    rejected: new Set([...termReviews.filter((row) => isRejected(row.status)), ...candidateReviews.filter((row) => isRejected(row.verdict))].map((row) => identity(row.term))),
  };
}

function relatedReviews(rows, keys) {
  return rows.filter((row) => keys.has(identity(row.term)));
}

function maintenanceTarget(state, term, fields) {
  const keys = identityKeys(term);
  const metadata = state.metadataByName.get(term.term) ?? null;
  const template = metadata ?? { ...state.template, term: term.term };
  const review = state.termReviews.find((row) => row.term === term.term);
  const target = {
    version: 1,
    canonical_term: term.term,
    source: { kind: term.source, url: review?.source_url ?? '' },
    review_status: review?.status ?? 'unreviewed_legacy',
    evidence: { meaning: term.meaning, origin: term.origin, example: term.example, tags: term.tags, aliases: decodeAliases(term.aliases), published_at: template.published_at },
    expected: {
      term, metadata, metadata_template: template, metadata_schema: state.metadataSchema,
      term_reviews: relatedReviews(state.termReviews, keys), candidate_reviews: relatedReviews(state.candidateReviews, keys),
    },
    fields,
  };
  return { ...target, digest: targetDigest(target) };
}

export function maintenanceCandidates({ dbPath = defaultDbPath, fields = maintenanceFields, source, limit = 50 } = {}) {
  options(dbPath, 0);
  const selected = parseMaintenanceFields(fields);
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000 || (source !== undefined && (typeof source !== 'string' || !source.trim()))) {
    fail('INVALID_OPTIONS', 'limit must be an integer in 0..1000 and source must be a nonempty source kind.');
  }
  return withDatabase(dbPath, false, (db) => {
    const state = maintenanceState(db);
    const targets = [];
    for (const term of [...state.terms].sort((a, b) => compare(identity(a.term), identity(b.term)) || compare(a.term, b.term))) {
      if (source !== undefined && term.source !== source) continue;
      const keys = identityKeys(term);
      if ([...keys].some((key) => state.rejected.has(key))) continue;
      const metadata = state.metadataByName.get(term.term) ?? state.template;
      const emptyFields = selected.filter((field) => !metadata[field].trim());
      if (!emptyFields.length) continue;
      if ([...keys].some((key) => state.owners.get(key).size > 1)) fail('AMBIGUOUS_IDENTITY', 'Maintenance selection found an ambiguous canonical identity.');
      targets.push(maintenanceTarget(state, term, emptyFields));
    }
    return targets.slice(0, limit);
  }, maintenanceDbOptions);
}

export function previewMaintenanceReviews(requests, { dbPath } = {}) {
  options(dbPath, 0);
  if (!Array.isArray(requests) || !requests.length || requests.length > 1000
    || requests.some((request) => !request || typeof request.term !== 'string' || !request.term.trim() || !['accepted', 'rejected'].includes(request.status))) {
    fail('INVALID_REVIEW', 'Review preview needs term/status records with accepted or rejected status.');
  }
  return withDatabase(dbPath, false, (db) => {
    const state = maintenanceState(db);
    return requests.map((request) => {
      const owners = state.owners.get(identity(request.term));
      if (!owners?.size) fail('TERM_NOT_FOUND', 'A requested review term no longer exists.');
      if (owners.size !== 1) fail('AMBIGUOUS_IDENTITY', 'The requested review identity is ambiguous.');
      const term = state.termsByName.get([...owners][0]);
      return draftReview(maintenanceTarget(state, term, []), request.status);
    });
  }, maintenanceDbOptions);
}

function maintenanceConflict(state, target, reviewStatus) {
  const term = state.termsByName.get(target.canonical_term);
  if (!term) return { status: 'deleted', reason: 'TERM_DELETED' };
  const keys = new Set([...identityKeys(term), ...identityKeys(target.expected.term)]);
  const wasRejected = target.expected.term_reviews.some((row) => isRejected(row.status)) || target.expected.candidate_reviews.some((row) => isRejected(row.verdict));
  if (reviewStatus !== 'rejected' && (wasRejected || [...keys].some((key) => state.rejected.has(key)))) {
    return { status: 'rejected', reason: 'IDENTITY_REJECTED' };
  }
  if ([...identityKeys(term)].some((key) => state.owners.get(key).size !== 1)) return { status: 'conflict', reason: 'IDENTITY_CHANGED' };
  const review = state.termReviews.find((row) => row.term === term.term);
  if (term.source !== target.source.kind || (review?.source_url ?? '') !== target.source.url) return { status: 'conflict', reason: 'SOURCE_CHANGED' };
  if (term.meaning !== target.evidence.meaning) return { status: 'conflict', reason: 'MEANING_CHANGED' };
  if (!rowsEqual(term, target.expected.term)) return { status: 'conflict', reason: 'MATERIAL_CHANGED' };
  if (!review || !target.source.url.trim()) return { status: 'failed', reason: 'EVIDENCE_MISSING' };
  let expectedReviews = target.expected.term_reviews;
  if (reviewStatus && review.status === reviewStatus && review.actor === 'maintenance:operator') {
    expectedReviews = expectedReviews.map((row) => row.term === term.term ? { ...row, status: reviewStatus, reviewed_at: review.reviewed_at, actor: 'maintenance:operator' } : row);
  }
  if (!rowsEqual(relatedReviews(state.termReviews, keys), expectedReviews)) return { status: 'conflict', reason: 'REVIEW_CHANGED' };
  if (!rowsEqual(relatedReviews(state.candidateReviews, keys), target.expected.candidate_reviews)) return { status: 'conflict', reason: 'EVIDENCE_CHANGED' };
  if (state.metadataSchema !== target.expected.metadata_schema
    && !(target.expected.metadata_schema === null && state.metadataSchema === standardMetadataDigest)) {
    return { status: 'conflict', reason: 'METADATA_SCHEMA_CHANGED' };
  }
  if (reviewStatus && !rowsEqual(state.metadataByName.get(term.term) ?? null, target.expected.metadata)) {
    return { status: 'conflict', reason: 'METADATA_CHANGED' };
  }
  return null;
}

function maintenanceOutcome(record, index, status, reason) {
  return {
    index,
    ...(typeof record?.id === 'string' && /^[a-f0-9]{64}$/.test(record.id) ? { id: record.id } : {}),
    ...(typeof record?.target?.canonical_term === 'string' ? { canonical_term: record.target.canonical_term } : {}),
    ...(maintenanceFields.includes(record?.field) ? { field: record.field } : {}),
    status, reason,
  };
}

function maintenanceRecords(records, parse, invalidCode) {
  if (!Array.isArray(records) || records.length > 1000) fail('INVALID_OPTIONS', 'Maintenance apply needs an array of at most 1000 records.');
  return records.map((record, index) => {
    try {
      return { record: parse(record), index };
    } catch (error) {
      const reason = ['APPROVAL_REQUIRED', 'APPROVAL_REJECTED', 'INVALID_TARGET', 'INVALID_CONTENT', invalidCode].includes(error.code) ? error.code : invalidCode;
      return { index, outcome: maintenanceOutcome(record, index, reason.startsWith('APPROVAL_') ? 'rejected' : 'failed', reason) };
    }
  });
}

function maintenanceGroups(prepared) {
  const groups = new Map();
  for (const item of prepared) {
    if (!item.record) continue;
    const term = item.record.target.canonical_term;
    if (!groups.has(term)) groups.set(term, []);
    groups.get(term).push(item);
  }
  return [...groups.values()];
}

function assertMaintenanceRows(db, state, metadata, termReviews = state.termReviews) {
  const sortedMeta = [...metadata.values()].sort((a, b) => compare(a.term, b.term));
  if (!rowsEqual(maintenanceRows(db, 'terms'), state.terms)
    || !rowsEqual(maintenanceRows(db, 'term_reviews'), termReviews)
    || !rowsEqual(maintenanceRows(db, 'candidate_reviews'), state.candidateReviews)
    || !rowsEqual(maintenanceRows(db, 'watcher_entry_meta'), sortedMeta)) {
    fail('DATABASE_ERROR', 'A database trigger changed protected maintenance material.');
  }
}

function maintenanceFailure(prepared, error) {
  const code = ['DATABASE_MISSING', 'DATABASE_INVALID', 'DATABASE_BUSY'].includes(error.code) ? error.code : 'DATABASE_ERROR';
  const reason = code === 'DATABASE_ERROR' ? 'TRANSACTION_ROLLED_BACK' : code;
  const messages = {
    DATABASE_MISSING: 'The maintenance database does not exist.',
    DATABASE_INVALID: 'The maintenance database is invalid.',
    DATABASE_BUSY: 'The maintenance database is busy; no changes were committed.',
    DATABASE_ERROR: 'The maintenance transaction failed; no changes were committed.',
  };
  return maintenanceReport(prepared.map((item) => item.outcome ?? maintenanceOutcome(item.record, item.index, 'failed', reason)), { code, message: messages[code] });
}

export function applyMaintenancePatches(patches, { dbPath, now = Date.now() / 1000 } = {}) {
  options(dbPath, now);
  const prepared = maintenanceRecords(patches, parseMaintenancePatch, 'INVALID_PATCH');
  try {
    return withDatabase(dbPath, true, (db) => {
      const state = maintenanceState(db);
      const outcomes = prepared.map((item) => item.outcome);
      const updates = [];
      for (const group of maintenanceGroups(prepared)) {
        const target = group[0].record.target;
        const values = new Map();
        let batchConflict = group.some((item) => item.record.target.digest !== target.digest) ? 'BATCH_SNAPSHOT_CONFLICT' : null;
        for (const { record } of group) {
          if (values.has(record.field) && values.get(record.field) !== record.value) batchConflict = 'BATCH_VALUE_CONFLICT';
          values.set(record.field, record.value);
        }
        const conflict = batchConflict ? { status: 'conflict', reason: batchConflict } : maintenanceConflict(state, target);
        const metadata = state.metadataByName.get(target.canonical_term);
        const expected = target.expected.metadata ?? target.expected.metadata_template;
        const projected = { ...expected };
        for (const [field, value] of values) {
          if (metadata?.[field] === value) projected[field] = value;
        }
        const metadataMatches = metadata ? rowsEqual(metadata, projected)
          && (target.expected.metadata !== null || [...values].some(([field, value]) => metadata[field] === value)) : target.expected.metadata === null;
        const seen = new Set();
        for (const item of group) {
          const { record, index } = item;
          let result = conflict;
          if (!result && metadata?.[record.field].trim() && metadata[record.field] !== record.value) result = { status: 'conflict', reason: 'FIELD_NOT_EMPTY' };
          if (!result && !metadataMatches) result = { status: 'conflict', reason: 'METADATA_CHANGED' };
          if (!result && metadata?.[record.field] === record.value) result = { status: 'unchanged', reason: 'ALREADY_APPLIED' };
          if (!result && seen.has(record.field)) result = { status: 'unchanged', reason: 'DUPLICATE_PATCH' };
          if (!result) {
            result = { status: 'updated', reason: 'FIELD_FILLED' };
            updates.push(record);
          }
          seen.add(record.field);
          outcomes[index] = maintenanceOutcome(record, index, result.status, result.reason);
        }
      }
      if (updates.length) {
        if (state.metadataSchema === null) db.exec(metadataSchema);
        const expectedMetadata = new Map(state.metadataByName);
        for (const record of updates) {
          const term = record.target.canonical_term;
          const row = expectedMetadata.get(term);
          let changes;
          if (row) {
            changes = db.prepare(`UPDATE watcher_entry_meta SET ${record.field}=? WHERE term=? AND ${record.field}=? AND EXISTS (SELECT 1 FROM terms WHERE term=?)`)
              .run(record.value, term, row[record.field], term).changes;
            expectedMetadata.set(term, { ...row, [record.field]: record.value });
          } else {
            const inserted = { ...record.target.expected.metadata_template, [record.field]: record.value };
            const columns = Object.keys(inserted);
            changes = db.prepare(`INSERT INTO watcher_entry_meta (${columns.map(quoteColumn).join(',')}) SELECT ${columns.map(() => '?').join(',')} WHERE EXISTS (SELECT 1 FROM terms WHERE term=?)`)
              .run(...columns.map((column) => sqliteValue(inserted[column])), term).changes;
            expectedMetadata.set(term, inserted);
          }
          if (changes !== 1) fail('DATABASE_ERROR', 'The conditional metadata write did not affect exactly one existing term.');
        }
        assertMaintenanceRows(db, state, expectedMetadata);
      }
      return maintenanceReport(outcomes);
    }, maintenanceDbOptions);
  } catch (error) {
    return maintenanceFailure(prepared, error);
  }
}

export function applyMaintenanceReviews(reviews, { dbPath, now = Date.now() / 1000 } = {}) {
  options(dbPath, now);
  const prepared = maintenanceRecords(reviews, parseMaintenanceReview, 'INVALID_REVIEW');
  try {
    return withDatabase(dbPath, true, (db) => {
      const state = maintenanceState(db);
      const outcomes = prepared.map((item) => item.outcome);
      const updates = [];
      for (const group of maintenanceGroups(prepared)) {
        const target = group[0].record.target;
        const status = group[0].record.status;
        const batchConflict = group.some((item) => item.record.target.digest !== target.digest || item.record.status !== status);
        const conflict = batchConflict ? { status: 'conflict', reason: 'BATCH_REVIEW_CONFLICT' } : maintenanceConflict(state, target, status);
        const current = state.termReviews.find((row) => row.term === target.canonical_term);
        group.forEach(({ record, index }, position) => {
          const result = conflict ?? (current.status === status ? { status: 'unchanged', reason: 'ALREADY_REVIEWED' }
            : position ? { status: 'unchanged', reason: 'DUPLICATE_REVIEW' } : { status: 'updated', reason: 'REVIEW_UPDATED' });
          outcomes[index] = maintenanceOutcome(record, index, result.status, result.reason);
          if (result.status === 'updated') updates.push(record);
        });
      }
      if (updates.length) {
        const expectedReviews = state.termReviews.map((row) => ({ ...row }));
        for (const record of updates) {
          const current = expectedReviews.find((row) => row.term === record.target.canonical_term);
          const changes = db.prepare('UPDATE term_reviews SET status=?,reviewed_at=?,actor=? WHERE term=? AND status=? AND source_url=?')
            .run(record.status, now, 'maintenance:operator', current.term, current.status, current.source_url).changes;
          if (changes !== 1) fail('DATABASE_ERROR', 'The conditional review write did not affect exactly one existing review.');
          Object.assign(current, { status: record.status, reviewed_at: now, actor: 'maintenance:operator' });
        }
        if (state.metadataSchema === null) {
          if (!rowsEqual(maintenanceRows(db, 'terms'), state.terms) || !rowsEqual(maintenanceRows(db, 'candidate_reviews'), state.candidateReviews)
            || !rowsEqual(maintenanceRows(db, 'term_reviews'), expectedReviews) || tableNames(db).has('watcher_entry_meta')) {
            fail('DATABASE_ERROR', 'A database trigger changed protected review material.');
          }
        } else {
          assertMaintenanceRows(db, state, state.metadataByName, expectedReviews);
        }
      }
      return maintenanceReport(outcomes);
    }, maintenanceDbOptions);
  } catch (error) {
    return maintenanceFailure(prepared, error);
  }
}
