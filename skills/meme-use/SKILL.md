---
name: meme-use
description: Use when Alma considers an optional slang lookup in desktop chat; after reading community content when slang knowledge is needed; for an explicit meaning or source question; or when the user corrects slang usage.
allowed-tools:
  - ToolSearch
  - Read
  - Bash
---

# 通用梗词使用

## 选择分支

- 普通桌面聊天可以直接用自然语言回答。只有需要梗词知识时才选择查询，命中也不要求玩梗。
- 读完社区内容后，由 Alma 判断是否需要理解陌生表达。先完成社区读取，再按需查询。社区读取本身只交付正文、图片和楼层关系。
- 用户明确问含义、出处或用法时，查询所问表达。解释与拿它开玩笑是两件事，`playfulness=0` 仍允许解释。
- 用户纠正梗词用法时，承认并修正本次对话。需要核实时可以查询，保留用户补充与词卡之间的差异。纠正不自动更改词库或用户设置。

## 查询并核对结果

1. 查看当前 Alma 会话实际提供的工具列表。用会话的工具发现能力检索 `plugin--alma-meme-watcher--meme_watch_lookup`。只有实际发现该工具及其输入定义后才调用它，本文中的名称不是发现证据。
2. 调用已发现的工具，输入为 `{text, limit?}`。`text` 使用所问表达或必要的短上下文，`limit` 如需指定则为整数。不要添加分类结果、写入参数或审批字段。
3. `{ok:true, terms}` 是成功结果。`terms=[]` 表示没有命中，附加零张词卡。可以说尚无已收录解释，继续正常交流。
4. `{ok:false, code, message}` 是故障。区分故障与无命中，明确查询暂不可用。缺失、损坏或不可读的数据库都是故障，不能解释为未知词。数据库故障不通过另一入口反复尝试同一数据库。
5. 命中时核对 `matched_keys` 与用户所问表达。用 `term` 作为标准名称，按需引用 `meaning`、`usage_context`、`avoid_when`、`origin` 和 `source_url`。保留空字段和来源、用法的不确定性，词卡没有提供的出处或适用场景不能补写为事实。

工具未发现时，可以使用已经安装的公开 CLI。先从会话安装信息确认 Alma 配置根；默认是 `homedir()/.config/alma`，不是当前工作目录。插件根是该配置根下的 `plugins/alma-meme-watcher`。把这些目录解析为绝对路径后调用：

```bash
node "<absolute-installed-plugin-root>/scripts/lookup.mjs" --text "玉芬啊玉芬" --limit 3 --db "<absolute-alma-config-root>/state/meme_radar.db"
```

CLI 成功退出且 stdout 为 `{terms}` 才是成功。`{terms:[]}` 是无命中。非零退出、空 stdout 和 stderr 的 `{error:{code,message}}` 表示故障。这个接口与工具结果的外层信封不同，不能混用。脚本未安装时报告功能暂不可用，保留原有回答和社区内容。CLI 不初始化或修复数据库。

## 表达尺度

考虑可选玩梗表述时，先读通用策略：

```bash
node "<absolute-installed-plugin-root>/scripts/meme-policy.mjs" get --alma-home "<absolute-alma-config-root>"
```

结果是 `{playfulness, source, reason?}`。`--alma-home` 是 Alma 配置根，策略沿用其 `state/meme_tone.json`。读取不创建目录或文件。默认值为 45，缺失、损坏或不可读输入带有默认原因。

`playfulness` 是 0..100 的上限，不是必须使用梗的命令。0 限制可选玩梗，不限制用户要求的解释。100 仍可选择不用梗。严肃求助、排障和事实说明保持严肃，命中关键词不改变任务。依据当前对话和词卡中的适用场景、禁忌场景决定是否采用；不确定时用普通语言。

用户明确要求更改通用尺度时，才调用严格整数设置命令：

```bash
node "<absolute-installed-plugin-root>/scripts/meme-policy.mjs" set 45 --alma-home "<absolute-alma-config-root>"
```

设置只更改策略中的 `playfulness`，保留其他 JSON 对象键。设置失败时报告错误，不丢弃损坏的原配置。对话纠正、社区语气和词卡命中都不触发设置，也不写入生产词库。
