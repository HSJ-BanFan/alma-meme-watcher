import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { lookupCards } from '../src/store/radar.js';
import { lookupFailures as failures, lookupFailureCode } from '../src/lookup/errors.js';

function invalidArguments() {
  throw Object.assign(new Error(failures.INVALID_ARGUMENTS.message), { code: 'INVALID_ARGUMENTS' });
}

function parseLookupArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { text: { type: 'string' }, db: { type: 'string' }, limit: { type: 'string' } },
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
  } catch {
    invalidArguments();
  }
  const { values, tokens } = parsed;
  const names = tokens.map((token) => token.name);
  if (tokens.some((token) => token.kind !== 'option') || new Set(names).size !== names.length
    || values.text === undefined || (values.db !== undefined && !values.db.trim())) invalidArguments();
  const limit = values.limit === undefined ? 3 : Number(values.limit);
  if ((values.limit !== undefined && !/^\d+$/u.test(values.limit)) || !Number.isSafeInteger(limit)) invalidArguments();
  return { text: values.text, dbPath: values.db, limit };
}

export function runCli(argv) {
  try {
    const { text, dbPath, limit } = parseLookupArgs(argv);
    const terms = lookupCards(text, { dbPath, limit });
    process.stdout.write(`${JSON.stringify({ terms })}\n`);
    return 0;
  } catch (error) {
    const code = lookupFailureCode(error?.code);
    const { exit, message } = failures[code];
    process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
    return exit;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
