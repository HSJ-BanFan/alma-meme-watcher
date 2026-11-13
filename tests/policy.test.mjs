import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PLAYFULNESS, getPolicy, setPolicy } from '../src/policy/policy.mjs';

const cli = fileURLToPath(new URL('../scripts/meme-policy.mjs', import.meta.url));

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'meme-policy-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function config(t, text) {
  const almaHome = temporary(t);
  const path = join(almaHome, 'state', 'meme_tone.json');
  mkdirSync(join(almaHome, 'state'));
  if (text !== undefined) writeFileSync(path, text);
  return { almaHome, path };
}

function command(argv, cwd) {
  return spawnSync(process.execPath, [cli, ...argv], { cwd, encoding: 'utf8' });
}

test('get defaults to 45 with visible reasons and never initializes a missing config root', (t) => {
  const almaHome = join(temporary(t), 'missing');
  assert.equal(DEFAULT_PLAYFULNESS, 45);
  assert.deepEqual(getPolicy({ almaHome }), { playfulness: 45, source: 'default', reason: 'missing_config' });
  assert.equal(existsSync(almaHome), false);
  const expectedDefault = getPolicy({ almaHome: join(homedir(), '.config', 'alma') });
  assert.deepEqual(getPolicy(), expectedDefault);
});

test('get preserves legacy int conversion, truncation and clamping without touching bytes', (t) => {
  const { almaHome, path } = config(t);
  for (const [value, expected] of [[0, 0], [100, 100], [45.9, 45], [-4.8, 0], [999, 100], [' +065 ', 65], ['1_0', 10], [true, 1], [false, 0], ['9999999999999999999999999', 100]]) {
    const text = JSON.stringify({ playfulness: value, unknown: 'preserved' });
    writeFileSync(path, text);
    assert.deepEqual(getPolicy({ almaHome }), { playfulness: expected, source: 'config' });
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.deepEqual(readdirSync(join(almaHome, 'state')), ['meme_tone.json']);
  }
});

test('get exposes corrupt, unreadable and invalid-value defaults without repair', (t) => {
  const { almaHome, path } = config(t);
  for (const [text, reason] of [['{', 'corrupt_config'], ['[]', 'corrupt_config'], ['null', 'corrupt_config'], ['{}', 'missing_playfulness'], ['{"playfulness":null}', 'invalid_playfulness'], ['{"playfulness":"45.8"}', 'invalid_playfulness'], ['{"playfulness":""}', 'invalid_playfulness'], ['{"playfulness":{}}', 'invalid_playfulness']]) {
    writeFileSync(path, text);
    assert.deepEqual(getPolicy({ almaHome }), { playfulness: 45, source: 'default', reason });
    assert.equal(readFileSync(path, 'utf8'), text);
  }
  rmSync(path);
  mkdirSync(path);
  assert.deepEqual(getPolicy({ almaHome }), { playfulness: 45, source: 'default', reason: 'unreadable_config' });
});

test('set preserves unknown object keys and atomically replaces only the policy file', (t) => {
  const { almaHome, path } = config(t, '{"playfulness":45,"theme":{"nested":true},"__proto__":{"keep":1}}');
  for (const value of [0, 100, 45]) {
    assert.deepEqual(setPolicy(value, { almaHome }), { playfulness: value, source: 'config' });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), JSON.parse(`{"playfulness":${value},"theme":{"nested":true},"__proto__":{"keep":1}}`));
    assert.deepEqual(readdirSync(join(almaHome, 'state')), ['meme_tone.json']);
  }
});

test('set rejects malformed and non-object policy without losing original data or leaving temporary files', (t) => {
  const { almaHome, path } = config(t);
  for (const text of ['{', '[]', 'null', '"foreign setting"', '42']) {
    writeFileSync(path, text);
    assert.throws(() => setPolicy(70, { almaHome }), { code: 'INVALID_POLICY' });
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.deepEqual(readdirSync(join(almaHome, 'state')), ['meme_tone.json']);
  }
});

test('invalid setters do not create a directory and an existing lock is not stolen', (t) => {
  const almaHome = join(temporary(t), 'missing');
  for (const value of [-1, 101, 45.1, '45', NaN, Infinity, undefined, null, true]) {
    assert.throws(() => setPolicy(value, { almaHome }), { code: 'INVALID_PLAYFULNESS' });
    assert.equal(existsSync(almaHome), false);
  }
  const existing = config(t, '{"playfulness":23,"foreign":true}');
  writeFileSync(`${existing.path}.lock`, 'other writer');
  assert.throws(() => setPolicy(80, existing), { code: 'POLICY_LOCKED' });
  assert.equal(readFileSync(existing.path, 'utf8'), '{"playfulness":23,"foreign":true}');
  assert.equal(readFileSync(`${existing.path}.lock`, 'utf8'), 'other writer');
});

test('the policy CLI uses the Alma config root from an unrelated cwd and reports faults separately', (t) => {
  const cwd = temporary(t);
  const almaHome = join(temporary(t), 'alternate config');
  let result = command(['get', `--alma-home=${almaHome}`], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { playfulness: 45, source: 'default', reason: 'missing_config' });
  assert.equal(existsSync(almaHome), false);
  result = command(['set', '65', '--alma-home', almaHome], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { playfulness: 65, source: 'config' });
  result = command(['get', '--alma-home', almaHome], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).playfulness, 65);
  const path = join(almaHome, 'state', 'meme_tone.json');
  const before = readFileSync(path);
  for (const argv of [['set', '101'], ['set', '45.1'], ['get', '1'], ['set'], ['tone'], ['get', '--other'], ['get', '--alma-home']]) {
    result = command([...argv, `--alma-home=${almaHome}`], cwd);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(typeof JSON.parse(result.stderr).error.code, 'string');
    assert.deepEqual(readFileSync(path), before);
  }
});

test('concurrent canonical setters preserve unknown settings and publish a complete JSON object', async (t) => {
  const { almaHome, path } = config(t, '{"playfulness":45,"foreign":{"keep":true}}');
  const run = (value) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'set', String(value), '--alma-home', almaHome]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const results = await Promise.all([run(20), run(80)]);
  assert.ok(results.some((result) => result.status === 0));
  for (const result of results) {
    if (result.status === 0) assert.equal(JSON.parse(result.stdout).source, 'config');
    else assert.equal(JSON.parse(result.stderr).error.code, 'POLICY_LOCKED');
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok([20, 80].includes(data.playfulness));
  assert.deepEqual(data.foreign, { keep: true });
  assert.deepEqual(readdirSync(join(almaHome, 'state')), ['meme_tone.json']);
});
