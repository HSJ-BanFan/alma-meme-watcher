import { randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const DEFAULT_PLAYFULNESS = 45;

function configPath(almaHome) {
  return join(resolve(almaHome ?? join(homedir(), '.config', 'alma')), 'state', 'meme_tone.json');
}

function fault(code, message) {
  return Object.assign(new Error(message), { code });
}

function objectFrom(text) {
  const data = JSON.parse(text);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw fault('INVALID_POLICY', 'Existing policy must be a JSON object.');
  }
  return data;
}

function legacyValue(value) {
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^[+-]?\d(?:_?\d)*$/.test(value.trim())) {
    return Number(value.trim().replaceAll('_', ''));
  }
  return null;
}

export function getPolicy({ almaHome } = {}) {
  const fallback = (reason) => ({ playfulness: DEFAULT_PLAYFULNESS, source: 'default', reason });
  let text;
  try {
    text = readFileSync(configPath(almaHome), 'utf8');
  } catch (error) {
    return fallback(error.code === 'ENOENT' ? 'missing_config' : 'unreadable_config');
  }
  let data;
  try {
    data = objectFrom(text);
  } catch {
    return fallback('corrupt_config');
  }
  if (!Object.hasOwn(data, 'playfulness')) return fallback('missing_playfulness');
  const value = legacyValue(data.playfulness);
  if (value === null) return fallback('invalid_playfulness');
  return { playfulness: Math.max(0, Math.min(100, value)), source: 'config' };
}

export function setPolicy(playfulness, { almaHome } = {}) {
  if (!Number.isInteger(playfulness) || playfulness < 0 || playfulness > 100) {
    throw fault('INVALID_PLAYFULNESS', 'playfulness must be an integer in 0..100.');
  }
  const path = configPath(almaHome);
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw fault('POLICY_LOCKED', 'Another policy setter owns the lock.');
    throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    let data = {};
    let mode = 0o600;
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw fault('INVALID_POLICY', `Cannot read existing policy: ${error.message}`);
    }
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink()) throw fault('INVALID_POLICY', 'Existing policy must be a regular file.');
      mode = stat.mode & 0o777;
      try {
        data = objectFrom(readFileSync(path, 'utf8'));
      } catch (error) {
        throw fault('INVALID_POLICY', `Cannot preserve existing policy: ${error.message}`);
      }
    }
    data.playfulness = playfulness;
    const file = openSync(temporary, 'wx', mode);
    try {
      writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      fchmodSync(file, mode);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    return { playfulness, source: 'config' };
  } finally {
    rmSync(temporary, { force: true });
    closeSync(lock);
    rmSync(lockPath);
  }
}
