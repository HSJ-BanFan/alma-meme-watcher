# 词卡查询接口

`node scripts/lookup.mjs` 提供进程外只读查询。调用方无需导入插件内部模块或读取 SQLite 私有表。验证环境为 Node.js 24.20.0。

## 调用形式

```bash
node scripts/lookup.mjs --text "玉芬啊玉芬"
node scripts/lookup.mjs --text "帖子文本" --db "/path/to/meme_radar.db" --limit 3
```

脚本支持从任意工作目录按绝对路径调用。相对 `--db` 路径以调用进程的工作目录为基准。

## 参数

| 参数 | 默认值 | 契约 |
|---|---|---|
| `--text` | 无，必填 | 查询字符串。允许空字符串和纯空白。 |
| `--db` | `~/.config/alma/state/meme_radar.db`，取当前用户主目录 | 数据库路径。拒绝空字符串和纯空白路径。 |
| `--limit` | `3` | 十进制非负安全整数，范围为 `0` 至 `9007199254740991`。允许前导零。 |

选项支持 `--name value` 和 `--name=value`。每个选项只能出现一次。以 `-` 开头的文本采用 `--text=<文本>` 形式，分离的选项值会产生歧义。未知选项、位置参数、缺失值、负数、小数、指数形式和超出安全整数范围的限制值均为参数错误。接口没有时钟参数。

空文本和 `--limit 0` 仍会检查数据库可用性、所需列和可读字段，不能掩盖缺失或损坏的词库。

## 成功输出

成功时退出码为 `0`，stdout 输出一行 UTF-8 JSON，stderr 为空。顶层只有 `terms` 数组。无命中输出如下。

```json
{"terms":[]}
```

每个命中仅包含以下十个字段。

| 字段 | JSON 类型 | 含义 |
|---|---|---|
| `term` | string | 存储的规范词名。 |
| `meaning` | string | 词义。 |
| `usage_context` | string | 使用场景和情绪提示。存量未知值保留为空字符串。 |
| `avoid_when` | string | 避用场景。存量未知值保留为空字符串。 |
| `origin` | string | 存储的来源叙述。 |
| `source_url` | string | 存储的原始出处链接。未知值保留为空字符串，不从来源叙述推断。 |
| `aliases` | string[] | 解码后的完整别名列表，保留存储顺序，不按命中结果过滤或额外去重。 |
| `matched_keys` | string[] | 实际命中的规范词名和别名，保留原始拼写。 |
| `confidence` | number | 有限数值置信度，不对存量值运行新词条编译校验。 |
| `days_left` | 正整数或 null | 正 TTL 的剩余天数向上取整。非正 TTL 表示无限期，返回 `null`。 |

接口不返回热度、审核记录、时间戳或同步版本。缺少存量上下文不触发补写，也不会生成用法或来源。

## 匹配和有效期

查询和匹配键统一按 NFC、首尾去空白和小写归一化。检索只使用 `term` 和 `aliases`，不搜索释义。键边缘的 ASCII 字母、数字或下划线不能贴着文本中的 ASCII 字母、数字或下划线。

`matched_keys` 先列规范词名，再按解码后的别名顺序列出所有命中。归一化身份重复时仅保留第一种拼写。精确别名命中不会把别名移到规范词名前面。

排序依次比较精确规范词名、精确别名、规范词名子串和别名子串。同级按热度降序、最后出现时间降序和归一化规范词名升序排序，再截取 `limit`。

仅 `accepted` 或 `local_reference` 审核状态且置信度至少为 `0.7` 的词条可参与查询。缺少审核记录保持未审核，不会被推定为可用。

每次查询使用同一个当前 Unix 秒数。正 TTL 在 `last_seen + ttl_days * 86400` 时刻到期，该时刻及之后不再返回。到期前 `days_left` 为剩余秒数除以 `86400` 后向上取整。非正 TTL 不过期。读取不刷新有效期。

## 错误输出

失败时 stdout 为空，stderr 输出一行 JSON。顶层只有 `error`，其中仅有稳定的 `code` 和非空字符串 `message`。

```json
{"error":{"code":"DATABASE_UNAVAILABLE","message":"Meme database is unavailable."}}
```

| 错误码 | 退出码 | 条件 |
|---|---|---|
| `INVALID_ARGUMENTS` | `2` | 参数违反上述契约。 |
| `DATABASE_UNAVAILABLE` | `1` | 指定数据库文件或其父路径不存在。 |
| `DATABASE_ERROR` | `1` | SQLite 无法打开或读取文件、缺少所需表或列、可读字段类型不兼容，或返回的有效期数值不可读。 |
| `INTERNAL_ERROR` | `1` | 非数据库操作发生未预期错误。 |

错误消息不含堆栈或本地路径。调用方按错误码处理，不依赖消息措辞。结构有效的空词库是成功无命中，缺少所需表或列不是空词库。存在但结构错误的可选旧表同样返回数据库错误。

查询以只读连接在同一快照内检查结构并读取词条，不创建目录、初始化表、修复数据库或运行同步。SQLite 的 WAL 和 SHM 协调文件不属于词条数据写入，接口不保证这些文件不会出现。

## 插件内测试接口

以下函数仅供插件内部使用和确定性测试。外部调用方使用 CLI，不依赖此模块路径。

`src/store/radar.js` 导出以下函数。

```js
lookupCards(text, { dbPath, now, limit })
```

返回值为 `TermCard[]`，字段与 CLI 相同。`dbPath` 和 `limit` 默认值与 CLI 相同。`now` 为可选的非负有限 Unix 秒数，仅供库调用注入确定性时间，默认取当前时间。无效库参数抛出 `INVALID_OPTIONS`。

已有 `lookup` 仍返回内部词条，`radarStatus` 仍返回原有统计。两者缺失文件时的空结果兼容性不变。新接口不以该宽松行为隐藏数据库故障。

## 插件工具接口

插件注册只读工具 `meme_watch_lookup`。它和 CLI 共用 `lookupCards`，匹配、排序、审核门槛、TTL 和只读语义完全一致，没有第二套检索实现。

安装后宿主给工具加的前缀是 `plugin--alma-meme-watcher--meme_watch_lookup`。这个名称由宿主生成，属于命名约定，不是本仓库已验证的事实；调用前沿用会话的工具发现能力确认工具是否存在及其输入定义。

### 输入

```json
{"type":"object","additionalProperties":false,"required":["text"],
 "properties":{"text":{"type":"string"},"limit":{"type":"integer","minimum":0,"maximum":9007199254740991,"default":3}}}
```

`text` 必填，允许空字符串和纯空白。`limit` 省略时按 `3` 处理；一旦出现，就必须是 `0` 到 `Number.MAX_SAFE_INTEGER` 的安全整数，schema 用 `minimum` 和 `maximum` 表达同一范围。除 `text` 和 `limit` 之外的键（例如 `dbPath`、`now`）一律拒绝，避免调用方绕过契约直接指定数据库或时钟。

### 输出

成功返回 `{"ok":true,"terms":[...]}`，`terms` 是十字段词卡数组，字段与 CLI 相同。无命中是 `{"ok":true,"terms":[]}`。

失败返回 `{"ok":false,"code":"...","message":"..."}`。工具用自己的固定消息，不转发底层异常文本，因此消息里不会出现本地路径、堆栈或密钥。

| `code` | 条件 |
|---|---|
| `INVALID_ARGUMENTS` | 输入违反上述契约。包含词库层抛出的 `INVALID_OPTIONS`。 |
| `DATABASE_UNAVAILABLE` | 数据库文件或其父路径不存在。 |
| `DATABASE_ERROR` | 数据库无法打开、损坏、缺少表或列，或字段不可读。 |
| `INTERNAL_ERROR` | 其他未预期错误。 |

工具信封与 CLI 信封不同，不要混用。CLI 成功只有 `terms`，失败只有 `error.code` 和 `error.message`。

查询不创建词条、不补字段、不刷新有效期，也不改动词库内容。

### 生命周期

`activate(context, { dbPath })` 按 `tools.register(id, { description, parameters, execute })` 注册三个工具，并返回 `{ dispose }`。`dispose` 幂等，只释放本次激活注册的工具；`deactivate()` 释放当前所有仍存活的注册。`dbPath` 未传时走词库默认路径。

## 打包与安装

```bash
node scripts/package-plugin.mjs --out <目录>
node scripts/install-plugin.mjs --alma-home <Alma 配置根> [--package <包目录>] [--plan]
node scripts/install-plugin.mjs --alma-home <Alma 配置根> [--package <包目录>] --apply
node scripts/install-plugin.mjs --alma-home <Alma 配置根> --rollback <备份 ID>
node scripts/install-plugin.mjs --alma-home <Alma 配置根> --uninstall
node scripts/install-plugin.mjs --alma-home <Alma 配置根> --list
```

`package-plugin.mjs` 按显式白名单收集 `main.js`、`manifest.json`、`package.json`、`docs/lookup-api.md` 以及 `src/`、`scripts/`、`skills/`、`integrations/` 下现有文件，复制到 `<目录>/alma-meme-watcher/`，并写入 `package-receipt.json`。

回执字段是 `schema`、`plugin`（`id`、`name`、`version`）、`revision`（构建时的 Git HEAD）、`dirty`（白名单文件是否有未提交改动）和 `files`（按路径排序的 `path`、`bytes`、`sha256`）。回执不含构建时间，所以同一提交重复打包得到逐字节相同的 `files`。

`--alma-home` 默认取 `os.homedir()/.config/alma`，安装目标是其下的 `plugins/alma-meme-watcher`，备份放在 `_backup/`。默认动作是 `--plan`，只报告将要做什么，不写任何文件。

`--apply` 先校验包内每个文件的哈希，再处理目标目录：目标不存在就直接安装；目标存在但由其他来源创建则拒绝覆盖；目标存在且与本包一致则报告 `unchanged`，不产生备份。替换前把旧目录整体移到 `_backup/plugin-alma-meme-watcher-<UTC 时间戳>/` 并写 `backup.json`，新装目录内写 `.install-receipt.json`。

`--rollback <备份 ID>` 校验备份后换回旧目录并删除本次安装。`--uninstall` 只删除带安装回执的目录。`--list` 列出已有备份。

安装副本可追溯到产生它的提交，回滚不需要重新构建。

### 显式指定数据库

CLI 的默认库路径取自调用进程的 `os.homedir()`，不是 Alma 配置根。当进程环境的 `HOME` 与 Alma 配置根不一致时，不传 `--db` 会读到错误的库。进程外调用一律显式传 `--db`，不要依赖默认值。

## 阶段范围

阶段 1 仅提供查询接口。数据维护迁移和社区侧适配属于阶段 2、3，本阶段不实现。词卡提供表达判断所需的信息，不决定语气、玩梗尺度或发帖行为。
