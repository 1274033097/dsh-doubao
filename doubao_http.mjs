/**
 * 豆包网页版「纯 HTTP」客户端 —— 不启动浏览器，不需要 Edge
 *
 * 原理：复刻网页版的 /chat/completion 接口（cookie 认证，实测 a_bogus 签名非强制）
 *   - 生图：ability_type=3，内层 ability_type=1
 *   - 生视频：ability_type=17，参数含 model/ratio/duration/resolution（两轮确认制）
 *   - 模型列表：POST /samantha/skill/pack {"skill_type":N}
 *   - 查结果：POST /im/conversation/info {"cmd":1110,...}
 *
 * 用法:
 *   node doubao_http.mjs models --for video|image
 *   node doubao_http.mjs image --prompt "..." [--model "Seedream 4.5"] [--ratio 16:9]
 *   node doubao_http.mjs video --prompt "..." [--model "Seedance 2.0 Fast"] [--ratio 16:9] [--duration 4] [--resolution 720p]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { uploadRefImages, buildAttachmentBlock, MAX_REF_IMAGES } from './doubao_upload.mjs';

const WS = process.cwd();
const OUT_DIR = process.env.DOUBAO_OUT || path.join(WS, 'doubao_out');
const BASE = 'https://www.doubao.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0';
const IDENT_FILE = path.join(WS, 'doubao_identity.json');
const COOKIE_FILE = process.env.DOUBAO_COOKIE_FILE || path.join(WS, 'doubao_cookies.txt');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const mode = argv[0] || '';
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

// 清理用户粘进来的路径（去成对引号、空白、Windows \\?\ 前缀）
// 历史坑：粘贴 "C:\...\x.png" 带引号 → existsSync 认不出 → 误报「文件不存在」
function cleanPath(raw) {
  let p = String(raw ?? '').trim();
  for (let i = 0; i < 3; i += 1) {
    if (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) {
      p = p.slice(1, -1).trim();
    } else break;
  }
  if (p.startsWith('\\\\?\\')) p = p.slice(4);
  return p;
}

// 收集 --ref a.png --ref b.png（也支持 --ref a.png,b.png）
function collectRefArgs() {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--ref') continue;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) continue;
    for (const piece of String(v).split(',')) {
      const p = cleanPath(piece);
      if (p) out.push(p);
    }
  }
  const missing = out.filter((p) => !existsSync(p));
  for (const p of missing) console.log(`[ref] ⚠ 文件不存在，跳过：${p}`);
  return out.filter((p) => existsSync(p));
}

// ── 身份参数（同一浏览器配置下稳定；首次从抓包生成，之后复用）
//
// 为什么要有这个文件：豆包 /chat/completion 的 query 里带 device_id / web_id / fp / tea_uuid
// 等设备参数，缺了服务端会拒。这些值不是常量，每个浏览器配置每台机器都不一样，所以只能
// 从一次真实请求里抓出来。
//
// 开源版故意不含 doubao_identity.json（那是作者本机的设备指纹），所以第一次用必须先拿到它。
// 三条获取途径，按从简到繁：
//   1) 环境变量（如果上游已经拿到了，直接注入，最少改动）
//   2) 抓包文件（--capture 指定）—— 由 capture_api.mjs 生成
//   3) 从 cookie 里的 web_id / device_id 反推（豆包 cookie 里就带这两个，成功率很高）
//
// 全都失败时才报错，并且报得让人能照着做，而不是抛一个 ENOENT 堆栈。
async function loadIdentity() {
  if (existsSync(IDENT_FILE)) {
    try {
      const j = JSON.parse(await readFile(IDENT_FILE, 'utf8'));
      if (j && j.device_id) return j;
    } catch {
      /* 文件坏了，往下走恢复路径 */
    }
  }

  // ── 途径 1：环境变量注入（CI / 脚本场景）
  if (process.env.DOUBAO_IDENTITY_JSON) {
    try {
      const j = JSON.parse(process.env.DOUBAO_IDENTITY_JSON);
      if (j && j.device_id) {
        await writeFile(IDENT_FILE, JSON.stringify(j, null, 2), 'utf8');
        console.log('[identity] 已从 DOUBAO_IDENTITY_JSON 环境变量写入 →', IDENT_FILE);
        return j;
      }
    } catch {
      /* 环境变量格式不对，继续 */
    }
  }

  // ── 途径 2：抓包文件
  const capPath = getArg('capture', 'cap_image.json');
  if (existsSync(capPath)) {
    try {
      const cap = JSON.parse(await readFile(capPath, 'utf8'));
      const rec = (cap.records || []).find((r) => /\/chat\/completion/.test(r.url || ''));
      if (rec) {
        const p = new URL(rec.url).searchParams;
        const ident = {
          aid: p.get('aid'),
          device_id: p.get('device_id'),
          doubao_pc_version: p.get('doubao_pc_version'),
          fp: p.get('fp'),
          pc_version: p.get('pc_version'),
          real_aid: p.get('real_aid'),
          tea_uuid: p.get('tea_uuid'),
          version_code: p.get('version_code'),
          web_id: p.get('web_id'),
        };
        await writeFile(IDENT_FILE, JSON.stringify(ident, null, 2), 'utf8');
        console.log('[identity] 已从抓包提取并保存 →', IDENT_FILE);
        return ident;
      }
    } catch {
      /* 抓包文件坏了，继续 */
    }
  }

  // ── 途径 3：让浏览器自己告诉我们（最可靠）
  // 设备参数由豆包网页的 JS 生成，cookie 里没有（实测 s_v_web_id 格式像 fp 但值不同），
  // 所以只能从一次真实请求里读。这里复用已有的 capture_api.mjs —— 它会用
  // playwright 打开豆包、发一次测试消息、截取 /chat/completion 的 URL。
  if (existsSync(path.join(WS, 'capture_api.mjs'))) {
    console.log('[identity] 缺少设备身份文件，尝试自动抓取一次（约 15-30 秒）…');
    try {
      const { spawnSync } = await import('node:child_process');
      const capOut = path.join(WS, 'cap_image.json');
      const r = spawnSync(process.execPath, ['capture_api.mjs', '--send', '测试', '--out', capOut], {
        cwd: WS,
        stdio: 'inherit',
        timeout: 180000,
      });
      if (r.status === 0 && existsSync(capOut)) {
        const cap = JSON.parse(await readFile(capOut, 'utf8'));
        const rec = (cap.records || []).find((x) => /\/chat\/completion/.test(x.url || ''));
        if (rec) {
          const p = new URL(rec.url).searchParams;
          const ident = {
            aid: p.get('aid'),
            device_id: p.get('device_id'),
            doubao_pc_version: p.get('doubao_pc_version'),
            fp: p.get('fp'),
            pc_version: p.get('pc_version'),
            real_aid: p.get('real_aid'),
            tea_uuid: p.get('tea_uuid'),
            version_code: p.get('version_code'),
            web_id: p.get('web_id'),
          };
          if (ident.device_id) {
            await writeFile(IDENT_FILE, JSON.stringify(ident, null, 2), 'utf8');
            console.log('[identity] 已自动抓取并保存 →', IDENT_FILE);
            return ident;
          }
        }
      }
    } catch {
      /* 自动抓取失败，落到下面的报错 */
    }
  }

  // ── 全失败：给人话，而不是 ENOENT 堆栈
  console.error('');
  console.error('════════════════════════════════════════════════════════════');
  console.error('[缺少设备身份文件] 需要 doubao_identity.json 才能调用豆包接口。');
  console.error('');
  console.error('这个文件含设备参数（device_id / web_id / fp 等），由豆包网页的 JS 生成，');
  console.error('每台机器不同，所以开源版不包含它。生成方式：');
  console.error('');
  console.error('  ① 自动（推荐，本插件会自己抓）：');
  console.error('       node capture_api.mjs --send "测试" --out cap_image.json');
  console.error('       node doubao_http.mjs models --for image');
  console.error('');
  console.error('  ② 手动：打开 https://www.doubao.com 并登录，F12 → Network，');
  console.error('     随便发一句话，找到 /chat/completion 请求，复制它 URL 里的 query 参数，');
  console.error('     填进 doubao_identity.json（格式见 doubao_identity.example.json）');
  console.error('');
  console.error('  ③ 从别人那里拿一份可用的 doubao_identity.json 放进本目录');
  console.error('     （注意：设备指纹会共享，可能触发风控，建议优先用 ①②）');
  console.error('');
  console.error('  自动抓取需要 playwright：npm i -g @playwright/cli');
  console.error('  期望路径: ' + IDENT_FILE);
  console.error('════════════════════════════════════════════════════════════');
  console.error('');
  process.exit(4);
}

const ident = await loadIdentity();
const cookies = existsSync(COOKIE_FILE) ? (await readFile(COOKIE_FILE, 'utf8')).trim() : '';
if (!cookies) {
  // 区分「文件不存在」和「文件存在但是空的」——后者是刚跑过 logout 的正常结果
  if (existsSync(COOKIE_FILE)) {
    console.error('[未登录] cookie 文件是空的（可能刚执行过退登）。');
  } else {
    console.error(`[未登录] 缺少 cookie 文件: ${COOKIE_FILE}`);
  }
  console.error('         处理：双击「登录.cmd」扫码登录，或跑 node login.mjs');
  console.error('              如果 Edge 里已经登录豆包，也可以关闭 Edge 后跑 node get_cookies.mjs');
  process.exit(3);
}

function buildQuery(extra = {}) {
  const q = {
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
    ...extra,
  };
  return Object.entries(q)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`)
    .join('&');
}

function headers(extra = {}) {
  return {
    accept: '*/*',
    'content-type': 'application/json',
    cookie: cookies,
    referer: `${BASE}/chat/`,
    origin: BASE,
    'user-agent': UA,
    'agw-js-conv': 'str, str',
    ...extra,
  };
}

// /im/* 系列接口要求特定 content-type（带 encoding=utf-8）与 agw-js-conv: str，
// 否则返回 status_code 712012002「不支持编码类型」
function imHeaders() {
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json; encoding=utf-8',
    cookie: cookies,
    referer: `${BASE}/chat/`,
    origin: BASE,
    'user-agent': UA,
    'agw-js-conv': 'str',
  };
}

async function postIm(pathname, body) {
  const url = `${BASE}${pathname}?${buildQuery()}`;
  const resp = await fetch(url, { method: 'POST', headers: imHeaders(), body: JSON.stringify(body) });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${pathname} HTTP ${resp.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${pathname} 返回非 JSON: ${text.slice(0, 300)}`);
  }
}

async function postJson(pathname, body, extraQuery = {}) {
  const url = `${BASE}${pathname}?${buildQuery(extraQuery)}`;
  const resp = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${pathname} HTTP ${resp.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${pathname} 返回非 JSON: ${text.slice(0, 300)}`);
  }
}

// 读 SSE 流，回调每个 event/data
async function readSSE(resp, { onEvent, maxSec = 300, stopWhen } = {}) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const raw = [];
  const deadline = Date.now() + maxSec * 1000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    raw.push(chunk);
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /event:\s*(\S+)/.exec(block)?.[1] || '';
      const dataLine = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (onEvent) onEvent(ev, dataLine, block);
      if (stopWhen && stopWhen(ev, dataLine)) {
        reader.cancel().catch(() => {});
        return raw.join('');
      }
    }
  }
  reader.cancel().catch(() => {});
  return raw.join('');
}

// ── 内置模型目录（skill/pack 不返回、但网页下拉里有的模型）
// 背景：`/samantha/skill/pack` 只返回「基础档」模型，网页下拉里的 Seedream 5.5 / 5.0 Flash、
// Seedance 2.5 / 2.5 Flash 不在里面。下面的 key 是从真实请求/网页配置实测得到的：
//   - 图片：key 就是显示名本身（已验证 Seedream 5.5 可直接生成）
//   - 视频：key 是内部标识（来自 /alice/slot/action_bar_v3/get_item_conf 的 option_key）
// 刷新方法见 项目维护.md §3.1
//
// ⚠ `member` 字段只表示「按会员额度/倍率计费」，和「是不是内置目录」是两件事：
//   内置目录里的模型也可能走免费额度（2026-11-13 用户实测更正）。
const MEMBER_MODELS = {
  image: [
    { name: 'Seedream 5.5', key: 'Seedream 5.5', desc: '旗舰生图', member: false },
    { name: 'Seedream 5.0 Flash', key: 'Seedream 5.0 Flash', desc: '专业快速', member: false },
  ],
  video: [
    { name: 'Seedance 2.5', key: 'seedance_v2.5', desc: '旗舰视频标杆 · 5 倍消耗', member: true },
    { name: 'Seedance 2.5 Flash', key: 'seedance_v2.5_flash', desc: '旗舰高性价比 · 2 倍消耗', member: true },
  ],
};

// ── 实测容量上限（2026-11-14 浏览器 / 直连双路复测）
//   参考图：**一次最多 10 张**——传 12 张时服务端只收下前 10 张（_probe_refcap 实测）
//           视频侧配置同值：max_ref_image_count=10，max_ref_video_count=1
//   生成数量：**一次最多 8 张**（用户规格）；实测服务端硬顶 10 张
//           要 8 张 → 8 张；要 12 张 → 10 张；要 20 张 → 10 张
const LIMITS = {
  maxRefImages: 10,
  maxGenImages: 8, // 对外规格
  hardMaxGenImages: 10, // 服务端实测硬顶，不要用满
};

// ── 会员档更正表：skill/pack 返回的「基础档」里，哪些其实按会员额度计费
// skill/pack 不标会员身份，只能人工维护。2026-11-13 用户按网页下拉实测更正：
//   图片：**只有 Seedream 5.0 Pro** 是会员模型（Seedream 5.5 / 5.0 Flash / 4.5 / 4.0 都免费）
//   视频：**Seedance 2.5 / 2.5 Flash / 2.0** 是会员模型（2.0 Fast / 2.0 Mini 免费）
const MEMBER_KEYS = {
  image: new Set(['Seedream 5.0 Pro']),
  video: new Set(['seedance_v2.5', 'seedance_v2.5_flash', 'seedance_v2.0_std']),
};

// ── 模型列表（纯 HTTP，不耗额度）
async function fetchModels(skillType) {
  const data = await postJson('/samantha/skill/pack', { skill_type: skillType });
  // 参数定义在形如 {value:"model", options:[{show_name,value},...]} 的节点里
  const params = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (typeof o.value === 'string' && Array.isArray(o.options)) params.push(o);
    Object.values(o).forEach(walk);
  };
  walk(data);
  const modelParam = params.find((p) => p.value === 'model');
  // skill/pack 不标会员身份，靠 MEMBER_KEYS 人工更正（图片档的 Seedream 5.0 Pro 是会员模型）
  const memberKeys = MEMBER_KEYS[skillType === 17 ? 'video' : 'image'] || new Set();
  // 图片：value 才是模型名（"Seedream 4.5"），show_name 是描述
  // 视频：show_name 才是显示名（"Seedance 2.0 Fast"），value 是内部 key
  const live = (modelParam?.options || []).map((o) => {
    const v = String(o.value || '');
    const isName = /^Seed(ream|ance)\b/i.test(v);
    return isName
      ? { name: v, key: v, desc: o.show_name || '', member: memberKeys.has(v), source: 'live' }
      : { name: o.show_name || v, key: v, desc: o.sub_display || '', member: memberKeys.has(v), source: 'live' };
  });
  // 合并内置会员模型（skill/pack 不返回会员档；按 key 去重，live 优先）
  const extra = MEMBER_MODELS[skillType === 17 ? 'video' : 'image'] || [];
  const seen = new Set(live.map((m) => m.key));
  const models = [...live, ...extra.filter((m) => !seen.has(m.key)).map((m) => ({ ...m, source: 'builtin' }))];
  // model_capability 在 .data.video_generation.meta.model_capability（深度搜索兜底）
  let cap = null;
  const findCap = (o) => {
    if (!o || typeof o !== 'object' || cap) return;
    if (Array.isArray(o)) return o.forEach(findCap);
    for (const [k, v] of Object.entries(o)) {
      if (k === 'model_capability' && v && typeof v === 'object') {
        cap = v;
        return;
      }
      findCap(v);
    }
  };
  findCap(data);
  const capabilities = {};
  for (const m of models) {
    const c = cap?.[m.key];
    if (!c) continue;
    capabilities[m.key] = {
      durations: c.supported_durations || null,
      range: c.supported_duration_range
        ? { lower: c.supported_duration_range.lower, upper: c.supported_duration_range.upper, step: c.supported_duration_range.step }
        : null,
      ratios: c.supported_ratios || null,
    };
  }
  const otherParams = params.filter((p) => p !== modelParam).map((p) => ({ name: p.show_name || p.value, key: p.value, options: p.options.map((o) => o.value) }));
  return { skillType, models, capabilities, otherParams };
}

// 从流里收所有 rc_gen_image 地址，按 hash 归并（同图多格式=一张）
function collectImageHashes(blocks, into) {
  for (const blk of blocks) {
    for (const m of blk.matchAll(/"(https:\/\/[^"]*rc_gen_image\/([A-Za-z0-9_-]+)\.[^"]*)"/g)) {
      const full = m[1];
      const hash = m[2];
      const fmt = /~tplv-[a-z0-9]+-(cthumb_lwm3|cgen_lwm3|cgen_wm0|image_raw)\.(png|heic|webp|jpeg)/.exec(full);
      if (!into.has(hash)) into.set(hash, new Set());
      if (fmt) into.get(hash).add(`${fmt[1]}.${fmt[2]}`);
    }
  }
}

// ── 生图（支持 count 多张，一次请求最多 8 张；支持参考图最多 10 张）
//
// ⚠ 重要：豆包**没有**「生成数量」参数。想出多张，必须在提示词里明说张数。
//   实测（2026-11-14）：
//     "只写画面描述"            + --count 3 → 只回 1 张
//     "生成3张不同构图的…"      + --count 3 → 真回 3 张
//   所以这里把 count 自动织进指令：count>1 时前缀「生成N张构图各不相同的图片：」。
//   想自己完全掌控措辞时传 --no-count-hint。
function withCountHint(prompt, count) {
  if (count <= 1) return prompt;
  return `生成${count}张构图各不相同的图片：${prompt}`;
}

async function genImage({ prompt, model, ratio, count = 1, refs = [] }) {
  const localConv = `local_${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const instructed = String(getArg('no-count-hint', '')) === 'true' ? prompt : withCountHint(prompt, count);
  const text = `生成图片：${instructed}，${ratio}`;
  // 参考图先走纯 HTTP 上传，拿到 uri 再塞进 attachment_block
  let attach = null;
  if (refs.length) {
    const up = await uploadRefImages({ files: refs, buildQuery, headers });
    console.log(`[ref] 已上传 ${up.length} 张参考图`);
    if (up.length) attach = buildAttachmentBlock(up);
  }
  const blocks = [];
  if (attach) blocks.push(attach);
  blocks.push({
    block_type: 10000,
    content: { text_block: { text, icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' },
    block_id: randomUUID(),
    parent_id: '',
    meta_info: [],
    extra_info: {},
    append_fields: [],
  });
  const body = {
    client_meta: {
      local_conversation_id: localConv,
      conversation_id: '',
      bot_id: '7338286299411103781',
      last_section_id: '',
      last_message_index: null,
      local_permissions: [
        { permission_name: 'ACCESS_COARSE_LOCATION', status: 3 },
        { permission_name: 'ACCESS_FINE_LOCATION', status: 3 },
        { permission_name: 'ACCESS_BACKGROUND_LOCATION', status: 3 },
      ],
    },
    messages: [
      {
        local_message_id: randomUUID(),
        content_block: blocks,
        message_status: 0,
      },
    ],
    option: {
      send_message_scene: '',
      create_time_ms: Date.now(),
      collect_id: '',
      is_audio: false,
      answer_with_suggest: false,
      tts_switch: false,
      need_deep_think: 0,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      is_from_click_softlink: false,
      disable_sse_cache: false,
      select_text_action: '',
      is_select_text: false,
      resend_for_regen: false,
      scene_type: 0,
      unique_key: randomUUID(),
      start_seq: 0,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: '',
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: '',
      shared_app_id: '',
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      is_ai_playground: false,
      is_old_user: true,
      general_task_param: { server_do_compare: true },
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000), append_sse_event_scene: 0 },
      message_storage_type: 0,
      related_deleted_message_ids: {},
      connector_info_list: [],
      model_config: { model_item_key: '', model_extra_params: {} },
      aggregate_params: {
        mention_skill_list: '[]',
        mention_plugin_list: '[]',
        mention_ext: '[{}]',
        conversation_mode: '1',
        mode_id: '',
        model_item_key: '',
        agent_mode: '',
        reasoning_effort: '',
        provider_id: '',
      },
      conversation_mode: 1,
    },
    chat_ability: {
      ability_type: 3,
      ability_param: JSON.stringify({
        ability_param: {
          model,
          ratio,
          input_box_content: { user_input_content: prompt, reply_message_format: '生成图片：%s' },
        },
        ability_type: 1,
      }),
    },
    user_context: [],
    ext: {
      answer_with_suggest: '0',
      sub_conv_firstmet_type: '1',
      general_task_param: '{"server_do_compare":true}',
      collection_id: '',
      is_finish: '1',
      conversation_init_option: '{"need_ack_conversation":true}',
      commerce_credit_config_enable: '0',
    },
  };

  const url = `${BASE}/chat/completion?${buildQuery({ tz_name: 'Etc/GMT-8' })}`;
  const resp = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  if (!/event-stream/i.test(resp.headers.get('content-type') || '')) {
    throw new Error(`非 SSE 响应: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`);
  }
  const urls = new Set();
  const hashes = new Map();
  const wantCount = Math.min(Math.max(1, Number(count) || 1), LIMITS.maxGenImages);
  let convId = '';
  // 服务端会在 SSE 末尾的 SSE_REPLY_END.brief 里说明「额度用完」这类拒绝原因。
  // 不抓下来的话，上层只会看到「未拿到图片地址」，误以为是程序 bug（已踩过）。
  let brief = '';
  await readSSE(resp, {
    maxSec: 300,
    onEvent: (ev, data, block) => {
      if (!convId) {
        const m = /"conversation_id":"(\d+)"/.exec(block);
        if (m) convId = m[1];
      }
      if (ev === 'SSE_REPLY_END' && !brief) {
        const m = /"brief":"((?:[^"\\]|\\.)*)"/.exec(block);
        if (m) brief = m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
      }
      for (const m of block.matchAll(/"(https:\/\/[^"]*rc_gen_image[^"]*)"/g)) urls.add(m[1]);
      collectImageHashes([block], hashes);
    },
    // 单张时见到成品就收流；多张时必须等流自然结束（多张是陆续下发的，提前断会漏图）
    stopWhen: wantCount <= 1 ? () => [...urls].some((u) => /image_raw\.png/.test(u)) : undefined,
  });
  return { convId, urls: [...urls], hashes: [...hashes.keys()], brief };
}

// 从对话 JSON 里提取视频地址（域名形如 v26-vdl.doubao.com，路径含 /video/tos/）
function extractVideoUrls(text) {
  const out = new Set();
  for (const re of [/https:\/\/[^"\\\s]*vdl\.doubao\.com[^"\\\s]*/g, /https:\/\/[^"\\\s]*\/video\/tos\/[^"\\\s]*/g]) {
    for (const m of text.matchAll(re)) out.add(m[0].replace(/\\\//g, '/'));
  }
  return [...out];
}

// 查某个会话的当前消息（不生成，只读）
async function fetchConversation(convId) {
  return postIm('/im/conversation/batch_get', {
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
  });
}

// ── 生视频（两轮：提交参数 → 确认 → 轮询）
async function genVideo({ prompt, model, ratio, duration, resolution, maxSec = 900 }) {
  const localConv = `local_${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const text = `生成视频：${prompt}，${ratio}，${duration}s，${resolution}`;
  const abilityParam = {
    ratio,
    model,
    duration: Number(duration),
    resolution,
    input_box_content: { user_input_content: prompt, reply_message_format: '生成视频：%s' },
  };

  const mkBody = ({ conversationId, text: t, ability }) => ({
    client_meta: {
      local_conversation_id: conversationId ? '' : localConv,
      conversation_id: conversationId || '',
      bot_id: '7338286299411103781',
      last_section_id: '',
      last_message_index: null,
      local_permissions: [
        { permission_name: 'ACCESS_COARSE_LOCATION', status: 3 },
        { permission_name: 'ACCESS_FINE_LOCATION', status: 3 },
        { permission_name: 'ACCESS_BACKGROUND_LOCATION', status: 3 },
      ],
    },
    messages: [
      {
        local_message_id: randomUUID(),
        content_block: [
          {
            block_type: 10000,
            content: { text_block: { text: t, icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' },
            block_id: randomUUID(),
            parent_id: '',
            meta_info: [],
            extra_info: {},
            append_fields: [],
          },
        ],
        message_status: 0,
      },
    ],
    option: {
      send_message_scene: '',
      create_time_ms: Date.now(),
      collect_id: '',
      is_audio: false,
      answer_with_suggest: false,
      tts_switch: false,
      need_deep_think: 0,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      is_from_click_softlink: false,
      disable_sse_cache: false,
      select_text_action: '',
      is_select_text: false,
      resend_for_regen: false,
      scene_type: 0,
      unique_key: randomUUID(),
      start_seq: 0,
      need_create_conversation: !conversationId,
      conversation_init_option: { need_ack_conversation: true },
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: '',
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: '',
      shared_app_id: '',
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      is_ai_playground: false,
      is_old_user: true,
      general_task_param: { server_do_compare: true },
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000), append_sse_event_scene: 0 },
      message_storage_type: 0,
      related_deleted_message_ids: {},
      connector_info_list: [],
      model_config: { model_item_key: '', model_extra_params: {} },
      aggregate_params: {
        mention_skill_list: '[]',
        mention_plugin_list: '[]',
        mention_ext: '[{}]',
        conversation_mode: '1',
        mode_id: '',
        model_item_key: '',
        agent_mode: '',
        reasoning_effort: '',
        provider_id: '',
      },
      conversation_mode: 1,
    },
    chat_ability: ability ? { ability_type: 17, ability_param: JSON.stringify(ability) } : {},
    user_context: [],
    ext: {
      answer_with_suggest: '0',
      sub_conv_firstmet_type: '1',
      general_task_param: '{"server_do_compare":true}',
      collection_id: '',
      is_finish: '1',
      conversation_init_option: '{"need_ack_conversation":true}',
      commerce_credit_config_enable: '0',
    },
  });

  const post = async (body) => {
    const url = `${BASE}/chat/completion?${buildQuery({ tz_name: 'Etc/GMT-8' })}`;
    const resp = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!/event-stream/i.test(resp.headers.get('content-type') || '')) {
      throw new Error(`非 SSE 响应: HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    }
    return resp;
  };

  // 第 1 轮：提交参数，等确认卡
  let convId = '';
  let confirmText = '';
  const resp1 = await post(mkBody({ conversationId: '', text, ability: abilityParam }));
  await readSSE(resp1, {
    maxSec: 120,
    onEvent: (ev, data, block) => {
      const m = /"conversation_id":"(\d+)"/.exec(block);
      if (m && !convId) convId = m[1];
      const t = /"brief":"([^"]{0,400})"/.exec(block);
      if (t) confirmText = t[1].replace(/\\n/g, ' ');
    },
    stopWhen: (ev) => ev === 'SSE_REPLY_END',
  });
  console.log('[turn1] conversation_id =', convId);
  console.log('[turn1] 回执:', (confirmText || '(无)').slice(0, 220));

  // 豆包三种回执：
  //   ①「本次使用 X 生成，大约需要 1-3 分钟」→ 已直接开工，**不要再发确认**（否则会重复生成、白烧额度）
  //   ②「…请先确认以下参数…确认后我再开始生成视频」→ 需要回「确认」
  //   ③「…是否继续生成？」→ 需要回「继续生成」
  // 注意：③ 必须只认**疑问句**。有时豆包只陈述「本次将消耗付费额度，并使用优先生成通道。」，
  // 这是「已开工」的通知，此时再发「继续生成」会重复生成、白烧额度。
  const askQuota = /是否继续生成|要继续生成吗|确认继续生成|是否继续视频生成/.test(confirmText);
  const askParams = /确认后我再开始生成视频|视频生成参数确认|请先确认/.test(confirmText);
  if (askQuota || askParams) {
    const reply = askQuota ? '继续生成' : '确认，开始生成';
    const resp2 = await post(mkBody({ conversationId: convId, text: reply, ability: null }));
    await readSSE(resp2, { maxSec: 90, stopWhen: (ev) => ev === 'SSE_REPLY_END' });
    console.log(`[turn2] 已回复「${reply}」（${askQuota ? '额度确认' : '参数确认'}），开始轮询结果…`);
  } else {
    console.log('[turn2] 已自动开工，跳过确认（避免重复生成），开始轮询结果…');
  }

  // 轮询对话，找视频地址
  // 注意：视频地址域名形如 https://v26-vdl.doubao.com/<hash>/<hash>/video/tos/cn/...
  // 需要 /im/conversation/batch_get（cmd 1111）才带消息正文，cmd 1110 只有会话元信息
  const deadline = Date.now() + maxSec * 1000;
  let round = 0;
  while (Date.now() < deadline) {
    round += 1;
    await sleep(round === 1 ? 20000 : 25000);
    let info;
    try {
      info = await postIm('/im/conversation/batch_get', {
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
      });
    } catch (e) {
      console.log(`[poll${round}] 查询失败: ${String(e.message).slice(0, 120)}`);
      continue;
    }
    const txt = JSON.stringify(info);
    const vids = extractVideoUrls(txt);
    console.log(`[poll${round}] videoUrls=${vids.length} len=${txt.length}`);
    if (vids.length) return { convId, urls: vids };
    const err = /"status_code":(?!0)\d+/.exec(txt);
    if (err) console.log('[poll] 服务端异常:', txt.slice(0, 200));
  }
  throw new Error('等待视频超时');
}

// ── 下载（CDN 偶发断连，重试 3 次）
async function download(url, ext, tries = 3) {
  let lastErr = null;
  for (let i = 1; i <= tries; i += 1) {
    try {
      const resp = await fetch(url, { headers: { referer: `${BASE}/`, 'user-agent': UA } });
      if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 1024) throw new Error(`下载内容异常（${buf.length} 字节）`);
      await mkdir(OUT_DIR, { recursive: true });
      const file = path.join(OUT_DIR, `http_${Date.now()}.${ext}`);
      await writeFile(file, buf);
      return { file, bytes: buf.length, mb: Math.round((buf.length / 1048576) * 100) / 100, tries: i };
    } catch (e) {
      lastErr = e;
      if (i < tries) {
        const wait = 1500 * i;
        console.log(`[download] 第 ${i} 次失败（${String(e.message).slice(0, 80)}），${wait}ms 后重试…`);
        await sleep(wait);
      }
    }
  }
  throw new Error(`下载失败（重试 ${tries} 次）：${String(lastErr && lastErr.message)}`);
}

// 同一会话可能残留多个视频（预览/正式/历史），按实际字节数挑最大的那个
async function pickLargest(urls) {
  const scored = [];
  for (const u of urls) {
    let size = 0;
    try {
      const r = await fetch(u, { method: 'HEAD', headers: { referer: `${BASE}/`, 'user-agent': UA } });
      size = Number(r.headers.get('content-length') || 0);
    } catch {
      /* 忽略 */
    }
    scored.push({ u, size });
  }
  scored.sort((a, b) => b.size - a.size);
  return scored[0]?.u || urls[0];
}

function pickBest(urls, kind) {
  const score = (u) => {
    if (kind === 'image') {
      if (/image_raw\.png/.test(u)) return 9;
      if (/image_raw\.heic/.test(u)) return 8;
      if (/cgen_wm0\.png/.test(u)) return 7;
      if (/cgen_wm0/.test(u)) return 6;
      if (/cgen_lwm3\.png/.test(u)) return 5;
      if (/cthumb/.test(u)) return 1;
      return 3;
    }
    if (/\.mp4/.test(u) || /video_mp4/.test(u)) return 9;
    return 5;
  };
  return [...urls].sort((a, b) => score(b) - score(a))[0];
}

// 描述校验：空 / 明显是占位符（历史上出现过把 cmd 的 $P$G 当描述发出去）→ 直接拒，不浪费额度
function assertPrompt(p) {
  const s = String(p ?? '').trim();
  if (!s) {
    console.error('[错误] 描述不能为空（--prompt）');
    process.exit(1);
  }
  if (/^\$P(\$G)?$|^%[A-Z_]+%$|^!.*!$/.test(s)) {
    console.error(`[错误] 描述看起来是未替换的占位符："${s}"，请传真实描述`);
    process.exit(1);
  }
  return s;
}

// ── 主流程
const t0 = Date.now();
if (mode === 'models') {
  const forWhat = String(getArg('for', 'video')).toLowerCase();
  const skillType = forWhat === 'video' ? 17 : 3;
  const r = await fetchModels(skillType);
  console.log(
    JSON.stringify(
      { mode: forWhat, skillType, count: r.models.length, models: r.models, capabilities: r.capabilities, otherParams: r.otherParams },
      null,
      2,
    ),
  );
  if (!r.models.length) {
    console.error('\n[hint] 没拿到模型清单，通常是 cookie 已失效（未登录）。');
    console.error('       处理：关闭 Edge 后跑 get_cookies.mjs 重新解密，或跑 login.mjs 扫码登录。');
  }
  process.exitCode = r.models.length ? 0 : 3;
} else if (mode === 'image') {
  const prompt = assertPrompt(getArg('prompt', ''));
  const model = getArg('model', 'Seedream 4.5');
  const ratio = getArg('ratio', '16:9');
  const count = Math.min(Math.max(1, Number(getArg('count', '1')) || 1), LIMITS.maxGenImages);
  const refs = collectRefArgs().slice(0, LIMITS.maxRefImages);
  console.log(`[image] model=${model} ratio=${ratio} count=${count}${refs.length ? ` refs=${refs.length}` : ''}`);
  const { convId, urls, hashes, brief } = await genImage({ prompt, model, ratio, count, refs });
  console.log(`[image] conv=${convId} 原图=${hashes.length} 地址=${urls.length}`);
  if (!urls.length) {
    // 服务端明确给了理由就照实说，别让用户以为是自己命令写错了
    if (brief) throw new Error(`豆包没有出图：${brief}`);
    throw new Error('未拿到图片地址（服务端没有返回任何图片，也没有说明原因）');
  }
  // 每张原图各挑一个最优格式下载
  const byHash = new Map();
  for (const u of urls) {
    const m = /rc_gen_image\/([A-Za-z0-9_-]+)\./.exec(u);
    if (!m) continue;
    const h = m[1];
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(u);
  }
  const order = [...byHash.keys()];
  const picked = order.slice(0, count).map((h) => pickBest(byHash.get(h), 'image'));
  const saved = [];
  for (const u of picked) {
    const dl = await download(u, /\.webp/i.test(u) ? 'webp' : 'png');
    saved.push(dl);
    console.log(`[saved] ${dl.file}  ${dl.mb} MB`);
  }
  console.log(
    '[summary]',
    JSON.stringify({ count: saved.length, elapsedSec: Math.round((Date.now() - t0) / 1000), files: saved.map((s) => s.file) }),
  );
  process.exitCode = saved.length ? 0 : 1;
} else if (mode === 'video') {
  const prompt = assertPrompt(getArg('prompt', ''));
  const model = getArg('model', 'seedance_v2.0_mini');
  const ratio = getArg('ratio', '16:9');
  const duration = getArg('duration', '4');
  const resolution = String(getArg('resolution', '720p')).toLowerCase();
  console.log(`[video] model=${model} ratio=${ratio} ${duration}s ${resolution}`);
  const { convId, urls } = await genVideo({ prompt, model, ratio, duration, resolution, maxSec: Number(getArg('timeout', 900)) });
  console.log(`[video] conv=${convId} urls=${urls.length}`);
  const best = await pickLargest(urls);
  const dl = await download(best, 'mp4');
  console.log('[saved]', JSON.stringify({ ...dl, elapsedSec: Math.round((Date.now() - t0) / 1000) }));
  process.exitCode = 0;
} else if (mode === 'poll') {
  // 只查已有会话的结果，不生成；图片/视频都支持
  const convId = getArg('conv', '');
  if (!convId) throw new Error('缺少 --conv');
  const info = await fetchConversation(convId);
  const txt = JSON.stringify(info);
  const vids = extractVideoUrls(txt);
  const imgs = [...new Set([...txt.matchAll(/https:\/\/[^"\\\s]*rc_gen_image[^"\\\s]*/g)].map((m) => m[0].replace(/\\\//g, '/')))];
  console.log(`[poll] conv=${convId} len=${txt.length} 视频=${vids.length} 图片=${imgs.length}`);
  for (const v of vids.slice(0, 2)) console.log('   视频:', v.slice(0, 130));
  for (const i of imgs.slice(0, 2)) console.log('   图片:', i.slice(0, 130));
  if (vids.length) {
    const dl = await download(await pickLargest(vids), 'mp4');
    console.log('[saved]', JSON.stringify(dl));
  } else if (imgs.length) {
    const dl = await download(pickBest(imgs, 'image'), 'png');
    console.log('[saved]', JSON.stringify(dl));
  } else {
    console.log('[poll] 该会话里没有找到图片或视频结果');
  }
  process.exitCode = vids.length || imgs.length ? 0 : 3;
} else {
  console.error('用法: node doubao_http.mjs models|image|video|poll ...');
  process.exitCode = 2;
}
