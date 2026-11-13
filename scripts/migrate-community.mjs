import { migrateCommunity } from '../integrations/xiaoheihe/migration.mjs';

function parse(argv) {
  const args = [...argv];
  const operation = args[0] && !args[0].startsWith('--') ? args.shift() : 'plan';
  const options = {
    plan: { '--skill-dir': 'skillDir', '--plugin-root': 'pluginRoot', '--alma-home': 'almaHome', '--out': 'out' },
    stage: { '--skill-dir': 'skillDir', '--plugin-root': 'pluginRoot', '--alma-home': 'almaHome' },
    apply: { '--plan': 'planPath', '--backup-dir': 'backupDir' },
    rollback: { '--plan': 'planPath', '--backup-dir': 'backupDir' },
  }[operation];
  if (!options) throw new Error('Use plan, stage, apply or rollback.');
  const request = { operation };
  for (let index = 0; index < args.length; index += 1) {
    const equal = args[index].indexOf('=');
    const flag = equal === -1 ? args[index] : args[index].slice(0, equal);
    const key = options[flag];
    if (!key || Object.hasOwn(request, key)) throw new Error(`Unexpected or repeated option ${flag}.`);
    const value = equal === -1 ? args[++index] : args[index].slice(equal + 1);
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a path.`);
    request[key] = value;
  }
  return request;
}

try {
  let request;
  try {
    request = parse(process.argv.slice(2));
  } catch (error) {
    error.code = 'INVALID_ARGUMENT';
    throw error;
  }
  process.stdout.write(`${JSON.stringify(migrateCommunity(request))}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: { code: error.code ?? 'MIGRATION_ERROR', message: error.message } })}\n`);
  process.exitCode = 1;
}
