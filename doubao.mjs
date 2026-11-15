/**
 * 豆包生图/生视频 · 统一调度器
 *
 * 两种运行方式：
 *   方式 A【默认优先】完全脱离浏览器 —— doubao_http.mjs，纯 HTTP，Edge 可以不运行
 *   方式 B【保底】需要浏览器进程 —— doubao_gen.mjs，CDP 驱动 Edge 窗口
 *
 * auto 模式的升级阶梯（逐级降级，每一步都会打印原因）：
 *   1. 直连（有 cookie 文件时）
 *   2. cookie 缺失/失效 → 用 get_cookies.mjs 从 Edge 配置目录重新解密 → 再试一次直连
 *   3. 仍失败 → 切方式 B（浏览器自动化）
 *
 * 用法:
 *   node doubao.mjs image  --prompt "..." [--model "Seedream 4.5"] [--ratio 16:9] [--mode auto|direct|browser]
 *   node doubao.mjs video  --prompt "..." [--model "Seedance 2.0 Fast"] [--duration 4] [--resolution 720p] [--mode ...]
 *   node doubao.mjs models --for image|video [--mode ...]
 *   node doubao.mjs login
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const WS = process.cwd();
const COOKIE_FILE = process.env.DOUBAO_COOKIE_FILE || path.join(WS, 'doubao_cookies.txt');
const IDENT_FILE = path.join(WS, 'doubao_identity.json');

const argv = process.argv.slice(2);
const kind = (argv[0] || '').toLowerCase();
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const hasFlag = (n) => argv.includes(`--${n}`);
const mode = String(getArg('mode', 'auto')).toLowerCase();

// 视频模型：显示名 ↔ 直连内部 key（两种写法都接受，自动归一）
// 会员档（Seedance 2.5 / 2.5 Flash）的 key 来自网页配置 get_item_conf 的 option_key
const VIDEO_MODELS = {
  'seedance_v2.5': { key: 'seedance_v2.5', display: 'Seedance 2.5' },
  'seedance_v2.5_flash': { key: 'seedance_v2.5_flash', display: 'Seedance 2.5 Flash' },
  'seedance_v2.0_std': { key: 'seedance_v2.0_std', display: 'Seedance 2.0' },
  'seedance_v2.0': { key: 'seedance_v2.0', display: 'Seedance 2.0 Fast' },
  'seedance_v2.0_mini': { key: 'seedance_v2.0_mini', display: 'Seedance 2.0 Mini' },
  'seedance 2.5': { key: 'seedance_v2.5', display: 'Seedance 2.5' },
  'seedance 2.5 flash': { key: 'seedance_v2.5_flash', display: 'Seedance 2.5 Flash' },
  'seedance 2.0': { key: 'seedance_v2.0_std', display: 'Seedance 2.0' },
  'seedance 2.0 fast': { key: 'seedance_v2.0', display: 'Seedance 2.0 Fast' },
  'seedance 2.0 mini': { key: 'seedance_v2.0_mini', display: 'Seedance 2.0 Mini' },
};

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};
const log = (s) => console.log(s);
const banner = (title, detail) => log(`\n${C.cyan}${C.bold}▶ ${title}${C.reset}${detail ? C.dim + '  ' + detail + C.reset : ''}`);

function run(script, args) {
  const r = spawnSync(process.execPath, [path.join(WS, script), ...args], { stdio: 'inherit', cwd: WS });
  return { code: r.status === null ? 1 : r.status, signal: r.signal };
}

// cookie 文件是否「看起来可用」：存在且不太旧
function cookieState() {
  if (!existsSync(COOKIE_FILE)) return { ok: false, reason: '缺少 cookie 文件' };
  const txt = (() => {
    try {
      return readFileSync(COOKIE_FILE, 'utf8');
    } catch {
      return '';
    }
  })();
  if (!/sessionid=/.test(txt)) return { ok: false, reason: 'cookie 里没有 sessionid' };
  const ageH = (Date.now() - statSync(COOKIE_FILE).mtimeMs) / 3600000;
  return { ok: true, ageH: Math.round(ageH * 10) / 10, bytes: txt.length };
}

function refreshCookies() {
  banner('刷新 cookie', '从 Edge 配置目录解密（Edge 需关闭）');
  if (!existsSync(path.join(WS, 'doubao_edge_profile'))) {
    log(`${C.yellow}  跳过：没有 doubao_edge_profile 目录${C.reset}`);
    return false;
  }
  const r = run('get_cookies.mjs', []);
  if (r.code !== 0) {
    log(`${C.yellow}  解密失败（Edge 可能还在运行）。可先关闭 Edge，或用「登录.cmd」扫码登录。${C.reset}`);
    return false;
  }
  return true;
}

// 参考图上限：一次最多 10 张（2026-11-14 实测，传多了服务端只收前 10 张）
const MAX_REF_IMAGES = 10;

// 清理用户粘进来的路径：
//   - 去掉首尾成对的引号（Explorer「复制文件地址」会带 "..."，cmd 里再包一层就更乱）
//   - 去掉首尾空白
//   - 处理 Windows 的 \\?\ 长路径前缀
// 历史坑：用户粘贴 "C:\...\x.png" 带引号 → existsSync 认不出来 → 报「参考图不存在」但文件其实在
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

// 收集参考图路径：--ref a.png --ref b.png  或  --ref a.png,b.png
function collectRefs() {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--ref') continue;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) continue;
    // 逗号分隔时，逐个再清一次引号（可能是 "a.png","b.png" 这种）
    for (const piece of String(v).split(',')) {
      const p = cleanPath(piece);
      if (p) out.push(p);
    }
  }
  if (out.length > MAX_REF_IMAGES) {
    log(`${C.yellow}⚠ 参考图最多 ${MAX_REF_IMAGES} 张，已忽略多余的 ${out.length - MAX_REF_IMAGES} 张${C.reset}`);
    out.length = MAX_REF_IMAGES;
  }
  const missing = out.filter((p) => !existsSync(p));
  for (const p of missing) log(`${C.yellow}⚠ 参考图不存在，将被跳过：${p}${C.reset}`);
  return out.filter((p) => existsSync(p));
}

// 把统一参数翻译成各模式自己的参数
function buildArgs(modeName) {
  const out = [kind];
  const prompt = getArg('prompt', '');
  if (prompt) out.push('--prompt', prompt);
  if (kind === 'models') {
    out.push('--for', String(getArg('for', 'image')).toLowerCase());
    return out;
  }
  const ratio = getArg('ratio', '16:9');
  out.push('--ratio', ratio);

  if (kind === 'image') {
    const model = getArg('model', 'Seedream 4.5');
    out.push('--model', model);
    const count = String(getArg('count', '1'));
    out.push('--count', count);
    for (const f of collectRefs()) out.push('--ref', f);
    return out;
  }

  // video
  const rawModel = String(getArg('model', 'Seedance 2.0 Mini'));
  const norm = VIDEO_MODELS[rawModel.toLowerCase()];
  if (!norm) {
    log(`${C.yellow}⚠ 未知视频模型 "${rawModel}"，可选：Seedance 2.0 / Seedance 2.0 Fast / Seedance 2.0 Mini${C.reset}`);
    log(`${C.yellow}  将按原样传递${C.reset}`);
    out.push('--model', modeName === 'direct' ? rawModel : rawModel);
  } else {
    out.push('--model', modeName === 'direct' ? norm.key : norm.display);
  }
  const dur = String(getArg('duration', '4'));
  out.push('--duration', dur);
  for (const f of collectRefs()) out.push('--ref', f);
  if (modeName === 'direct') {
    out.push('--resolution', String(getArg('resolution', '720p')).toLowerCase());
    out.push('--timeout', String(getArg('timeout', 900)));
  } else {
    out.push('--resolution', String(getArg('resolution', '720P')).toUpperCase());
    out.push('--timeout', String(getArg('timeout', 1200)));
  }
  // 透传：干跑、窗口位置、重启浏览器等（仅浏览器模式有意义的开关也一并传，direct 会忽略未知参数）
  for (const flag of ['dry-run', 'hidden', 'headless', 'minimized', 'restart-edge']) {
    const v = getArg(flag, null);
    if (v !== null) out.push(`--${flag}`, v);
  }
  return out;
}

// ── 交互式向导：在 Node 里收集输入，彻底避开 cmd 的 set /p 与变量展开陷阱
// （历史坑：.cmd 里用 PROMPT 当变量名，撞上 cmd 内置的 $P$G，空输入时把 "$P$G" 当成描述发了出去）
async function wizard() {
  const isTTY = Boolean(process.stdin.isTTY);
  let rl = null;
  let lines = [];
  let li = 0;

  if (isTTY) {
    const { createInterface } = await import('node:readline/promises');
    rl = createInterface({ input: process.stdin, output: process.stdout });
  } else {
    // 管道输入（脚本化/测试）：一次性读完，避免 question 在 stdin 关闭后永不 resolve
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  }

  const ask = async (q, def) => {
    if (isTTY) {
      const a = ((await rl.question(q)) ?? '').trim();
      return a === '' ? def : a;
    }
    process.stdout.write(q);
    const a = String(lines[li++] ?? '').trim();
    process.stdout.write(`${a}\n`);
    return a === '' ? def : a;
  };
  const done = () => {
    if (rl) rl.close();
  };

  const out = [];
  if (kind === 'models') {
    const f = await ask('要查哪类模型？image / video（回车=video）: ', 'video');
    out.push('--for', f.toLowerCase() === 'image' ? 'image' : 'video');
    done();
    return out;
  }

  const prompt = await ask('请输入画面描述: ', '');
  // 二次校验：空 / 明显是占位符 → 直接拒，别浪费额度
  if (!prompt) {
    done();
    console.error('[错误] 描述不能为空');
    process.exitCode = 1;
    return null;
  }
  if (/^\$P(\$G)?$|^%[A-Z_]+%$|^!.*!$/.test(prompt)) {
    done();
    console.error(`[错误] 描述看起来是占位符（"${prompt}"），请重新运行并输入真实内容`);
    process.exitCode = 1;
    return null;
  }
  out.push('--prompt', prompt);

  if (kind === 'image') {
    const model = await ask('模型（回车=Seedream 4.5；可选 Seedream 5.5 / 5.0 Pro★ / 5.0 Lite / 5.0 Flash / 4.5 / 4.0，★=会员）: ', 'Seedream 4.5');
    out.push('--model', model);
    const ratio = await ask('比例（回车=16:9；可选 auto / 1:1 / 3:4 / 4:3 / 9:16 / 16:9）: ', '16:9');
    out.push('--ratio', ratio);
    const cnt = await ask(`生成数量（回车=1，一次最多 8 张）: `, '1');
    out.push('--count', cnt);
    const refs = await ask('参考图（回车=不用；多张用逗号分隔，最多 10 张；直接粘贴路径即可，带引号也行）: ', '');
    if (refs) {
      const list = refs.split(/[,，]/).map((s) => cleanPath(s)).filter(Boolean);
      const kept = list.slice(0, MAX_REF_IMAGES);
      if (list.length > MAX_REF_IMAGES) log(`  参考图最多 ${MAX_REF_IMAGES} 张，已只取前 ${MAX_REF_IMAGES} 张`);
      for (const f of kept) out.push('--ref', f);
    }
  } else {
    const model = await ask('模型（回车=Seedance 2.0 Mini；可选 Seedance 2.5★ / 2.5 Flash★ / 2.0★ / 2.0 Fast / 2.0 Mini，★=会员）: ', 'Seedance 2.0 Mini');
    out.push('--model', model);
    const ratio = await ask('比例（回车=16:9；可选 1:1 / 3:4 / 4:3 / 9:16 / 16:9）: ', '16:9');
    out.push('--ratio', ratio);
    const dur = await ask('时长秒数（回车=4，范围 4-15）: ', '4');
    out.push('--duration', dur);
    const refs = await ask('参考图（回车=不用；多张用逗号分隔，最多 10 张；直接粘贴路径即可，带引号也行）: ', '');
    if (refs) {
      const list = refs.split(/[,，]/).map((s) => cleanPath(s)).filter(Boolean);
      const kept = list.slice(0, MAX_REF_IMAGES);
      if (list.length > MAX_REF_IMAGES) log(`  参考图最多 ${MAX_REF_IMAGES} 张，已只取前 ${MAX_REF_IMAGES} 张`);
      for (const f of kept) out.push('--ref', f);
    }
  }
  done();
  return out;
}

// ── 入口
// --interactive：由 Node 收集输入（.cmd 只负责调用，不碰任何变量）
let wizardFailed = false;
if (hasFlag('interactive') && ['image', 'video', 'models'].includes(kind)) {
  const extra = await wizard();
  if (!extra) wizardFailed = true;
  else argv.push(...extra);
}

if (wizardFailed) {
  process.exitCode = 1;
} else if (!['image', 'video', 'models', 'login', 'logout'].includes(kind)) {
  console.error(
    [
      '用法:',
      '  node doubao.mjs image  --prompt "..." [--model "Seedream 4.5"] [--ratio 16:9] [--count 1-8] [--ref a.png] [--mode auto|direct|browser]',
      '  node doubao.mjs video  --prompt "..." [--model "Seedance 2.0 Fast"] [--duration 4] [--ref frame.png] [--mode ...]',
      '  node doubao.mjs models --for image|video',
      '  node doubao.mjs login',
      '  node doubao.mjs logout [--status|--dry-run|--yes|--keep-profile|--keep-cookie]',
    ].join('\n'),
  );
  process.exitCode = 2;
} else if (kind === 'login') {
  process.exitCode = run('login.mjs', argv.slice(1)).code;
} else if (kind === 'logout') {
  // 退登 = 本地彻底清理（服务端退登接口被风控挡死，见 logout.mjs 顶部说明）
  process.exitCode = run('logout.mjs', argv.slice(1)).code;
} else {
  const forceBrowser = mode === 'browser';
  const forceDirect = mode === 'direct';

  // 方式 B：浏览器
  const runBrowser = () => {
    banner('方式 B：需要浏览器进程（Edge 自动化）', 'doubao_gen.mjs');
    return run('doubao_gen.mjs', buildArgs('browser'));
  };

  // 方式 A：直连
  const runDirect = () => {
    banner('方式 A：完全脱离浏览器（纯 HTTP 直连）', 'doubao_http.mjs');
    return run('doubao_http.mjs', buildArgs('direct'));
  };

  if (forceBrowser) {
    process.exitCode = runBrowser().code;
  } else if (forceDirect) {
    const cs = cookieState();
    if (!cs.ok) {
      log(`${C.yellow}cookie 状态：${cs.reason}${C.reset}`);
      refreshCookies();
    }
    process.exitCode = runDirect().code;
  } else {
    // auto：直连优先 → 刷新 cookie 重试 → 浏览器兜底
    const cs = cookieState();
    const hasProfile = existsSync(path.join(WS, 'doubao_edge_profile'));
    log(
      cs.ok
        ? `${C.dim}cookie 就绪（${cs.bytes} 字节，${cs.ageH} 小时前）${C.reset}`
        : `${C.dim}cookie 状态：${cs.reason}${C.reset}`,
    );
    // 完全没有登录态（cookie 和 Edge 配置都不在）时，直接指引去登录，别白等浏览器那 30 秒
    if (!cs.ok && !hasProfile) {
      log(`\n${C.yellow}⚠ 当前没有任何登录态（cookie 文件${existsSync(COOKIE_FILE) ? '是空的' : '不存在'}，Edge 配置目录也不在）${C.reset}`);
      log(`${C.yellow}  这通常是刚执行过退登。${C.reset}`);
      log(`${C.green}  下一步：双击「登录.cmd」扫码登录（约 10 秒）${C.reset}\n`);
      log(`${C.dim}  若确实想用浏览器方式（会在新 profile 里弹登录页），加 --try-browser true${C.reset}`);
      process.exitCode = 3;
      if (hasFlag('try-browser') || hasFlag('interactive')) {
        log('');
        process.exitCode = runBrowser().code;
      }
    } else {
      let rc = -1;
      if (cs.ok) rc = runDirect().code;

      if (rc !== 0) {
        if (rc > 0) log(`\n${C.yellow}✗ 方式 A 失败（退出码 ${rc}）${C.reset}`);
        if (refreshCookies()) {
          rc = runDirect().code;
          if (rc === 0) {
            log(`\n${C.green}✓ 刷新 cookie 后直连成功${C.reset}`);
            process.exitCode = 0;
          }
        }
      }

      if (rc !== 0) {
        log(`\n${C.yellow}↓ 直连不可用，降级到方式 B（需要浏览器进程）${C.reset}`);
        const rb = runBrowser();
        process.exitCode = rb.code;
        if (rb.code === 0) log(`\n${C.green}✓ 方式 B 成功${C.reset}`);
        else log(`\n${C.red}✗ 两种方式都失败（退出码 ${rb.code}）${C.reset}`);
      } else {
        process.exitCode = 0;
      }
    }
  }
}
