import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const skill = readFileSync(new URL('../skills/meme-use/SKILL.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

test('generic skill discovery metadata exposes all four invocation branches', () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, 'Skill must have discoverable frontmatter.');
  assert.match(frontmatter[1], /^name: meme-use$/m);
  const description = frontmatter[1].match(/^description: (.+)$/m)?.[1];
  assert.ok(description);
  for (const branch of ['optional slang lookup in desktop chat', 'after reading community content', 'explicit meaning or source question', 'user corrects slang usage']) {
    assert.ok(description.includes(branch), `Missing discovery branch ${branch}`);
  }
  assert.doesNotMatch(frontmatter[1], /disable-model-invocation: true/);
  assert.match(frontmatter[1], /allowed-tools:\n  - ToolSearch\n  - Read\n  - Bash/);
});

test('skill contract names the unchanged public lookup envelopes and installed-path fallback', () => {
  for (const contract of ['plugin--alma-meme-watcher--meme_watch_lookup', '{text, limit?}', '{ok:true, terms}', '{ok:false, code, message}', '{terms:[]}', '{error:{code,message}}', 'scripts/lookup.mjs', 'homedir()/.config/alma', 'state/meme_tone.json', 'playfulness=0']) {
    assert.ok(skill.includes(contract), `Missing public contract ${contract}`);
  }
  const migrationDoc = readFileSync(new URL('../docs/integration-migration.md', import.meta.url), 'utf8');
  assert.match(migrationDoc, /installation and natural-language checks are pending/);
});

test('partial Python fixtures remain data rather than importable source modules', () => {
  const files = readdirSync(new URL('./fixtures/integration-community/', import.meta.url));
  assert.equal(files.filter((file) => file.endsWith('.py')).length, 0);
  assert.equal(files.filter((file) => file.endsWith('.py.txt')).length, 10);
});
