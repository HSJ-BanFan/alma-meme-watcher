import { compileVideo } from './src/compiler/schema.js';
import { syncEntries, radarStatus, lookupCards } from './src/store/radar.js';
import { lookupFailures, lookupFailureCode } from './src/lookup/errors.js';

const liveSessions = new Set();

function execute(operation) {
  return async (input) => {
    try {
      return { ok: true, ...operation(input) };
    } catch (error) {
      return { ok: false, code: error.code ?? 'INTERNAL_ERROR', message: error.message ?? String(error) };
    }
  };
}

const lookupParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string' },
    limit: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 3 },
  },
};

function lookupFailure(code) {
  const normalized = lookupFailureCode(code === 'INVALID_OPTIONS' ? 'INVALID_ARGUMENTS' : code);
  return { ok: false, code: normalized, message: lookupFailures[normalized].message };
}

// The host may hand over any JSON value. Reject before the store runs so an
// unusable call never looks like a no-hit result.
function readLookupInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  if (Object.keys(input).some((key) => key !== 'text' && key !== 'limit')) return null;
  if (typeof input.text !== 'string') return null;
  const limit = Object.hasOwn(input, 'limit') ? input.limit : 3;
  if (!Number.isSafeInteger(limit) || limit < 0) return null;
  return { text: input.text, limit };
}

function createLookup({ dbPath }) {
  return async (input) => {
    const parsed = readLookupInput(input);
    if (!parsed) return lookupFailure('INVALID_ARGUMENTS');
    try {
      return { ok: true, terms: lookupCards(parsed.text, { dbPath, limit: parsed.limit }) };
    } catch (error) {
      return lookupFailure(error?.code);
    }
  };
}

export async function activate(context, { dbPath } = {}) {
  const { logger, tools } = context ?? {};
  logger?.info?.('[alma-meme-watcher] activated');

  const disposables = [];
  const session = {
    dispose() {
      if (!liveSessions.delete(session)) return;
      for (const disposable of disposables.splice(0)) {
        try {
          disposable?.dispose?.();
        } catch {
          // One failing registration must not strand the rest.
        }
      }
    },
  };
  liveSessions.add(session);

  if (tools?.register) {
    const register = (id, descriptor) => {
      const disposable = tools.register(id, descriptor);
      disposables.push(disposable);
      return disposable;
    };
    register('meme_watch_status', {
      description: '读取词库统计和最近成功同步；不运行实时采集或音频转写。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: execute(() => {
        const status = radarStatus({ dbPath });
        return { targetMid: '94510621', status: status.last_sync ? 'synced' : 'ready_not_synced', ...status };
      }),
    });
    register('meme_watch_sync', {
      description: '编译传入的视频转录或 Agent entries，并原子同步带出处的词条；不下载视频。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          video: { type: 'object' },
          entries: { type: 'array', items: { type: 'object' } },
        },
      },
      execute: execute((input) => {
        const entries = compileVideo(input?.video, { entries: input?.entries });
        return syncEntries(entries, { dbPath });
      }),
    });
    register('meme_watch_lookup', {
      description:
        '只读查询梗词库，返回十字段词卡：term、meaning、usage_context、avoid_when、origin、source_url、aliases、matched_keys、confidence、days_left。查询结果只是参考，不要求使用梗；limit 默认为 3。无命中返回空数组；词库缺失或损坏是故障，不是无命中。查询不写入、不补字段、不刷新有效期。',
      parameters: lookupParameters,
      execute: createLookup({ dbPath }),
    });
  }

  return { dispose: session.dispose };
}

export async function deactivate() {
  for (const session of [...liveSessions]) session.dispose();
}
