#!/usr/bin/env node
/**
 * 豆包网页版 生图/生视频 独立脚本（Edge + CDP）
 *
 * 用法：
 *   node doubao_gen.mjs image --prompt "雨夜东京街头，柴犬" --model "Seedream 5.0 Pro" --ratio 16:9
 *   node doubao_gen.mjs video --prompt "橘猫窗台伸懒腰" --model "Seedance 2.5" --ratio 16:9 --duration 10 --resolution 720P
 *
 * 依据 doubao_dom_map.md 的实测契约：
 * - 参数项没有 data-testid，按「面板 rect + 文本」定位
 * - 时长滑块运行时读 aria-valuemax（会员 26 / 非会员 11），不硬编码
 * - 视频↔图像切换必须整页导航重置
 * - 视频结果是懒加载卡片，点击后才出现 <video>
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// 浏览器探测：不再硬编码 msedge.exe
import { pickBrowser, describeFailure } from './browser.mjs';

const WS = process.cwd();
const CHAT_URL = 'https://www.doubao.com/chat/';
const PORT = Number(process.env.DOUBAO_EDGE_PORT || 9226);
const PROFILE = process.env.DOUBAO_EDGE_PROFILE || path.join(WS, 'doubao_edge_profile');
const OUT_DIR = process.env.DOUBAO_OUT || path.join(WS, 'doubao_out');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = { mode };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true';
      opts[key] = val;
    }
  }
  return opts;
}

const args = parseArgs(process.argv.slice(2));
const MODES = ['image', 'video', 'models'];
if (!args.mode || !MODES.includes(args.mode) || (args.mode !== 'models' && !args.prompt)) {
  console.error(
    [
      '用法:',
      '  node doubao_gen.mjs image  --prompt "..." [--model X] [--ratio 16:9]',
      '  node doubao_gen.mjs video  --prompt "..." [--model X] [--ratio 16:9] [--duration 10] [--resolution 720P]',
      '  node doubao_gen.mjs models --for image|video    # 列出当前可用模型（不生成、不消耗额度）',
    ].join('\n'),
  );
  process.exit(2);
}

// 描述校验：空 / 未替换的占位符（历史上出现过把 cmd 的 $P$G 当描述发出去）→ 直接拒，别浪费额度
if (args.mode !== 'models') {
  const p = String(args.prompt || '').trim();
  if (!p || /^\$P(\$G)?$|^%[A-Z_]+%$|^!.*!$/.test(p)) {
    console.error(`[错误] --prompt 无效（"${p}"），请传真实描述`);
    process.exit(1);
  }
  args.prompt = p;
}

const isVideo = args.mode === 'video';
const isModels = args.mode === 'models';
// 默认走非会员档位（额度友好）；会员档位用 --model 显式指定
const model = args.model || (isVideo ? 'Seedance 2.0 Mini' : 'Seedream 4.5');
const ratio = args.ratio || '16:9';
const duration = Number(args.duration || 10);
const resolution = (args.resolution || '720P').toUpperCase();
const timeoutSec = Number(args.timeout || (isVideo ? 1200 : 180));

// ── 实测上限（2026-11-14）
//   参考图：一次最多 10 张（传 12 张时页面只保留前 10 张）
//   生成数量：一次最多 8 张；豆包没有数量控件，必须写进提示词才会真出多张
const MAX_REF_IMAGES = 10;
const MAX_GEN_IMAGES = 8;

// 收集 --ref（支持多次 --ref，或 --ref a.png,b.png）
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

function collectRefs() {
  const out = [];
  const raw = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== '--ref') continue;
    const v = process.argv[i + 1];
    if (!v || v.startsWith('--')) continue;
    for (const piece of String(v).split(',')) {
      const p = cleanPath(piece);
      if (p) raw.push(p);
    }
  }
  for (const p of raw) {
    if (!existsSync(p)) {
      console.log(`[ref] ⚠ 文件不存在，跳过：${p}`);
      continue;
    }
    out.push(path.resolve(p));
  }
  if (out.length > MAX_REF_IMAGES) {
    console.log(`[ref] ⚠ 参考图最多 ${MAX_REF_IMAGES} 张，已忽略多余的 ${out.length - MAX_REF_IMAGES} 张`);
    out.length = MAX_REF_IMAGES;
  }
  return out;
}

const refs = collectRefs();
const genCount = Math.min(Math.max(1, Number(args.count || 1) || 1), MAX_GEN_IMAGES);

// 数量必须织进提示词（豆包没有数量参数）
function withCountHint(p) {
  if (genCount <= 1) return p;
  return `生成${genCount}张构图各不相同的图片：${p}`;
}

// 解析 playwright-core。要找到的是「真正的文件」，不能是目录。
//
// 历史坑（2026-11-15）：过去把插件自己的 package.json 也当搜索起点，
// 而插件目录名是 @local/dsh-doubao —— 在 profile 的 node_modules 里它是**目录**。
// Node 的 ESM 解析器不允许 import 目录，于是报：
//   ERR_UNSUPPORTED_DIR_IMPORT: Directory import '...\node_modules\@local\dsh-doubao'
// 所以：只认真实文件（.js/.cjs/.mjs）、且必须存在；解析到目录/自身一律跳过。
function resolvePw() {
  const starts = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@playwright', 'cli', 'package.json'),
    path.join(WS, 'node_modules', 'playwright-core', 'package.json'),
  ].filter((p) => existsSync(p));

  for (const start of starts) {
    try {
      const resolved = createRequire(start).resolve('playwright-core');
      if (typeof resolved !== 'string' || !resolved) continue;
      if (!/\.(c|m)?js$/i.test(resolved)) continue;
      if (!existsSync(resolved)) continue;
      return resolved;
    } catch {
      /* next */
    }
  }
  return '';
}

/**
 * 加载 playwright-core。找不到就抛一个**人能看懂**的错误，
 * 而不是让 pathToFileURL('') 产生一个莫名其妙的 ESM 异常。
 */
async function loadPlaywright() {
  const pw = resolvePw();
  if (!pw) {
    throw new Error(
      [
        '找不到 playwright-core（浏览器模式需要它）。处理二选一：',
        '  ① npm i -g @playwright/cli  然后重跑',
        '  ② 改用直连模式：加 --mode direct（不需要浏览器）',
      ].join('\n'),
    );
  }
  return import(pathToFileURL(pw).href);
}

async function ensureEdge() {
  const probe = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };
  if (await probe()) {
    if (String(args['restart-edge']) === 'true') {
      // 必须「优雅关闭」：强杀会让 Chromium 来不及把 cookie 落盘，登录态会丢
      try {
        const mod = await loadPlaywright();
        const chromium = mod.chromium || mod.default?.chromium;
        const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
        await b.close(); // 对 CDP 连接而言等价于 Browser.close，浏览器会正常退出并刷盘
      } catch {
        /* ignore */
      }
      await sleep(2500);
    } else {
      return 'reused';
    }
  }
  // 不再硬编码 msedge.exe：用 browser.mjs 统一探测
  // （环境变量 DOUBAO_BROWSER / 系统默认浏览器 / 已安装的 Chromium 系回退）
  const picked = pickBrowser();
  if (!picked.path) throw new Error(describeFailure());
  const edge = picked.path;
  await mkdir(PROFILE, { recursive: true });
  const { spawn } = await import('node:child_process');

  // 窗口可见性：--headless 无窗口；--hidden 移到屏幕外（仍是 headful，最不易被识别）；--minimized 最小化
  const extra = [];
  if (String(args.headless) === 'true') extra.push('--headless=new');
  else if (String(args.hidden) === 'true') extra.push('--window-position=-3200,-3200');
  else if (String(args.minimized) === 'true') extra.push('--start-minimized');

  const child = spawn(
    edge,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1440,960',
      ...extra,
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await probe()) return `spawned(${extra.join(',') || 'visible'})`;
    await sleep(500);
  }
  throw new Error('Edge DevTools 未就绪');
}

// ── 页面内工具
// Playwright 的 page.evaluate 只接受 (fn, arg) 两个参数，入参必须打包成对象
const findTextFn = ({ src, bottomOnly = true, maxLen = 40 }) => {
  const rx = new RegExp(src);
  const vh = window.innerHeight;
  const cands = [];
  document.querySelectorAll('span, div, button').forEach((el) => {
    const t = (el.innerText || '').trim();
    if (!t || t.length > maxLen || !rx.test(t)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    if (bottomOnly && r.top < vh * 0.7) return;
    let d = 0;
    for (let n = el; n.parentElement; n = n.parentElement) d += 1;
    cands.push({
      t: t.replace(/\s+/g, ' '),
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
      d,
    });
  });
  cands.sort((a, b) => b.d - a.d);
  return cands[0] || null;
};

async function clickText(page, src, opts = {}) {
  const hit = await page.evaluate(findTextFn, { src, ...opts });
  if (!hit) return null;
  await page.mouse.click(hit.x, hit.y);
  return hit;
}

/** 轮询等待某段文本出现：点完技能/切模式后 UI 有渲染延迟，只读一次会偶发拿不到 */
async function waitForText(page, src, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await page.evaluate(findTextFn, { src, bottomOnly: true });
    if (hit) return hit;
    await sleep(400);
  }
  return null;
}

async function markPanel(page) {
  return page.evaluate(() => {
    document.querySelectorAll('[data-probe-panel]').forEach((e) => e.removeAttribute('data-probe-panel'));
    const all = Array.from(document.querySelectorAll('div')).filter((d) => {
      const t = d.innerText || '';
      return t.length < 1600 && /比例/.test(t) && /\d:\d/.test(t);
    });
    all.sort((a, b) => a.innerText.length - b.innerText.length);
    const root = all[0];
    if (!root) return null;
    root.setAttribute('data-probe-panel', '1');
    const r = root.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      text: (root.innerText || '').replace(/\s+/g, ' '),
    };
  });
}

async function clickInPanel(page, label) {
  const pos = await page.evaluate((lbl) => {
    const root = document.querySelector('[data-probe-panel="1"]');
    if (!root) return null;
    const cands = [];
    root.querySelectorAll('div, span, button').forEach((el) => {
      if ((el.innerText || '').trim() !== lbl) return;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 16) return;
      cands.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), area: r.width * r.height });
    });
    cands.sort((a, b) => b.area - a.area);
    return cands[0] || null;
  }, label);
  if (!pos) return false;
  await page.mouse.click(pos.x, pos.y);
  await sleep(500);
  return true;
}

async function readSummary(page) {
  // 摘要条在不同档位下结构不同：
  //   会员档位：一段「视频生成 模型 Seedance 2.5 自动 · 10s · 720P」
  //   非会员档位：两段「模型 Seedance 2.0 Mini」+「16:9 · 10s」
  // 所以取「底部区域、含『模型』、宽度足够大、文本最长」的那一行
  return page.evaluate(() => {
    const vh = window.innerHeight;
    const cands = [];
    document.querySelectorAll('div').forEach((el) => {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 140 || !/模型/.test(t)) return;
      const r = el.getBoundingClientRect();
      if (r.top < vh * 0.7) return;
      cands.push({ t, w: r.width });
    });
    if (!cands.length) return '';
    const wide = cands.filter((c) => c.w > 380).sort((a, b) => b.t.length - a.t.length);
    if (wide.length) return wide[0].t;
    return cands.sort((a, b) => b.t.length - a.t.length)[0].t;
  });
}

/** 面板里是否存在某分区（如「分辨率」） */
async function panelHasSection(page, name) {
  return page.evaluate((n) => {
    const root = document.querySelector('[data-probe-panel="1"]');
    return Boolean(root && (root.innerText || '').includes(n));
  }, name);
}

async function setDuration(page, seconds) {
  const readSlider = () =>
    page.evaluate(() => {
      const root = document.querySelector('[data-probe-panel="1"]');
      const sl = root && root.querySelector('[role="slider"]');
      if (!sl) return null;
      const track = sl.parentElement;
      const tr = track.getBoundingClientRect();
      const sr = sl.getBoundingClientRect();
      return {
        min: Number(sl.getAttribute('aria-valuemin')),
        max: Number(sl.getAttribute('aria-valuemax')),
        now: Number(sl.getAttribute('aria-valuenow')),
        track: { x: tr.x, y: tr.y, w: tr.width, h: tr.height },
        thumbX: sr.x + sr.width / 2,
        thumbY: sr.y + sr.height / 2,
      };
    });

  const info = await readSlider();
  if (!info) return { ok: false, reason: 'no-slider' };

  const startSec = 4;
  const targetIdx = Math.max(info.min, Math.min(info.max, seconds - startSec));
  const actualSec = startSec + targetIdx;

  // 用 aria-valuenow 校验（比摘要文本可靠）
  const verify = async () => {
    const cur = await readSlider();
    return Boolean(cur && cur.now === targetIdx);
  };

  // 方案 A：聚焦滑块后键盘操作（Radix slider 支持 Home / 方向键）
  await page.mouse.click(info.thumbX, info.thumbY);
  await sleep(250);
  if (targetIdx === info.min) {
    await page.keyboard.press('Home');
    await sleep(300);
  }
  if (await verify()) return { ok: true, requested: seconds, applied: actualSec, method: 'keyboard-home' };

  for (let i = 0; i < 40; i += 1) {
    const cur = await readSlider();
    if (!cur || cur.now === targetIdx) break;
    await page.keyboard.press(cur.now > targetIdx ? 'ArrowLeft' : 'ArrowRight');
    await sleep(80);
  }
  if (await verify()) return { ok: true, requested: seconds, applied: actualSec, method: 'keyboard-arrows' };

  // 方案 B：点轨道
  const ratioPos = info.max === info.min ? 0 : (targetIdx - info.min) / (info.max - info.min);
  await page.mouse.click(info.track.x + 6 + ratioPos * (info.track.w - 12), info.track.y + info.track.h / 2);
  await sleep(400);
  if (await verify()) return { ok: true, requested: seconds, applied: actualSec, method: 'track-click' };

  // 方案 C：拖动拇指
  await page.mouse.move(info.thumbX, info.thumbY);
  await page.mouse.down();
  await page.mouse.move(info.track.x + 6 + ratioPos * (info.track.w - 12), info.track.y + info.track.h / 2, { steps: 18 });
  await page.mouse.up();
  await sleep(400);
  const finalCur = await readSlider();
  return {
    ok: Boolean(finalCur && finalCur.now === targetIdx),
    requested: seconds,
    applied: finalCur ? startSec + finalCur.now : null,
    range: `${startSec}s~${startSec + info.max}s`,
    method: 'drag',
  };
}

async function activateSkill(page, which) {
  const sel = which === 'video' ? '[data-testid="skill_bar_button_17"]' : '[data-testid="skill_bar_button_3"]';
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate((s) => Boolean(document.querySelector(s)), sel);
    if (ready) break;
    await sleep(600);
  }
  const ok = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, sel);
  await sleep(2200);
  return ok;
}

// 打开「模型」下拉：摘要条会随技能切换重渲染，首次点击常落空 → 点击后轮询菜单，空则重试
async function openModelMenu(page) {
  const trig = await waitForText(page, '^模型\\s+\\S+');
  if (!trig) return { trig: null, items: [] };
  const readItems = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="menuitem"]')).map((m) => {
        const r = m.getBoundingClientRect();
        return {
          text: (m.innerText || '').trim().replace(/\s+/g, ' '),
          ariaChecked: m.getAttribute('aria-checked'),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        };
      }),
    );
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    // 每次重试都重新定位：重渲染后旧坐标可能已失效
    const t = attempt === 1 ? trig : await waitForText(page, '^模型\\s+\\S+', 4000);
    if (!t) continue;
    await page.mouse.move(t.x, t.y).catch(() => {});
    await sleep(150);
    await page.mouse.click(t.x, t.y);
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      await sleep(300);
      const items = await readItems();
      if (items.length) return { trig: t, items, attempts: attempt };
    }
    await sleep(500);
  }
  return { trig, items: [], attempts: 4 };
}

async function selectModel(page, wanted) {
  let last = { ok: false, reason: 'unknown' };
  for (let tryNo = 1; tryNo <= 2; tryNo += 1) {
    const opened = await openModelMenu(page);
    if (!opened.trig) return { ok: false, reason: 'no-model-trigger' };
    const items = opened.items;
    const hit = items.find((i) => i.text.startsWith(wanted));
    if (!hit) {
      last = { ok: false, reason: 'model-not-found', available: items.map((i) => i.text) };
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(800);
      continue;
    }
    await page.mouse.click(hit.x, hit.y);
    await sleep(1500);
    const summary = await readSummary(page);
    // 用完整模型名校验，避免「Seedance 2.0 Fast」被「Seedance 2.0」误判通过
    const ok = summary.includes(wanted) || summary.includes(hit.text.split(' ').slice(0, 3).join(' '));
    last = { ok, applied: hit.text, summary, menuAttempts: opened.attempts, tryNo };
    if (ok) return last;
    await sleep(800);
  }
  return last;
}

async function baselineImageKeys(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('img'))
      .map((i) => i.currentSrc || i.src || '')
      .filter(Boolean)
      .map((src) => {
        const m = /\/rc_gen_image\/([^.~/?#]+)/i.exec(src);
        return m && m[1] ? `k:${m[1]}` : src.split('?')[0];
      }),
  );
}

async function collectImages(page, baselineKeys) {
  return page.evaluate((baseline) => {
    const base = new Set(baseline);
    const key = (src) => {
      const m = /\/rc_gen_image\/([^.~/?#]+)/i.exec(src || '');
      return m && m[1] ? `k:${m[1]}` : src.split('?')[0];
    };
    const byKey = new Map();
    document.querySelectorAll('img').forEach((img) => {
      const src = img.currentSrc || img.src || '';
      if (!/^https?:/i.test(src)) return;
      const lower = src.toLowerCase();
      if (
        lower.includes('-cthumb') ||
        lower.includes('/rc/icon/') ||
        lower.includes('/static/image/') ||
        lower.includes('avatar') ||
        lower.includes('qrcode') ||
        lower.endsWith('.svg')
      ) {
        return;
      }
      const w = Math.max(img.naturalWidth || 0, img.width || 0);
      const h = Math.max(img.naturalHeight || 0, img.height || 0);
      if (!lower.includes('/rc_gen_image/') && (w < 360 || h < 360)) return;
      const k = key(src);
      if (base.has(k)) return;
      const score = lower.includes('wm0.png') ? 3 : lower.includes('wm0') ? 2 : 1;
      const prev = byKey.get(k);
      if (!prev || prev.score < score) byKey.set(k, { src, w, h, score, watermarkFree: lower.includes('wm0') });
    });
    return Array.from(byKey.values());
  }, baselineKeys);
}

async function download(url, ext) {
  const resp = await fetch(url, {
    headers: {
      Referer: 'https://www.doubao.com/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `doubao_${Date.now()}.${ext}`);
  await writeFile(file, buf);
  return { file, bytes: buf.length, mb: Math.round((buf.length / 1048576) * 100) / 100 };
}

// ── 主流程
const report = { mode: args.mode, model, ratio, prompt: args.prompt, steps: [] };
const step = (name, value) => {
  report.steps.push({ name, value });
  console.log(`[${name}]`, typeof value === 'string' ? value : JSON.stringify(value));
};

try {
  step('edge', await ensureEdge());
  const mod = await loadPlaywright();
  const chromium = mod.chromium || mod.default?.chromium;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('doubao.com')) || (await ctx.newPage());
  await page.setViewportSize({ width: 1440, height: 960 }).catch(() => {});

  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(4000);
  const loggedIn = await page.evaluate(() => document.querySelectorAll('[data-testid="to_login_button"]').length === 0);
  step('loggedIn', loggedIn);
  if (!loggedIn) throw new Error('豆包未登录：请在刚弹出的 Edge 窗口里扫码登录，登录成功后重新运行本脚本（或下次直接双击 登录.cmd 扫码）');

  // goto('/chat/') 会恢复上一个对话，旧结果卡片仍在 DOM 里 → 必须显式新建对话
  await page.evaluate(() => document.querySelector('[data-testid="create_conversation_button"]')?.click());
  await sleep(2500);
  step('newConversation', await page.evaluate(() => ({
    url: location.href,
    videos: document.querySelectorAll('video').length,
    bigImgs: Array.from(document.querySelectorAll('img')).filter((i) => i.getBoundingClientRect().width > 280).length,
  })));

  // ── models 模式：只读探测当前可用模型，不生成、不消耗额度
  if (isModels) {
    const target = String(args.for || 'image') === 'video' ? 'video' : 'image';
    step('discoverFor', target);
    step('activateSkill', await activateSkill(page, target));

    const opened = await openModelMenu(page);
    step('modelTrigger', opened.trig);
    if (!opened.trig) throw new Error('未找到「模型」下拉入口');

    const raw = opened.items.map((i) => ({ raw: i.text, ariaChecked: i.ariaChecked }));

    // 名字可能是两段（Seedance 2.5）或三段（Seedream 5.0 Pro）
    const models = raw.map(({ raw: t, ariaChecked }) => {
      const m = t.match(/^((?:Seedream|Seedance)\s+[\d.]+(?:\s+(?:Pro|Flash|Fast|Mini|Lite))?)/i);
      const name = m ? m[1].trim() : t.split(' ').slice(0, 2).join(' ');
      const desc = m ? t.slice(m[1].length).trim() : '';
      return { name, desc, selected: /✓/.test(t) || ariaChecked === 'true' };
    });

    // 勾选标记是 SVG 图标取不到文字 → 用摘要条里的当前模型名判定选中项
    const summary = await readSummary(page);
    let currentName = '';
    for (const m of models) {
      if (summary.includes(m.name) && m.name.length > currentName.length) currentName = m.name;
    }
    for (const m of models) {
      if (m.name === currentName) m.selected = true;
    }

    console.log('\n' + JSON.stringify({ mode: target, current: currentName || null, count: models.length, models }, null, 2));
    await page.keyboard.press('Escape').catch(() => {});
    process.exit(models.length ? 0 : 3);
  }

  step('activateSkill', await activateSkill(page, args.mode));
  step('afterActivate', await readSummary(page));

  // ── 参考图：必须在选完技能之后、发提示词之前塞进上传控件
  if (refs.length) {
    const fi = page.locator('input[type=file]').first();
    const has = await fi.count();
    if (!has) throw new Error('找不到上传控件 input[type=file]（参考图需要网页在技能态下渲染上传入口）');
    await fi.setInputFiles(refs);
    step('refUpload', { requested: refs.length, files: refs.map((r) => path.basename(r)) });
    // 等上传完成：缩略图出现（blob: 或 tos-cn-i-）
    const upDeadline = Date.now() + 90000;
    let thumbs = 0;
    while (Date.now() < upDeadline) {
      await sleep(1500);
      thumbs = await page.evaluate(() => {
        const vh = window.innerHeight;
        const set = new Set();
        document.querySelectorAll('img').forEach((i) => {
          const s = i.currentSrc || i.src || '';
          const r = i.getBoundingClientRect();
          if (r.top < vh * 0.45) return;
          if (!s.startsWith('blob:') && !/tos-cn-i-/.test(s)) return;
          if (r.width < 20) return;
          set.add(s);
        });
        return set.size;
      });
      if (thumbs >= refs.length) break;
    }
    step('refThumbs', thumbs);
    if (thumbs === 0) throw new Error('参考图上传后没有出现任何缩略图，放弃发送以免浪费额度');
  }

  step('selectModel', await selectModel(page, model));

  if (isVideo) {
    const trig = await waitForText(page, '^自动\\s*·');
    step('paramsTrigger', trig);
    if (trig) {
      await page.mouse.click(trig.x, trig.y);
      await sleep(1400);
      step('panel', await markPanel(page));
      step('setRatio', { clicked: await clickInPanel(page, ratio), ratio });
      step('setDuration', await setDuration(page, duration));
      // 分辨率：会员档位才有 720P/1080P；非会员档位固定 720P，面板里没有该分区
      if (await panelHasSection(page, '分辨率')) {
        step('setResolution', { clicked: await clickInPanel(page, resolution), resolution });
      } else {
        step('setResolution', { skipped: true, reason: '当前档位面板无「分辨率」分区（固定 720P）', requested: resolution });
      }
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(600);
    }
  } else {
    const trig = await waitForText(page, '^比例\\s*\\S+$');
    step('paramsTrigger', trig);
    if (trig) {
      await page.mouse.click(trig.x, trig.y);
      await sleep(1400);
      step('panel', await markPanel(page));
      step('setRatio', { clicked: await clickInPanel(page, ratio), ratio });
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(600);
    }
  }
  step('finalSummary', await readSummary(page));

  // --dry-run：只验证「技能/模型/比例/时长/分辨率」是否点选成功，不发送、不消耗额度
  if (String(args['dry-run']) === 'true') {
    step('dryRun', true);
    await page.screenshot({ path: path.join(OUT_DIR, `dryrun_${Date.now()}.png`) }).catch(() => {});
    console.log('\nRESULT ' + JSON.stringify(report, null, 2));
    process.exit(report.steps.some((s) => s.name === 'setDuration' && s.value && s.value.ok === false) ? 3 : 0);
  }

  const baseline = isVideo ? [] : await baselineImageKeys(page);
  // 视频也要基线：避免把上一个对话里的旧视频当成新结果
  const baselineVideos = isVideo
    ? await page.evaluate(() => Array.from(document.querySelectorAll('video')).map((v) => v.currentSrc || v.src || ''))
    : [];
  step('baseline', { images: baseline.length, videos: baselineVideos.length });
  const editor = page
    .locator('[data-testid="chat_input_input"] .ProseMirror, .ProseMirror[contenteditable="true"]')
    .first();
  await editor.waitFor({ state: 'visible', timeout: 15000 });
  await editor.click();
  const sendPrompt = isVideo ? args.prompt : withCountHint(args.prompt);
  step('promptSent', sendPrompt);
  await page.keyboard.insertText(sendPrompt);
  await sleep(700);
  const sendBtn = page.locator('[data-testid="chat_input_send_button"]').first();
  if (await sendBtn.count()) await sendBtn.click();
  else await page.keyboard.press('Enter');
  step('sent', new Date().toISOString());

  const deadline = Date.now() + timeoutSec * 1000;

  if (isVideo) {
    // 豆包有三种回执：
    //   ① 参数确认卡片 → 回「确认，开始生成」
    //   ② 直接开工 → 「本次使用 Seedance 2.0 Fast 生成，大约需要 1-3 分钟」
    //   ③ 额度确认 → 「…是否继续生成？」→ 回「继续生成」
    //      注意只认疑问句；「本次将消耗付费额度，并使用优先生成通道。」是已开工的陈述，不能回确认
    // 只在有限时间内等确认；等到与否都进入轮询（轮询才是取结果的唯一途径）
    const confirmDeadline = Date.now() + Math.min(timeoutSec * 1000, 90000);
    while (Date.now() < confirmDeadline) {
      await sleep(4000);
      const txt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '));
      const askQuota = /是否继续生成|要继续生成吗|确认继续生成|是否继续视频生成/.test(txt);
      const askParams = /确认后我再开始生成视频|视频生成参数确认/.test(txt);
      if (askQuota || askParams) {
        const reply = askQuota ? '继续生成' : '确认，开始生成';
        step(askQuota ? 'quotaConfirmRequested' : 'confirmationRequested', true);
        const ed2 = page
          .locator('[data-testid="chat_input_input"] .ProseMirror, .ProseMirror[contenteditable="true"]')
          .first();
        await ed2.click();
        await page.keyboard.insertText(reply);
        await sleep(600);
        const sb = page.locator('[data-testid="chat_input_send_button"]').first();
        if (await sb.count()) await sb.click();
        else await page.keyboard.press('Enter');
        step('confirmedAt', new Date().toISOString());
        step('confirmReply', reply);
        break;
      }
      // 没有确认卡片、已经直接开工
      if (/正在使用|本次使用|预计等待|大约需要|生成好后|排队中/.test(txt)) {
        step('acceptedDirectly', true);
        break;
      }
    }

    let video = null;
    let round = 0;
    const baseSet = new Set(baselineVideos);
    // 豆包不会推送结果：必须周期性刷新页面才能看到视频卡片
    while (Date.now() < deadline) {
      round += 1;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(4500);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await sleep(1800);

      const snap = await page.evaluate((base) => {
        const bs = new Set(base);
        const fresh = Array.from(document.querySelectorAll('video'))
          .map((v) => ({
            src: v.currentSrc || v.src || '',
            w: v.videoWidth,
            h: v.videoHeight,
            duration: v.duration,
          }))
          .filter((v) => v.src && !bs.has(v.src));
        const text = document.body.innerText || '';
        return {
          fresh,
          done: /视频生成好了|已生成视频|视频已生成/.test(text),
          busy: /正在生成|预计等待|渲染中|排队/.test(text),
        };
      }, baselineVideos);

      step(`poll${round}`, { fresh: snap.fresh.length, done: snap.done, busy: snap.busy });

      if (snap.fresh.length) {
        video = snap.fresh[snap.fresh.length - 1];
        break;
      }

      // 有「生成好了」但还没 <video>：点视频卡片海报触发懒加载
      if (snap.done) {
        const poster = await page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('img'))
            .map((i) => {
              const r = i.getBoundingClientRect();
              return { el: i, w: r.width, h: r.height };
            })
            .filter((i) => i.w > 280 && i.h > 150);
          const last = imgs[imgs.length - 1];
          if (!last) return null;
          last.el.scrollIntoView({ block: 'center' });
          const r = last.el.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        });
        if (poster) {
          await page.mouse.click(poster.x, poster.y).catch(() => {});
          await sleep(3000);
          const after = await page.evaluate((base) => {
            const bs = new Set(base);
            return Array.from(document.querySelectorAll('video'))
              .map((v) => ({ src: v.currentSrc || v.src || '', w: v.videoWidth, h: v.videoHeight, duration: v.duration }))
              .filter((v) => v.src && !bs.has(v.src));
          }, baselineVideos);
          if (after.length) {
            video = after[after.length - 1];
            break;
          }
        }
      }

      await sleep(30000);
    }
    if (!video) throw new Error('等待视频超时（未出现新的 <video>）');
    if (Number.isFinite(video.duration) && video.duration > duration + 3) {
      step('durationMismatch', { requested: duration, actual: Math.round(video.duration * 10) / 10 });
    }
    step('videoMeta', video);
    const dl = await download(video.src, 'mp4');
    step('downloaded', dl);
    report.result = { type: 'video', ...dl, ...video };
  } else {
    // 多张图是陆续落地的，等「够数」或超时；单张等到第一张成品就走
    let picked = [];
    const want = Math.max(1, genCount);
    while (Date.now() < deadline) {
      await sleep(4000);
      const found = await collectImages(page, baseline);
      if (found.length) {
        picked = found.sort((a, b) => b.score - a.score);
        if (picked.length >= want && picked[0].score >= 2) break;
        if (want === 1 && picked[0].score >= 2) break;
      }
    }
    if (!picked.length) {
      // 额度用完时豆包只在页面里回一句说明，不产生图；照实报出来，别让人以为程序坏了
      const why = await page
        .evaluate(() => {
          const t = document.body.innerText || '';
          const m = /[^。\n]{0,30}(?:额度已用完|额度不足|预计明天恢复|加购创作额度)[^。\n]{0,60}/.exec(t);
          return m ? m[0].replace(/\s+/g, ' ').trim() : '';
        })
        .catch(() => '');
      throw new Error(why ? `豆包没有出图：${why}` : '等待图片超时（页面没有出现新图片，也没有给出原因）');
    }
    // 按 hash 归并（同图多格式只算一张），取够 want 张
    const uniq = [];
    const seen = new Set();
    for (const p of picked) {
      const m = /\/rc_gen_image\/([^.~?#]+)/i.exec(p.src);
      const k = m ? m[1] : p.src.split('?')[0];
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push({ ...p, hash: k });
      if (uniq.length >= want) break;
    }
    const saved = [];
    for (const u of uniq) {
      const dl = await download(u.src, u.src.toLowerCase().includes('.webp') ? 'webp' : 'png');
      saved.push(dl);
      console.log(`[saved] ${dl.file}  ${dl.mb} MB`);
    }
    step('imageCount', { requested: want, got: saved.length });
    report.result = { type: 'image', count: saved.length, items: saved.map((s, i) => ({ ...s, hash: uniq[i].hash, w: uniq[i].w, h: uniq[i].h })) };
  }

  await mkdir(OUT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(OUT_DIR, `shot_${Date.now()}.png`) }).catch(() => {});
  console.log('\nRESULT ' + JSON.stringify(report, null, 2));
  process.exit(0);
} catch (err) {
  step('ERROR', String(err && err.message ? err.message : err));
  await mkdir(OUT_DIR, { recursive: true }).catch(() => {});
  await writeFile(path.join(OUT_DIR, `fail_${Date.now()}.json`), JSON.stringify(report, null, 2), 'utf8').catch(() => {});
  console.log('\nRESULT ' + JSON.stringify(report, null, 2));
  process.exit(1);
}
