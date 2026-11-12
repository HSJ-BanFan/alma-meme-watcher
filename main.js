/**
 * alma-meme-watcher —— Alma 插件入口（骨架）。
 *
 * 职责边界：
 *   - 监控 B 站 UP 主「梗指南」(mid=94510621) 的新投稿
 *   - 提取平台字幕或音频转写，结构化提炼 { term, aliases, meaning, origin, source_url }
 *   - 写入 ~/.config/alma/state/meme_radar.db（不修改人格或直接发言）
 */

export async function activate(context) {
  const { logger, tools } = context ?? {};
  logger?.info?.('[alma-meme-watcher] activated');

  if (tools?.register) {
    tools.register({
      id: 'meme_watch_status',
      name: 'Meme Watcher Status',
      description: '查看当前梗指南监控状态与词条统计。',
      execute: async () => ({
        ok: true,
        targetMid: '94510621',
        status: 'scaffold_ready',
      }),
    });
  }
}

export async function deactivate() {
  // Cleanup hook when Alma unloads the plugin.
}
