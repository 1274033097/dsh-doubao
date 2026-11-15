/**
 * 豆包网页版接口抓包器（只读观察，不改页面状态）
 * 用法: node capture_api.mjs --seconds 12 [--out capture.json] [--send "提示词"]
 *
 * 目的：判断能否脱离浏览器纯 HTTP 重放豆包接口
 *   - 看认证靠什么（cookie / 头 / 签名参数）
 *   - 看生成请求的 URL、body 结构、返回格式
 */
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WS = process.cwd();
const PORT = Number(process.env.DOUBAO_EDGE_PORT || 9226);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SECONDS = Number(getArg('seconds', 12));
const OUT = getArg('out', 'capture.json');
const SEND = getArg('send', '');

function resolvePw() {
  const req = createRequire(import.meta.url);
  for (const a of [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@playwright', 'cli', 'package.json'),
    path.join(WS, 'package.json'),
  ].filter((p) => existsSync(p))) {
    try {
      return createRequire(a).resolve('playwright-core');
    } catch {
      /* next */
    }
  }
  return '';
}

const INTEREST = [/\/samantha\//i, /\/api\//i, /\/alice\//i, /completion/i, /conversation/i, /\/chat\//i];
const SKIP_EXT = /\.(js|css|png|jpe?g|webp|gif|svg|woff2?|ttf|mp4|ico|map)(\?|$)/i;

const mod = await import(pathToFileURL(resolvePw()).href);
const chromium = mod.chromium || mod.default?.chromium;
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('doubao.com'));
if (!page) throw new Error('找不到豆包页面');

const records = [];
const bodyOf = new Map(); // request -> Promise<string>

const wantUrl = (u) => !SKIP_EXT.test(u) && INTEREST.some((re) => re.test(u));

ctx.on('request', (req) => {
  const u = req.url();
  if (!wantUrl(u)) return;
  const h = req.headers();
  const interesting = {};
  for (const k of Object.keys(h)) {
    if (/^(cookie|content-type|referer|origin|user-agent|accept|x-|agw-|s-|r-)/i.test(k)) interesting[k] = h[k];
  }
  const rec = {
    t: Date.now(),
    method: req.method(),
    url: u,
    resourceType: req.resourceType(),
    headers: interesting,
    postDataLen: req.postData() ? req.postData().length : 0,
    postData: req.postData() ? req.postData().slice(0, 4000) : null,
  };
  records.push(rec);
  bodyOf.set(req, null);
});

ctx.on('response', async (resp) => {
  const req = resp.request();
  if (!bodyOf.has(req)) return;
  const ct = resp.headers()['content-type'] || '';
  const rec = records.find((r) => r.url === req.url() && r.status === undefined);
  if (rec) {
    rec.status = resp.status();
    rec.ct = ct;
  }
  try {
    if (/json/i.test(ct)) {
      const txt = await resp.text();
      if (rec) rec.respBody = txt.slice(0, 6000);
    } else if (/event-stream/i.test(ct)) {
      // SSE：流会正常结束，抢一个 90s 超时把正文拿到
      const txt = await Promise.race([resp.text(), sleep(90000).then(() => null)]);
      if (rec) {
        rec.respBodyLen = txt ? txt.length : null;
        rec.respBody = txt ? txt.slice(0, 8000) : '[SSE 读取超时]';
        rec.sseEventCount = txt ? (txt.match(/^event:/gm) || []).length : null;
      }
    }
  } catch {
    /* 流式响应可能读不了 */
  }
});

console.log('capture start, url =', page.url());
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await sleep(3000);

if (SEND) {
  console.log('send prompt:', SEND);
  const ed = page.locator('[data-testid="chat_input_input"] .ProseMirror, .ProseMirror[contenteditable="true"]').first();
  await ed.waitFor({ state: 'visible', timeout: 15000 });
  await ed.click();
  await page.keyboard.insertText(SEND);
  await sleep(700);
  const sb = page.locator('[data-testid="chat_input_send_button"]').first();
  if (await sb.count()) await sb.click();
  else await page.keyboard.press('Enter');
}

await sleep(SECONDS * 1000);

// cookie 清单（值单独存，不打印）
const cookies = await ctx.cookies('https://www.doubao.com');
const cookieFile = OUT.replace(/\.json$/, '') + '.cookies.txt';
await writeFile(cookieFile, cookies.map((c) => `${c.name}=${c.value}`).join('; '), 'utf8');

const report = {
  capturedAt: new Date().toISOString(),
  pageUrl: page.url(),
  userAgent: await page.evaluate(() => navigator.userAgent),
  cookieNames: cookies.map((c) => ({ name: c.name, len: c.value.length, httpOnly: c.httpOnly })),
  requestCount: records.length,
  records,
};
await writeFile(OUT, JSON.stringify(report, null, 2), 'utf8');

console.log('\n=== 接口清单 ===');
for (const r of records) {
  const q = r.url.includes('?') ? '?' + r.url.split('?')[1].split('&').map((kv) => kv.split('=')[0]).join('&') : '';
  console.log(`${r.method.padEnd(4)} ${String(r.status ?? '-').padEnd(4)} ${r.url.split('?')[0].replace('https://www.doubao.com', '')}${q}`);
}
console.log('\ncookie 数:', cookies.length, '→', cookieFile);
console.log('明细 →', OUT);
process.exit(0);
