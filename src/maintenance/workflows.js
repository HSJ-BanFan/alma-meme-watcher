import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { parseMemeEntry } from '../compiler/schema.js';
import { maintenanceCandidates, syncMaintenanceEntries } from '../store/radar.js';
import {
  draftPatch, maintenanceError, parseGeneratedValue, parseMaintenancePatch, parseMaintenanceReview,
} from './model.js';
import { createHttpGenerator, generationContext, generationFault } from './generator.js';

const messages = {
  INVALID_OPTIONS: 'The maintenance command options are invalid.',
  INVALID_ENTRY: 'The normalized entry has missing, unknown or invalid fields.',
  INVALID_BATCH: 'Normalized import requires a nonempty entry array.',
  INVALID_SOURCE_URL: 'Normalized import accepts only the existing supported Bilibili video URLs.',
  IMPORT_METADATA_REQUIRED: 'Normalized import requires nonempty term, meaning, usage_context and avoid_when.',
  DATABASE_MISSING: 'The maintenance database does not exist; creation requires explicit import --create.',
  DATABASE_INVALID: 'The maintenance database is invalid and was not repaired.',
  DATABASE_BUSY: 'The maintenance database is busy; no changes were committed.',
  DATABASE_ERROR: 'The maintenance database operation failed; no transaction was committed.',
  AMBIGUOUS_IDENTITY: 'The canonical/alias identity is ambiguous.',
  CONTENT_CONFLICT: 'Connected import entries contain conflicting material.',
  UNREPRESENTABLE_ALIAS: 'An imported spelling cannot be stored safely as an alias.',
  REVIEW_CONFLICT: 'Import conflicts with an existing rejected identity.',
  STALE_VERSION: 'Import refers to a deleted canonical version and cannot restore it automatically.',
  INVALID_REVIEW: 'Review preview requires term/status records with accepted or rejected status.',
  TERM_NOT_FOUND: 'A requested review identity no longer exists.',
  INVALID_JSON_FILE: 'The maintenance input must be a bounded, readable JSON file.',
  INVALID_DRAFT_FILE: 'The file is not a supported maintenance draft report.',
  INVALID_APPROVAL_SELECTION: 'Approval requires explicit, unique record IDs present in the draft file.',
  APPROVAL_REJECTED: 'An explicitly rejected draft cannot be approved by this operation.',
  INVALID_TARGET: 'The maintenance target snapshot is invalid.',
  INVALID_PATCH: 'The metadata patch must bind an empty field in its original target snapshot.',
  INVALID_CONTENT: 'The proposed field contains invalid or placeholder content.',
  REPORT_EXISTS: 'The output report already exists; choose a new file.',
  REPORT_CONFLICT: 'The active draft report changed outside this process; generation stopped without overwriting it.',
  REPORT_TOO_LARGE: 'The maintenance report exceeds the bounded file size.',
  REPORT_WRITE_FAILED: 'The maintenance report could not be saved.',
  MAINTENANCE_FAILED: 'The maintenance operation failed.',
};

export function safeMaintenanceFault(error) {
  const code = Object.hasOwn(messages, error?.code) ? error.code : 'MAINTENANCE_FAILED';
  return { code, message: messages[code] };
}

function normalizedEntries(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 1000) throw maintenanceError('INVALID_BATCH', messages.INVALID_BATCH);
  return raw.map((value) => {
    let entry;
    try {
      entry = parseMemeEntry(value);
    } catch (error) {
      const fault = safeMaintenanceFault(error);
      throw maintenanceError(fault.code, fault.message);
    }
    if (!entry.term || !entry.meaning || !entry.usage_context || !entry.avoid_when) {
      throw maintenanceError('IMPORT_METADATA_REQUIRED', messages.IMPORT_METADATA_REQUIRED);
    }
    return entry;
  });
}

export function previewNormalizedImport(raw, { dbPath } = {}) {
  const entries = normalizedEntries(raw);
  if (dbPath !== undefined) maintenanceCandidates({ dbPath, limit: 0 });
  return { version: 1, kind: 'normalized-import-preview', count: entries.length, entries };
}

export function applyNormalizedImport(raw, { dbPath, now = Date.now() / 1000, create = false } = {}) {
  const entries = normalizedEntries(raw);
  try {
    return syncMaintenanceEntries(entries, { dbPath, now, create });
  } catch (error) {
    const fault = safeMaintenanceFault(error);
    throw maintenanceError(fault.code, fault.message);
  }
}

export function readMaintenanceJson(file) {
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size < 1 || info.size > 16777216) throw new Error('invalid size');
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw maintenanceError('INVALID_JSON_FILE', messages.INVALID_JSON_FILE);
  }
}

function persistReport(file, report, previous = null) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > 16777216) throw maintenanceError('REPORT_TOO_LARGE', messages.REPORT_TOO_LARGE);
  const destination = previous === null ? file : `${file}.${randomUUID()}.tmp`;
  let fd;
  let created = false;
  try {
    if (previous !== null && readFileSync(file, 'utf8') !== previous) throw maintenanceError('REPORT_CONFLICT', messages.REPORT_CONFLICT);
    fd = openSync(destination, 'wx', 0o600);
    created = true;
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (previous !== null) renameSync(destination, file);
    return text;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try { unlinkSync(destination); } catch {}
    }
    const code = error.code === 'REPORT_CONFLICT' ? error.code : error.code === 'EEXIST' && previous === null ? 'REPORT_EXISTS' : 'REPORT_WRITE_FAILED';
    throw maintenanceError(code, messages[code]);
  }
}

export function writeNewMaintenanceReport(file, report) {
  persistReport(file, report);
}

export function recordsFromReport(report, type) {
  const kinds = { patches: 'maintenance-drafts', reviews: 'maintenance-review-preview' };
  if (!report || report.version !== 1 || report.kind !== kinds[type] || !Array.isArray(report[type])) {
    throw maintenanceError('INVALID_DRAFT_FILE', messages.INVALID_DRAFT_FILE);
  }
  return report[type];
}

export function approveMaintenanceReport(report, ids) {
  const type = report?.kind === 'maintenance-drafts' ? 'patches' : report?.kind === 'maintenance-review-preview' ? 'reviews' : null;
  if (!type) throw maintenanceError('INVALID_DRAFT_FILE', messages.INVALID_DRAFT_FILE);
  const records = recordsFromReport(report, type);
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
    || new Set(ids).size !== ids.length || ids.some((id) => records.filter((record) => record?.id === id).length !== 1)) {
    throw maintenanceError('INVALID_APPROVAL_SELECTION', messages.INVALID_APPROVAL_SELECTION);
  }
  const parse = type === 'patches' ? parseMaintenancePatch : parseMaintenanceReview;
  const approved = records.filter((record) => ids.includes(record.id)).map((record) => {
    if (record.approval === 'rejected') throw maintenanceError('APPROVAL_REJECTED', messages.APPROVAL_REJECTED);
    return parse({ ...record, approval: 'approved' });
  });
  return { version: 1, kind: report.kind, [type]: approved };
}

async function generationAttempt(generator, target, field, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(maintenanceError('MODEL_TIMEOUT', 'The generation deadline expired.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => generator(target, field, { signal: controller.signal })), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function backfillDrafts({
  dbPath, fields, source, limit = 50, generator, runtime = {}, draftPath,
  timeoutMs = 20000, maxAttempts = 3, circuitFailures = 3, retryDelayMs = 100,
} = {}) {
  if (typeof dbPath !== 'string' || !dbPath.trim() || (generator !== undefined && typeof generator !== 'function')
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5
    || !Number.isInteger(circuitFailures) || circuitFailures < 1 || circuitFailures > 100
    || !Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 2000
    || (draftPath !== undefined && (typeof draftPath !== 'string' || !draftPath.trim()))) {
    throw maintenanceError('INVALID_OPTIONS', messages.INVALID_OPTIONS);
  }
  const targets = maintenanceCandidates({ dbPath, fields, source, limit });
  const items = targets.flatMap((target) => target.fields.map((field) => ({ target, field })));
  const unattempted = (start, reason) => items.slice(start).map(({ target, field }, offset) => ({ index: start + offset, canonical_term: target.canonical_term, field, reason }));
  const report = {
    version: 1, kind: 'maintenance-drafts', patches: [], failures: [], attempt_failures: [],
    unattempted: unattempted(0, 'PENDING_GENERATION'),
    circuit: { open: false, consecutive_failures: 0, threshold: circuitFailures }, stop_reason: null,
  };
  let previous = null;
  const checkpoint = () => { if (draftPath !== undefined) previous = persistReport(draftPath, report, previous); };
  let generate = generator;
  if (!generate) {
    try {
      generate = createHttpGenerator({ ...runtime, timeoutMs });
    } catch (error) {
      const { code, message } = generationFault(error);
      report.error = { code, message };
      report.stop_reason = code;
      report.unattempted = unattempted(0, code);
      checkpoint();
      return report;
    }
  }
  checkpoint();
  for (const [index, { target, field }] of items.entries()) {
    let failure;
    let attempts = 0;
    try {
      generationContext(target, field);
    } catch (error) {
      failure = generationFault(error);
    }
    while (!failure || (failure.retryable && attempts < maxAttempts)) {
      attempts++;
      try {
        const output = await generationAttempt(generate, target, field, timeoutMs);
        const value = parseGeneratedValue(output, field);
        report.patches.push(draftPatch(target, field, value));
        failure = null;
        break;
      } catch (error) {
        failure = generationFault(error);
        report.attempt_failures.push({ index, canonical_term: target.canonical_term, field, attempt: attempts, code: failure.code, message: failure.message, retryable: failure.retryable });
        checkpoint();
        if (!failure.retryable || attempts >= maxAttempts) break;
        const delay = Math.min(retryDelayMs * 2 ** (attempts - 1), 2000);
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    if (failure) {
      report.failures.push({ index, canonical_term: target.canonical_term, field, attempts, code: failure.code, message: failure.message });
      report.circuit.consecutive_failures++;
      report.circuit.open = report.circuit.consecutive_failures >= circuitFailures;
      if (report.circuit.open || failure.stopBatch) {
        report.stop_reason = failure.stopBatch ? failure.code : 'CIRCUIT_OPEN';
        report.unattempted = unattempted(index + 1, report.stop_reason);
        checkpoint();
        break;
      }
    } else {
      report.circuit.consecutive_failures = 0;
    }
    report.unattempted = unattempted(index + 1, 'PENDING_GENERATION');
    checkpoint();
  }
  return report;
}
