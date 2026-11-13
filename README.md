# alma-meme-watcher

Alma 插件，把调用者提供的 B 站视频转录或 Agent 结构化词条同步到 `meme_radar.db`。目标来源是「梗指南」，`mid=94510621`。目前没有实时监控、投稿下载、字幕采集、音频转写或模型调用。

## 运行环境

需要 Node.js `>=22.13.0`，使用内置 `node:sqlite`，无第三方运行依赖或 Python bridge。本地验证环境为 Node.js `24.20.0`。部分 Node 版本会显示 SQLite 实验性 API 警告。

默认数据库是当前用户的 `~/.config/alma/state/meme_radar.db`。`activate(context, { dbPath })` 可显式指定路径，原有 `activate(context)` 调用仍有效。每个存储操作独立打开并关闭连接，不运行后台任务。

## 编译接口

`src/compiler/schema.js` 导出 `memeEntrySchema`、`parseMemeEntry(raw)` 和 `compileVideo(video, { entries } = {})`。编译与验证都是纯函数，不读文件、不联网、不调用 Alma，也不修改输入。

`MemeEntry` 的九个字段全部必填，不进行类型转换或补齐缺失字段。

| 字段 | 类型与约束 |
| --- | --- |
| `term` | 去除首尾空白的非空字符串 |
| `aliases` | 字符串数组，按 NFC 和大小写去重并保留显示拼写；不能含 `,，;；|/`、换行或 NUL |
| `meaning` | 去除首尾空白的非空中文释义字符串 |
| `usage_context` | 适用语境字符串，可以为空 |
| `avoid_when` | 不适用语境字符串，可以为空 |
| `origin` | 叙述性出处字符串，可以为空，与 URL 分开保存 |
| `source_url` | B 站 HTTP(S) 视频完整链接 |
| `ttl_days` | `0..3660` 的整数，`0` 表示不过期 |
| `confidence` | `0..1` 的有限数字 |

可选 `published_at` 是有效 ISO 日期或带时区的 ISO 日期时间，保留其原始字符串，例如 `2026-11-09`。不接受未声明字段。

视频链接支持 `www.bilibili.com`、`bilibili.com` 和 `m.bilibili.com` 的 `/video/BVxxxxxxxxxx` 或 `/video/av正整数`。普通分享参数和尾部斜杠会被移除，结果统一为 HTTPS www 链接。凭据、非默认端口、其他站点或路径都被拒绝。短链需要调用者先解析为完整视频链接。

如果 `video.bvid` 存在，它必须与链接中的 BV 身份一致。可选 `aid` 必须保持为数字字符串。编译器不猜测 aid 与 BVID 的对应关系。

### 自动提取的窄规则

不传 `entries` 时，`video` 必须含 `source_url`、`title` 和 `raw_transcript_ja`。标题使用“词条是什么梗”或“词条是什么梗【栏目】”形式。

当前规则仅支持日文转录中的狗尾草表情包关系。它要求句子明确支持以下事实。

- エノコログサ是表情包中的草，キプフェル持草。
- 猫逗人，而非只出现猫、人、草等孤立关键词。
- 原视频的具名投稿者、VRChat 猫娘角色和具名模型作者。
- 其他角色复用这一姿态作为模板，并在评论区分享。

词典将 キプフェル译为 Kipfel、ブイアールチャット译为 VRChat，并从标题生成词条名。释义、别名和出处根据这些关系生成，不按视频 ID 或完整标题返回预制答案。转录没有支持的“双手握草”或“上下晃动”不会被添加。

缺失、空白、未知或否定的关键关系会抛出 `UNSUPPORTED_TRANSCRIPT`，而不是猜测释义。自动结果的 `90` 天、`0.8` 置信值和保守使用建议都是本地策略，不是转录事实或实测概率。

### Agent 结构化输入

显式传入非空 `entries` 数组会完全跳过自动提取。它仍要求全部九字段，并核对每条来源是否属于传入视频。其他语言或不支持的主题可由上游 Agent 提供经核实的词条。本插件验证结构与来源身份，不调用模型，也不自动核实自由文本的全部事实。

```js
import { compileVideo, parseMemeEntry } from './src/compiler/schema.js';

const supplied = parseMemeEntry({
	term: '狗尾草表情包',
	aliases: ['Kipfel逗人', '反向逗猫'],
	meaning: '指猫娘拿狗尾草反过来逗人的表情包和二创模板。',
	usage_context: '评论区分享和友善地逗弄对方。',
	avoid_when: '严肃讨论和求助时不使用。',
	origin: '投稿者リリアミオ制作了原视频，角色是ムクミ创作的 Kipfel。',
	source_url: 'https://www.bilibili.com/video/BV1hNWm6mEkz',
	ttl_days: 90,
	confidence: 0.8,
});
const entries = compileVideo({ source_url: supplied.source_url }, { entries: [supplied] });
```

## 存储接口

`src/store/radar.js` 导出三个同步函数。

- `syncEntries(entries, { dbPath, now })` 返回 `{ inserted, updated, unchanged, entries }`。计数按 canonical 连接分量计算，返回条目是实际入库后的 canonical 投影。
- `lookup(text, { dbPath, now, limit = 3 })` 返回包含当前释义、真实来源 URL、额外语境和审核元数据的扁平条目。
- `radarStatus({ dbPath, now })` 返回 `terms`、`candidates`、`eligible`、`last_sync`、`live_watching: false` 和 `audio_transcription: false`。`last_sync` 为 `{ source_url, applied_at }` 或 `null`。

`now` 是 Unix 秒数，默认取当前时间。查询只返回审核状态为 `accepted` 或 `local_reference`、置信值至少 `0.7` 且未过期的词条。TTL 到期条件是 `last_seen + ttl_days * 86400 <= now`，按秒计算。canonical 与别名都支持自然语言匹配，ASCII 词边界使 `Kipfel` 不匹配 `Kipfeler`。结果先按精确匹配排序，再按热度和最近出现时间排序。

读取不存在的数据库返回空查询或零统计，不创建文件或补充表。损坏、不可读的已有数据库会抛出错误。只有同步操作能创建数据库和表。

下面的 ESM 示例在仓库根目录读取提供的实际样本，并明确使用临时数据库。

```js
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileVideo } from './src/compiler/schema.js';
import { syncEntries, lookup, radarStatus } from './src/store/radar.js';

const directory = mkdtempSync(join(tmpdir(), 'meme-radar-demo-'));
const dbPath = join(directory, 'radar.db');
try {
	const video = JSON.parse(readFileSync('./tests/fixtures/BV1hNWm6mEkz.json', 'utf8'));
	console.log(syncEntries(compileVideo(video), { dbPath }));
	console.log(lookup('Kipfel逗人', { dbPath }));
	console.log(radarStatus({ dbPath }));
} finally {
	rmSync(directory, { recursive: true, force: true });
}
```

### 数据库映射与完整性

旧五张表 `terms`、`candidates`、`search_cache`、`term_reviews`、`candidate_reviews` 的列数、顺序和约束不变，旧 positional insert 仍有效。

- `terms` 保存 canonical、分隔文本别名、释义、叙述性出处、置信值和 TTL。更新保留 `first_seen`、`heat`、`example` 和 `tags`。空出处保留已有非空出处。
- `term_reviews` 独立保存当前 `source_url`、审核状态、actor 和审核时间。新或修改的定义使用 `source=meme_watcher`、`local_reference` 和 `meme_watcher:machine`，不冒充人工审核，也不继承旧 MEMORY 来源标签。
- `watcher_entry_meta` 只保存 `usage_context`、`avoid_when` 和可选 `published_at`。空语境保留旧非空值，省略日期保留旧日期。
- `watcher_sync_versions` 保存 canonical、规范视频来源、输入指纹和应用时间。替换旧审核时保存此前的审核快照，不保存第二份权威释义。

身份按 NFC、首尾空白和大小写归一化，连接 canonical 与别名，包括批内别名和已经过期或未准入的旧词条。有旧 canonical 时保持它不变；新分量按归一化词条顺序选择稳定 canonical。别名合并为并集，不丢失旧拼写。桥接多个旧词条抛出 `AMBIGUOUS_IDENTITY`，批内非别名字段冲突抛出 `CONTENT_CONFLICT`，无法表示的新别名抛出 `UNREPRESENTABLE_ALIAS`。

输入指纹不包含当前时间或数据库后来新增的别名。已记录版本重放返回 `unchanged`，不改定义、审核、候选、同步时间或 TTL。A-B-A 重放保留最新 B，原 Python 工具修改后的查询也直接读取当前 `terms` 和 `term_reviews`。旧版本对应的 canonical 被外部删除时抛出 `STALE_VERSION`，不自动复活词条。

整批解析完成后才打开写连接。schema 创建、身份读取、归并计划、定义、审核、额外字段、版本和候选清理都在一个 `IMMEDIATE` 事务中完成。任一步失败会回滚整批。候选仅按 canonical 和合并别名的精确归一化身份清理，不插入 BVID 或 URL 作为 `link_id`，不写 `candidate_reviews`。人工 `rejected` 记录导致 `REVIEW_CONFLICT`，其原因和 actor 不会被覆盖。

## Alma 工具

工具 ID 保持不变。

- `meme_watch_sync` 接收 `{ video, entries? }`，只编译并同步这一批传入数据。成功返回 `{ ok: true, inserted, updated, unchanged, entries }`。
- `meme_watch_status` 无输入，返回真实统计与 `targetMid`。未同步时 `status` 为 `ready_not_synced`，存在成功版本时为 `synced`。它不表示后台监控正在运行。

工具失败返回 `{ ok: false, code, message }`，不伪造成功计数或空状态。模块接口抛出带 `code` 的异常。主要格式错误是 `INVALID_ENTRY`、`INVALID_SOURCE_URL`、`INVALID_VIDEO`、`VIDEO_ID_MISMATCH`、`SOURCE_MISMATCH` 和 `INVALID_BATCH`；数据库错误为 `DATABASE_ERROR`。

## 本地验证

```bash
npm test
```

测试需要调用者提供的原始 `tests/fixtures/BV1hNWm6mEkz.json` 和 `data/seed-memes.json`。两份样本保持原样，seed 仅用于独立格式和别名期望，不是自动提取的生产输入。

全套测试覆盖真实样本、Agent 分支、临时 SQLite、旧表 positional insert、稳定 canonical、别名归并冲突、重放、当前行读取、审核和秒级 TTL。SQLite 触发器分别强制审核与 metadata 写入失败，验证整批及候选清理回滚。所有存储和工具测试显式指定临时 `dbPath`，不需要网络、凭据、付费模型、真实 Alma 数据库或安装 Alma host。
