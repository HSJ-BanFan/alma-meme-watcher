import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const PLUGIN = 'alma-meme-watcher';

const sha256 = (absolute) => createHash('sha256').update(readFileSync(absolute)).digest('hex');

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function readJson(absolute, code) {
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    fail(code, 'A required receipt is missing or unreadable.');
  }
}

function parse(argv) {
  const options = {
    almaHome: join(homedir(), '.config', 'alma'),
    packageDir: join(root, 'dist', PLUGIN),
    action: 'plan',
    backup: null,
  };
  const take = (name, index) => {
    const value = argv[index];
    if (!value || value.startsWith('--')) fail('INVALID_ARGUMENTS', `${name} needs a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--alma-home') { options.almaHome = resolve(take('--alma-home', index + 1)); index += 1; }
    else if (argument.startsWith('--alma-home=')) options.almaHome = resolve(argument.slice(12));
    else if (argument === '--package') { options.packageDir = resolve(take('--package', index + 1)); index += 1; }
    else if (argument.startsWith('--package=')) options.packageDir = resolve(argument.slice(10));
    else if (argument === '--rollback') { options.action = 'rollback'; options.backup = take('--rollback', index + 1); index += 1; }
    else if (argument.startsWith('--rollback=')) { options.action = 'rollback'; options.backup = argument.slice(11); }
    else if (argument === '--apply') options.action = 'apply';
    else if (argument === '--plan') options.action = 'plan';
    else if (argument === '--list') options.action = 'list';
    else if (argument === '--uninstall') options.action = 'uninstall';
    else fail('INVALID_ARGUMENTS', 'Unknown option.');
  }
  return options;
}

function paths(almaHome) {
  return {
    target: join(almaHome, 'plugins', PLUGIN),
    backupRoot: join(almaHome, '_backup'),
    receipt: join(almaHome, 'plugins', PLUGIN, '.install-receipt.json'),
  };
}

function verifyPackage(packageDir) {
  const receipt = readJson(join(packageDir, 'package-receipt.json'), 'PACKAGE_INVALID');
  if (!Array.isArray(receipt.files) || !receipt.files.length) fail('PACKAGE_INVALID', 'The package lists no files.');
  for (const file of receipt.files) {
    const absolute = join(packageDir, file.path.split('/').join(sep));
    if (!existsSync(absolute) || statSync(absolute).size !== file.bytes || sha256(absolute) !== file.sha256) {
      fail('PACKAGE_INVALID', `The package file ${file.path} does not match its receipt.`);
    }
  }
  return receipt;
}

function matchesPackage(target, files) {
  return files.every((file) => {
    const absolute = join(target, file.path.split('/').join(sep));
    return existsSync(absolute) && sha256(absolute) === file.sha256;
  });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

function backupId(backupRoot) {
  const base = `${PLUGIN}-${stamp()}`;
  let candidate = base;
  for (let index = 2; existsSync(join(backupRoot, candidate)); index += 1) candidate = `${base}-${index}`;
  return candidate;
}

function apply({ almaHome, packageDir }) {
  const receipt = verifyPackage(packageDir);
  const { target, backupRoot, receipt: receiptPath } = paths(almaHome);
  if (existsSync(target)) {
    if (!existsSync(receiptPath)) fail('REFUSE_UNKNOWN_TARGET', 'The target directory was not installed by this script; refusing to replace it.');
    if (matchesPackage(target, receipt.files)) return { action: 'unchanged', target, revision: receipt.revision };
    const previous = readJson(receiptPath, 'REFUSE_UNKNOWN_TARGET');
    const id = backupId(backupRoot);
    const staging = stageFiles(packageDir, target, receipt);
    mkdirSync(join(backupRoot, id), { recursive: true });
    writeFileSync(join(backupRoot, id, 'backup.json'), `${JSON.stringify({ schema: 1, id, revision: previous.revision ?? null, createdAt: new Date().toISOString() }, null, 2)}\n`);
    renameSync(target, join(backupRoot, id, PLUGIN));
    renameSync(staging, target);
    return { action: 'reinstalled', target, revision: receipt.revision, backup: id };
  }
  renameSync(stageFiles(packageDir, target, receipt), target);
  return { action: 'installed', target, revision: receipt.revision, backup: null };
}

// Build the new tree next to the target and swap it in, so a failed copy never
// leaves a half-installed directory that the next run would refuse to replace.
function stageFiles(packageDir, target, receipt) {
  const staging = `${target}.incoming`;
  rmSync(staging, { recursive: true, force: true });
  writeTree(packageDir, staging, receipt);
  return staging;
}

function writeTree(packageDir, target, receipt) {
  mkdirSync(target, { recursive: true });
  for (const file of receipt.files) {
    const destination = join(target, file.path.split('/').join(sep));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(packageDir, file.path.split('/').join(sep)), destination);
  }
  copyFileSync(join(packageDir, 'package-receipt.json'), join(target, 'package-receipt.json'));
  writeFileSync(join(target, '.install-receipt.json'), `${JSON.stringify({
    schema: 1,
    revision: receipt.revision,
    installedAt: new Date().toISOString(),
    files: receipt.files,
  }, null, 2)}\n`);
}

function rollback({ almaHome, backup }) {
  const { target, backupRoot, receipt: receiptPath } = paths(almaHome);
  const directory = join(backupRoot, backup);
  if (!backup || !existsSync(join(directory, 'backup.json'))) fail('BACKUP_NOT_FOUND', 'No backup with that identifier.');
  if (existsSync(target)) {
    if (!existsSync(receiptPath)) fail('REFUSE_UNKNOWN_TARGET', 'The current directory was not installed by this script; refusing to remove it.');
    rmSync(target, { recursive: true, force: true });
  }
  const previous = join(directory, PLUGIN);
  if (existsSync(previous)) renameSync(previous, target);
  rmSync(directory, { recursive: true, force: true });
  return { action: 'rolled_back', target, backup, restored: existsSync(target) };
}

function uninstall({ almaHome }) {
  const { target, receipt: receiptPath } = paths(almaHome);
  if (!existsSync(target)) return { action: 'absent', target };
  if (!existsSync(receiptPath)) fail('REFUSE_UNKNOWN_TARGET', 'The current directory was not installed by this script; refusing to remove it.');
  const receipt = readJson(receiptPath, 'REFUSE_UNKNOWN_TARGET');
  rmSync(target, { recursive: true, force: true });
  return { action: 'uninstalled', target, revision: receipt.revision };
}

function list({ almaHome }) {
  const { backupRoot } = paths(almaHome);
  if (!existsSync(backupRoot)) return { action: 'list', backups: [] };
  const backups = readdirSync(backupRoot)
    .filter((name) => existsSync(join(backupRoot, name, 'backup.json')))
    .sort()
    .map((name) => ({ id: name, ...readJson(join(backupRoot, name, 'backup.json'), 'BACKUP_NOT_FOUND') }));
  return { action: 'list', backups };
}

function plan({ almaHome, packageDir }) {
  const receipt = verifyPackage(packageDir);
  const { target, receipt: receiptPath } = paths(almaHome);
  let action = 'install';
  if (existsSync(target)) {
    if (!existsSync(receiptPath)) fail('REFUSE_UNKNOWN_TARGET', 'The target directory was not installed by this script; refusing to replace it.');
    action = matchesPackage(target, receipt.files) ? 'unchanged' : 'backup_then_install';
  }
  return { action: 'plan', planned: action, target, revision: receipt.revision, package: packageDir };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const options = parse(process.argv.slice(2));
    const result = options.action === 'apply' ? apply(options)
      : options.action === 'rollback' ? rollback(options)
        : options.action === 'uninstall' ? uninstall(options)
          : options.action === 'list' ? list(options)
            : plan(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message } })}\n`);
    process.exitCode = 1;
  }
}
