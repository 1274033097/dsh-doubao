/**
 * 会话体检：看某个对话里生成了几条结果，用来判断有没有「重复生成」或「没生成成功」
 *
 * 用法: node check_conv.mjs --conv <会话ID>
 *       node check_conv.mjs --latest          # 取最近一条对话（需 Edge 关闭且能解 cookie）
 *
 * 输出：
 *   block_type 统计（10040 = 视频块，10000 = 文本块，2074 = 参数卡）
 *   去重后的视频/图片资源数
 *   判定：视频块 <= 1 正常；> 1 说明重复生成（多半是回执判断把陈述句当成了提问）
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const WS = process.cwd();
const COOKIE_FILE = process.env.DOUBAO_COOKIE_FILE || path.join(WS, 'doubao_cookies.txt');
const IDENT_FILE = path.join(WS, 'doubao_identity.json');
const BASE = 'https://www.doubao.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0';

const argv = process.argv.slice(2);
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

if (!existsSync(COOKIE_FILE)) {
  console.error(`[错误] 缺少 ${COOKIE_FILE}，先跑 node get_cookies.mjs 或 node login.mjs`);
  process.exit(1);
}
if (!existsSync(IDENT_FILE)) {
  console.error(`[错误] 缺少 ${IDENT_FILE}`);
  process.exit(1);
}

const cookies = (await readFile(COOKIE_FILE, 'utf8')).trim();
const ident = JSON.parse(await readFile(IDENT_FILE, 'utf8'));

function qs() {
  return new URLSearchParams({
    version_code: ident.version_code,
    language: 'zh',
    device_platform: 'web',
    doubao_device_platform: 'web',
    aid: ident.aid,
    real_aid: ident.real_aid,
    pkg_type: 'release_version',
    device_id: ident.device_id,
    pc_version: ident.pc_version,
    doubao_pc_version: ident.doubao_pc_version,
    web_id: ident.web_id,
    tea_uuid: ident.tea_uuid,
    region: 'CN',
    sys_region: 'CN',
    samantha_web: '1',
    web_platform: 'browser',
    'use-olympus-account': '1',
    web_tab_id: randomUUID(),
  }).toString();
}

const IM_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json; encoding=utf-8',
  cookie: cookies,
  referer: `${BASE}/chat/`,
  origin: BASE,
  'user-agent': UA,
  'agw-js-conv': 'str',
};

async function batchGet(convId) {
  const body = {
    cmd: 1111,
    uplink_body: {
      batch_get_conv_info_uplink_body: {
        conversation_id: [convId],
        option: { recent_message_count_per_conv: 20 },
        ext: {},
      },
    },
    sequence_id: randomUUID(),
    channel: 2,
    version: '1',
  };
  const r = await fetch(`${BASE}/im/conversation/batch_get?${qs()}`, {
    method: 'POST',
    headers: IM_HEADERS,
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
  return txt;
}

// 取最近一条对话 ID：批量接口需要 ID，这里用会话列表接口拿最新的
async function latestConvId() {
  const body = {
    cmd: 1111,
    uplink_body: { batch_get_conv_info_uplink_body: { conversation_id: [], option: { recent_message_count_per_conv: 1 }, ext: {} } },
    sequence_id: randomUUID(),
    channel: 2,
    version: '1',
  };
  const r = await fetch(`${BASE}/im/conversation/batch_get?${qs()}`, {
    method: 'POST',
    headers: IM_HEADERS,
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  const ids = [...txt.matchAll(/"conversation_id":"(\d+)"/g)].map((m) => m[1]);
  return ids[0] || '';
}

const convArg = getArg('conv', '');
let conv = convArg;
if (!conv && argv.includes('--latest')) {
  conv = await latestConvId();
  if (!conv) {
    console.error('[错误] 没能自动取到最近会话 ID，请用 --conv 手动指定');
    process.exit(1);
  }
  console.log(`[latest] 最近会话: ${conv}`);
}
if (!conv) {
  console.error('用法: node check_conv.mjs --conv <会话ID> | --latest');
  process.exit(2);
}

const txt = await batchGet(conv);
const blocks = [...txt.matchAll(/"block_type":(\d+)/g)].map((m) => m[1]);
const cnt = {};
for (const b of blocks) cnt[b] = (cnt[b] || 0) + 1;

const videoRes = new Set(
  [...txt.matchAll(/https:\/\/[^"\\]*\/video\/tos\/[^"\\]*/g)].map((m) => m[0].split('/video/tos/')[1].split('?')[0]),
);
const imageRes = new Set(
  [...txt.matchAll(/https:\/\/[^"\\]*rc_gen_image\/([^"\\?~]+)/g)].map((m) => m[1]),
);

const videoBlocks = cnt['10040'] || 0;
// 判定以「实际资源数」为准：block_type 10040 是媒体块，图片/视频任务都可能出现
let verdict;
let code = 0;
if (videoRes.size > 1) {
  verdict = `⚠️ 重复生成：${videoRes.size} 个不同视频资源 —— 检查回执判断是否把陈述句当成了提问`;
  code = 3;
} else if (videoRes.size === 1) {
  verdict = '✅ 正常：1 个视频资源';
} else if (imageRes.size > 0) {
  verdict = `✅ 正常：图片任务（${imageRes.size} 个不同图片资源）`;
} else {
  verdict = '⚠️ 没找到图片/视频结果，可能还没生成完，或该会话不是生成任务';
  code = 4;
}

console.log(
  JSON.stringify(
    {
      conversation: conv,
      bytes: txt.length,
      blockTypes: cnt,
      mediaBlocks: videoBlocks,
      videoResources: videoRes.size,
      imageResources: imageRes.size,
      verdict,
    },
    null,
    2,
  ),
);
process.exitCode = code;
