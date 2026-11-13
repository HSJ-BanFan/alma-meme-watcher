import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateCommunity } from '../integrations/xiaoheihe/migration.mjs';
import { syncEntries } from '../src/store/radar.js';

const fixture = fileURLToPath(new URL('./fixtures/integration-community', import.meta.url));
const pluginFixture = fileURLToPath(new URL('./fixtures/integration-plugin', import.meta.url));
const probeScript = fileURLToPath(new URL('./fixtures/integration-probe.py', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/migrate-community.mjs', import.meta.url));
const python = process.env.MEME_INTEGRATION_PYTHON ?? 'python';

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function snapshot(root, prefix = '') {
  const files = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '__pycache__' || /\.py[co]$/.test(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, snapshot(root, path));
    else files[path] = { sha256: hash(readFileSync(join(root, path))), mode: lstatSync(join(root, path)).mode & 0o777 };
  }
  return files;
}

function prepare(t, source = fixture) {
  const root = mkdtempSync(join(tmpdir(), 'meme-integration-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skillDir = join(root, 'skills', 'xiaoheihe-community-ops');
  const pluginRoot = join(root, 'plugins', 'alma-meme-watcher');
  cpSync(source, skillDir, { recursive: true, filter: (path) => !path.includes('__pycache__') && !/\.py[co]$/.test(path) });
  for (const file of readdirSync(skillDir)) {
    if (file.endsWith('.py.txt')) renameSync(join(skillDir, file), join(skillDir, file.slice(0, -4)));
  }
  cpSync(pluginFixture, pluginRoot, { recursive: true });
  cpSync(new URL('../scripts/meme-policy.mjs', import.meta.url), join(pluginRoot, 'scripts', 'meme-policy.mjs'));
  mkdirSync(join(pluginRoot, 'src', 'policy'), { recursive: true });
  cpSync(new URL('../src/policy/policy.mjs', import.meta.url), join(pluginRoot, 'src', 'policy', 'policy.mjs'));
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state', 'meme_tone.json'), '{"playfulness":65,"foreign":{"keep":true}}');
  const cwd = join(root, 'unrelated cwd');
  mkdirSync(cwd);
  return { root, skillDir, pluginRoot, almaHome: root, cwd, planPath: join(root, 'migration-plan.json'), backupDir: join(root, 'backup') };
}

function savedPlan(env) {
  return migrateCommunity({ operation: 'plan', ...env, out: env.planPath });
}

function probe(skillDir, { cwd, pluginRoot, compare } = {}) {
  const args = ['-I', '-X', 'utf8', probeScript, skillDir];
  if (pluginRoot) args.push('--plugin-root', pluginRoot);
  if (compare) args.push('--compare', compare);
  const result = spawnSync(python, args, { cwd, encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.stdout, '', result.stderr);
  return { status: result.status, result: JSON.parse(result.stdout), stderr: result.stderr };
}

function successfulProbe(skillDir, options) {
  const output = probe(skillDir, options);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.result.ok, true);
  assert.deepEqual(output.result.implicit_lookup_calls, { read_post: 0, read_floor: 0, facade_detail: 0 });
  assert.deepEqual(output.result.failures, []);
  assert.equal(output.result.plugin_absent_read, 'passed');
  if (options.pluginRoot) {
    assert.equal(output.result.public_knowledge, 'success_no_hit_and_faults');
    assert.equal(output.result.protocol_faults_rejected, 11);
  }
  return output.result;
}

test('staged tone and scale shims preserve valid legacy integers through the real policy CLI', (t) => {
  const env = prepare(t);
  const before = snapshot(env.skillDir);
  const staged = migrateCommunity({ operation: 'stage', ...env });
  t.after(() => rmSync(dirname(staged.stageDir), { recursive: true, force: true }));
  const home = join(env.root, 'isolated process home');
  mkdirSync(home);
  const childEnv = { ...process.env, HOME: home, USERPROFILE: home };
  const policy = join(env.almaHome, 'state', 'meme_tone.json');
  const invoke = (script, operation, token) => spawnSync(python, ['-I', '-X', 'utf8',
    join(staged.stageDir, script), operation, token], { cwd: env.cwd, env: childEnv, encoding: 'utf8', timeout: 10000 });
  for (const script of ['meme_inject.py', 'meme_radar.py']) {
    for (const [operation, token, value] of [['tone', '+65', 65], ['scale', '1_0', 10], ['tone', '  +065  ', 65], ['scale', '1_0_0', 100], ['scale', '-0', 0]]) {
      const result = invoke(script, operation, token);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), { playfulness: value, source: 'config' });
      assert.deepEqual(JSON.parse(readFileSync(policy, 'utf8')), { playfulness: value, foreign: { keep: true } });
    }
    const saved = readFileSync(policy);
    for (const [operation, token] of [['tone', '+101'], ['scale', '6__5'], ['scale', '-1'], ['tone', '65.0']]) {
      const result = invoke(script, operation, token);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.equal(result.stdout, '');
      assert.equal(typeof JSON.parse(result.stderr).error.code, 'string');
      assert.deepEqual(readFileSync(policy), saved);
    }
  }
  assert.equal(existsSync(join(home, '.config', 'alma')), false);
  assert.deepEqual(snapshot(env.skillDir), before);
});

test('ordinary reads reproduce the implicit-lookup defect, then staging removes it without changing the source', (t) => {
  const env = prepare(t);
  const before = snapshot(env.skillDir);
  const policyBefore = readFileSync(join(env.almaHome, 'state', 'meme_tone.json'));
  const red = probe(env.skillDir, { cwd: env.cwd });
  assert.equal(red.status, 1);
  assert.deepEqual(red.result.implicit_lookup_calls, { read_post: 1, read_floor: 1, facade_detail: 1 });
  assert.deepEqual(red.result.failures, ['read_post', 'read_floor', 'facade_detail', 'facade_contains_knowledge', 'post_contains_attachment', 'floor_contains_attachment']);
  const staged = migrateCommunity({ operation: 'stage', ...env });
  t.after(() => rmSync(dirname(staged.stageDir), { recursive: true, force: true }));
  const result = successfulProbe(staged.stageDir, { ...env, compare: env.skillDir });
  assert.ok(result.protected_functions > 0);
  assert.equal(result.unchanged_file_hashes['meme_backfill_avoid.py'], before['meme_backfill_avoid.py'].sha256);
  assert.deepEqual(snapshot(env.skillDir), before);
  assert.deepEqual(readFileSync(join(env.almaHome, 'state', 'meme_tone.json')), policyBefore);
  const replayPlan = migrateCommunity({ operation: 'plan', ...env, skillDir: staged.stageDir });
  assert.ok(replayPlan.files.every((record) => record.preimage.sha256 === record.postimage.sha256));
});

test('the staging CLI works when the temporary directory is a junction or symlink', (t) => {
  const env = prepare(t);
  const physical = join(env.root, 'physical temp');
  const alias = join(env.root, 'temporary alias');
  mkdirSync(physical);
  symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const before = snapshot(env.skillDir);
  const policyBefore = readFileSync(join(env.almaHome, 'state', 'meme_tone.json'));
  const stage = spawnSync(process.execPath, [cli, 'stage', `--skill-dir=${env.skillDir}`,
    `--plugin-root=${env.pluginRoot}`, `--alma-home=${env.almaHome}`], {
    cwd: env.cwd, env: { ...process.env, HOME: env.root, USERPROFILE: env.root,
      TMP: alias, TEMP: alias, TMPDIR: alias }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(stage.error, undefined);
  assert.equal(stage.status, 0, stage.stderr);
  assert.equal(stage.stderr, '');
  const staged = JSON.parse(stage.stdout);
  assert.equal(staged.status, 'staged');
  t.after(() => rmSync(dirname(staged.stageDir), { recursive: true, force: true }));
  successfulProbe(staged.stageDir, { ...env, compare: env.skillDir });
  assert.deepEqual(snapshot(env.skillDir), before);
  assert.deepEqual(readFileSync(join(env.almaHome, 'state', 'meme_tone.json')), policyBefore);
});

test('staging preserves literal replacement characters in plugin and Alma roots', (t) => {
  const script = String.raw`import json, math, runpy, subprocess, sys
from pathlib import Path
extract = runpy.run_path(sys.argv[1])["extract"]
public = extract(Path(sys.argv[2]), "PublicKnowledge", {
    "Path": Path, "ReadProblem": RuntimeError, "subprocess": subprocess, "json": json, "math": math,
})
adapter = public()
assert adapter.entry == Path(sys.argv[3])
assert adapter.db_path == Path(sys.argv[4])
assert adapter.lookup("玉芬啊玉芬")[0]["term"] == "结过婚我也认"
print(json.dumps({"ok": True}))
`;
  for (const field of ['pluginRoot', 'almaHome']) {
    const env = prepare(t);
    const root = join(env.root, "literal $& $$ $' $`");
    if (field === 'pluginRoot') cpSync(env.pluginRoot, root, { recursive: true });
    else mkdirSync(root);
    env[field] = root;
    const stage = spawnSync(process.execPath, [cli, 'stage', `--skill-dir=${env.skillDir}`,
      `--plugin-root=${env.pluginRoot}`, `--alma-home=${env.almaHome}`], {
      cwd: env.cwd, env: { ...process.env, HOME: env.root, USERPROFILE: env.root }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(stage.error, undefined);
    assert.equal(stage.status, 0, stage.stderr);
    assert.equal(stage.stderr, '');
    const staged = JSON.parse(stage.stdout);
    t.after(() => rmSync(dirname(staged.stageDir), { recursive: true, force: true }));
    const result = spawnSync(python, ['-I', '-X', 'utf8', '-c', script, probeScript,
      join(staged.stageDir, 'community_bindings.py'), join(env.pluginRoot, 'scripts', 'lookup.mjs'),
      join(env.almaHome, 'state', 'meme_radar.db')], { cwd: env.cwd, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { ok: true });
    successfulProbe(staged.stageDir, { ...env, compare: env.skillDir });
  }
});

test('planning is deterministic, read-only and binds the plugin to the co-located Alma config root', (t) => {
  const env = prepare(t);
  const before = snapshot(env.skillDir);
  const first = migrateCommunity({ skillDir: env.skillDir });
  const second = migrateCommunity({ operation: 'plan', skillDir: env.skillDir });
  assert.deepEqual(first, second);
  assert.equal(first.pluginRoot, env.pluginRoot);
  assert.equal(first.almaHome, env.almaHome);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.files.filter((record) => record.preimage.sha256 !== record.postimage.sha256).map((record) => record.path),
    ['community_bindings.py', 'community_facade.py', 'meme_inject.py', 'meme_radar.py', 'xhh_tool.py']);
  assert.deepEqual(snapshot(env.skillDir), before);
  assert.equal(existsSync(env.backupDir), false);
  assert.equal(existsSync(env.planPath), false);
});

test('apply backs up every changed preimage, replays, resumes partial state and conditionally rolls back', (t) => {
  const env = prepare(t);
  const before = snapshot(env.skillDir);
  const plan = savedPlan(env);
  const records = plan.files.filter((record) => record.preimage.sha256 !== record.postimage.sha256);
  const applied = migrateCommunity({ operation: 'apply', ...env });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.written, records.length);
  for (const record of records) {
    assert.equal(hash(readFileSync(join(env.backupDir, 'preimages', record.path))), record.preimage.sha256);
    assert.equal(hash(readFileSync(join(env.skillDir, record.path))), record.postimage.sha256);
  }
  successfulProbe(env.skillDir, { ...env, compare: fixture });
  const replay = migrateCommunity({ operation: 'apply', ...env });
  assert.equal(replay.status, 'already_applied');
  assert.equal(replay.written, 0);
  for (const record of records.slice(1)) writeFileSync(join(env.skillDir, record.path), Buffer.from(record.preimage.content, 'base64'));
  const resumed = migrateCommunity({ operation: 'apply', ...env });
  assert.equal(resumed.status, 'resumed');
  assert.equal(resumed.written, records.length - 1);
  writeFileSync(join(env.skillDir, records[0].path), Buffer.from(records[0].preimage.content, 'base64'));
  const rolledBack = migrateCommunity({ operation: 'rollback', ...env });
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(rolledBack.written, records.length - 1);
  assert.deepEqual(snapshot(env.skillDir), before);
  assert.equal(migrateCommunity({ operation: 'rollback', ...env }).status, 'already_rolled_back');
  assert.equal(existsSync(join(env.backupDir, 'plan.json')), true);
  for (const record of records) assert.equal(hash(readFileSync(join(env.backupDir, 'preimages', record.path))), record.preimage.sha256);
});

test('drift in either the last changed file or a protected file rejects apply before any source or backup write', (t) => {
  for (const path of ['xhh_tool.py', 'meme_backfill_avoid.py', 'community_runtime.py', 'foreign_source.py']) {
    const env = prepare(t);
    savedPlan(env);
    writeFileSync(join(env.skillDir, path), 'foreign edit\n');
    const before = snapshot(env.skillDir);
    assert.throws(() => migrateCommunity({ operation: 'apply', ...env }), { code: 'SOURCE_DRIFT' });
    assert.deepEqual(snapshot(env.skillDir), before);
    assert.equal(existsSync(env.backupDir), false);
  }
});

test('replaced source roots and symlinked backup preimages cannot redirect migration writes', (t) => {
  const env = prepare(t);
  savedPlan(env);
  const foreign = join(env.root, 'foreign-source');
  cpSync(env.skillDir, foreign, { recursive: true });
  rmSync(env.skillDir, { recursive: true });
  symlinkSync(foreign, env.skillDir, 'junction');
  const before = snapshot(foreign);
  assert.throws(() => migrateCommunity({ operation: 'apply', ...env }), { code: 'SOURCE_DRIFT' });
  assert.deepEqual(snapshot(foreign), before);
  assert.equal(existsSync(env.backupDir), false);

  const other = prepare(t);
  savedPlan(other);
  migrateCommunity({ operation: 'apply', ...other });
  rmSync(join(other.backupDir, 'preimages'), { recursive: true });
  symlinkSync(other.skillDir, join(other.backupDir, 'preimages'), 'junction');
  const sourceBefore = snapshot(other.skillDir);
  assert.throws(() => migrateCommunity({ operation: 'rollback', ...other }), { code: 'BACKUP_CONFLICT' });
  assert.deepEqual(snapshot(other.skillDir), sourceBefore);
});

test('unsupported helper and caller shapes fail planning before writing a saved plan', (t) => {
  for (const [path, edit] of [
    ['community_facade.py', (text) => `${text}\n    def new_read(self, detail):\n        return self._catalog_detail(detail)\n`],
    ['xhh_tool.py', (text) => text.replace('notes = _meme_notes("\\n".join(lines), link_id)', 'notes = _meme_notes(lines, link_id)')],
    ['meme_inject.py', (text) => `${text}\nforeign_setting = True\n`],
    ['community_bindings.py', (text) => text.replace('        self.runner = runner or subprocess.run',
      '        self.db_path = entry\n        self.runner = runner or subprocess.run')],
  ]) {
    const env = prepare(t);
    writeFileSync(join(env.skillDir, path), edit(readFileSync(join(env.skillDir, path), 'utf8')));
    const before = snapshot(env.skillDir);
    assert.throws(() => savedPlan(env), { code: 'UNSUPPORTED_SOURCE' });
    assert.deepEqual(snapshot(env.skillDir), before);
    assert.equal(existsSync(env.planPath), false);
  }
});

test('a partial source without a complete original backup is detected and not modified', (t) => {
  const env = prepare(t);
  const plan = savedPlan(env);
  const record = plan.files.find((file) => file.preimage.sha256 !== file.postimage.sha256);
  writeFileSync(join(env.skillDir, record.path), Buffer.from(record.postimage.content, 'base64'));
  const before = snapshot(env.skillDir);
  assert.throws(() => migrateCommunity({ operation: 'apply', ...env }), { code: 'BACKUP_INCOMPLETE' });
  assert.deepEqual(snapshot(env.skillDir), before);
  assert.equal(existsSync(env.backupDir), false);
});

test('rollback refuses foreign source edits and altered backups without restoring an earlier file', (t) => {
  const env = prepare(t);
  const plan = savedPlan(env);
  migrateCommunity({ operation: 'apply', ...env });
  const path = join(env.skillDir, 'xhh_tool.py');
  const postimage = readFileSync(path);
  writeFileSync(path, `${postimage.toString()}\nforeign_edit = True\n`);
  const before = snapshot(env.skillDir);
  assert.throws(() => migrateCommunity({ operation: 'rollback', ...env }), { code: 'SOURCE_DRIFT' });
  assert.deepEqual(snapshot(env.skillDir), before);
  writeFileSync(path, postimage);
  const record = plan.files.find((file) => file.preimage.sha256 !== file.postimage.sha256);
  writeFileSync(join(env.backupDir, 'preimages', record.path), 'foreign backup edit');
  const sourceBefore = snapshot(env.skillDir);
  for (const operation of ['apply', 'rollback']) {
    assert.throws(() => migrateCommunity({ operation, ...env }), { code: 'BACKUP_CONFLICT' });
    assert.deepEqual(snapshot(env.skillDir), sourceBefore);
  }
});

test('a changed saved plan digest and a reused foreign backup are rejected without source changes', (t) => {
  const env = prepare(t);
  const plan = savedPlan(env);
  const before = snapshot(env.skillDir);
  writeFileSync(env.planPath, JSON.stringify({ ...plan, pluginRoot: join(env.root, 'foreign-plugin') }));
  assert.throws(() => migrateCommunity({ operation: 'apply', ...env }), { code: 'INVALID_PLAN' });
  assert.deepEqual(snapshot(env.skillDir), before);
  writeFileSync(env.planPath, JSON.stringify(plan));
  mkdirSync(env.backupDir);
  writeFileSync(join(env.backupDir, 'foreign.txt'), 'keep');
  assert.throws(() => migrateCommunity({ operation: 'apply', ...env }), { code: 'BACKUP_CONFLICT' });
  assert.deepEqual(snapshot(env.skillDir), before);
  assert.equal(readFileSync(join(env.backupDir, 'foreign.txt'), 'utf8'), 'keep');
});

test('live migration locks are preserved and a same-plan dead process lock can be recovered', (t) => {
  const env = prepare(t);
  const plan = savedPlan(env);
  const before = snapshot(env.skillDir);
  const path = join(env.skillDir, '.meme-integration.lock');
  const live = JSON.stringify({ pid: process.pid, digest: plan.digest });
  writeFileSync(path, live);
  assert.throws(() => migrateCommunity({ operation: 'apply', ...env }), { code: 'MIGRATION_LOCKED' });
  assert.equal(readFileSync(path, 'utf8'), live);
  rmSync(path);
  assert.deepEqual(snapshot(env.skillDir), before);
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(dead.status, 0);
  writeFileSync(path, JSON.stringify({ pid: dead.pid, digest: plan.digest }));
  assert.equal(migrateCommunity({ operation: 'apply', ...env }).status, 'applied');
  assert.equal(existsSync(path), false);
});

test('the migration CLI defaults to plan and supports stage, explicit apply and rollback from an unrelated cwd', (t) => {
  const env = prepare(t);
  const before = snapshot(env.skillDir);
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: env.cwd, encoding: 'utf8' });
  let output = run([`--skill-dir=${env.skillDir}`, '--plugin-root', env.pluginRoot, '--alma-home', env.almaHome, '--out', env.planPath]);
  assert.equal(output.status, 0, output.stderr);
  assert.match(JSON.parse(output.stdout).digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot(env.skillDir), before);
  output = run(['stage', '--skill-dir', env.skillDir, `--plugin-root=${env.pluginRoot}`, `--alma-home=${env.almaHome}`]);
  assert.equal(output.status, 0, output.stderr);
  const stage = JSON.parse(output.stdout);
  t.after(() => rmSync(dirname(stage.stageDir), { recursive: true, force: true }));
  successfulProbe(stage.stageDir, { ...env, compare: env.skillDir });
  output = run(['apply', '--plan', env.planPath, '--backup-dir', env.backupDir]);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).status, 'applied');
  output = run(['rollback', `--backup-dir=${env.backupDir}`]);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).status, 'rolled_back');
  assert.deepEqual(snapshot(env.skillDir), before);
  for (const args of [['apply'], ['stage', '--skill-dir'], ['apply', '--skill-dir', env.skillDir], ['rollback'], ['deploy'], ['--other']]) {
    output = run(args);
    assert.equal(output.status, 1);
    assert.equal(output.stdout, '');
    assert.equal(JSON.parse(output.stderr).error.code, 'INVALID_ARGUMENT');
    assert.deepEqual(snapshot(env.skillDir), before);
  }
});

test('staged compatibility commands forward explicit lookups and the sole policy setter from an unrelated cwd', (t) => {
  const env = prepare(t);
  const staged = migrateCommunity({ operation: 'stage', ...env });
  t.after(() => rmSync(dirname(staged.stageDir), { recursive: true, force: true }));
  writeFileSync(join(env.cwd, 'community_bindings.py'), 'raise RuntimeError("ambient import")\n');
  const run = (file, args) => spawnSync(python, ['-I', '-X', 'utf8', join(staged.stageDir, file), ...args, '--alma-home', env.almaHome], { cwd: env.cwd, encoding: 'utf8' });
  for (const file of ['meme_radar.py', 'meme_inject.py']) {
    let result = run(file, ['lookup', '玉芬啊玉芬']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).terms[0].term, '结过婚我也认');
    result = run(file, ['lookup', 'unknown']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { terms: [] });
    result = run(file, ['lookup', 'missing_db']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'DATABASE_NOT_FOUND');
  }
  const policyPath = join(env.almaHome, 'state', 'meme_tone.json');
  const before = readFileSync(policyPath);
  let result = run('meme_inject.py', ['tone']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).playfulness, 65);
  assert.deepEqual(readFileSync(policyPath), before);
  result = run('meme_inject.py', ['scale', '20']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(policyPath)), { playfulness: 20, foreign: { keep: true } });
  writeFileSync(policyPath, '{malformed');
  result = run('meme_inject.py', ['set', '30']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_POLICY');
  assert.equal(readFileSync(policyPath, 'utf8'), '{malformed');
});

test('explicit knowledge uses the selected Alma root with the real lookup CLI', (t) => {
  const env = prepare(t);
  const realPluginRoot = fileURLToPath(new URL('..', import.meta.url));
  const home = join(env.root, 'separate process home');
  mkdirSync(home);
  const childEnv = { ...process.env, HOME: home, USERPROFILE: home };
  const dbPath = join(env.almaHome, 'state', 'meme_radar.db');
  const sample = JSON.parse(readFileSync(new URL('../data/seed-memes.json', import.meta.url), 'utf8'))
    .find((entry) => entry.term === '结过婚我也认');
  syncEntries([sample], { dbPath, now: Math.floor(Date.now() / 1000) - 3600 });
  const before = readFileSync(dbPath);
  const realCli = join(realPluginRoot, 'scripts', 'lookup.mjs');
  const direct = spawnSync(process.execPath, [realCli, '--text=玉芬啊玉芬', `--db=${dbPath}`],
    { cwd: env.cwd, env: childEnv, encoding: 'utf8', timeout: 10000 });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stderr, '');
  const expected = JSON.parse(direct.stdout).terms;
  assert.equal(expected.length, 1);
  assert.equal(expected[0].term, '结过婚我也认');
  const staged = migrateCommunity({ operation: 'stage', ...env, pluginRoot: realPluginRoot });
  t.after(() => rmSync(dirname(staged.stageDir), { recursive: true, force: true }));
  const helper = fileURLToPath(new URL('./fixtures/integration-real-knowledge.py', import.meta.url));
  for (const [text, terms] of [['玉芬啊玉芬', expected], ['unknown_real_cli_fixture', []]]) {
    const result = spawnSync(python, ['-I', '-X', 'utf8', helper,
      join(staged.stageDir, 'community_bindings.py'), text],
    { cwd: env.cwd, env: childEnv, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, terms });
  }
  assert.equal(existsSync(join(home, '.config', 'alma')), false);
  assert.deepEqual(readFileSync(dbPath), before);
});

if (process.env.MEME_INTEGRATION_INSTALLED_SKILL) {
  test('installed source passes the copied-tree behavior and protected-function probe without production changes', (t) => {
    const installed = process.env.MEME_INTEGRATION_INSTALLED_SKILL;
    const original = snapshot(installed);
    const env = prepare(t, installed);
    const copyBefore = snapshot(env.skillDir);
    const red = probe(env.skillDir, { cwd: env.cwd });
    assert.equal(red.status, 1);
    assert.deepEqual(red.result.implicit_lookup_calls, { read_post: 1, read_floor: 1, facade_detail: 1 });
    const staged = migrateCommunity({ operation: 'stage', ...env });
    t.after(() => rmSync(dirname(staged.stageDir), { recursive: true, force: true }));
    const green = successfulProbe(staged.stageDir, { ...env, compare: env.skillDir });
    savedPlan(env);
    assert.equal(migrateCommunity({ operation: 'apply', ...env }).status, 'applied');
    successfulProbe(env.skillDir, { ...env, compare: installed });
    assert.equal(migrateCommunity({ operation: 'apply', ...env }).status, 'already_applied');
    assert.equal(migrateCommunity({ operation: 'rollback', ...env }).status, 'rolled_back');
    assert.deepEqual(snapshot(env.skillDir), copyBefore);
    assert.deepEqual(snapshot(installed), original);
    console.log('installed_source_red', JSON.stringify(red.result));
    console.log('installed_source_staged', JSON.stringify(green));
  });
}
