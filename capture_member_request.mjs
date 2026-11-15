/**
 * 让浏览器用「会员模型」真实生成一次，抓 /chat/completion 的请求体
 * 目的：拿到会员模型在 ability_param 里的真实 key
 * 用法: node _capture_member_request.mjs --model "Seedream 5.5" --prompt "test"
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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
const MODEL = getArg('model', 'Seedream 5.5');
const PROMPT = getArg('prompt', 'a red apple on a wooden table');

function resolvePw() {
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

const mod = await import(pathToFileURL(resolvePw()).href);
const chromium = mod.chromium || mod.default?.chromium;
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('doubao.com')) || (await ctx.newPage());

const bodies = [];
ctx.on('request', (req) => {
  if (!/\/chat\/completion/.test(req.url())) return;
  const pd = req.postData();
  if (pd) bodies.push(pd);
});

await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await sleep(4000);
await page.evaluate(() => document.querySelector('[data-testid="create_conversation_button"]')?.click()).catch(() => {});
await sleep(2500);

// 点图像生成技能
await page.evaluate(() => document.querySelector('[data-testid="skill_bar_button_3"]')?.click()).catch(() => {});
await sleep(4000);

// 打开模型下拉
const trig = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('div,span,button'));
  const hit = els.find((e) => /^模型\s+\S/.test((e.innerText || '').trim()) && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height < 60 && e.getBoundingClientRect().width < 400);
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
if (!trig) throw new Error('找不到模型入口');
await page.mouse.click(trig.x, trig.y);
await sleep(3000);

// 点目标模型
const picked = await page.evaluate((wanted) => {
  const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
  const hit = items.find((m) => (m.innerText || '').trim().startsWith(wanted));
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (hit.innerText || '').trim().replace(/\s+/g, ' ') };
}, MODEL);
console.log('选中模型:', JSON.stringify(picked));
if (!picked) throw new Error(`下拉里没有「${MODEL}」`);
await page.mouse.click(picked.x, picked.y);
await sleep(2500);

// 输入并发送
const ed = page.locator('[data-testid="chat_input_input"] .ProseMirror, .ProseMirror[contenteditable="true"]').first();
await ed.click();
await page.keyboard.insertText(PROMPT);
await sleep(800);
const sb = page.locator('[data-testid="chat_input_send_button"]').first();
if (await sb.count()) await sb.click();
else await page.keyboard.press('Enter');
console.log('已发送，等待抓包…');
await sleep(8000);

// 解析最新一条 completion 请求
if (!bodies.length) {
  console.log('没抓到 /chat/completion 请求');
  process.exit(1);
}
const last = bodies[bodies.length - 1];
await writeFile('_member_req.json', last, 'utf8');
try {
  const j = JSON.parse(last);
  const ca = j.chat_ability || {};
  console.log('\n=== chat_ability ===');
  console.log('ability_type:', ca.ability_type);
  console.log('ability_param:', ca.ability_param);
  console.log('\n文本:', j.messages?.[0]?.content_block?.[0]?.content?.text_block?.text);
} catch (e) {
  console.log('解析失败:', e.message);
}
process.exit(0);
