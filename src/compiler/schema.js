const text = (description, nonempty = false) => ({
  type: 'string',
  description,
  ...(nonempty ? { minLength: 1, pattern: '\\S' } : {}),
});

export const memeEntrySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['term', 'aliases', 'meaning', 'usage_context', 'avoid_when', 'origin', 'source_url', 'ttl_days', 'confidence'],
  properties: {
    term: text('词条名，去除首尾空白后不能为空。', true),
    aliases: {
      type: 'array',
      description: '别名，去除首尾空白并按 NFC 和大小写去重；不能含旧格式分隔符、换行或 NUL。',
      items: { type: 'string', minLength: 1, pattern: '^(?!\\s*$)[^,，;；|/\\r\\n\\u0000]+$' },
    },
    meaning: text('明确的中文释义，去除首尾空白后不能为空。', true),
    usage_context: text('适用语境，可以为空；同步时空值保留已有非空值。'),
    avoid_when: text('不适用语境，可以为空；这是使用建议而非来源事实。'),
    origin: text('叙述性出处，与来源 URL 分开保存，可以为空。'),
    source_url: {
      type: 'string',
      format: 'uri',
      description: 'B 站 HTTP(S) 视频完整链接，BV 后十位字母数字或 av 后正整数；允许普通分享参数，运行时规范为 HTTPS www 链接。',
    },
    ttl_days: { type: 'integer', minimum: 0, maximum: 3660, description: '有效天数，0 表示不过期；自动窄规则的本地策略为 90 天。' },
    confidence: { type: 'number', minimum: 0, maximum: 1, description: '有限置信值；自动窄规则使用本地准入策略 0.8，并非实测概率。' },
    published_at: {
      type: 'string',
      anyOf: [{ format: 'date' }, { format: 'date-time' }],
      description: '可选的有效 ISO 日期或带时区的 ISO 日期时间，保留输入字符串。',
    },
  },
};

const aliasSeparator = /[,，;；|/\r\n\0]/u;
const identity = (value) => value.normalize('NFC').trim().toLowerCase();

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function sourceUrl(value) {
  if (typeof value !== 'string') fail('INVALID_SOURCE_URL', 'source_url 必须是 B 站视频链接字符串。');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    fail('INVALID_SOURCE_URL', 'source_url 不是有效 URL。');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname)
    || url.username || url.password || url.port
    || !/^\/video\/(BV[A-Za-z0-9]{10}|av[1-9][0-9]*)\/?$/.test(url.pathname)) {
    fail('INVALID_SOURCE_URL', '只接受无凭据、无非默认端口的 B 站视频完整链接。');
  }
  return `https://www.bilibili.com${url.pathname.replace(/\/$/, '')}`;
}

function validDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  if (match[2] && (+match[2] > 23 || +match[3] > 59 || +match[4] > 59)) return false;
  return new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) === match[1];
}

export function parseMemeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_ENTRY', 'MemeEntry 必须是对象。');
  for (const field of Object.keys(raw)) {
    if (!Object.hasOwn(memeEntrySchema.properties, field)) fail('INVALID_ENTRY', `未知的 MemeEntry 字段 ${field}。`);
  }
  const entry = {};
  for (const field of memeEntrySchema.required) {
    if (!Object.hasOwn(raw, field)) fail('INVALID_ENTRY', `缺少必填字段 ${field}。`);
    if (memeEntrySchema.properties[field].type === 'string') {
      if (typeof raw[field] !== 'string') fail('INVALID_ENTRY', `${field} 必须是字符串。`);
      entry[field] = raw[field].trim();
    }
  }
  if (!entry.term || !entry.meaning) fail('INVALID_ENTRY', 'term 和 meaning 不能为空。');
  if (!Array.isArray(raw.aliases)) fail('INVALID_ENTRY', 'aliases 必须是字符串数组。');
  const seen = new Set();
  entry.aliases = raw.aliases.map((alias) => {
    if (typeof alias !== 'string' || aliasSeparator.test(alias) || !alias.trim()) {
      fail('INVALID_ENTRY', '别名不能为空，也不能含分隔符、换行或 NUL。');
    }
    return alias.trim();
  }).filter((alias) => {
    const key = identity(alias);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!Number.isInteger(raw.ttl_days) || raw.ttl_days < 0 || raw.ttl_days > 3660) fail('INVALID_ENTRY', 'ttl_days 必须是 0..3660 的整数。');
  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
    fail('INVALID_ENTRY', 'confidence 必须是 0..1 的有限数字。');
  }
  entry.ttl_days = raw.ttl_days;
  entry.confidence = raw.confidence;
  entry.source_url = sourceUrl(entry.source_url);
  if (Object.hasOwn(raw, 'published_at')) {
    if (!validDate(raw.published_at)) fail('INVALID_ENTRY', 'published_at 必须是有效 ISO 日期或带时区的 ISO 日期时间。');
    entry.published_at = raw.published_at;
  }
  return entry;
}

const lexicon = {
  エノコログサ: '狗尾草',
  キプフェル: 'Kipfel',
  ブイアールチャット: 'VRChat',
};

const relations = {
  grass: /エノコログサ(?:のスタンプ|を持ってるスタンプ)/u,
  holding: /キプフェルが(?:草|エノコログサ)を持って(?:る|いる|ない|いない)/u,
  original: /投稿者(?<author>[\p{L}\p{N}ー・]+?)が作った[、,]*キプフェルが(?:草|エノコログサ)を持って(?:る|いる)動画/u,
  teasing: /猫が人をからか(?:う|わない)/u,
  character: /猫娘[、,]?キプフェルっていう/u,
  platform: /ブイアールチャットで.+モデル/u,
  model: /モデラー(?<author>[\p{L}\p{N}ー・]+?)さんが作った(?:スリーディー|3D)モデル/u,
  template: /テンプレにして[、,]*他のキャラがエノコログサを持って人をからかうスタンプ/u,
  sharing: /コメント[欄栏]でシェアしてみてください/u,
};

function recognize(transcript) {
  if (typeof transcript !== 'string' || !transcript.trim()) fail('UNSUPPORTED_TRANSCRIPT', '自动提取需要非空日文转录；也可显式提供 Agent entries。');
  const sentences = transcript.normalize('NFC')
    .replace(/」\s*「/g, '。')
    .replace(/[「」]/g, '')
    .split(/[。.!?！？…\r\n]+/u)
    .map((sentence) => sentence.replace(/\s+/g, ''));
  const facts = {};
  for (const [name, pattern] of Object.entries(relations)) {
    const matches = sentences.filter((sentence) => pattern.test(sentence));
    if (!matches.length || matches.some((sentence) => /ない|なかった|ません|ずに/u.test(sentence))) {
      fail('UNSUPPORTED_TRANSCRIPT', `缺少、否定或不支持的日文关系 ${name}；请提供经核实的 Agent entries。`);
    }
    facts[name] = pattern.exec(matches[0]).groups ?? {};
  }
  return facts;
}

export function compileVideo(video, { entries } = {}) {
  if (!video || typeof video !== 'object' || Array.isArray(video)) fail('INVALID_VIDEO', 'video 必须是对象。');
  const source = sourceUrl(video.source_url);
  const videoId = source.split('/').at(-1);
  if (video.bvid !== undefined && (typeof video.bvid !== 'string' || !/^BV[A-Za-z0-9]{10}$/.test(video.bvid) || video.bvid !== videoId)) {
    fail('VIDEO_ID_MISMATCH', 'bvid 必须与 source_url 中的 BV 身份一致，不能猜测 av 与 BV 的对应关系。');
  }
  if (video.aid !== undefined && (typeof video.aid !== 'string' || !/^[1-9][0-9]*$/.test(video.aid))) {
    fail('INVALID_VIDEO', 'aid 必须保留为正整数数字字符串。');
  }
  if (videoId.startsWith('av') && video.aid !== undefined && video.aid !== videoId.slice(2)) fail('VIDEO_ID_MISMATCH', 'aid 与 av 视频链接不一致。');
  if (entries !== undefined) {
    if (!Array.isArray(entries) || entries.length === 0) fail('INVALID_BATCH', 'entries 必须是非空数组。');
    return entries.map((raw) => {
      const entry = parseMemeEntry(raw);
      if (entry.source_url !== source) fail('SOURCE_MISMATCH', 'entries 的 source_url 必须属于传入 video。');
      return entry;
    });
  }
  const title = typeof video.title === 'string' && /^(.+?)是什么梗(?:【[^】]+】)?$/u.exec(video.title.trim());
  if (!title) fail('INVALID_VIDEO', '自动提取只支持“词条是什么梗【栏目】”标题。');
  const facts = recognize(video.raw_transcript_ja);
  const grass = lexicon.エノコログサ;
  const character = lexicon.キプフェル;
  const platform = lexicon.ブイアールチャット;
  return [parseMemeEntry({
    term: title[1],
    aliases: [`猫娘拿${grass}`, `${character}逗人`, '逗猫草表情包', '反向逗猫'],
    meaning: `指 ${platform} 猫娘角色 ${character} 手持${grass}、由猫反过来逗人的表情包；这一姿态也被其他角色复用为二创模板。`,
    usage_context: '用于评论区分享、卖萌和友善地逗弄对方。',
    avoid_when: '严肃讨论、求助、维权或诉苦等需要认真回应的场景不要使用。',
    origin: `原始视频由投稿者${facts.original.author}制作。${character} 是建模者${facts.model.author}创作的 ${platform} 3D 猫娘模型，拿草逗人的姿态随后成为其他角色的表情包模板。`,
    source_url: source,
    ttl_days: 90,
    confidence: 0.8,
    ...(video.published_at !== undefined ? { published_at: video.published_at } : {}),
  })];
}
