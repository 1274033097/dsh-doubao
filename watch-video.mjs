/**
 * 视频生成「看门狗」：周期性刷新页面轮询结果，出现视频自动下载
 * 不触发新生成，只查询当前对话。
 *
 * 用法：node watch-video.mjs [--minutes 25] [--interval 45]
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WS = process.cwd();
const OUT = path.join(WS, 'doubao_out');
const PORT = Number(process.env.DOUBAO_EDGE_PORT || 9226);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const minutes = Number(getArg('minutes', 25));
const interval = Number(getArg('interval', 45));

function resolvePw() {
  for (const a of [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@playwright', 'cli', 'package.json'),
    path.join(WS, 'package.json'),
  ].filter((p) => existsSync(p))) {
    try {
      return createRequire(a).resolve('playwright-core');
    } catch {}
  }
  return '';
}

const t0 = Date.now();
const log = (...a) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...a);

try {
  await mkdir(OUT, { recursive: true });
  const mod = await import(pathToFileURL(resolvePw()).href);
  const chromium = mod.chromium || mod.default?.chromium;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = browser.contexts()[0].pages().find((p) => p.url().includes('doubao.com'));
  if (!page) throw new Error('找不到豆包页面');
  await page.setViewportSize({ width: 1440, height: 960 }).catch(() => {});
  log('watch url:', page.url());

  const deadline = Date.now() + minutes * 60000;
  let round = 0;
  while (Date.now() < deadline) {
    round += 1;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(4500);

    // 如果停在首页（URL 里没有 /chat/<id>），打开「最近」里最新的一条对话
    const inConversation = await page.evaluate(() => /\/chat\/\d+/.test(location.href));
    if (!inConversation) {
      const opened = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('[data-testid="conversation-list-v2-item"]'));
        const first = items[0];
        if (!first) return null;
        first.click();
        return (first.innerText || '').trim().slice(0, 30);
      });
      log('open latest conversation:', opened);
      await sleep(4000);
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(2000);

    const snap = await page.evaluate(() => {
      const v = document.querySelector('video');
      const text = document.body.innerText || '';
      return {
        hasVideo: Boolean(v),
        src: v ? v.currentSrc || v.src || '' : '',
        dur: v ? v.duration : null,
        w: v ? v.videoWidth : 0,
        h: v ? v.videoHeight : 0,
        done: /视频生成好了|已生成视频|视频已生成/.test(text),
        busy: /正在生成|预计等待|渲染中|排队/.test(text),
        tail: text.replace(/\s+/g, ' ').slice(-120),
      };
    });

    log(`round ${round}`, JSON.stringify({ hasVideo: snap.hasVideo, done: snap.done, busy: snap.busy, dur: snap.dur }), snap.tail.slice(-60));

    if (!snap.hasVideo && snap.done) {
      // 有「生成好了」但没 <video>：点视频卡片海报触发懒加载
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
        log('click poster');
        await page.mouse.click(poster.x, poster.y);
        await sleep(3500);
      }
    }

    const v = await page.evaluate(() => {
      const el = document.querySelector('video');
      return el ? { src: el.currentSrc || el.src || '', w: el.videoWidth, h: el.videoHeight, dur: el.duration } : null;
    });

    if (v && v.src) {
      log('FOUND video', JSON.stringify(v));
      const resp = await fetch(v.src, {
        headers: {
          Referer: 'https://www.doubao.com/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0',
        },
      });
      if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const file = path.join(OUT, `doubao_video_${Date.now()}.mp4`);
      await writeFile(file, buf);
      const box = buf.subarray(4, 8).toString('latin1');
      const result = {
        file,
        bytes: buf.length,
        mb: Math.round((buf.length / 1048576) * 100) / 100,
        box,
        ok: box === 'ftyp',
        width: v.w,
        height: v.h,
        duration: v.dur,
        elapsedSec: Math.round((Date.now() - t0) / 1000),
      };
      await page.screenshot({ path: path.join(OUT, 'watch-done.png') }).catch(() => {});
      console.log('WATCH_RESULT ' + JSON.stringify(result, null, 2));
      process.exit(0);
    }

    await sleep(interval * 1000);
  }

  console.log('WATCH_RESULT ' + JSON.stringify({ ok: false, reason: 'timeout', rounds: round }));
  process.exit(4);
} catch (err) {
  console.log('WATCH_RESULT ' + JSON.stringify({ ok: false, reason: String(err && err.message ? err.message : err) }));
  process.exit(1);
}
