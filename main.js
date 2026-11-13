import { compileVideo } from './src/compiler/schema.js';
import { syncEntries, radarStatus } from './src/store/radar.js';

function execute(operation) {
  return async (input) => {
    try {
      return { ok: true, ...operation(input) };
    } catch (error) {
      return { ok: false, code: error.code ?? 'INTERNAL_ERROR', message: error.message ?? String(error) };
    }
  };
}

export async function activate(context, { dbPath } = {}) {
  const { logger, tools } = context ?? {};
  logger?.info?.('[alma-meme-watcher] activated');
  if (tools?.register) {
    tools.register({
      id: 'meme_watch_status',
      name: 'Meme Watcher Status',
      description: '读取词库统计和最近成功同步；不运行实时采集或音频转写。',
      execute: execute(() => {
        const status = radarStatus({ dbPath });
        return { targetMid: '94510621', status: status.last_sync ? 'synced' : 'ready_not_synced', ...status };
      }),
    });
    tools.register({
      id: 'meme_watch_sync',
      name: 'Sync Memes from GengZhiNan',
      description: '编译传入的视频转录或 Agent entries，并原子同步带出处的词条；不下载视频。',
      execute: execute((input) => {
        const entries = compileVideo(input?.video, { entries: input?.entries });
        return syncEntries(entries, { dbPath });
      }),
    });
  }
}

export async function deactivate() {}
