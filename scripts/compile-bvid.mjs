#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMemeEntry } from '../src/compiler/schema.js';
import { syncEntries } from '../src/store/radar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SEED_FILE = resolve(ROOT, 'data/seed-memes.json');

const MAGPIE_URL = process.env.MAGPIE_URL || 'http://127.0.0.1:3425/v1/chat/completions';
const MAGPIE_KEY = process.env.MAGPIE_KEY || 'magpie-alma';
const PRIMARY_MODEL = process.env.MEME_MODEL || 'opencode-go/deepseek-v4.1-flash';
const FALLBACK_MODEL = process.env.MEME_FALLBACK_MODEL || '';

/**
 * 抓取 B 站视频基本元数据与热评
 */
async function fetchBiliMeta(bvid) {
  const cleanBvid = bvid.trim().replace(/^.*video\//i, '').replace(/[\/?#].*$/, '');
  const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${cleanBvid}`;
  const res = await fetch(viewUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`B站接口报错 (code ${data.code}): ${data.message || '未知错误'}`);

  const v = data.data;
  const aid = v.aid;
  const pubdate = new Date(v.pubdate * 1000).toISOString().slice(0, 10);

  // 抓取 Top 15 热评
  let comments = [];
  try {
    const replyUrl = `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=1&nohot=0&ps=15`;
    const rRes = await fetch(replyUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const rData = await rRes.json();
    if (rData.code === 0 && rData.data?.replies) {
      comments = rData.data.replies.map((r) => ({
        user: r.member.uname,
        like: r.like,
        content: r.content.message.trim(),
      })).filter((c) => c.content.length > 2);
    }
  } catch (err) {
    // 热评拉取失败不阻断主流程
  }

  return {
    bvid: cleanBvid,
    aid,
    title: v.title,
    desc: v.desc || '',
    pubdate,
    author: v.owner?.name || '',
    source_url: `https://www.bilibili.com/video/${cleanBvid}`,
    comments,
  };
}

/**
 * 调用 Magpie 编译 9 字段标准词条
 */
async function compileWithAI(meta) {
  const prompt = `你是一个专业的网络热梗与社媒黑话编译专家。
请根据以下 B 站「梗指南」视频信息和热评材料，提炼并编译出面向 AI Agent 使用的 9 字段标准结构化词卡。

视频信息：
- 标题：${meta.title}
- 链接：${meta.source_url}
- 发布时间：${meta.pubdate}
- UP主：${meta.author}
- 视频简介：
${meta.desc || '（暂无详细简介）'}

${meta.comments.length > 0 ? `高赞热评精选：\n${meta.comments.slice(0, 10).map((c) => `- [👍${c.like}] ${c.content}`).join('\n')}` : ''}

【格式要求】
必须严格输出纯 JSON 格式（不要包含任何 markdown 标记、\`\`\` 代码块或多余解释文字，直接以大括号开始和结束）。字符串内部请避免使用未转义的双引号：
{
  "term": "主词条名称（规范名词，简短明确）",
  "aliases": ["别名1", "别名2", "常见变体（禁止包含逗号/分号/竖线等标点）"],
  "meaning": "大白话简短释义（<=40字）",
  "usage_context": "使用场景与情绪极性（是什么场景用、什么语气）",
  "avoid_when": "误用禁忌场景（绝对不能在哪些场景用）",
  "origin": "出处背景与演变路径",
  "source_url": "${meta.source_url}",
  "published_at": "${meta.pubdate}",
  "ttl_days": 90,
  "confidence": 0.95
}
`;

  async function tryModel(modelName) {
    const payload = {
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1500,
    };
    const res = await fetch(MAGPIE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MAGPIE_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Magpie 返回 HTTP ${res.status}: ${errText}`);
    }
    const json = await res.json();
    let content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('AI 未返回任何内容');

    // 剥离可能存在的 ```json 代码块
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    // 尝试提取最外层大括号内的有效 JSON
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error(`未能找到完整的 JSON 对象区间: ${content}`);
    }
    const rawJson = content.slice(firstBrace, lastBrace + 1);
    return JSON.parse(rawJson);
  }

  try {
    return await tryModel(PRIMARY_MODEL);
  } catch (err) {
    if (!FALLBACK_MODEL) throw err;
    console.warn(`[WARN] 主模型 ${PRIMARY_MODEL} 失败 (${err.message})，尝试显式配置的备选模型 ${FALLBACK_MODEL}...`);
    return await tryModel(FALLBACK_MODEL);
  }
}

/**
 * 主执行函数
 */
async function main() {
  const args = process.argv.slice(2);
  const shouldSync = args.includes('--sync');
  const bvidArg = args.find((a) => !a.startsWith('--'));

  if (!bvidArg) {
    console.error('用法: node scripts/compile-bvid.mjs <BV号或视频链接> [--sync]');
    process.exit(1);
  }

  console.log(`[1/4] 正在抓取 B 站视频素材: ${bvidArg}...`);
  const meta = await fetchBiliMeta(bvidArg);
  console.log(`      视频: 《${meta.title}》 (${meta.pubdate}) | 收集到 ${meta.comments.length} 条热评`);

  console.log(`[2/4] 正在调用 Magpie (${PRIMARY_MODEL}) 进行 AI 结构化提炼...`);
  const rawCompiled = await compileWithAI(meta);

  // 清洗别名中的非法字符（如逗号）
  if (Array.isArray(rawCompiled.aliases)) {
    rawCompiled.aliases = rawCompiled.aliases
      .map((a) => String(a).replace(/[,，;；|/\r\n\0]/gu, '').trim())
      .filter(Boolean);
  }

  console.log(`[3/4] 正在通过 Schema 严格校验与归一化...`);
  const normalized = parseMemeEntry(rawCompiled);
  console.log(`      主词条: ${normalized.term}`);
  console.log(`      别名: [${normalized.aliases.join(', ')}]`);
  console.log(`      释义: ${normalized.meaning}`);
  console.log(`      禁忌: ${normalized.avoid_when}`);

  console.log(`[4/4] 正在保存入库...`);
  const seedContent = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
  const existingIndex = seedContent.findIndex(
    (item) => item.term === normalized.term || item.source_url === normalized.source_url
  );

  if (existingIndex >= 0) {
    seedContent[existingIndex] = normalized;
    console.log(`      更新了已有条目: ${normalized.term}`);
  } else {
    seedContent.push(normalized);
    console.log(`      追加了新条目: ${normalized.term} (总条目: ${seedContent.length})`);
  }

  writeFileSync(SEED_FILE, JSON.stringify(seedContent, null, 2), 'utf8');

  if (shouldSync) {
    console.log(`      正在同步生产数据库 (~/.config/alma/state/meme_radar.db)...`);
    const syncRes = syncEntries(seedContent);
    console.log(`      生产库同步完成: inserted=${syncRes.inserted}, updated=${syncRes.updated}, total=${syncRes.entries.length}`);
  }

  console.log('\n[SUCCESS] 一键编译与维护完成！');
  console.log(JSON.stringify(normalized, null, 2));
}

main().catch((err) => {
  console.error('\n[ERROR] 执行失败:', err);
  process.exit(1);
});
