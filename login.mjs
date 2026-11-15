/**
 * 豆包登录（两种方式）
 *
 *   默认（推荐）：--mode browser
 *     离屏 Edge 打开真实登录页 → 截取页面里的二维码给你扫 → 登录成功后直接从浏览器取 cookie
 *     优点：登录由真实页面完成，不受 passport 接口风控（「服务繁忙」）影响；二维码由页面自己刷新
 *     窗口在屏幕外（--window-position=-3200,-3200），不会打扰你
 *
 *   --mode http
 *     纯 HTTP 扫码（不启动任何浏览器）。服务端对 passport 接口有风控，可能返回「服务繁忙」，
 *     仅作为备选方案。
 *
 * 用法:
 *   node login.mjs                      # 默认 browser 方式
 *   node login.mjs --open               # 额外用系统看图程序打开二维码
 *   node login.mjs --mode http          # 纯 HTTP 方式
 *   node login.mjs --timeout 600        # 自定义等待秒数
 */
import { existsSync } from 'node:fs';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// 浏览器探测：不再硬编码 msedge.exe，改用系统默认浏览器 + 已安装回退
import { pickBrowser, describeFailure } from './browser.mjs';

const WS = process.cwd();
const OUT_DIR = process.env.DOUBAO_OUT || path.join(WS, 'doubao_out');
const COOKIE_FILE = process.env.DOUBAO_COOKIE_FILE || path.join(WS, 'doubao_cookies.txt');
const PROFILE = process.env.DOUBAO_EDGE_PROFILE || path.join(WS, 'doubao_edge_profile');
const PORT = Number(process.env.DOUBAO_EDGE_PORT || 9226);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0';
const HOST = 'https://accounts.doubao.com';
const CHAT_URL = 'https://www.doubao.com/chat/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const hasFlag = (n) => argv.includes(`--${n}`);
const TIMEOUT = Number(getArg('timeout', 300));
const OPEN = hasFlag('open');
const MODE = String(getArg('mode', 'browser')).toLowerCase();

// ───────────────────────── 公共：写 cookie + 验证
function toCookieString(cookieObjs) {
  const map = new Map();
  for (const c of cookieObjs) {
    if (!c || !c.name) continue;
    if (!/^[\x20-\x7E]*$/.test(c.value || '')) continue; // 非 ASCII 的会让请求头构造失败
    map.set(c.name, c.value);
  }
  return { str: [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; '), count: map.size, names: [...map.keys()] };
}

async function saveCookies(cookieObjs) {
  const { str, count, names } = toCookieString(cookieObjs);
  await writeFile(COOKIE_FILE, str, 'utf8');
  console.log(`   已写入 ${COOKIE_FILE}`);
  console.log(`   ${count} 条 · ${str.length} 字节 · 含 sessionid: ${names.includes('sessionid')}`);
  return { count, hasSession: names.includes('sessionid') };
}

async function verify() {
  const cookie = (await readFile(COOKIE_FILE, 'utf8')).trim();
  try {
    const r = await fetch('https://www.doubao.com/alice/profile/self?' + new URLSearchParams({ aid: '497858', device_platform: 'web', version_code: '20800' }), {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        cookie,
        referer: 'https://www.doubao.com/chat/',
        origin: 'https://www.doubao.com',
        'user-agent': UA,
        'agw-js-conv': 'str, str',
      },
      body: '{}',
    });
    const j = await r.json();
    const code = j?.status_code ?? j?.data?.error_code ?? null;
    return { ok: r.status === 200 && code === 0, status: r.status, code };
  } catch (e) {
    return { ok: false, reason: String(e.message).slice(0, 120) };
  }
}

// ───────────────────────── 方式一：离屏 Edge（默认）
// 解析 playwright-core，并且**拿到 ESM 入口**。
//
// 2026-11-15 两个踩坑记录（下面这段代码同时防这两个）：
//
//  坑 1：把插件自己的 package.json 当搜索起点，而插件目录名 @local/dsh-doubao 在 profile
//        的 node_modules 里是**目录**。ESM 不允许 import 目录，报
//        ERR_UNSUPPORTED_DIR_IMPORT。→ 所以搜索起点不能是插件自身，且必须落到真实文件。
//
//  坑 2（更隐蔽）：playwright-core 的 exports 声明了 import: ./index.mjs / require: ./index.js。
//        createRequire().resolve() 走的是 **require 条件**，拿到 index.js（CJS）。
//        再用动态 import() 加载 CJS 时，Node 互操作只挂 default，
//        于是 `mod.chromium` 是 undefined，只有 `mod.default.chromium` 有值。
//        → 所以优先取同一目录下的 index.mjs，这样 import 出来顶层就有 chromium。
function resolvePw() {
  const starts = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@playwright', 'cli', 'package.json'),
    path.join(WS, 'node_modules', 'playwright-core', 'package.json'),
  ].filter((p) => existsSync(p));

  for (const start of starts) {
    try {
      const cjsEntry = createRequire(start).resolve('playwright-core');
      if (typeof cjsEntry !== 'string' || !cjsEntry) continue;
      if (!existsSync(cjsEntry)) continue;
      if (!/\.(c|m)?js$/i.test(cjsEntry)) continue; // 目录/无扩展名一律跳过

      // 优先 ESM 入口（顶层直接有 chromium）
      const esmEntry = path.join(path.dirname(cjsEntry), 'index.mjs');
      if (existsSync(esmEntry)) return esmEntry;

      // 老版本没 index.mjs 就用 CJS；调用方会用 pickChromium 兜底 default.chromium
      return cjsEntry;
    } catch {
      /* next */
    }
  }
  return '';
}

/** 兼容两种导出形态：ESM 入口顶层有 chromium；CJS 经 import() 只有 default.chromium */
function pickChromium(mod) {
  return (mod && mod.chromium) || (mod && mod.default && mod.default.chromium) || null;
}

const cdpUp = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return r.ok;
  } catch {
    return false;
  }
};

async function ensureEdge() {
  if (await cdpUp()) return 'reused';
  // 不再硬编码 msedge.exe：用 browser.mjs 统一探测（默认浏览器 → 已安装的回退）
  const picked = pickBrowser();
  if (!picked.path) throw new Error(describeFailure());
  await mkdir(PROFILE, { recursive: true });
  const child = spawn(
    picked.path,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
      '--window-position=-3200,-3200', // 屏幕外，不打扰
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  const dl = Date.now() + 30000;
  while (Date.now() < dl) {
    if (await cdpUp()) return `spawned(off-screen, ${picked.name}, via ${picked.via})`;
    await sleep(400);
  }
  throw new Error(`${picked.name} 的 DevTools 端口未就绪（30 秒超时）`);
}

// 用 CDP 的 Browser.close 真正关掉 Edge，并等端口消失（确保 cookie 落盘、profile 解锁）
// 注意：playwright 的 browser.close() 对 connectOverCDP 的连接常常无效，实测关不掉
async function hardCloseEdge() {
  try {
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const ws = ver.webSocketDebuggerUrl;
    if (ws && typeof WebSocket === 'function') {
      const sock = new WebSocket(ws);
      await new Promise((res, rej) => {
        sock.onopen = res;
        sock.onerror = rej;
        setTimeout(rej, 3000);
      }).catch(() => {});
      try {
        sock.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      } catch {
        /* ignore */
      }
      await sleep(800);
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* Edge 可能已经不在 */
  }
  const dl = Date.now() + 12000;
  while (Date.now() < dl) {
    if (!(await cdpUp())) return true;
    await sleep(300);
  }
  return false;
}

async function browserLogin() {
  const t0 = Date.now();
  console.log('① 启动离屏 Edge（窗口在屏幕外，不影响你）…');

  // 先确认 playwright-core 找得到，再拉 Edge —— 否则会先无谓地拉起一个浏览器再崩
  const pwPath = resolvePw();
  if (!pwPath) {
    console.error('\n[错误] 找不到 playwright-core（扫码登录需要它来驱动 Edge）。');
    console.error('  处理二选一：');
    console.error('    ① 安装：npm i -g @playwright/cli   然后重跑');
    console.error('    ② 改用纯 HTTP 扫码，不依赖浏览器：node login.mjs --mode http');
    console.error('    ③ 或者：自己用 Edge 登录豆包后关闭 Edge，跑 node get_cookies.mjs');
    process.exitCode = 1;
    return;
  }

  console.log('   ' + (await ensureEdge()));

  const mod = await import(pathToFileURL(pwPath).href);
  const chromium = pickChromium(mod);
  if (!chromium) {
    console.error('\n[错误] playwright-core 加载到了，但拿不到 chromium。');
    console.error('  通常是版本不兼容。试：npm i -g @playwright/cli@latest');
    process.exitCode = 1;
    return;
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) => p.url().includes('doubao.com')) || ctx.pages()[0] || (await ctx.newPage());

  // 结束前统一收尾：保留最后一张二维码图，优雅关闭 Edge（刷盘 cookie），然后退出
  // 注意：CDP 连接是打开的 WebSocket，不显式 process.exit 会一直挂着不退
  const qrFiles = [];
  const finish = async (code, { closeEdge = true } = {}) => {
    for (const f of qrFiles.slice(0, -1)) {
      await (await import('node:fs/promises')).rm(f, { force: true }).catch(() => {});
    }
    if (closeEdge) {
      await hardCloseEdge();
    }
    process.exit(code);
  };

  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  // 等「登录」按钮真的出现再继续。
  // 实测：domcontentloaded 之后页面还在水合，固定 sleep(4000) 有时不够，
  // 按钮还没渲染出来就去点，自然点不到（整页截图里就是还没加载完的首页）。
  const waitForLoginButton = async (timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await page
        .evaluate(() => {
          if (document.querySelector('[data-testid="to_login_button"]')) return 'testid';
          for (const x of document.querySelectorAll('button')) {
            if (/^登录$/.test((x.innerText || '').trim())) {
              const r = x.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) return 'text';
            }
          }
          return '';
        })
        .catch(() => '');
      if (found) return found;
      await sleep(500);
    }
    return '';
  };
  const btnHow = await waitForLoginButton();
  if (btnHow) console.log('   登录按钮已出现（' + btnHow + '）');
  else console.log('   ⚠ 20 秒内没等到登录按钮');
  await sleep(800);

  const isLoggedIn = async () => {
    const cs = await ctx.cookies('https://www.doubao.com').catch(() => []);
    return cs.some((c) => c.name === 'sessionid' && c.value);
  };

  if (await isLoggedIn()) {
    console.log('② 检测到已登录，直接取 cookie…');
    const cs = await ctx.cookies('https://www.doubao.com');
    const r = await saveCookies(cs);
    const v = await verify();
    console.log('   验证:', JSON.stringify(v));
    await finish(r.hasSession && v.ok ? 0 : 4);
    return;
  }

  console.log('② 打开登录弹窗…');

  /**
   * 点开登录弹窗。
   *
   * 2026-11-15 实测查清了两个坑：
   *
   *  坑 1：`[data-testid="to_login_button"]` 这个选择器其实**还在**（页面没改版），
   *        但 Playwright 的 click() 会超时 8 秒、`el.click()` 也毫无反应。
   *
   *  坑 2（真因）：豆包未登录首页给整层套了 `pointer-events: none`。
   *        实测按钮及其 8 层祖先全是 pointer-events:none，
   *        document.elementFromPoint(按钮中心) 命中的是别的容器。
   *        所以任何「按坐标/按命中检测」的点击都会被浏览器丢掉。
   *
   * 解法：用 dispatchEvent 手工派发完整鼠标事件序列 —— 它不经过命中检测，
   * 所以能穿透 pointer-events:none。实测点击后二维码立刻出现。
   *
   * 顺序：先精确 testid → 再按文字 → 再按右上角位置兜底。
   */
  const fireClick = (selectorOrPicker) =>
    page
      .evaluate((kind) => {
        let el = null;
        if (kind.type === 'testid') {
          el = document.querySelector('[data-testid="to_login_button"]');
        } else if (kind.type === 'text') {
          const cands = [];
          for (const x of document.querySelectorAll('button,a,[role=button],div,span')) {
            const t = (x.innerText || '').trim();
            if (!/^(登录|立即登录|登录\/注册|扫码登录)$/.test(t)) continue;
            const r = x.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0) || r.width > 300 || r.height > 90) continue;
            cands.push({ x, right: window.innerWidth - (r.x + r.width) });
          }
          cands.sort((a, b) => a.right - b.right);
          el = cands.length ? cands[0].x : null;
        } else {
          // 位置兜底：最靠右上的按钮
          const b = Array.from(document.querySelectorAll('button'))
            .map((x) => ({ x, r: x.getBoundingClientRect() }))
            .filter((v) => v.r.width > 0 && v.r.height > 0 && v.r.y < 120)
            .sort((a, b2) => b2.r.x - a.r.x);
          el = b.length ? b[0].x : null;
        }
        if (!el) return 'not-found';

        // 只派发事件，**不**改 pointer-events、也不额外调 el.click()。
        //
        // 为什么这么克制（2026-11-15 实测对比）：
        //   - 纯 dispatchEvent 序列：点击成功、二维码出现（PASS）
        //   - dispatchEvent + el.click()：也成功
        //   - 但「先临时把 pointer-events 改成 auto」的做法，
        //     会让 React 的合成事件系统在还原样式时丢失状态，导致弹窗开了又关。
        //   dispatchEvent 本身不经过命中检测，所以 pointer-events:none 拦不住它，
        //   根本不需要改样式。
        const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
        el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, isPrimary: true }));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, isPrimary: true }));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return 'dispatched';
      }, selectorOrPicker)
      .catch((e) => 'ERR:' + e.message);

  // 已登录就直接跳过
  if (await isLoggedIn()) {
    console.log('   检测到已登录，跳过点按钮');
  } else {
    // 逐个尝试选择器，**成功一次就立刻停**。
    // 之前写成嵌套循环：testid 点开后弹窗已出现，但检测稍慢没命中，
    // 于是 text / pos 又各点了一次 —— 第二次点击把刚打开的弹窗又关掉了。
    // 现在每轮结束都检查 popped，命中就完全不碰后面的选择器。
    let popped = false;
    const checkQr = async () => {
      return page
        .evaluate(() => {
          if (document.querySelector('[class*=qrcode],[class*=qr-code],[class*=QrCode]')) return true;
          return /扫码登录|二维码|请使用.*客户端扫描/.test((document.body.innerText || '').replace(/\s+/g, ' '));
        })
        .catch(() => false);
    };

    for (let attempt = 1; attempt <= 3 && !popped; attempt += 1) {
      for (const picker of [{ type: 'testid' }, { type: 'text' }, { type: 'pos' }]) {
        const r = await fireClick(picker);
        if (r === 'not-found') continue;

        // 给足等待：弹窗 + 二维码图渲染通常 1~3 秒，这里最多等 10 秒
        for (let i = 0; i < 20; i += 1) {
          await sleep(500);
          if (await checkQr()) {
            popped = true;
            break;
          }
        }
        // 关键：一旦出现就跳出，绝不再用下一个选择器点第二次
        if (popped) break;
      }
    }
    if (!popped) console.log('   ⚠ 点击后仍没看到二维码，继续尝试截图');
  }
  await sleep(1500);

  await mkdir(OUT_DIR, { recursive: true });

  /**
   * 关掉挡住二维码的**推广浮层**。
   *
   * 2026-11-15 关键教训：这段逻辑必须**绝不能碰登录弹窗本身**。
   * 原来的实现在每次截图前无差别点击所有 close 系按钮 —— 包括登录弹窗自己的 ✕，
   * 结果二维码刚渲染出来就被自己关掉了。表现就是：调试脚本能量到二维码，
   * login.mjs 却永远「没定位到二维码元素」。
   *
   * 现在只处理「明确是推广/订阅/公告」的浮层，且跳过任何包含二维码的容器。
   */
  const dismissOverlays = async () => {
    await page
      .evaluate(() => {
        // 判定：这个元素（或它的祖先）是不是登录弹窗？是就不许碰
        const isLoginDialog = (node) => {
          for (let n = node; n && n !== document.body; n = n.parentElement) {
            if (n.querySelector && n.querySelector('[class*=qrcode],[class*=qr-code]')) return true;
            const role = n.getAttribute && n.getAttribute('role');
            if (role === 'dialog' && /登录|扫码|login/i.test(n.innerText || '')) return true;
          }
          return false;
        };
        // 判定：是不是推广类浮层（订阅权益 / 使用更畅快 / 开通会员 …）
        const isPromo = (node) => /订阅|权益|会员|畅快|升级|试用|开通/.test((node.innerText || '').slice(0, 200));

        const closers = [
          '[aria-label="关闭"]',
          '[aria-label="Close"]',
          '[data-testid*="close" i]',
          '[class*="close-btn"]',
          '[class*="closeBtn"]',
        ];
        for (const sel of closers) {
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) continue;
            // 跳过登录弹窗里的关闭按钮；只关推广浮层上的
            if (isLoginDialog(el)) continue;
            const host = el.closest('[class*=modal],[class*=popup],[class*=dialog],[class*=overlay]') || el.parentElement;
            if (host && !isPromo(host)) continue;
            el.click();
          }
        }
        // 推广浮层的「跳过 / 以后再说」才算；「取消」容易命中登录弹窗，去掉
        const skipTexts = /^(跳过|以后再说|暂不|我知道了|知道了)$/;
        for (const el of document.querySelectorAll('button,a,div,span')) {
          const t = (el.innerText || '').trim();
          if (!skipTexts.test(t)) continue;
          if (isLoginDialog(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.width < 220 && r.height < 60) el.click();
        }
      })
      .catch(() => {});
    await sleep(600);
  };

  /**
   * 找出真正的二维码元素（返回它的位置矩形，而不是 handle）。
   *
   * 为什么返回矩形而不是 elementHandle：
   *   1) elementHandle 在 dismissOverlays 改动 DOM 后可能失效；
   *   2) 豆包给页面套了 pointer-events:none，elementHandle.screenshot 有时截不到内容；
   *   3) 我们最终只要一张图，直接用 page.screenshot({clip}) 最稳。
   *
   * 打分依据：
   *   + 接近正方形（二维码一定 1:1）
   *   + 边长 100~400（太小是图标，太大是整块面板）
   *   + 内部有 img / canvas
   *   - 有大段文字或多个按钮（那是浮层）
   */
  const findQrRect = async () => {
    return page
      .evaluate(() => {
        const inView = (r) =>
          r.x >= 0 && r.y >= 0 && r.x + r.width <= window.innerWidth && r.y + r.height <= window.innerHeight;

        // ── 第一级：尺寸正常的二维码元素（最理想，只截那张图）
        const qrCands = [];
        let hasQrButZeroSize = false;
        for (const el of document.querySelectorAll('[class*=qrcode], [class*=qr-code], [class*=QrCode]')) {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
          // 尺寸为 0 说明还没布局出来（视口小 / 动画未完成），记住它的存在，走回退
          if (!(r.width > 60 && r.height > 60)) {
            hasQrButZeroSize = true;
            continue;
          }
          if (!inView(r)) continue;
          const ratio = r.width / r.height;
          let score = 0;
          if (ratio > 0.85 && ratio < 1.18) score += 40;
          const side = Math.min(r.width, r.height);
          if (side >= 100 && side <= 400) score += 30;
          if (el.querySelector('canvas')) score += 30;
          else if (el.querySelector('img')) score += 25;
          if ((el.innerText || '').trim().length > 12) score -= 35;
          if (el.querySelectorAll('button,a').length > 1) score -= 20;
          qrCands.push({ score, kind: 'qr', rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
        }
        qrCands.sort((a, b) => b.score - a.score);
        if (qrCands.length && qrCands[0].score >= 25) return qrCands[0];

        // ── 第二级：二维码元素存在但尺寸为 0 → 截整个登录弹窗
        // 2026-11-15 实测：窗口 1280x900 时二维码元素 rect 就是 0x0，
        // 但它所在的弹窗（role=dialog）尺寸正常，截弹窗一样能扫。
        const dialogs = [];
        for (const el of document.querySelectorAll('[role=dialog], [class*=LoginModal], [class*=login-modal], [class*=modal]')) {
          const r = el.getBoundingClientRect();
          if (!(r.width > 200 && r.height > 200)) continue;
          if (!inView(r)) continue;
          dialogs.push({ area: r.width * r.height, rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
        }
        dialogs.sort((a, b) => a.area - b.area); // 最小的那个，避免截到全屏遮罩
        if (dialogs.length) return { score: 100, kind: 'dialog', rect: dialogs[0].rect };

        // ── 第三级：连弹窗都找不到，但有二维码元素 → 截视口中间那块
        if (hasQrButZeroSize) {
          const w = Math.min(520, window.innerWidth * 0.6);
          const h = Math.min(620, window.innerHeight * 0.8);
          return {
            score: 50,
            kind: 'center',
            rect: { x: (window.innerWidth - w) / 2, y: (window.innerHeight - h) / 2, width: w, height: h },
          };
        }
        return null;
      })
      .catch(() => null);
  };

  let shotRound = 0;
  const shot = async () => {
    shotRound += 1;
    await dismissOverlays();
    const p = path.join(OUT_DIR, shotRound === 1 ? 'login_qr.png' : `login_qr_${shotRound}.png`);

    // findQrRect 返回 { score, kind, rect }；kind 表示截的是「二维码本体 / 整个弹窗 / 居中区域」
    const found = await findQrRect();
    if (found && found.rect) {
      const b = found.rect;
      // 留 6px 边距，避免把外框切掉
      const clip = {
        x: Math.max(0, Math.round(b.x) - 6),
        y: Math.max(0, Math.round(b.y) - 6),
        width: Math.round(b.width) + 12,
        height: Math.round(b.height) + 12,
      };
      await page.screenshot({ path: p, clip }).catch(() => {});
      let sz = 0;
      try {
        sz = (await import('node:fs')).statSync(p).size;
      } catch {}
      if (sz > 1000) {
        qrFiles.push(p);
        const label = found.kind === 'qr' ? '二维码' : found.kind === 'dialog' ? '登录弹窗' : '居中区域';
        console.log(`\n[${label} #${shotRound}] ${p}  (${Math.round(b.width)}x${Math.round(b.height)})`);
        if (OPEN) execFile('cmd', ['/c', 'start', '', p], () => {});
        return p;
      }
    }

    // 找不到像样的二维码：退回整页截图，至少让人看到页面现状来排查
    await page.screenshot({ path: p }).catch(() => {});
    qrFiles.push(p);
    console.log(`\n[整页截图 #${shotRound}] ${p}  （没定位到二维码元素）`);
    if (OPEN) execFile('cmd', ['/c', 'start', '', p], () => {});
    return null;
  };

  const first = await shot();
  if (!first) {
    // 已经存了整页截图，说明二维码没定位到：给出可操作建议而不是直接退出
    console.log('   ⚠ 没定位到二维码。可能是登录弹窗没打开，或页面改版。');
    console.log('   已保存整页截图便于排查；也可以改用纯 HTTP 扫码：');
    console.log('     node login.mjs --mode http');
  } else {
    console.log('   请用「豆包 APP」或「抖音 APP」扫码，并在手机上点确认');
    console.log('   二维码由页面自己刷新，过期了我这里会自动重截');
  }

  const deadline = Date.now() + TIMEOUT * 1000;
  let lastShot = Date.now();
  let lastHint = '';
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await isLoggedIn()) {
      console.log(`\n③ 登录成功（${Math.round((Date.now() - t0) / 1000)}s），正在取 cookie…`);
      const cs = await ctx.cookies('https://www.doubao.com');
      const r = await saveCookies(cs);
      const v = await verify();
      console.log('   验证:', JSON.stringify(v));
      await finish(r.hasSession && v.ok ? 0 : 4);
      return;
    }
    if (Date.now() - lastShot > 15000) {
      lastShot = Date.now();
      const hint = await page
        .evaluate(() => {
          const t = (document.body.innerText || '').replace(/\s+/g, ' ');
          if (/二维码已失效|点击刷新|已过期/.test(t)) return 'expired';
          if (/已扫描|请在手机/.test(t)) return 'scanned';
          return '';
        })
        .catch(() => '');
      if (hint === 'expired') {
        await page
          .evaluate(() => {
            const cands = Array.from(document.querySelectorAll('div,span,button'));
            const hit = cands.find((e) => /点击刷新|刷新/.test((e.innerText || '').trim()) && e.getBoundingClientRect().width > 0);
            if (hit) hit.click();
          })
          .catch(() => {});
        await sleep(1500);
      }
      if (hint && hint !== lastHint) {
        console.log(
          `   [${Math.round((Date.now() - t0) / 1000)}s] ${hint === 'expired' ? '二维码已过期 → 已点击刷新' : '已扫码 → 请在手机上点「确认登录」'}`,
        );
        lastHint = hint;
      }
      await shot();
    }
  }
  console.log('\n未在超时时间内完成登录。');
  await finish(3);
}

// ───────────────────────── 方式二：纯 HTTP（备选）
const BASE_Q = {
  next: 'https://www.doubao.com',
  passport_jssdk_version: '4.4.6',
  passport_jssdk_type: 'normal',
  is_from_ttaccountsdk: '1',
  aid: '497858',
  language: 'zh',
  account_app_language: 'zh-CN',
  device_platform: 'web',
  os_type: '1',
  terminal_type: '2',
  multi_login: '1',
  account_sdk_source: 'web',
};
const qs = (extra = {}) =>
  new URLSearchParams({ ...BASE_Q, ts: String(Math.floor(Date.now() / 1000)), ...extra }).toString();

async function getQRCode() {
  const r = await fetch(`${HOST}/passport/web/get_qrcode/?${qs()}`, {
    headers: { 'user-agent': UA, accept: 'application/json', referer: 'https://www.doubao.com/' },
  });
  const j = await r.json();
  const d = j?.data || {};
  if (d.error_code !== 0 || !d.qrcode) throw new Error(`获取二维码失败: ${JSON.stringify(d).slice(0, 300)}`);
  return d;
}

async function check(token) {
  const r = await fetch(`${HOST}/passport/web/check_qrconnect/?${qs({ token })}`, {
    headers: { 'user-agent': UA, accept: 'application/json', referer: 'https://www.doubao.com/' },
  });
  return r.json();
}

function absorbSetCookie(headers, jar) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const raw of list) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return list.length;
}

async function followForCookies(startUrl, jar, maxHops = 8) {
  let url = startUrl;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const r = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'text/html,application/json,*/*', referer: 'https://www.doubao.com/' },
    });
    absorbSetCookie(r.headers, jar);
    const loc = r.headers.get('location');
    console.log(`  [hop${hop + 1}] ${r.status} ${url.slice(0, 110)}${loc ? ' → ' + loc.slice(0, 90) : ''}`);
    if (!loc) return { ok: true, finalUrl: url };
    url = new URL(loc, url).toString();
  }
  return { ok: false, finalUrl: url };
}

const STATUS_HINT = {
  new: '等待扫码',
  scanned: '已扫码 → 请在手机上点「确认登录」',
  scanning: '已扫码 → 请在手机上点「确认登录」',
  confirmed: '已确认',
  expired: '二维码已过期',
};

async function httpLogin() {
  const t0 = Date.now();
  const deadline = Date.now() + TIMEOUT * 1000;
  const jar = new Map();
  let round = 0;
  let confirmedBody = null;

  while (Date.now() < deadline && !confirmedBody) {
    round += 1;
    const qr = await getQRCode();
    const token = qr.token;
    const b64 = String(qr.qrcode).replace(/^data:image\/\w+;base64,/, '');
    await mkdir(OUT_DIR, { recursive: true });
    const qrPath = path.join(OUT_DIR, round === 1 ? 'login_qr.png' : `login_qr_${round}.png`);
    await writeFile(qrPath, Buffer.from(b64, 'base64'));
    const expireSec = qr.expire_time ? Math.max(0, qr.expire_time - Math.floor(Date.now() / 1000)) : 60;
    console.log(`\n[第 ${round} 张二维码] ${qrPath}`);
    console.log(`  有效期 ${expireSec} 秒 · token=${token}`);
    if (OPEN) execFile('cmd', ['/c', 'start', '', qrPath], () => {});

    let loopDeadline = Date.now() + (Math.max(20, expireSec) + 20) * 1000;
    let lastStatus = '';
    let lastErrMsg = '';
    let scanned = false;
    let interval = 3000;
    let errCount = 0;

    while (Date.now() < loopDeadline && Date.now() < deadline && !confirmedBody) {
      await sleep(interval);
      let j;
      try {
        j = await check(token);
      } catch {
        interval = Math.min(Math.round(interval * 1.5), 10000);
        continue;
      }
      const d = j?.data || {};

      if (d.error_code && d.error_code !== 0) {
        errCount += 1;
        const msg = d.description || `error_code=${d.error_code}`;
        if (msg !== lastErrMsg) {
          console.log(`   [${Math.round((Date.now() - t0) / 1000)}s] ⚠ 服务端返回：${msg}（自动重试中）`);
          lastErrMsg = msg;
        }
        interval = Math.min(Math.round(interval * 1.5), 10000);
        if (errCount === 8) {
          console.log('   ↳ 连续多次被拒。passport 接口有风控，建议改用默认的浏览器方式：node login.mjs');
        }
        continue;
      }
      lastErrMsg = '';
      errCount = 0;

      const st = String(d.status || '');
      if (st !== lastStatus) {
        console.log(`   [${Math.round((Date.now() - t0) / 1000)}s] ${st} ${STATUS_HINT[st] || ''}`);
        lastStatus = st;
      }
      if (st === 'confirmed') {
        confirmedBody = j;
        break;
      }
      if (st === 'expired') break;
      if (st === 'scanned' || st === 'scanning') {
        scanned = true;
        interval = 2000;
        loopDeadline = Math.max(loopDeadline, Date.now() + 60000);
      } else if (!scanned) {
        interval = 3000;
      }
    }

    if (!confirmedBody && Date.now() < deadline) {
      console.log(
        scanned
          ? '   （已扫码但未完成确认，本张码已过期 → 换新码，请重新扫并在手机上点确认）'
          : '   （本张码到期/即将到期，自动换新码）',
      );
    }
  }

  if (!confirmedBody) {
    console.log('\n未在超时时间内完成扫码确认。');
    process.exitCode = 3;
    return;
  }

  console.log('\n③ 登录已确认，收集 cookie…');
  const d = confirmedBody?.data || {};
  const redirect = d.redirect_url || d.redirect || d.url;
  if (redirect) await followForCookies(redirect, jar);
  await followForCookies(CHAT_URL, jar);
  if (existsSync(COOKIE_FILE)) {
    const old = (await readFile(COOKIE_FILE, 'utf8')).trim();
    for (const kv of old.split('; ')) {
      const i = kv.indexOf('=');
      if (i > 0 && !jar.has(kv.slice(0, i))) jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  }
  const cookieStr = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  await writeFile(COOKIE_FILE, cookieStr, 'utf8');
  console.log(`   已写入 ${COOKIE_FILE}（${jar.size} 条，${cookieStr.length} 字节）`);
  const v = await verify();
  console.log('   验证:', JSON.stringify(v).slice(0, 300));
  process.exitCode = v.ok ? 0 : 4;
}

// ───────────────────────── 入口
if (MODE === 'http') {
  await httpLogin();
  process.exit(process.exitCode ?? 0); // 显式退出，避免 keep-alive socket 拖住进程
} else if (MODE === 'browser') {
  await browserLogin(); // 内部已 process.exit
} else {
  console.error(`未知 --mode: ${MODE}（可选 browser / http）`);
  process.exit(2);
}
