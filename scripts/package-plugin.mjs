import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const FILES = ['main.js', 'manifest.json', 'package.json', 'docs/lookup-api.md'];
const DIRECTORY = ['src', 'scripts', 'skills', 'integrations'];

function walk(directory, prefix) {
  const entries = [];
  for (const name of readdirSync(directory).sort()) {
    const absolute = join(directory, name);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (statSync(absolute).isDirectory()) entries.push(...walk(absolute, relativePath));
    else entries.push(relativePath);
  }
  return entries;
}

export function collect() {
  const paths = FILES.filter((path) => existsSync(join(root, path)));
  for (const directory of DIRECTORY) {
    const absolute = join(root, directory);
    if (existsSync(absolute)) paths.push(...walk(absolute, directory));
  }
  return paths.sort();
}

const sha256 = (absolute) => createHash('sha256').update(readFileSync(absolute)).digest('hex');

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

export function build({ out = join(root, 'dist') } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const paths = collect();
  const target = join(out, 'alma-meme-watcher');
  rmSync(target, { recursive: true, force: true });
  for (const path of paths) {
    const destination = join(target, path.split('/').join(sep));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, path), destination);
  }
  const revision = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--', ...paths) !== '';
  const receipt = {
    schema: 1,
    plugin: { id: manifest.id, name: manifest.name, version: manifest.version },
    revision,
    dirty,
    files: paths.map((path) => ({ path, bytes: statSync(join(root, path)).size, sha256: sha256(join(root, path)) })),
  };
  writeFileSync(join(target, 'package-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return { target, receipt };
}

function parse(argv) {
  const options = { out: join(root, 'dist') };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw Object.assign(new Error('--out needs a directory.'), { code: 'INVALID_ARGUMENTS' });
      options.out = resolve(value);
      index += 1;
    } else if (argument.startsWith('--out=')) {
      options.out = resolve(argument.slice('--out='.length));
    } else {
      throw Object.assign(new Error('Unknown option.'), { code: 'INVALID_ARGUMENTS' });
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const { target, receipt } = build(parse(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ package: target, revision: receipt.revision, dirty: receipt.dirty, files: receipt.files.length })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message } })}\n`);
    process.exitCode = 1;
  }
}
