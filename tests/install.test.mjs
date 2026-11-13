import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const scripts = join(import.meta.dirname, '..', 'scripts');
const pack = join(scripts, 'package-plugin.mjs');
const install = join(scripts, 'install-plugin.mjs');

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'meme-install-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 60000 });
  return { status: result.status, stderr: result.stderr, json: result.stdout ? JSON.parse(result.stdout) : null };
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const local = (path) => path.split('/').join(sep);
const receiptOf = (packageDir) => JSON.parse(readFileSync(join(packageDir, 'package-receipt.json'), 'utf8'));

function workspaceWithPackage(t) {
  const workspace = temporary(t);
  const out = join(workspace, 'dist');
  const built = run(pack, [`--out=${out}`], workspace);
  assert.equal(built.status, 0, built.stderr);
  return { workspace, out, packageDir: join(out, 'alma-meme-watcher'), home: join(workspace, 'alma') };
}

test('packaging twice yields identical receipts and file hashes', (t) => {
  const workspace = temporary(t);
  const first = run(pack, [`--out=${join(workspace, 'one')}`], workspace);
  const second = run(pack, [`--out=${join(workspace, 'two')}`], workspace);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const one = receiptOf(join(workspace, 'one', 'alma-meme-watcher'));
  const two = receiptOf(join(workspace, 'two', 'alma-meme-watcher'));
  assert.deepEqual(one, two);
  assert.equal(Object.hasOwn(one, 'createdAt'), false);
  const paths = one.files.map(({ path }) => path);
  assert.deepEqual(paths, [...paths].sort());
  for (const path of ['main.js', 'manifest.json', 'src/lookup/errors.js', 'scripts/lookup.mjs']) {
    assert.ok(paths.includes(path), `${path} is packaged`);
    assert.equal(sha(join(workspace, 'one', 'alma-meme-watcher', local(path))), one.files.find((file) => file.path === path).sha256);
  }
});

test('plan reports the action and writes nothing', (t) => {
  const { workspace, packageDir, home } = workspaceWithPackage(t);
  const planned = run(install, [`--alma-home=${home}`, `--package=${packageDir}`], workspace);
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(planned.json.planned, 'install');
  assert.equal(existsSync(home), false);
});

test('apply copies the package, reports its revision and repeats as a no-op', (t) => {
  const { workspace, packageDir, home } = workspaceWithPackage(t);
  const receipt = receiptOf(packageDir);
  const first = run(install, [`--alma-home=${home}`, `--package=${packageDir}`, '--apply'], workspace);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.action, 'installed');
  assert.equal(first.json.revision, receipt.revision);
  const target = join(home, 'plugins', 'alma-meme-watcher');
  for (const file of receipt.files) assert.equal(sha(join(target, local(file.path))), file.sha256);
  assert.equal(existsSync(join(target, '.install-receipt.json')), true);
  const again = run(install, [`--alma-home=${home}`, `--package=${packageDir}`, '--apply'], workspace);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.action, 'unchanged');
  assert.equal(existsSync(join(home, '_backup')), false);
});

test('a changed install is backed up once and rollback restores it', (t) => {
  const { workspace, packageDir, home } = workspaceWithPackage(t);
  assert.equal(run(install, [`--alma-home=${home}`, `--package=${packageDir}`, '--apply'], workspace).status, 0);
  const target = join(home, 'plugins', 'alma-meme-watcher');
  const localEdit = `${readFileSync(join(target, 'main.js'), 'utf8')}\n// local edit\n`;
  writeFileSync(join(target, 'main.js'), localEdit);
  const replaced = run(install, [`--alma-home=${home}`, `--package=${packageDir}`, '--apply'], workspace);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(replaced.json.action, 'reinstalled');
  assert.ok(replaced.json.backup);
  assert.equal(sha(join(target, 'main.js')), receiptOf(packageDir).files.find((file) => file.path === 'main.js').sha256);
  assert.equal(readdirSync(join(home, '_backup')).length, 1);
  const restored = run(install, [`--alma-home=${home}`, `--rollback=${replaced.json.backup}`], workspace);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(readFileSync(join(target, 'main.js'), 'utf8'), localEdit);
  assert.deepEqual(readdirSync(join(home, '_backup')), []);
});

test('uninstall removes a verified install and refuses a directory it did not create', (t) => {
  const { workspace, packageDir, home } = workspaceWithPackage(t);
  assert.equal(run(install, [`--alma-home=${home}`, `--package=${packageDir}`, '--apply'], workspace).status, 0);
  const removed = run(install, [`--alma-home=${home}`, '--uninstall'], workspace);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(removed.json.action, 'uninstalled');
  assert.equal(existsSync(join(home, 'plugins', 'alma-meme-watcher')), false);

  const foreignHome = join(workspace, 'foreign');
  const foreign = join(foreignHome, 'plugins', 'alma-meme-watcher');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, 'keep.txt'), 'mine');
  const refused = run(install, [`--alma-home=${foreignHome}`, '--uninstall'], workspace);
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stderr).error.code, 'REFUSE_UNKNOWN_TARGET');
  assert.equal(readFileSync(join(foreign, 'keep.txt'), 'utf8'), 'mine');
  const refusedApply = run(install, [`--alma-home=${foreignHome}`, `--package=${packageDir}`, '--apply'], workspace);
  assert.equal(refusedApply.status, 1);
  assert.equal(JSON.parse(refusedApply.stderr).error.code, 'REFUSE_UNKNOWN_TARGET');
});

test('a package that disagrees with its own receipt is refused before any change', (t) => {
  const { workspace, packageDir, home } = workspaceWithPackage(t);
  writeFileSync(join(packageDir, 'main.js'), '// tampered package\n');
  const result = run(install, [`--alma-home=${home}`, `--package=${packageDir}`, '--apply'], workspace);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'PACKAGE_INVALID');
  assert.equal(existsSync(join(home, 'plugins', 'alma-meme-watcher')), false);
});
