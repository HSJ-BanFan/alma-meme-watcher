import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileVideo, parseMemeEntry, memeEntrySchema } from '../src/compiler/schema.js';

const video = JSON.parse(readFileSync(new URL('./fixtures/BV1hNWm6mEkz.json', import.meta.url), 'utf8'));
const [seed] = JSON.parse(readFileSync(new URL('../data/seed-memes.json', import.meta.url), 'utf8'));
const fields = ['term', 'aliases', 'meaning', 'usage_context', 'avoid_when', 'origin', 'source_url', 'ttl_days', 'confidence'];
const failsWith = (code) => (error) => error.code === code && typeof error.message === 'string';

function freeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freeze(child);
  }
  return Object.freeze(value);
}

test('the public schema declares the nine-field entry and optional publication date', () => {
  assert.deepEqual(memeEntrySchema.required, fields);
  assert.equal(memeEntrySchema.type, 'object');
  assert.equal(memeEntrySchema.additionalProperties, false);
  for (const field of Object.keys(seed)) {
    assert.equal(typeof memeEntrySchema.properties[field].description, 'string');
    assert.equal(memeEntrySchema.properties[field].type, Array.isArray(seed[field]) ? 'array' : typeof seed[field] === 'number' && field === 'ttl_days' ? 'integer' : typeof seed[field]);
  }
  assert.equal(memeEntrySchema.properties.ttl_days.maximum, 3660);
  assert.equal(memeEntrySchema.properties.confidence.maximum, 1);
});

test('parsing normalizes a new object without mutation or type coercion', () => {
  const input = freeze({
    ...seed,
    term: ` ${seed.term} `,
    meaning: ' 明确的中文解释 ',
    aliases: [' Kipfel逗人 ', 'kipfel逗人', ' 反向逗猫 '],
    source_url: 'http://m.bilibili.com/video/BV1hNWm6mEkz/?spm_id_from=333.999#reply',
  });
  const before = structuredClone(input);
  const entry = parseMemeEntry(input);
  assert.notEqual(entry, input);
  assert.notEqual(entry.aliases, input.aliases);
  assert.deepEqual(input, before);
  assert.equal(entry.term, seed.term);
  assert.equal(entry.meaning, '明确的中文解释');
  assert.deepEqual(entry.aliases, ['Kipfel逗人', '反向逗猫']);
  assert.equal(entry.source_url, video.source_url);
  assert.equal(entry.published_at, seed.published_at);
  assert.equal(parseMemeEntry({ ...seed, published_at: '2026-11-09T12:30:01.100+08:00' }).published_at, '2026-11-09T12:30:01.100+08:00');
  assert.equal(parseMemeEntry({ ...seed, published_at: '2026-11-09T12:30:01.123456Z' }).published_at, '2026-11-09T12:30:01.123456Z');
  assert.equal(parseMemeEntry({ ...seed, ttl_days: 0, confidence: 0 }).ttl_days, 0);
  assert.equal(parseMemeEntry({ ...seed, ttl_days: 3660, confidence: 1 }).confidence, 1);
});

test('entry validation rejects omitted fields, unsafe aliases, invalid dates and numeric bounds', () => {
  for (const field of fields) {
    const input = { ...seed };
    delete input[field];
    assert.throws(() => parseMemeEntry(input), failsWith('INVALID_ENTRY'), `missing ${field}`);
  }
  const invalid = [
    null, [], { ...seed, extra: true },
    ...['term', 'meaning', 'usage_context', 'avoid_when', 'origin'].map((field) => ({ ...seed, [field]: 2 })),
    { ...seed, term: ' ' }, { ...seed, meaning: '\n' },
    ...[-1, 3661, 1.5, '90'].map((ttl_days) => ({ ...seed, ttl_days })),
    ...[-0.1, 1.1, NaN, Infinity, '0.8'].map((confidence) => ({ ...seed, confidence })),
    { ...seed, aliases: 'Kipfel逗人' }, { ...seed, aliases: [2] },
    ...[',', '，', ';', '；', '|', '/', '\n', '\r', '\0'].map((separator) => ({ ...seed, aliases: [`猫${separator}人`] })),
    { ...seed, aliases: [' '] },
    ...['2026-02-30', '2026-13-01', 'tomorrow', '2026-11-09T25:00:00Z', 3].map((published_at) => ({ ...seed, published_at })),
  ];
  for (const input of invalid) assert.throws(() => parseMemeEntry(input), failsWith('INVALID_ENTRY'));
});

test('sources accept normal full video share URLs but reject unrelated or deceptive URLs', () => {
  assert.equal(parseMemeEntry({ ...seed, source_url: 'https://bilibili.com/video/av42/?from=search' }).source_url, 'https://www.bilibili.com/video/av42');
  const invalid = [
    'https://example.com/video/BV1hNWm6mEkz',
    'https://www.bilibili.com.evil.test/video/BV1hNWm6mEkz',
    'https://user:password@www.bilibili.com/video/BV1hNWm6mEkz',
    'https://www.bilibili.com:444/video/BV1hNWm6mEkz',
    'https://www.bilibili.com/read/BV1hNWm6mEkz',
    'https://www.bilibili.com/video/BV123',
    'https://www.bilibili.com/video/av0',
    'https://b23.tv/unknown',
    'file:///video/BV1hNWm6mEkz',
    'not a URL',
  ];
  for (const source_url of invalid) assert.throws(() => parseMemeEntry({ ...seed, source_url }), failsWith('INVALID_SOURCE_URL'));
});

test('the real Japanese fixture yields grounded Chinese facts rather than the gold sample prose', () => {
  const input = freeze(structuredClone(video));
  const before = structuredClone(input);
  const [entry] = compileVideo(input);
  assert.deepEqual(input, before);
  assert.equal(entry.term, seed.term);
  assert.equal(entry.source_url, seed.source_url);
  for (const field of fields) assert.equal(Array.isArray(entry[field]) ? 'array' : typeof entry[field], Array.isArray(seed[field]) ? 'array' : typeof seed[field]);
  for (const alias of seed.aliases) assert.ok(entry.aliases.includes(alias), alias);
  assert.match(entry.meaning, /狗尾草/);
  assert.match(entry.meaning, /Kipfel/);
  assert.match(entry.meaning, /猫.*逗.*人/);
  assert.match(entry.meaning, /模板|二创/);
  assert.doesNotMatch(entry.meaning, /双手|上下|竖直|垂直/);
  assert.notEqual(entry.meaning, seed.meaning);
  assert.match(entry.origin, /リリアミオ/);
  assert.match(entry.origin, /ムクミ/);
  assert.match(entry.origin, /VRChat/);
  assert.match(entry.usage_context, /评论区.*分享|分享.*评论区/);
  assert.match(entry.avoid_when, /严肃|求助/);
  assert.equal(entry.ttl_days, 90);
  assert.equal(entry.confidence, 0.8);
});

test('title, source identity and named authors are derived without a fixture answer cache', () => {
  const changed = {
    ...video,
    title: '猫猫逗你是什么梗【另一个栏目】',
    bvid: 'BV2abcdefghK',
    aid: '123456789012345678',
    source_url: 'https://www.bilibili.com/video/BV2abcdefghK/?share_source=copy',
    raw_transcript_ja: video.raw_transcript_ja.replaceAll('リリアミオ', 'サクラ').replaceAll('ムクミ', 'アオイ'),
  };
  const [entry] = compileVideo(changed);
  assert.equal(entry.term, '猫猫逗你');
  assert.equal(entry.source_url, 'https://www.bilibili.com/video/BV2abcdefghK');
  assert.match(entry.origin, /サクラ/);
  assert.match(entry.origin, /アオイ/);
  assert.doesNotMatch(entry.origin, /リリアミオ|ムクミ/);
  assert.equal(changed.aid, '123456789012345678');
  assert.throws(() => compileVideo({ ...video, bvid: changed.bvid }), failsWith('VIDEO_ID_MISMATCH'));
  assert.throws(() => compileVideo({ ...video, aid: 123 }), failsWith('INVALID_VIDEO'));
});

test('missing, unsupported and negated required sentence relations explicitly fail', () => {
  const replacements = [
    ['エノコログサ', 'シロツメクサ'],
    ['キプフェルが草を持ってる', 'キプフェルが寝てる'],
    ['猫が人をからかう', '人が猫をからかう'],
    ['ブイアールチャット', '別のゲーム'],
    ['投稿者リリアミオが作った', '投稿者リリアミオが紹介した'],
    ['ムクミさんが作った', 'ムクミさんが紹介した'],
    ['テンプレにして', '話題にして'],
    ['コメント栏でシェアしてみてください', 'コメント栏を読んでください'],
    ['キプフェルが草を持ってる', 'キプフェルが草を持ってない'],
    ['猫が人をからかう', '猫が人をからかわない'],
    ['猫が人をからかう', '猫が人をからかうわけではない'],
    ['色々作ったんですよ', '色々作っていないんですよ'],
    ['ムクミさんが作った', 'ムクミさんが作ったわけではない'],
  ];
  for (const [from, to] of replacements) {
    assert.ok(video.raw_transcript_ja.includes(from));
    assert.throws(() => compileVideo({ ...video, raw_transcript_ja: video.raw_transcript_ja.replaceAll(from, to) }), failsWith('UNSUPPORTED_TRANSCRIPT'), to);
  }
  for (const raw_transcript_ja of ['', undefined, 'エノコログサ キプフェル 猫 人 ブイアールチャット ムクミ テンプレ コメント']) {
    assert.throws(() => compileVideo({ ...video, raw_transcript_ja }), failsWith('UNSUPPORTED_TRANSCRIPT'));
  }
  assert.throws(() => compileVideo({ ...video, raw_transcript_ja: `${video.raw_transcript_ja}。猫が人をからかうわけではない。` }), failsWith('UNSUPPORTED_TRANSCRIPT'));
});

test('explicit Agent entries skip extraction but retain identical schema and video source checks', () => {
  const input = freeze([{ ...seed, meaning: '由 Agent 提供的明确释义。' }]);
  const unsupported = { source_url: video.source_url, bvid: video.bvid, aid: video.aid };
  const entries = compileVideo(unsupported, { entries: input });
  assert.equal(entries[0].meaning, input[0].meaning);
  assert.equal(entries[0].published_at, seed.published_at);
  assert.notEqual(entries[0], input[0]);
  assert.throws(() => compileVideo(unsupported, { entries: [] }), failsWith('INVALID_BATCH'));
  assert.throws(() => compileVideo(unsupported, { entries: [{ ...seed, confidence: '0.9' }] }), failsWith('INVALID_ENTRY'));
  assert.throws(() => compileVideo(unsupported, { entries: [{ ...seed, source_url: 'https://www.bilibili.com/video/av42' }] }), failsWith('SOURCE_MISMATCH'));
});
