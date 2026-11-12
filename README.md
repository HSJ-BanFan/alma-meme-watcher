# alma-meme-watcher

Alma 插件：持续监控 B 站 UP 主 [**梗指南**](https://space.bilibili.com/94510621)（`mid=94510621`），提取新视频的字幕/转写并提炼结构化热梗词条（附带原视频 `source_url` 与出处），同步到 Alma 的 `meme_radar.db` 词库。

## 设计原则

- **作为 DSH / Alma 外环协作的样板仓库**：
  - **运行时**：插件定期采集「梗指南」新视频并更新本地 `meme_radar.db`，让 Alma 在社区互动时能直接读懂最新热梗。
  - **研发外环**：当采集接口受风控、字幕解析失效或需要拓展新 UP 主/新平台时，由 Alma 整理 Issue 交给 DSH Worker 自动修复并开 PR，再由 Alma 独立验收合并。

## 本地验证

```bash
npm test
```
