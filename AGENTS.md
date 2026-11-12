# AGENTS.md — alma-meme-watcher

本仓库是一个 **Alma 插件**，目标是通过监控 B 站 UP 主「梗指南」（`mid=94510621`）的新视频，抽取字幕/转写并提炼带出处的词条，更新 Alma 的 `~/.config/alma/state/meme_radar.db`。

## 架构与职责边界

1. **代码维护 vs 数据运行分离**：
   - 本仓库只维护插件源码、采集适配器、词条解析逻辑与测试。
   - 词条数据写入 `~/.config/alma/state/meme_radar.db`，不把抓取到的日常词条反复提交成代码仓库 PR。
2. **词条写入契约**：
   - 每条正式入库的词条必须带有合法的 `source_url`（B 站视频原链接）和清晰的 `meaning`。
   - 优先复用 `xiaoheihe-community-ops/meme_radar.py` 的 `review_candidate` / `meme_add` 契约，不破坏现有 `terms` / `candidates` / `term_reviews` 表结构。
3. **B 站采集注意点**：
   - 不要用未鉴权裸请求硬刷空间动态接口（会触发 412），优先走 `bili-cli` / `opencli bilibili subtitle` 或稳定签名/RSS 通道，无字幕时预留音频转写兜底。

## 验证命令

提交 PR 前必须本地跑通并保持全绿：

```bash
npm test
```

## 变更约束

- 不要修改无关文件或提交本地个人路径/Cookie/Token。
- 破坏性修改 `manifest.json` 暴露的工具 ID 或数据库表结构时，必须在 PR 中明确说明。
