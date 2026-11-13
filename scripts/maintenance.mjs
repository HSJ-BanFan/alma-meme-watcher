import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMaintenancePatches, applyMaintenanceReviews, maintenanceCandidates, previewMaintenanceReviews } from '../src/store/radar.js';
import { maintenanceError } from '../src/maintenance/model.js';
import {
  applyNormalizedImport, approveMaintenanceReport, backfillDrafts, previewNormalizedImport,
  readMaintenanceJson, recordsFromReport, safeMaintenanceFault, writeNewMaintenanceReport,
} from '../src/maintenance/workflows.js';

const commandFlags = {
  inspect: ['db', 'alma-home', 'fields', 'source', 'limit'],
  'import-preview': ['input', 'db', 'out'],
  'import-apply': ['input', 'db', 'create'],
  draft: ['db', 'out', 'fields', 'source', 'limit', 'model', 'timeout-ms', 'attempts', 'circuit-failures', 'retry-delay-ms'],
  approve: ['draft-file', 'ids', 'out'],
  'patch-apply': ['approved-file', 'db'],
  'review-preview': ['requests', 'db', 'out'],
  'review-apply': ['approved-file', 'db'],
};
const requiredFlags = {
  'import-preview': ['input'], 'import-apply': ['input', 'db'], draft: ['db', 'out'],
  approve: ['draft-file', 'ids', 'out'], 'patch-apply': ['approved-file', 'db'],
  'review-preview': ['requests', 'db', 'out'], 'review-apply': ['approved-file', 'db'],
};

function invalidOptions() {
  throw maintenanceError('INVALID_OPTIONS', 'The maintenance command options are invalid.');
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!Object.hasOwn(commandFlags, command)) invalidOptions();
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(args[index]);
    if (!match || !commandFlags[command].includes(match[1]) || Object.hasOwn(flags, match[1])) invalidOptions();
    const name = match[1];
    if (name === 'create') {
      if (match[2] !== undefined) invalidOptions();
      flags[name] = true;
      continue;
    }
    const value = match[2] ?? args[++index];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) invalidOptions();
    flags[name] = value;
  }
  if ((requiredFlags[command] ?? []).some((name) => !flags[name])) invalidOptions();
  return { command, flags };
}

function numberFlag(flags, name, fallback) {
  if (flags[name] === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(flags[name])) invalidOptions();
  const value = Number(flags[name]);
  if (!Number.isSafeInteger(value)) invalidOptions();
  return value;
}

function selection(flags) {
  return {
    ...(flags.fields ? { fields: flags.fields.split(',').map((field) => field.trim()) } : {}),
    ...(flags.source ? { source: flags.source } : {}),
    limit: numberFlag(flags, 'limit', 50),
  };
}

async function execute(command, flags) {
  switch (command) {
    case 'inspect': {
      const root = resolve(flags['alma-home'] ?? join(homedir(), '.config', 'alma'));
      const dbPath = flags.db ? resolve(flags.db) : join(root, 'state', 'meme_radar.db');
      return { version: 1, kind: 'maintenance-candidates', targets: maintenanceCandidates({ dbPath, ...selection(flags) }) };
    }
    case 'import-preview': {
      const report = previewNormalizedImport(readMaintenanceJson(resolve(flags.input)), { ...(flags.db ? { dbPath: resolve(flags.db) } : {}) });
      if (flags.out) writeNewMaintenanceReport(resolve(flags.out), report);
      return report;
    }
    case 'import-apply':
      return applyNormalizedImport(readMaintenanceJson(resolve(flags.input)), { dbPath: resolve(flags.db), create: flags.create ?? false });
    case 'draft':
      return backfillDrafts({
        dbPath: resolve(flags.db), draftPath: resolve(flags.out), ...selection(flags),
        runtime: { ...(flags.model ? { model: flags.model } : {}) },
        timeoutMs: numberFlag(flags, 'timeout-ms', 20000), maxAttempts: numberFlag(flags, 'attempts', 3),
        circuitFailures: numberFlag(flags, 'circuit-failures', 3), retryDelayMs: numberFlag(flags, 'retry-delay-ms', 100),
      });
    case 'approve': {
      const report = approveMaintenanceReport(readMaintenanceJson(resolve(flags['draft-file'])), flags.ids.split(',').map((id) => id.trim()));
      writeNewMaintenanceReport(resolve(flags.out), report);
      return report;
    }
    case 'patch-apply':
      return applyMaintenancePatches(recordsFromReport(readMaintenanceJson(resolve(flags['approved-file'])), 'patches'), { dbPath: resolve(flags.db) });
    case 'review-preview': {
      const report = {
        version: 1, kind: 'maintenance-review-preview',
        reviews: previewMaintenanceReviews(readMaintenanceJson(resolve(flags.requests)), { dbPath: resolve(flags.db) }),
      };
      writeNewMaintenanceReport(resolve(flags.out), report);
      return report;
    }
    case 'review-apply':
      return applyMaintenanceReviews(recordsFromReport(readMaintenanceJson(resolve(flags['approved-file'])), 'reviews'), { dbPath: resolve(flags.db) });
    default:
      invalidOptions();
  }
}

try {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const report = await execute(command, flags);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.error || report.failures?.length || report.unattempted?.length
    || ['conflict', 'deleted', 'rejected', 'failed'].some((status) => report.counts?.[status])) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: safeMaintenanceFault(error) })}\n`);
  process.exitCode = 2;
}
