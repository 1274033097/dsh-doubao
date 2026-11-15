/**
 * 豆包 · 退出登录 + 清理登录信息
 *
 * 为什么是「本地清理」而不是调服务端退登接口：
 *   2026-11-14 实测 —— passport 的退登接口全部被风控挡掉：
 *     POST /passport/web/logout/             → {"error_code":2035,"description":"非法请求"}
 *     GET  /passport/web/logout/             → 同上
 *     带 passport_csrf_token + x-tt-passport-csrf-token → 302，但只是重新下发 cookie，**并没有真的退登**
 *     /passport/web/logout_v2/、/sso_logout/、/account/logout/ → 16「该应用无权限」
 *     /alice/user/logout                     → 404
 *   且退登后 cookie 文件仍能正常调用 /samantha/skill/pack（验证：无 cookie → 710012001，当前 cookie → code 0 + 4 模型）。
 *   所以：真正的「退登」= 把本地所有登录凭据彻底删掉。服务端会话会自然过期。
 *
 * 清理范围（默认全清）：
 *   1. doubao_cookies.txt        —— cookie 明文（最关键，含 sessionid）
 *   2. doubao_edge_profile/      —— Edge 配置目录（含 Cookies 数据库、Local Storage、登录缓存）
 *   3. 二维码 / 抓包等临时产物   —— doubao_out 里的 login_qr_*.png、capture*.json 等
 *   4. doubao_identity.json      —— 设备身份（可选，默认保留：它不含账号信息，删了要重新抓包生成）
 *
 * 用法:
 *   node logout.mjs                      # 交互确认后全清（cookie + profile）
 *   node logout.mjs --yes                # 不询问（脚本化用）
 *   node logout.mjs --keep-profile       # 只删 cookie，保留 Edge 配置目录
 *   node logout.mjs --keep-cookie        # 只删 profile
 *   node logout.mjs --keep-identity      # 保留 doubao_identity.json（默认就是保留）
 *   node logout.mjs --dry-run            # 只报告将删除什么，不真删
 *   node logout.mjs --status             # 只看当前登录态，不删任何东西
 */
import { existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const WS = process.cwd();
const COOKIE_FILE = process.env.DOUBAO_COOKIE_FILE || path.join(WS, 'doubao_cookies.txt');
const PROFILE = process.env.DOUBAO_EDGE_PROFILE || path.join(WS, 'doubao_edge_profile');
const IDENT_FILE = path.join(WS, 'doubao_identity.json');
const OUT_DIR = process.env.DOUBAO_OUT || path.join(WS, 'doubao_out');
const PORT = Number(process.env.DOUBAO_EDGE_PORT || 9226);

const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes(`--${n}`);

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };
const log = (s = '') => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 目录大小（只算文件，跳过符号链接）
function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      try {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) {
          bytes += statSync(p).size;
          files += 1;
        }
      } catch {
        /* 被占用/权限问题，忽略 */
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

const mb = (b) => `${Math.round((b / 1048576) * 10) / 10} MB`;

// ── Edge 是否在跑（在跑就删不掉 profile，必须先优雅关掉）
async function cdpAlive() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return r.ok;
  } catch {
    return false;
  }
}

// 用 CDP 的 Browser.close 优雅关闭：强杀会让 Chromium 来不及刷盘，也没必要
async function closeEdge() {
  if (!(await cdpAlive())) return false;
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
      await sleep(900);
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!(await cdpAlive())) return true;
    await sleep(400);
  }
  return false;
}

// ── 当前登录态速览
async function cookieState() {
  if (!existsSync(COOKIE_FILE)) return { has: false };
  let txt = '';
  try {
    txt = (await readFile(COOKIE_FILE, 'utf8')).trim();
  } catch {
    return { has: false, error: '读取失败' };
  }
  const hasSession = /(?:^|;\s*)sessionid=[^;]+/.test(txt);
  const sid = /(?:^|;\s*)sessionid=([^;]+)/.exec(txt)?.[1] || '';
  const ageH = Math.round(((Date.now() - statSync(COOKIE_FILE).mtimeMs) / 3600000) * 10) / 10;
  return { has: true, hasSession, sid, ageH, bytes: txt.length };
}

async function printStatus() {
  log(`${C.cyan}${C.bold}▶ 当前登录态${C.reset}`);
  const cs = await cookieState();
  if (!cs.has) {
    log(`  cookie 文件   ${C.dim}不存在${C.reset}`);
  } else if (!cs.hasSession) {
    log(`  cookie 文件   ${C.yellow}存在，但没有 sessionid${C.reset}  (${cs.bytes} 字节, ${cs.ageH} 小时前)`);
  } else {
    log(`  cookie 文件   ${C.green}有 sessionid${C.reset}  ${C.dim}${String(cs.sid).slice(0, 12)}… · ${cs.bytes} 字节 · ${cs.ageH} 小时前${C.reset}`);
  }
  if (existsSync(PROFILE)) {
    const s = dirSize(PROFILE);
    log(`  Edge 配置目录 ${C.yellow}存在${C.reset}  ${C.dim}${s.files} 个文件 / ${mb(s.bytes)}${C.reset}`);
  } else {
    log(`  Edge 配置目录 ${C.dim}不存在${C.reset}`);
  }
  log(`  设备身份文件  ${existsSync(IDENT_FILE) ? `${C.dim}存在（不含账号信息）${C.reset}` : `${C.dim}不存在${C.reset}`}`);
  log(`  Edge 进程     ${(await cdpAlive()) ? `${C.yellow}CDP 端口 ${PORT} 在响（运行中）${C.reset}` : `${C.dim}未运行${C.reset}`}`);
  const leftovers = findLeftovers();
  if (leftovers.length) {
    log(`  登录残留      ${C.dim}${leftovers.length} 个文件${C.reset}`);
    for (const f of leftovers) log(`     ${C.dim}${path.relative(WS, f)}${C.reset}`);
  }
}

// ── 二维码 / 抓包等残留
function findLeftovers() {
  const out = [];
  if (!existsSync(OUT_DIR)) return out;
  let ents = [];
  try {
    ents = readdirSync(OUT_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (!e.isFile()) continue;
    // login_qr_*.png（扫码二维码）、cap*.json / capture*.json（抓包里含 cookie）、*.cookies.txt
    if (/^(login_qr_.*\.png|cap.*\.json|capture.*\.json|.*\.cookies\.txt)$/i.test(e.name)) {
      out.push(path.join(OUT_DIR, e.name));
    }
  }
  return out;
}

// ── 交互确认
async function confirm(question) {
  if (hasFlag('yes')) return true;
  if (!process.stdin.isTTY) {
    log(`\n${C.yellow}⚠ 非交互环境，未加 --yes 就退出（不做任何修改）${C.reset}`);
    return false;
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes' || a === '是';
}

// ── 主流程
const DRY = hasFlag('dry-run');
const STATUS_ONLY = hasFlag('status');
const KEEP_PROFILE = hasFlag('keep-profile');
const KEEP_COOKIE = hasFlag('keep-cookie');
const KEEP_IDENTITY = hasFlag('keep-identity') || !hasFlag('with-identity');

log(`\n${C.cyan}${C.bold}════════════════════════════════════════${C.reset}`);
log(`${C.cyan}${C.bold}  豆包 · 退出登录 / 清理登录信息${C.reset}`);
log(`${C.cyan}${C.bold}════════════════════════════════════════${C.reset}`);
log(`${C.dim}说明：服务端退登接口被风控挡死（实测 2035 非法请求），所以采用本地彻底清理。${C.reset}`);
log(`${C.dim}      服务端会话会自然过期；本地凭据删除后，工具即处于未登录状态。${C.reset}\n`);

await printStatus();

if (STATUS_ONLY) {
  log('');
  process.exit(0);
}

// 待删清单
const targets = [];
if (!KEEP_COOKIE && existsSync(COOKIE_FILE)) targets.push({ kind: 'cookie', p: COOKIE_FILE, label: 'cookie 文件（含 sessionid）' });
if (!KEEP_PROFILE && existsSync(PROFILE)) {
  const s = dirSize(PROFILE);
  targets.push({ kind: 'profile', p: PROFILE, label: `Edge 配置目录（${s.files} 个文件 / ${mb(s.bytes)}）` });
}
for (const f of findLeftovers()) targets.push({ kind: 'residue', p: f, label: `临时残留：${path.basename(f)}` });
if (!KEEP_IDENTITY && existsSync(IDENT_FILE)) {
  targets.push({ kind: 'identity', p: IDENT_FILE, label: '设备身份文件（不含账号信息）' });
}

if (!targets.length) {
  log(`\n${C.green}✓ 没有需要清理的登录信息，已经是干净状态${C.reset}`);
  process.exit(0);
}

log(`\n${C.bold}将要删除：${C.reset}`);
for (const t of targets) {
  const rel = t.p.startsWith(WS) ? path.relative(WS, t.p) : t.p;
  log(`  ${C.red}✗${C.reset} ${t.label}`);
  log(`     ${C.dim}${rel}${C.reset}`);
}

if (DRY) {
  log(`\n${C.yellow}[dry-run] 以上只是预览，没有删除任何内容${C.reset}`);
  process.exit(0);
}

if (!(await confirm(`\n确认删除上述 ${targets.length} 项？不可恢复。(y/N): `))) {
  log(`\n${C.dim}已取消，未做任何修改${C.reset}`);
  process.exit(0);
}

log('');
let failed = 0;
for (const t of targets) {
  const rel = t.p.startsWith(WS) ? path.relative(WS, t.p) : t.p;
  // profile 必须先关 Edge，否则文件被占用（尤其 Cookies / Local Storage 的 SQLite 文件）
  if (t.kind === 'profile' && (await cdpAlive())) {
    log(`  ${C.dim}Edge 正在运行，先优雅关闭…${C.reset}`);
    const closed = await closeEdge();
    if (!closed) {
      log(`  ${C.yellow}⚠ 无法自动关闭 Edge${C.reset}`);
      log(`     ${C.dim}请手动关掉那个窗口，再重跑本命令（profile 文件被占用时删不掉）${C.reset}`);
      failed += 1;
      continue;
    }
    log(`  ${C.green}✓${C.reset} Edge 已关闭`);
  }
  try {
    if (t.kind === 'cookie') {
      // cookie 文件改成空文件而不是删除：避免某些脚本误判「没有 cookie 文件 = 崩溃」
      await writeFile(t.p, '', 'utf8');
      log(`  ${C.green}✓${C.reset} 已清空 ${rel} ${C.dim}(0 字节)${C.reset}`);
    } else {
      rmSync(t.p, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      log(`  ${C.green}✓${C.reset} 已删除 ${rel}`);
    }
  } catch (e) {
    failed += 1;
    log(`  ${C.red}✗${C.reset} 删除失败 ${rel}`);
    log(`     ${C.dim}${String(e && e.message).slice(0, 160)}${C.reset}`);
    if (t.kind === 'profile') {
      log(`     ${C.dim}常见原因：Edge 还在跑 / 杀毒软件占用。关掉所有 Edge 窗口后重试。${C.reset}`);
    }
  }
}

// 确保 out 目录还在（后面生成要用）
await mkdir(OUT_DIR, { recursive: true }).catch(() => {});

log('');
if (failed === 0) {
  log(`${C.green}${C.bold}✓ 登录信息已彻底清理${C.reset}`);
  log(`${C.dim}  下一步：双击「登录.cmd」扫码重新登录${C.reset}`);
  process.exit(0);
} else {
  log(`${C.yellow}${C.bold}⚠ 有 ${failed} 项没能删除${C.reset}`);
  log(`${C.dim}  多半是 Edge 还在运行占着 profile。关掉 Edge（或先跑 --keep-profile 只清 cookie）后重试。${C.reset}`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);