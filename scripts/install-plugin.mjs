import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const PLUGIN = 'alma-meme-watcher';
const SKILL = 'meme-use';

const sha256 = (absolute) => createHash('sha256').update(readFileSync(absolute)).digest('hex');
const posix = (path) => path.split('/').join(sep);

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
    withSkill: false,
  };
  const take = (name, index) => {
    const value = argv[index];
    if (!value || value.startsWith('--')) fail('INVALID_ARGUMENTS', `${name} needs a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--alma-home') { options.almaHome = resolve(take('--alma-home', index + 1)); index += 1; }
    else if (argument.startsWith('--alma-home=')) options.almaHome = resolve(argument.slice('--alma-home='.length));
    else if (argument === '--package') { options.packageDir = resolve(take('--package', index + 1)); index += 1; }
    else if (argument.startsWith('--package=')) options.packageDir = resolve(argument.slice('--package='.length));
    else if (argument === '--rollback') { options.action = 'rollback'; options.backup = take('--rollback', index + 1); index += 1; }
    else if (argument.startsWith('--rollback=')) { options.action = 'rollback'; options.backup = argument.slice('--rollback='.length); }
    else if (argument === '--apply') options.action = 'apply';
    else if (argument === '--plan') options.action = 'plan';
    else if (argument === '--list') options.action = 'list';
    else if (argument === '--uninstall') options.action = 'uninstall';
    else if (argument === '--with-skill') options.withSkill = true;
    else fail('INVALID_ARGUMENTS', 'Unknown option.');
  }
  return options;
}

function home(almaHome) {
  return {
    pluginTarget: join(almaHome, 'plugins', PLUGIN),
    skillTarget: join(almaHome, 'skills', SKILL),
    backupRoot: join(almaHome, '_backup'),
  };
}

function verifyPackage(packageDir) {
  const receipt = readJson(join(packageDir, 'package-receipt.json'), 'PACKAGE_INVALID');
  if (!Array.isArray(receipt.files) || !receipt.files.length) fail('PACKAGE_INVALID', 'The package lists no files.');
  for (const file of receipt.files) {
    const absolute = join(packageDir, posix(file.path));
    if (!existsSync(absolute) || statSync(absolute).size !== file.bytes || sha256(absolute) !== file.sha256) {
      fail('PACKAGE_INVALID', `The package file ${file.path} does not match its receipt.`);
    }
  }
  return receipt;
}

function filesUnder(receipt, prefix) {
  return receipt.files
    .filter((file) => file.path.startsWith(`${prefix}/`))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length + 1) }));
}

function matches(target, files) {
  return files.every((file) => {
    const absolute = join(target, posix(file.path));
    return existsSync(absolute) && sha256(absolute) === file.sha256;
  });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

function freshBackupId(backupRoot, base) {
  const prefix = `${base}-${stamp()}`;
  let candidate = prefix;
  for (let index = 2; existsSync(join(backupRoot, candidate)); index += 1) candidate = `${prefix}-${index}`;
  return candidate;
}

// Build beside the target and rename into place, so a failed copy never leaves a
// half-installed directory that the next run would refuse to replace.
function stage(sourceDir, files, target, kind, revision) {
  const staging = `${target}.incoming`;
  rmSync(staging, { recursive: true, force: true });
  for (const file of files) {
    const destination = join(staging, posix(file.path));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(sourceDir, posix(file.path)), destination);
  }
  writeFileSync(join(staging, '.install-receipt.json'), `${JSON.stringify({
    schema: 1,
    kind,
    revision,
    installedAt: new Date().toISOString(),
    files,
  }, null, 2)}\n`);
  return staging;
}

function place({ sourceDir, files, target, backupRoot, base, kind, revision }) {
  if (!existsSync(target)) {
    renameSync(stage(sourceDir, files, target, kind, revision), target);
    return { action: 'installed', backup: null };
  }
  const receiptPath = join(target, '.install-receipt.json');
  if (!existsSync(receiptPath)) fail('REFUSE_UNKNOWN_TARGET', `The directory ${target} was not installed by this script; refusing to replace it.`);
  if (matches(target, files)) return { action: 'unchanged', backup: null };
  const previous = readJson(receiptPath, 'REFUSE_UNKNOWN_TARGET');
  const id = freshBackupId(backupRoot, base);
  const backupDirectory = join(backupRoot, id);
  const staging = stage(sourceDir, files, target, kind, revision);
  mkdirSync(backupDirectory, { recursive: true });
  writeFileSync(join(backupDirectory, 'backup.json'), `${JSON.stringify({ schema: 1, id, kind, target, revision: previous.revision ?? null, createdAt: new Date().toISOString() }, null, 2)}\n`);
  renameSync(target, join(backupDirectory, 'content'));
  renameSync(staging, target);
  return { action: 'reinstalled', backup: id };
}

function installPlugin({ almaHome, packageDir }) {
  const receipt = verifyPackage(packageDir);
  const { pluginTarget, backupRoot } = home(almaHome);
  const placed = place({ sourceDir: packageDir, files: receipt.files, target: pluginTarget, backupRoot, base: PLUGIN, kind: 'plugin', revision: receipt.revision });
  copyFileSync(join(packageDir, 'package-receipt.json'), join(pluginTarget, 'package-receipt.json'));
  return { action: placed.action, target: pluginTarget, revision: receipt.revision, backup: placed.backup };
}

function installSkill({ almaHome, packageDir }) {
  const receipt = verifyPackage(packageDir);
  const files = filesUnder(receipt, `skills/${SKILL}`);
  if (!files.length) fail('PACKAGE_INVALID', `The package carries no skills/${SKILL}.`);
  const { skillTarget, backupRoot } = home(almaHome);
  const sourceDir = join(packageDir, 'skills', SKILL);
  const placed = place({ sourceDir, files, target: skillTarget, backupRoot, base: `skill-${SKILL}`, kind: 'skill', revision: receipt.revision });
  return { action: placed.action, target: skillTarget, revision: receipt.revision, backup: placed.backup };
}

function apply(options) {
  const plugin = installPlugin(options);
  const skill = options.withSkill ? installSkill(options) : null;
  return { action: 'apply', plugin, skill };
}

function plan(options) {
  const receipt = verifyPackage(options.packageDir);
  const { pluginTarget, skillTarget } = home(options.almaHome);
  const describe = (target, files) => {
    if (!existsSync(target)) return 'install';
    if (!existsSync(join(target, '.install-receipt.json'))) return 'refuse_unknown_target';
    return matches(target, files) ? 'unchanged' : 'backup_then_install';
  };
  const skillFiles = filesUnder(receipt, `skills/${SKILL}`);
  return {
    action: 'plan',
    plugin: { target: pluginTarget, planned: describe(pluginTarget, receipt.files) },
    skill: options.withSkill
      ? { target: skillTarget, planned: skillFiles.length ? describe(skillTarget, skillFiles) : 'not_in_package' }
      : null,
    revision: receipt.revision,
    package: options.packageDir,
  };
}

function rollback({ almaHome, backup }) {
  const { backupRoot } = home(almaHome);
  const directory = join(backupRoot, backup);
  const meta = existsSync(join(directory, 'backup.json')) ? readJson(join(directory, 'backup.json'), 'BACKUP_NOT_FOUND') : null;
  if (!meta || !meta.target) fail('BACKUP_NOT_FOUND', 'No backup with that identifier.');
  const target = meta.target;
  if (existsSync(target)) {
    if (!existsSync(join(target, '.install-receipt.json'))) fail('REFUSE_UNKNOWN_TARGET', 'The current directory was not installed by this script; refusing to remove it.');
    rmSync(target, { recursive: true, force: true });
  }
  const previous = join(directory, 'content');
  if (existsSync(previous)) renameSync(previous, target);
  rmSync(directory, { recursive: true, force: true });
  return { action: 'rolled_back', target, backup, restored: existsSync(target) };
}

function uninstall({ almaHome }) {
  const { pluginTarget, skillTarget } = home(almaHome);
  const removed = [];
  for (const target of [pluginTarget, skillTarget]) {
    if (!existsSync(target)) continue;
    if (!existsSync(join(target, '.install-receipt.json'))) fail('REFUSE_UNKNOWN_TARGET', `${target} was not installed by this script; refusing to remove it.`);
    rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }
  return { action: removed.length ? 'uninstalled' : 'absent', removed };
}

function list({ almaHome }) {
  const { backupRoot } = home(almaHome);
  if (!existsSync(backupRoot)) return { action: 'list', backups: [] };
  const backups = readdirSync(backupRoot)
    .filter((name) => existsSync(join(backupRoot, name, 'backup.json')))
    .sort()
    .map((name) => readJson(join(backupRoot, name, 'backup.json'), 'BACKUP_NOT_FOUND'));
  return { action: 'list', backups };
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
