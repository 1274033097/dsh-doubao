/**
 * 从 Edge 配置目录直接提取豆包 cookie —— 不需要启动 Edge
 *
 * 原理：Edge 的 cookie 用 AES-256-GCM 加密，密钥存在 Local State 的
 *       os_crypt.encrypted_key 里，再用 Windows DPAPI(当前用户) 包裹。
 *       本机实测：92 个 cookie 全是 v10 前缀（DPAPI 方案，无 v20 应用绑定加密）。
 *
 * 用法: node get_cookies.mjs [--profile <目录>] [--out doubao_cookies.txt]
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const WS = process.cwd();
const argv = process.argv.slice(2);
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const PROFILE = getArg('profile', path.join(WS, 'doubao_edge_profile'));
const OUT = getArg('out', path.join(WS, 'doubao_cookies.txt'));

// ── 1. 用 DPAPI 解出主密钥（Node 没有 DPAPI 绑定，借 PowerShell 一次性解密）
function dpapiUnprotect(b64) {
  const ps = `
Add-Type -AssemblyName System.Security
$b = [Convert]::FromBase64String('${b64}')
$d = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')
[Convert]::ToBase64String($d)`;
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  return Buffer.from(out.trim(), 'base64');
}

async function getMasterKey() {
  const lsPath = path.join(PROFILE, 'Local State');
  if (!existsSync(lsPath)) throw new Error(`找不到 Local State: ${lsPath}`);
  const ls = JSON.parse(await readFile(lsPath, 'utf8'));
  const enc = ls?.os_crypt?.encrypted_key;
  if (!enc) throw new Error('Local State 里没有 os_crypt.encrypted_key');
  const raw = Buffer.from(enc, 'base64');
  // 前 5 字节是 "DPAPI" 标记
  if (raw.subarray(0, 5).toString('latin1') !== 'DPAPI') throw new Error('未知的密钥格式（非 DPAPI）');
  const key = dpapiUnprotect(raw.subarray(5).toString('base64'));
  if (key.length !== 32) throw new Error(`主密钥长度异常: ${key.length}`);
  return key;
}

// ── 2. 解单条 cookie：v10|v11 + 12字节nonce + 密文 + 16字节tag
// Edge/Chrome 130+（cookie DB version >= 24）会在明文前加 32 字节 SHA256(host_key)，需剥掉
function decryptValue(key, buf, hostKey) {
  if (!buf || buf.length < 3) return '';
  const prefix = buf.subarray(0, 3).toString('latin1');
  if (prefix === 'v20') throw new Error('遇到 v20（应用绑定加密），本机 DPAPI 无法解密');
  if (prefix !== 'v10' && prefix !== 'v11') {
    // 老式：整段就是 DPAPI 密文
    return dpapiUnprotect(buf.toString('base64')).toString('utf8');
  }
  const nonce = buf.subarray(3, 15);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(15, buf.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  let plain = Buffer.concat([d.update(ct), d.final()]);
  // 剥掉 SHA256(host_key) 前缀
  if (hostKey && plain.length > 32) {
    const h = createHash('sha256').update(hostKey).digest();
    if (plain.subarray(0, 32).equals(h)) plain = plain.subarray(32);
  }
  return plain.toString('utf8');
}

// ── 主流程
const dbPath = path.join(PROFILE, 'Default', 'Network', 'Cookies');
const altPath = path.join(PROFILE, 'Default', 'Cookies');
const src = existsSync(dbPath) ? dbPath : altPath;

try {
  if (!existsSync(src)) throw new Error(`找不到 cookie 库：${dbPath}`);

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dck-'));
  const tmpDb = path.join(tmpDir, 'Cookies');
  try {
    await copyFile(src, tmpDb); // 复制一份，避免 Edge 运行时锁库
  } catch (e) {
    await rm(tmpDir, { recursive: true, force: true });
    const busy = /EBUSY|EPERM|locked|占用/.test(String(e.message));
    throw new Error(
      busy
        ? 'cookie 库被 Edge 占用 —— 请先完全关闭 Edge（任务栏退出），或改用「登录.cmd」扫码登录'
        : `读取 cookie 库失败：${e.message}`,
    );
  }

  const key = await getMasterKey();
  const db = new DatabaseSync(tmpDb, { readOnly: true });
  const rows = db
    .prepare("select host_key, name, encrypted_value, value from cookies where host_key like '%doubao.com%' order by host_key")
    .all();
  db.close();

  const jar = [];
  const stats = { total: rows.length, ok: 0, failed: 0, empty: 0, dropped: 0 };
  const droppedNames = [];
  for (const r of rows) {
    let v = '';
    try {
      if (r.value) v = r.value;
      else if (r.encrypted_value?.length) v = decryptValue(key, Buffer.from(r.encrypted_value), r.host_key);
      else {
        stats.empty += 1;
        continue;
      }
      // cookie 值是字节串：含非 ASCII 或非法 UTF-8 的条目会让请求头构造失败，直接丢弃
      if (!/^[\x20-\x7E]*$/.test(v)) {
        stats.dropped += 1;
        droppedNames.push(r.name);
        continue;
      }
      stats.ok += 1;
      jar.push(`${r.name}=${v}`);
    } catch {
      stats.failed += 1;
    }
  }

  // 同名 cookie 去重（不同 path 可能有重复），保留最后一个
  const map = new Map();
  for (const kv of jar) map.set(kv.slice(0, kv.indexOf('=')), kv);
  const cookieStr = [...map.values()].join('; ');

  await writeFile(OUT, cookieStr, 'utf8');
  console.log(
    JSON.stringify(
      {
        profile: PROFILE,
        out: OUT,
        ...stats,
        cookieCount: map.size,
        bytes: cookieStr.length,
        hasSessionId: map.has('sessionid'),
        droppedNonAscii: droppedNames,
        names: [...map.keys()].sort().join(','),
      },
      null,
      2,
    ),
  );
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  process.exitCode = stats.ok > 0 ? 0 : 4;
} catch (err) {
  // 友好报错，不打印调用栈
  console.error(`[get_cookies] ${String(err && err.message ? err.message : err)}`);
  process.exitCode = 1;
}
