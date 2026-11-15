/**
 * 浏览器探测 —— 统一入口，别在别处再硬编码 msedge.exe。
 *
 * 为什么需要这个文件：
 *   原来的实现把 Edge 路径写死在三个地方（login.mjs / doubao_gen.mjs / logout.mjs），
 *   换一台默认浏览器不是 Edge 的机器就用不了。现在改成：
 *     1) 优先读 Windows 注册表里的「默认浏览器」（https 关联）
 *     2) 找不够就按常见安装位置扫一遍（Edge / Chrome / Brave / Vivaldi / Opera）
 *     3) 都找不到才报错，并告诉你怎么办
 *
 * 只支持 Chromium 系（需要 CDP 调试端口）。Firefox / Safari 用不了这套协议。
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** 常见 Chromium 浏览器的安装位置（按优先级） */
function candidateList() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    // Edge（Win10+ 自带，最常见）
    { name: 'Edge', path: path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'), progId: 'MSEdgeHTM' },
    { name: 'Edge', path: path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'), progId: 'MSEdgeHTM' },
    // Chrome
    { name: 'Chrome', path: path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'), progId: 'ChromeHTML' },
    { name: 'Chrome', path: path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'), progId: 'ChromeHTML' },
    { name: 'Chrome', path: path.join(local, 'Google\\Chrome\\Application\\chrome.exe'), progId: 'ChromeHTML' },
    // 其它 Chromium 系（都支持 CDP）
    { name: 'Brave', path: path.join(pf, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'), progId: 'BraveHTML' },
    { name: 'Vivaldi', path: path.join(local, 'Vivaldi\\Application\\vivaldi.exe'), progId: 'VivaldiHTM' },
    { name: 'Opera', path: path.join(local, 'Programs\\Opera\\opera.exe'), progId: 'OperaStable' },
  ].filter((c) => c.path);
}

/**
 * 读 Windows 默认浏览器的 ProgId。
 * 注意：这个键在有些系统上会因权限或策略读不到，读不到就当空。
 */
function defaultBrowserProgId() {
  if (process.platform !== 'win32') return '';
  const key = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
  try {
    // 用 reg query 而不是 PowerShell：启动更快，也不依赖 PowerShell 是否可用
    const out = execFileSync('reg', ['query', key, '/v', 'ProgId'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = /ProgId\s+REG_\w+\s+(\S+)/i.exec(out);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** 记住上一次选中的浏览器，避免每次调用都去扫注册表 */
let cached = null;

/**
 * 选择要驱动的浏览器。
 * 返回 `{ name, path, via }`，`via` 说明是怎么选中的（default / installed / config）。
 * 找不到任何 Chromium 系浏览器时返回 `{ name:'', path:'', via:'none' }`。
 */
export function pickBrowser(preferredPath) {
  if (cached) return cached;

  // 0) 调用方显式指定（环境变量或参数）优先
  const explicit = preferredPath || process.env.DOUBAO_BROWSER || '';
  if (explicit && existsSync(explicit)) {
    cached = { name: path.basename(explicit, '.exe'), path: explicit, via: 'config' };
    return cached;
  }

  const candidates = candidateList().filter((c) => existsSync(c.path));
  if (!candidates.length) {
    cached = { name: '', path: '', via: 'none' };
    return cached;
  }

  // 1) 默认浏览器的 ProgId 能对上哪个就选哪个
  const progId = defaultBrowserProgId();
  if (progId) {
    const hit = candidates.find((c) => progId.startsWith(c.progId));
    if (hit) {
      cached = { name: hit.name, path: hit.path, via: 'default' };
      return cached;
    }
  }

  // 2) 没匹配上就用第一个可用的（Edge 排最前，Windows 上基本都有）
  cached = { name: candidates[0].name, path: candidates[0].path, via: 'installed' };
  return cached;
}

/** 给用户看的说明：为什么没找到、能怎么办 */
export function describeFailure() {
  return [
    '找不到可用的 Chromium 系浏览器（需要 Edge / Chrome / Brave / Vivaldi / Opera）。',
    '  处理办法：',
    '    ① 装一个 Chrome 或 Edge（Windows 一般自带 Edge）',
    '    ② 或者指定路径：设置环境变量 DOUBAO_BROWSER=你的浏览器.exe 后重试',
    '    ③ 只做纯 HTTP 扫码（不依赖浏览器）：node login.mjs --mode http',
  ].join('\n');
}

/** 测试用：清掉缓存 */
export function resetBrowserCache() {
  cached = null;
}