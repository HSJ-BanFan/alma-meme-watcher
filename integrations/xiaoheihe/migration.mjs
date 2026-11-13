import { createHash, randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const ownedFiles = new Set(['community_facade.py', 'xhh_tool.py', 'community_bindings.py', 'meme_inject.py', 'meme_radar.py']);
const legacyHashes = {
  'meme_inject.py': new Set(['a26d14aa3607b992389a49cc8fb5c673a9ab7b3bbd1ca529627ebab5a2143292', 'd8707c95a2ff247838947b37c571479ddc69a2aa6f7b3e0e849a508ee89e83ee']),
  'meme_radar.py': new Set(['17c7c012b12b16b52252b0677bb46b53ad448d7bd7135e34da28277c5a2df68b', '5e97528d9fdb1e38c66b322a538068b4b6042e341c0537b569d1b37683c18216']),
};
const catalogDetail = String.raw`    def _catalog_detail(self, detail: dict) -> dict:
        if self.catalog is False:
            return {}
        post = detail["post"]
        text = "\n".join([post["title"], post["body"]] + [node["text"] for node in detail["nodes"]])
        return self._knowledge(text)

`;
const memeNotes = String.raw`def _meme_notes(text: str, link_id: str = "") -> list[str]:
    try:
        from community_bindings import PublicKnowledge
        return ["〔词条〕%s：%s" % (card["term"], card["meaning"]) for card in PublicKnowledge().lookup(text)]
    except Exception:
        return ["knowledge_unavailable"]


`;

function fault(code, message) {
  return Object.assign(new Error(message), { code });
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function replaceOnce(text, before, after) {
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) {
    throw fault('UNSUPPORTED_SOURCE', `Expected one recognized block: ${before.split('\n')[0]}`);
  }
  return text.replace(before, after);
}

function shim(plan) {
  return `import argparse
import subprocess
from pathlib import Path

PLUGIN_ROOT = Path(${JSON.stringify(plan.pluginRoot.replaceAll('\\', '/'))})
ALMA_HOME = Path(${JSON.stringify(plan.almaHome.replaceAll('\\', '/'))})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("lookup", "get", "set", "tone", "scale"))
    parser.add_argument("value", nargs="*")
    parser.add_argument("--limit", type=int, default=3)
    parser.add_argument("--alma-home", type=Path, default=ALMA_HOME)
    args = parser.parse_args()
    if args.operation == "lookup":
        if not args.value:
            parser.error("lookup requires text")
        command = ["node", str(PLUGIN_ROOT / "scripts" / "lookup.mjs"),
                   "--text=" + " ".join(args.value), "--limit", str(args.limit),
                   "--db", str(args.alma_home / "state" / "meme_radar.db")]
    else:
        if (args.operation == "get" and args.value) or len(args.value) > 1:
            parser.error("get takes no value; set, tone and scale take one integer")
        if args.operation == "set" and not args.value:
            parser.error("set requires an integer in 0..100")
        operation = "set" if args.value else "get"
        command = ["node", str(PLUGIN_ROOT / "scripts" / "meme-policy.mjs"), operation,
                   *args.value, "--alma-home", str(args.alma_home)]
    return subprocess.run(command, stdin=subprocess.DEVNULL, shell=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
`;
}

function transform(path, bytes, plan) {
  let text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw fault('UNSUPPORTED_SOURCE', `${path} is not UTF-8.`);
  const crlf = text.includes('\r\n');
  if (crlf && text.replaceAll('\r\n', '').includes('\n')) throw fault('UNSUPPORTED_SOURCE', `${path} has mixed line endings.`);
  text = text.replaceAll('\r\n', '\n');
  if (text.includes('\r')) throw fault('UNSUPPORTED_SOURCE', `${path} has unsupported line endings.`);
  if (path === 'community_facade.py') {
    if (text.includes('    def _catalog_detail(')) {
      text = replaceOnce(text, catalogDetail, '');
      text = replaceOnce(text, '"target_currently_observed": target_seen, "knowledge": self._catalog_detail(detail)}', '"target_currently_observed": target_seen}');
      const scanCall = '                            self._catalog_detail(detail)\n';
      if (text.includes(scanCall)) text = replaceOnce(text, scanCall, '');
    }
    if (/\b_catalog_detail\b/.test(text) || !text.includes('"target_currently_observed": target_seen}') || !text.includes('knowledge = self._knowledge(query)')) {
      throw fault('UNSUPPORTED_SOURCE', 'Unrecognized facade read or explicit knowledge shape.');
    }
  } else if (path === 'xhh_tool.py') {
    if (text.includes('def _meme_notes(')) {
      text = replaceOnce(text, memeNotes, '');
      for (const indent of ['    ', '        ']) {
        const block = `${indent}notes = _meme_notes("\\n".join(lines), link_id)\n${indent}if notes:\n${indent}    lines.extend(notes)\n`;
        text = replaceOnce(text, block, '');
      }
    }
    if (/\b_meme_notes\b/.test(text) || !text.includes('def read_post(') || !text.includes('def read_floor(')) {
      throw fault('UNSUPPORTED_SOURCE', 'Unrecognized post or floor read shape.');
    }
  } else if (path === 'community_bindings.py') {
    const defaults = text.match(/^        self\.entry = entry or Path\("(?:[^"\\]|\\.)*"\)$/gm) ?? [];
    if (defaults.length !== 1 || !text.includes('class PublicKnowledge:')) {
      throw fault('UNSUPPORTED_SOURCE', 'Unrecognized PublicKnowledge binding.');
    }
    const entry = join(plan.pluginRoot, 'scripts', 'lookup.mjs').replaceAll('\\', '/');
    text = replaceOnce(text, defaults[0], `        self.entry = entry or Path(${JSON.stringify(entry)})`);
  } else if (legacyHashes[path]) {
    const replacement = shim(plan);
    if (text !== replacement && !legacyHashes[path].has(hash(text))) {
      throw fault('UNSUPPORTED_SOURCE', `${path} differs from the supported legacy source or this plan's public shim.`);
    }
    text = replacement;
  }
  return Buffer.from(crlf ? text.replaceAll('\n', '\r\n') : text);
}

function treeFiles(root, prefix = '') {
  const files = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === '__pycache__' || /\.py[co]$/.test(entry.name) || entry.name === '.meme-integration.lock') continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw fault('UNSUPPORTED_SOURCE', `Symlinks are not supported: ${path}`);
    if (entry.isDirectory()) files.push(...treeFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw fault('UNSUPPORTED_SOURCE', `Not a regular source file: ${path}`);
  }
  return files.sort();
}

function planDigest(plan) {
  const { digest, ...body } = plan;
  return hash(JSON.stringify(body));
}

function createPlan(request) {
  if (!request.skillDir) throw fault('INVALID_ARGUMENT', '--skill-dir is required.');
  const inputRoot = resolve(request.skillDir);
  if (lstatSync(inputRoot).isSymbolicLink()) throw fault('UNSUPPORTED_SOURCE', 'The source root cannot be a symlink.');
  const sourceRoot = realpathSync(inputRoot);
  if (!lstatSync(sourceRoot).isDirectory()) throw fault('INVALID_ARGUMENT', 'skill-dir must be a directory.');
  const colocated = basename(dirname(sourceRoot)) === 'skills' ? dirname(dirname(sourceRoot)) : join(homedir(), '.config', 'alma');
  const almaHome = resolve(request.almaHome ?? colocated);
  const pluginRoot = resolve(request.pluginRoot ?? join(almaHome, 'plugins', 'alma-meme-watcher'));
  const plan = { version: 1, sourceRoot, pluginRoot, almaHome, files: [] };
  const files = treeFiles(sourceRoot);
  for (const required of ['community_facade.py', 'xhh_tool.py', 'community_bindings.py']) {
    if (!files.includes(required)) throw fault('UNSUPPORTED_SOURCE', `Missing ${required}.`);
  }
  for (const path of files) {
    const absolute = join(sourceRoot, path);
    const preimage = readFileSync(absolute);
    const postimage = ownedFiles.has(path) ? transform(path, preimage, plan) : preimage;
    const mode = lstatSync(absolute).mode & 0o777;
    const before = { sha256: hash(preimage), mode };
    const after = { sha256: hash(postimage), mode };
    if (!preimage.equals(postimage)) {
      before.content = preimage.toString('base64');
      after.content = postimage.toString('base64');
    }
    plan.files.push({ path, preimage: before, postimage: after });
  }
  plan.digest = planDigest(plan);
  return plan;
}

function loadPlan(path) {
  let plan;
  try {
    plan = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw fault('INVALID_PLAN', `Cannot read saved plan: ${error.message}`);
  }
  if (!plan || plan.version !== 1 || !['sourceRoot', 'pluginRoot', 'almaHome'].every((key) => typeof plan[key] === 'string' && isAbsolute(plan[key])) ||
      !Array.isArray(plan.files) || !plan.files.length || plan.digest !== planDigest(plan)) {
    throw fault('INVALID_PLAN', 'Plan shape or digest is invalid.');
  }
  const seen = new Set();
  for (const record of plan.files) {
    if (!record || typeof record.path !== 'string' || /[\\:]/.test(record.path) || record.path.startsWith('/') ||
        record.path.split('/').some((part) => !part || part === '.' || part === '..') || seen.has(record.path)) {
      throw fault('INVALID_PLAN', 'Plan contains an unsafe or duplicate file path.');
    }
    seen.add(record.path);
    for (const image of [record.preimage, record.postimage]) {
      if (!image || !/^[a-f0-9]{64}$/.test(image.sha256) || !Number.isInteger(image.mode) || image.mode < 0 || image.mode > 0o777) {
        throw fault('INVALID_PLAN', `Invalid image for ${record.path}.`);
      }
    }
    const changed = record.preimage.sha256 !== record.postimage.sha256;
    if (record.preimage.mode !== record.postimage.mode || (changed && !ownedFiles.has(record.path))) {
      throw fault('INVALID_PLAN', `Plan cannot change ${record.path}.`);
    }
    if (changed) {
      for (const image of [record.preimage, record.postimage]) {
        if (typeof image.content !== 'string' || Buffer.from(image.content, 'base64').toString('base64') !== image.content || hash(Buffer.from(image.content, 'base64')) !== image.sha256) {
          throw fault('INVALID_PLAN', `Invalid saved content for ${record.path}.`);
        }
      }
      const expected = transform(record.path, Buffer.from(record.preimage.content, 'base64'), plan);
      if (hash(expected) !== record.postimage.sha256) throw fault('INVALID_PLAN', `Unrecognized change to ${record.path}.`);
    }
  }
  if (!['community_facade.py', 'xhh_tool.py', 'community_bindings.py'].every((path) => seen.has(path))) {
    throw fault('INVALID_PLAN', 'Required source records are missing.');
  }
  return plan;
}

function changes(plan) {
  return plan.files.filter((record) => record.preimage.sha256 !== record.postimage.sha256);
}

function readStates(plan) {
  try {
    if (realpathSync(plan.sourceRoot) !== plan.sourceRoot || JSON.stringify(treeFiles(plan.sourceRoot)) !== JSON.stringify(plan.files.map((record) => record.path).sort())) {
      throw new Error('Source root or file inventory changed.');
    }
  } catch (error) {
    throw fault('SOURCE_DRIFT', error.message);
  }
  return plan.files.map((record) => {
    const path = join(plan.sourceRoot, record.path);
    let stat;
    let digest;
    try {
      stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
      digest = hash(readFileSync(path));
    } catch (error) {
      throw fault('SOURCE_DRIFT', `${record.path}: ${error.message}`);
    }
    if ((stat.mode & 0o777) !== record.preimage.mode || (digest !== record.preimage.sha256 && digest !== record.postimage.sha256)) {
      throw fault('SOURCE_DRIFT', `${record.path} matches neither the preimage nor postimage.`);
    }
    return { record, state: digest === record.preimage.sha256 ? 'preimage' : 'postimage' };
  });
}

function writeExclusive(path, bytes, mode = 0o600) {
  const file = openSync(path, 'wx', mode);
  try {
    writeFileSync(file, bytes);
    fchmodSync(file, mode);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

function atomicReplace(path, bytes, mode) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeExclusive(temporary, bytes, mode);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function separateLocation(path, sourceRoot) {
  let ancestor = resolve(path);
  const suffix = [];
  while (!existsSync(ancestor)) {
    suffix.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw fault('INVALID_ARGUMENT', 'Cannot resolve the output location.');
    ancestor = parent;
  }
  const canonical = join(realpathSync(ancestor), ...suffix);
  const delta = relative(sourceRoot, canonical);
  if (!delta || (!delta.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && delta !== '..' && !isAbsolute(delta))) {
    throw fault('INVALID_ARGUMENT', 'Plans and backups must be outside the skill tree.');
  }
}

function backupPlan(plan, backupDir, allowCreate) {
  if (existsSync(backupDir)) {
    try {
      if (!lstatSync(backupDir).isDirectory() || lstatSync(backupDir).isSymbolicLink()) throw new Error('Backup root must be a regular directory.');
      treeFiles(backupDir);
    } catch (error) {
      throw fault('BACKUP_CONFLICT', error.message);
    }
  }
  const saved = join(backupDir, 'plan.json');
  if (existsSync(saved)) {
    if (loadPlan(saved).digest !== plan.digest) throw fault('BACKUP_CONFLICT', 'Backup belongs to a different plan.');
  } else {
    if (!allowCreate) throw fault('BACKUP_INCOMPLETE', 'Partial source state requires its complete original backup.');
    if (existsSync(backupDir) && readdirSync(backupDir).length) throw fault('BACKUP_CONFLICT', 'Backup directory is not empty.');
    mkdirSync(backupDir, { recursive: true });
    writeExclusive(saved, `${JSON.stringify(plan, null, 2)}\n`);
  }
  for (const record of changes(plan)) {
    const path = join(backupDir, 'preimages', record.path);
    if (existsSync(path)) {
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || hash(readFileSync(path)) !== record.preimage.sha256) {
        throw fault('BACKUP_CONFLICT', `Backup preimage changed: ${record.path}`);
      }
    } else {
      if (!allowCreate) throw fault('BACKUP_INCOMPLETE', `Missing original backup for ${record.path}.`);
      mkdirSync(dirname(path), { recursive: true });
      writeExclusive(path, Buffer.from(record.preimage.content, 'base64'), record.preimage.mode);
    }
  }
}

function withSourceLock(plan, work) {
  const path = join(plan.sourceRoot, '.meme-integration.lock');
  let lock;
  try {
    lock = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    const bytes = readFileSync(path, 'utf8');
    try {
      owner = JSON.parse(bytes);
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || owner.digest !== plan.digest) throw new Error('foreign lock');
      process.kill(owner.pid, 0);
    } catch (probe) {
      if (probe.code === 'ESRCH' && readFileSync(path, 'utf8') === bytes) {
        rmSync(path);
        lock = openSync(path, 'wx', 0o600);
      }
    }
    if (lock === undefined) throw fault('MIGRATION_LOCKED', 'A live or unrecognized migration lock exists.');
  }
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, digest: plan.digest }));
    return work();
  } finally {
    closeSync(lock);
    rmSync(path);
  }
}

function restoreOrApply(plan, backupDir, rollback) {
  separateLocation(backupDir, plan.sourceRoot);
  const states = readStates(plan);
  const hasPostimages = states.some(({ state }) => state === 'postimage');
  backupPlan(plan, backupDir, !rollback && !hasPostimages);
  return withSourceLock(plan, () => {
    const current = readStates(plan);
    let written = 0;
    for (const { record, state } of current) {
      if (record.preimage.sha256 === record.postimage.sha256 || state === (rollback ? 'preimage' : 'postimage')) continue;
      const path = join(plan.sourceRoot, record.path);
      const expected = record[state].sha256;
      if (hash(readFileSync(path)) !== expected) throw fault('SOURCE_DRIFT', `${record.path} changed during migration.`);
      const image = rollback ? record.preimage : record.postimage;
      const bytes = rollback ? readFileSync(join(backupDir, 'preimages', record.path)) : Buffer.from(image.content, 'base64');
      if (rollback && hash(bytes) !== image.sha256) throw fault('BACKUP_CONFLICT', `${record.path} backup changed during rollback.`);
      atomicReplace(path, bytes, image.mode);
      written += 1;
    }
    return { status: rollback ? (written ? 'rolled_back' : 'already_rolled_back') : (written ? (hasPostimages ? 'resumed' : 'applied') : 'already_applied'),
      digest: plan.digest, written, changedFiles: changes(plan).map((record) => record.path) };
  });
}

export function migrateCommunity(request) {
  const operation = request.operation ?? 'plan';
  if (operation === 'plan') {
    const plan = createPlan(request);
    if (request.out) {
      separateLocation(request.out, plan.sourceRoot);
      writeExclusive(resolve(request.out), `${JSON.stringify(plan, null, 2)}\n`);
    }
    return plan;
  }
  if (operation === 'stage') {
    const plan = createPlan(request);
    const temporary = mkdtempSync(join(tmpdir(), 'meme-integration-stage-'));
    const stageDir = join(temporary, 'skill');
    try {
      cpSync(plan.sourceRoot, stageDir, { recursive: true, filter: (path) => basename(path) !== '__pycache__' && !/\.py[co]$/.test(path) && basename(path) !== '.meme-integration.lock' });
      readStates({ ...plan, sourceRoot: stageDir });
      for (const record of changes(plan)) atomicReplace(join(stageDir, record.path), Buffer.from(record.postimage.content, 'base64'), record.postimage.mode);
      const planPath = join(temporary, 'plan.json');
      writeExclusive(planPath, `${JSON.stringify(plan, null, 2)}\n`);
      return { status: 'staged', stageDir, planPath, digest: plan.digest, changedFiles: changes(plan).map((record) => record.path) };
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  if (operation === 'apply') {
    if (!request.planPath || !request.backupDir) throw fault('INVALID_ARGUMENT', 'apply requires --plan and --backup-dir.');
    return restoreOrApply(loadPlan(request.planPath), resolve(request.backupDir), false);
  }
  if (operation === 'rollback') {
    if (!request.backupDir) throw fault('INVALID_ARGUMENT', 'rollback requires --backup-dir.');
    const backupDir = resolve(request.backupDir);
    const plan = loadPlan(join(backupDir, 'plan.json'));
    if (request.planPath && loadPlan(request.planPath).digest !== plan.digest) throw fault('BACKUP_CONFLICT', 'Saved plan and backup disagree.');
    return restoreOrApply(plan, backupDir, true);
  }
  throw fault('INVALID_ARGUMENT', 'Use plan, stage, apply or rollback.');
}
