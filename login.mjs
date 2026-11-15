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
// 解析 playwright-core。要找到的是「真正的文件」，不能是目录。
//
// 历史坑（2026-11-15）：过去会把插件目录自己也放进 createRequire 的搜索起点，
// 而插件目录名是 @local/dsh-doubao —— 在 profile 的 node_modules 里它是一个**目录**。
// Node 的 ESM 解析器不允许 import 目录，于是报：
//   ERR_UNSUPPORTED_DIR_IMPORT: Directory import '...\node_modules\@local\dsh-doubao'
// 所以这里必须：
//   1) 只要有 leads to a directory 就丢弃；
//   2) 只接受以 .js/.cjs/.mjs 结尾的真实文件；
//   3) 把插件自己的 package.json 从搜索起点里剔除（否则解析器会跑到自身包里找）。
function resolvePw() {
  const starts = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@playwright', 'cli', 'package.json'),
    path.join(WS, 'node_modules', 'playwright-core', 'package.json'),
  ].filter((p) => existsSync(p));

  for (const start of starts) {
    try {
      const resolved = createRequire(start).resolve('playwright-core');
      // 只认真实文件；目录（或解析到插件自身）一律跳过
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
  const edge = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => existsSync(p));
  if (!edge) throw new Error('未找到 msedge.exe');
  await mkdir(PROFILE, { recursive: true });
  const child = spawn(
    edge,
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
    if (await cdpUp()) return 'spawned(off-screen)';
    await sleep(400);
  }
  throw new Error('Edge DevTools 未就绪');
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
  const chromium = mod.chromium || mod.default?.chromium;
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
  await sleep(4000);

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
  await page
    .evaluate(() => {
      const el = document.querySelector('[data-testid="to_login_button"]');
      if (el) return el.click();
      const cands = Array.from(document.querySelectorAll('button,div,span,a'));
      const hit = cands.find((e) => /^(登录|立即登录)$/.test((e.innerText || '').trim()) && e.getBoundingClientRect().width > 0);
      if (hit) hit.click();
      return null;
    })
    .catch(() => {});
  await sleep(5000);

  await mkdir(OUT_DIR, { recursive: true });
  let shotRound = 0;
  const shot = async () => {
    shotRound += 1;
    const el = await page.$('[class*=qrcode]');
    if (!el) return null;
    const p = path.join(OUT_DIR, shotRound === 1 ? 'login_qr.png' : `login_qr_${shotRound}.png`);
    await el.screenshot({ path: p }).catch(() => {});
    qrFiles.push(p);
    console.log(`\n[二维码 #${shotRound}] ${p}`);
    if (OPEN) execFile('cmd', ['/c', 'start', '', p], () => {});
    return p;
  };

  const first = await shot();
  if (!first) {
    console.log('   ⚠ 没找到二维码元素（[class*=qrcode]），可能页面结构变了');
    const p = path.join(OUT_DIR, 'login_page.png');
    await page.screenshot({ path: p }).catch(() => {});
    console.log('   整页截图: ' + p);
    await finish(5);
    return;
  }
  console.log('   请用「豆包 APP」或「抖音 APP」扫码，并在手机上点确认');
  console.log('   二维码由页面自己刷新，过期了我这里会自动重截');

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
