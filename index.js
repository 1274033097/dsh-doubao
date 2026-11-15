/**
 * @local/dsh-doubao · Host 半边
 *
 * 职责：把本机已有的豆包工具脚本（doubao.mjs / login.mjs / doubao_http.mjs）包装成一组
 * 挂在 DSH Web 服务上的 HTTP 接口，供 client.js 那个页面调用。
 *
 * 设计要点（为什么这么写）：
 *  - 一条 `kind: 'prefix'` 路由挂在 `/doubao/api`，内部按 pathname 分发。
 *    DSH 的 webServer 给的是 Node 原生 IncomingMessage/ServerResponse（不是 fetch 的
 *    Request/Response），所以这里全部用 writeHead/end，不用 Web 标准对象。
 *  - 子进程用异步 spawn（不是 spawnSync），否则会卡住 Electron 主进程的事件循环，
 *    整个桌面端 UI 都会跟着卡死。
 *  - 任务状态只存在内存里（一个闭包内的 state）。插件卸载时闭包被丢弃，同时要显式
 *    杀掉还在跑的子进程，否则会留下孤儿 node/msedge 进程。
 *  - 任何可能抛错的地方（spawn、读文件、JSON 解析、stat）都兜住，返回 {ok:false,message}，
 *    绝不让异常冒到 DSH 进程里。
 */

import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件前缀路由；所有接口都在它下面 */
const PREFIX = '/doubao/api'

/** 单任务超时：30 分钟强制收尾（生视频可能跑很久，但超过这个时长基本是卡死了） */
const TASK_TIMEOUT_MS = 30 * 60 * 1000

/** 取消/超时后等 close 事件的保险时间：Windows 上杀进程偶尔不触发 close */
const KILL_SAFETY_MS = 8000

/** 日志只保留末尾 8000 字符：轮询类日志会一直刷，任务对象不能无限膨胀 */
const LOG_LIMIT = 8000

/**
 * 2026-11-14：一次最多 8 张图，每张一行 `[saved]`，8000 字符在长日志下可能把
 * 前面的 `[saved]` 行挤掉（多图时 poll 日志会刷得很快），所以多图任务放宽到 24000。
 * 单图/视频仍用 8000，避免常态占用内存。
 */
const LOG_LIMIT_MULTI = 24000

/** /logout --status 是只读查询，几秒内应该返回；超时说明子进程卡住了 */
const LOGOUT_STATUS_TIMEOUT_MS = 20000

/** 请求体上限（只有 prompt 之类的小字段，1MB 足够） */
const BODY_LIMIT = 1024 * 1024

/** /models 子进程超时：拿模型清单要发一次 HTTP 请求，给足 120 秒 */
const MODELS_TIMEOUT_MS = 120 * 1000

/** 历史记录条数 */
const HISTORY_LIMIT = 20

/** 产物列表条数 */
const OUTPUT_LIMIT = 60

/** 这些扩展名算「产物」，用来区分 image / video */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const VIDEO_EXT = new Set(['.mp4'])

/** 生图一次最多几张（2026-11-14 起 doubao.mjs 支持 --count 1-8） */
const MAX_GEN_IMAGES = 8

/** 参考图最多几张（doubao.mjs 的 --ref 上限） */
const MAX_REF_IMAGES = 10

/** 参考图允许的扩展名：豆包上传接口只吃这几种，别的传上去也会失败 */
const REF_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/** 按扩展名给 Content-Type（契约 1.3） */
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
}

/**
 * ANSI 转义序列（颜色、光标控制等）。脚本会打彩色 banner，日志里必须去掉，
 * 否则前端 <pre> 里会看到一堆乱码。
 */
const ANSI_RE = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*)?\\u0007)|(?:(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  'g',
)

/** 写方法带 Origin 头时允许的主机名（契约 1.2） */
const ALLOWED_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

const stripAnsi = (s) => String(s ?? '').replace(ANSI_RE, '')

const errMsg = (e) => {
  const t = String((e && e.message) || e || '未知错误')
  return t.length > 300 ? t.slice(0, 300) + '…' : t
}

/**
 * 判断 socket 对端是不是本机。
 * 注意 IPv4-mapped IPv6（::ffff:127.0.0.1）在 Windows 上很常见，必须先剥前缀再判断。
 */
function isLoopback(addr) {
  if (!addr) return false
  let a = String(addr).trim().toLowerCase()
  if (a.startsWith('::ffff:')) a = a.slice('::ffff:'.length)
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
}

/**
 * 写方法（非 GET/HEAD）的 Origin 同源闸：浏览器跨站请求会带 Origin，
 * 挡住「别的网页偷偷 POST /generate 烧我额度」这种情况。没有 Origin 头的
 * （curl、同源表单）放行——本机回环已经由 isLoopback 把住第一道门了。
 */
function isAllowedOrigin(req) {
  const raw = req.headers && req.headers.origin
  if (!raw) return true
  let host
  try {
    host = new URL(String(raw)).hostname.toLowerCase()
  } catch {
    return false // Origin: null / 非法值 一律拒
  }
  return ALLOWED_ORIGIN_HOSTS.has(host)
}

/** 安全地写 JSON；已经发过 header 或已经结束就放弃（避免 ERR_HTTP_HEADERS_SENT） */
function sendJson(res, status, payload) {
  if (!res || res.writableEnded || res.headersSent) return
  let body
  try {
    body = JSON.stringify(payload === undefined ? null : payload)
  } catch {
    body = '{"ok":false,"message":"响应序列化失败"}'
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    try {
      res.destroy()
    } catch {
      /* 已经断了，忽略 */
    }
  }
}

/** 把 stdout 里那段 JSON 抠出来解析（脚本是 console.log 打印的，偶尔前面会带别的行） */
function parseJsonLoose(text) {
  const t = String(text ?? '').trim()
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch {
    /* 落到下面的宽松解析 */
  }
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s >= 0 && e > s) {
    try {
      return JSON.parse(t.slice(s, e + 1))
    } catch {
      /* 真的不是 JSON */
    }
  }
  return null
}

/** 取日志最后 3 行非空内容当人话错误（契约 1.6），最多 500 字 */
function tailError(log) {
  const lines = stripAnsi(log)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const tail = lines.slice(-3).join('\n')
  return tail.slice(0, 500)
}

export const inject = ['webServer']

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}

  // ── 目录 / 可执行文件解析 ───────────────────────────────────────────────
  // 插件目录从 import.meta.url 推出来，不写死盘符（插件可能被装到任意位置）。
  // path.resolve 顺带去掉 fileURLToPath 在 Windows 上带的结尾反斜杠。
  let pluginDir
  try {
    pluginDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)))
  } catch {
    pluginDir = process.cwd()
  }
  const toolkitDir = cfg.toolkitDir ? path.resolve(String(cfg.toolkitDir)) : pluginDir
  const outDir = path.join(toolkitDir, 'doubao_out')
  const cookieFile = path.join(toolkitDir, 'doubao_cookies.txt')
  const profileDir = path.join(toolkitDir, 'doubao_edge_profile')
  const identityFile = path.join(toolkitDir, 'doubao_identity.json')

  const isFile = (p) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }

  /**
   * node 解析顺序（契约 1.7）：
   *   1. config.nodePath             —— 显式配置优先，用户最清楚自己机器上 node 在哪
   *   2. DSH_DOUBAO_NODE             —— 环境变量，方便不改插件配置就临时换
   *   3. PATH 里的 node(.exe)        —— 最常见的情况
   *   4. process.execPath + ELECTRON_RUN_AS_NODE=1
   *      兜底：DSH 跑在 Electron 主进程里，execPath 就是 electron 本身；
   *      设 ELECTRON_RUN_AS_NODE=1 后它会以纯 node 模式执行脚本，这是最后的保险。
   * 结果缓存：PATH 扫描要 stat 一堆目录，/state 每 1.5 秒被轮询一次，没必要反复扫。
   */
  let nodeCache = null
  function resolveNode() {
    if (nodeCache) return nodeCache

    const explicit = cfg.nodePath ? String(cfg.nodePath) : ''
    if (explicit && isFile(explicit)) {
      nodeCache = { command: explicit, env: {} }
      return nodeCache
    }

    const fromEnv = process.env.DSH_DOUBAO_NODE ? String(process.env.DSH_DOUBAO_NODE) : ''
    if (fromEnv && isFile(fromEnv)) {
      nodeCache = { command: fromEnv, env: {} }
      return nodeCache
    }

    const exeName = process.platform === 'win32' ? 'node.exe' : 'node'
    const pathVar = process.env.PATH || process.env.Path || ''
    for (const rawDir of String(pathVar).split(path.delimiter)) {
      // PATH 里的条目在 Windows 上可能带引号，先剥掉
      const dir = rawDir.replace(/^"+|"+$/g, '').trim()
      if (!dir) continue
      const candidate = path.join(dir, exeName)
      if (isFile(candidate)) {
        nodeCache = { command: candidate, env: {} }
        return nodeCache
      }
    }

    nodeCache = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
    return nodeCache
  }

  /** 子进程统一环境：继承宿主 env，叠加 ELECTRON_RUN_AS_NODE（兜底时才有）和 DOUBAO_OUT */
  function childEnv() {
    const node = resolveNode()
    return { ...process.env, ...node.env, DOUBAO_OUT: outDir }
  }

  /**
   * 杀掉子进程树。
   * 关键点：doubao.mjs 内部还会用 spawnSync 起 doubao_http.mjs / doubao_gen.mjs，
   * 只 kill 父进程会留下孙子进程继续跑（还在烧额度），所以 Windows 上用
   * taskkill /T /F 把整棵树干掉；其它平台 proc.kill 已经够用。
   */
  function killTree(proc) {
    if (!proc || !proc.pid) return
    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.on('error', () => {})
        killer.unref?.()
      } catch {
        /* taskkill 起不来就退化成下面普通 kill */
      }
    }
    try {
      proc.kill()
    } catch {
      /* 已经退了 */
    }
  }

  // ── 任务状态 ────────────────────────────────────────────────────────────
  const state = {
    /** 当前运行中的任务（内部对象，含 proc/timer 等不可序列化字段） */
    current: null,
    /** 已结束任务，新的在前，最多 HISTORY_LIMIT 条 */
    history: [],
  }
  /** 正在跑的 /models 子进程，插件卸载时一起清掉 */
  const modelsProcs = new Set()
  let idSeq = 0

  const nextId = () => `j_${Date.now()}_${++idSeq}`

  /** 把内部任务对象转成对外形状（契约 1.6）；history 里不带 log */
  function publicTask(task, withLog) {
    const out = {
      id: task.id,
      kind: task.kind,
      status: task.status,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      prompt: task.prompt,
      result: task.result,
      error: task.error,
    }
    // 多图时给个总大小，前端状态行直接读，不用自己遍历 files
    if (task.result && Array.isArray(task.result.files) && task.result.files.length > 0) {
      out.totalMb = totalMb(task.result.files)
    }
    if (withLog) out.log = stripAnsi(task._log)
    return out
  }

  function pushHistory(task) {
    state.history.unshift(publicTask(task, false))
    if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT
  }

  /** 追加日志：去 ANSI、统一换行、只留末尾 N 字符（N 由任务自己定，见 LOG_LIMIT / LOG_LIMIT_MULTI） */
  function appendLog(task, chunk) {
    if (!chunk) return
    const limit = task._logLimit || LOG_LIMIT
    const clean = stripAnsi(String(chunk)).replace(/\r\n/g, '\n')
    task._log += clean
    if (task._log.length > limit) task._log = task._log.slice(-limit)
  }

  /** 生图数量夹取：1-8，非法值回 1 */
  function clampCount(raw) {
    const n = Number(raw)
    if (!Number.isFinite(n)) return 1
    const v = Math.floor(n)
    if (v < 1) return 1
    if (v > MAX_GEN_IMAGES) return MAX_GEN_IMAGES
    return v
  }

  /**
   * 把前端传来的参考图字符串解析成可用的绝对路径。
   *
   * 规则（契约 v2 §1.3）：
   *   - 绝对路径（`C:\...`、`/x`、`\\server\share`）直接用，必须存在
   *   - 裸文件名 → 在 doubao_out 里找（前端点选产物缩略图时传的就是 name）
   *   - 扩展名只允许 png/jpg/jpeg/webp
   *   - 超过 10 张只取前 10，并带回 warning
   *
   * 一定要「不存在就报错」：静默跳过会让用户以为参考图生效了，白烧一次额度。
   * 返回 `{ ok, paths, warnings, message }`。
   */
  function resolveRefs(rawRefs) {
    const warnings = []
    if (rawRefs === undefined || rawRefs === null) return { ok: true, paths: [], warnings }
    if (!Array.isArray(rawRefs)) return { ok: false, paths: [], warnings, message: 'refs 必须是数组' }

    const paths = []
    const seen = new Set()
    for (const item of rawRefs) {
      const raw = String(item ?? '').trim()
      if (!raw) continue
      // 前端偶尔会把多行文本塞进一个元素，按换行再拆一次
      for (const piece of raw.split(/\r?\n/)) {
        const value = piece.trim()
        if (!value) continue

        // Windows 绝对路径 / POSIX 绝对路径 / UNC
        const isAbs = path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)
        // 裸文件名直接拼 doubao_out；其它（相对路径）也按 doubao_out 解析，避免 cwd 歧义
        const abs = isAbs ? value : path.join(outDir, value)

        if (!isFile(abs)) return { ok: false, paths: [], warnings, message: `参考图不存在：${value}` }
        const ext = path.extname(abs).toLowerCase()
        if (!REF_IMAGE_EXT.has(ext)) {
          return { ok: false, paths: [], warnings, message: `参考图只支持 png / jpg / jpeg / webp：${value}` }
        }
        // 同一张图重复选中只算一次
        const key = abs.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        paths.push(abs)
      }
    }

    if (paths.length > MAX_REF_IMAGES) {
      const extra = paths.length - MAX_REF_IMAGES
      warnings.push(`参考图最多 ${MAX_REF_IMAGES} 张，已忽略多余的 ${extra} 张`)
      paths.length = MAX_REF_IMAGES
    }
    return { ok: true, paths, warnings }
  }

  /** 取文件字节数；文件不在了就返回 0，别让一次 stat 失败把整次解析带崩 */
  function statBytes(abs) {
    try {
      return statSync(abs).size
    } catch {
      return 0
    }
  }

  /**
   * 解析日志里的产物记录。2026-11-14 起生图改成了文本行，所以三种形态都要吃：
   *
   *   1) `[saved] {"file":"C:\\...\\http_1.png","bytes":123,"mb":1.2,"tries":1}`
   *      —— 视频直连 / poll 还在用 JSON
   *   2) `[saved] C:\...\doubao_out\http_1700000000000.png  4.2 MB`
   *      —— 生图（直连 + 浏览器）、浏览器视频；路径里可能有空格，不能按空格硬切
   *   3) `[summary] {"count":2,"elapsedSec":21,"files":[...]}`
   *      —— 末尾汇总，只用来取 elapsedSec
   *
   * 只要行首是 `[saved]` 就收，不依赖行内其余格式（脚本以后再加字段也不会漏解析）。
   * 返回 `{ files: [{file,path,bytes,mb}], summary: {...}|null }`。
   */
  function parseSavedFiles(log) {
    const files = []
    const seen = new Set()
    let summary = null
    const lines = String(log || '').split(/\r?\n/)

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue

      if (line.startsWith('[summary]')) {
        const parsed = parseJsonLoose(line.slice('[summary]'.length))
        if (parsed && typeof parsed === 'object') summary = parsed
        continue
      }
      if (!line.startsWith('[saved]')) continue

      const rest = line.slice('[saved]'.length).trim()
      if (!rest) continue

      let rawPath = ''
      let givenBytes = null
      let givenMb = null

      if (rest.startsWith('{')) {
        // 形态 1：JSON。用宽松解析，容忍 elapsedSec / tries 之类的额外字段
        const parsed = parseJsonLoose(rest)
        if (!parsed || typeof parsed !== 'object') continue
        if (typeof parsed.file === 'string') rawPath = parsed.file
        if (parsed.bytes !== undefined) givenBytes = Number(parsed.bytes)
        if (parsed.mb !== undefined) givenMb = Number(parsed.mb)
      } else {
        // 形态 2：`<路径>  <MB> MB`。路径可能含空格（C:\My Pics\a.png），
        // 所以用正则从右往左把末尾的 `N MB` / `N` 剥掉，剩下整段才是路径。
        const m = /^(.*?)\s+([\d.]+)\s*M?B?$/i.exec(rest)
        if (m) {
          rawPath = m[1]
          givenMb = Number(m[2])
        } else {
          // 没有大小字段（脚本万一只打路径）也照收，字节数后面用 statSync 补
          rawPath = rest
        }
      }

      rawPath = String(rawPath || '')
        .trim()
        .replace(/^"(.*)"$/, '$1') // 用户手填带引号的路径时，脚本可能原样带出来
        .trim()
      if (!rawPath) continue

      const abs = path.isAbsolute(rawPath) ? rawPath : path.join(outDir, rawPath)
      const name = path.basename(abs)
      if (!name) continue
      // 同一个 basename 只留一次：重试/降级路径下脚本偶尔会重复打印同一张
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)

      // 文本形态没有字节数，用 statSync 补；mb 有就用脚本给的，没有就按字节数算
      const bytes = Number.isFinite(givenBytes) && givenBytes > 0 ? givenBytes : statBytes(abs)
      const mb =
        Number.isFinite(givenMb) && givenMb > 0
          ? givenMb
          : Math.round((bytes / 1048576) * 100) / 100

      files.push({ file: name, path: abs, bytes, mb })
    }

    return { files, summary }
  }

  /**
   * 把解析结果组装成对外 result（契约 v2 §1.2）。
   * `files` 永远是数组（单张也长度 1），前端按数组渲染才不会为「单张/多张」写两套逻辑。
   * elapsedSec 优先用脚本 `[summary]` 给的（它从请求开始算，比我们自己掐表准）；
   * 没有就按任务开始时间算。
   */
  function toResult(parsed, task) {
    const files = parsed && Array.isArray(parsed.files) ? parsed.files : []
    if (!files.length) return null
    const fromSummary = parsed.summary && Number(parsed.summary.elapsedSec)
    let elapsedSec = Number.isFinite(fromSummary) && fromSummary >= 0 ? fromSummary : null
    if (elapsedSec === null && task && task.startedAt) {
      elapsedSec = Math.max(0, Math.round((Date.now() - task.startedAt) / 1000))
    }
    return { files, count: files.length, elapsedSec }
  }

  /** 总字节数：前端状态行要报「完成 · 3 张 · 12.4 MB」，别让它自己再遍历一遍 */
  function totalMb(files) {
    const sum = files.reduce((acc, f) => acc + (Number(f.mb) || 0), 0)
    return Math.round(sum * 100) / 100
  }

  /**
   * 任务收尾（幂等）。超时 / 取消 / close 三条路都可能调进来，
   * 用 _finalized 保证只结算一次，历史里不会出现重复条目。
   */
  function finalize(task, code) {
    if (!task || task._finalized) return
    task._finalized = true
    if (task._timer) clearTimeout(task._timer)
    if (task._safety) clearTimeout(task._safety)
    task._timer = null
    task._safety = null
    task.proc = null
    task.endedAt = Date.now()

    if (task._timedOut) {
      task.status = 'failed'
      task.error = '超时'
      task.result = null
    } else if (task._cancelled) {
      task.status = 'cancelled'
      task.error = '已取消'
      task.result = null
    } else if (code === 0) {
      if (task.kind === 'login') {
        task.status = 'done'
        task.error = null
        task.result = { loggedIn: true }
      } else if (task.kind === 'logout') {
        // 退登成功后 cookie 文件会被清成 0 字节，脚本还会打印「已清理」之类的行
        task.status = 'done'
        task.error = null
        task.result = { loggedOut: true }
      } else {
        // 2026-11-14：生图改成「每张一行 [saved] 文本」，视频仍是 JSON，用 parseSavedFiles 一起吃。
        // 退出码 0 但没有产物 = 脚本自己认为结束了却没落文件（改版、被中途打断等），
        // 报「完成」但没缩略图会让人以为成功，所以按失败处理并把原因说清楚。
        const parsed = parseSavedFiles(task._log)
        const result = toResult(parsed, task)
        if (result) {
          task.status = 'done'
          task.error = null
          task.result = result
        } else {
          task.status = 'failed'
          task.result = null
          // 未登录时 doubao.mjs 会 exit 3 并打印登录指引；这里它走的是 code!==0 分支，
          // 但如果是被 auto 降级吞掉的场景，也给一句固定尾巴，免得用户对着日志发懵。
          task.error = '脚本结束了，但日志里没有 [saved] 产物记录（可能豆包改版或结果没拿到）'
        }
      }
    } else {
      task.status = 'failed'
      task.result = null
      // 未登录（cookie + profile 都不在）时 doubao.mjs 固定 exit 3，日志里已有登录指引；
      // 补一句固定尾巴，让「刚退登过」这种情况一眼能认出来。
      if (code === 3) {
        task.error = `${tailError(task._log) || '未登录'}\n若刚执行过退登，请先扫码登录`
      } else {
        task.error = tailError(task._log) || `子进程异常退出（退出码 ${code === null || code === undefined ? '未知' : code}）`
      }
    }

    if (state.current === task) state.current = null
    pushHistory(task)
  }

  /**
   * 起一个任务。单任务互斥在这里做：state.current 非空就直接拒，
   * 避免两个进程同时抢 cookie / 抢 Edge 的 CDP 端口。
   */
  function startTask(spec) {
    if (state.current) {
      return { ok: false, message: '已有任务在运行，请等它结束或先取消' }
    }
    const node = resolveNode()
    const task = {
      id: nextId(),
      kind: spec.kind,
      status: 'running',
      startedAt: Date.now(),
      endedAt: 0,
      prompt: spec.prompt || '',
      result: null,
      error: null,
      _log: '',
      // 多图任务日志更长：8 张图每张一行 [saved]，再叠上 poll 日志，8000 字符会挤掉前面的产物行
      _logLimit: spec.multi ? LOG_LIMIT_MULTI : LOG_LIMIT,
      _finalized: false,
      _cancelled: false,
      _timedOut: false,
      _timer: null,
      _safety: null,
      proc: null,
    }
    state.current = task

    let proc
    try {
      proc = spawn(node.command, [path.join(toolkitDir, spec.script), ...spec.args], {
        // cwd 必须是 toolkitDir：脚本全用 process.cwd() 定位自己的文件
        cwd: toolkitDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(),
      })
    } catch (err) {
      task._finalized = true
      task.status = 'failed'
      task.error = `无法启动子进程：${errMsg(err)}`
      task.endedAt = Date.now()
      state.current = null
      pushHistory(task)
      console.warn('[dsh-doubao] 启动子进程失败:', errMsg(err))
      return { ok: false, message: task.error }
    }

    task.proc = proc
    // setEncoding 让 Node 自己处理跨 chunk 的多字节字符，避免中文日志被切坏
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', (s) => appendLog(task, s))
    proc.stderr?.on('data', (s) => appendLog(task, s))

    proc.on('error', (err) => {
      appendLog(task, `\n[spawn 错误] ${errMsg(err)}\n`)
      finalize(task, -1)
    })
    proc.on('close', (code) => finalize(task, code))

    task._timer = setTimeout(() => {
      task._timedOut = true
      appendLog(task, `\n[超时] 任务超过 ${Math.round(TASK_TIMEOUT_MS / 60000)} 分钟，已强制结束\n`)
      killTree(task.proc)
      // 保险：kill 之后 close 事件理论上会来，但 Windows 上偶发不来，
      // 8 秒后直接结算，免得 state.current 永远卡住导致后续任务全被互斥挡掉
      task._safety = setTimeout(() => finalize(task, -1), KILL_SAFETY_MS)
    }, TASK_TIMEOUT_MS)

    return { ok: true, id: task.id }
  }

  /** 读登录态：只看文件存在/年龄，cookie 内容只在内存里判一下 sessionid 就丢 */
  function readLoginState() {
    let hasCookies = false
    let cookieAgeHours = null
    try {
      if (isFile(cookieFile)) {
        cookieAgeHours = Math.round(((Date.now() - statSync(cookieFile).mtimeMs) / 3600000) * 10) / 10
        // 契约 1.4 要求判断是否含 sessionid；读完即丢，不记录、不回传内容
        hasCookies = /sessionid=/.test(readFileSync(cookieFile, 'utf8'))
      }
    } catch {
      hasCookies = false
      cookieAgeHours = null
    }
    let hasProfile = false
    try {
      hasProfile = statSync(profileDir).isDirectory()
    } catch {
      hasProfile = false
    }
    return { hasCookies, cookieAgeHours, hasProfile, hasIdentity: isFile(identityFile) }
  }

  /** 产物列表：doubao_out 里图片/视频，mtime 倒序，最多 60 个 */
  function listOutputs() {
    let entries
    try {
      entries = readdirSync(outDir, { withFileTypes: true })
    } catch {
      return [] // 目录还不存在（没生成过东西）就是空列表，不算错误
    }
    const out = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      const isVideo = VIDEO_EXT.has(ext)
      if (!isVideo && !IMAGE_EXT.has(ext)) continue
      try {
        const st = statSync(path.join(outDir, entry.name))
        out.push({
          name: entry.name,
          kind: isVideo ? 'video' : 'image',
          bytes: st.size,
          mtime: Math.round(st.mtimeMs),
        })
      } catch {
        /* 刚好被删了，跳过 */
      }
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out.slice(0, OUTPUT_LIMIT)
  }

  /** 读请求体并解析 JSON（带大小上限），任何失败都变成 {ok:false,message} */
  function readJsonBody(req) {
    return new Promise((resolve) => {
      let size = 0
      let tooBig = false
      const chunks = []
      let settled = false
      const done = (v) => {
        if (settled) return
        settled = true
        resolve(v)
      }
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > BODY_LIMIT) {
          tooBig = true
          return // 继续把流读空（不 destroy），保证响应还能写出去
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (tooBig) return done({ ok: false, message: '请求体过大' })
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (!text) return done({ ok: true, value: {} })
        try {
          const value = JSON.parse(text)
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return done({ ok: false, message: '请求体必须是 JSON 对象' })
          }
          return done({ ok: true, value })
        } catch {
          return done({ ok: false, message: '请求体不是合法 JSON' })
        }
      })
      req.on('error', () => done({ ok: false, message: '读取请求体失败' }))
      req.on('aborted', () => done({ ok: false, message: '请求被中断' }))
    })
  }

  // ── 路由处理 ────────────────────────────────────────────────────────────

  /** GET /state */
  function handleState(res) {
    sendJson(res, 200, {
      ok: true,
      toolkitDir,
      nodePath: resolveNode().command,
      login: readLoginState(),
      busy: Boolean(state.current),
      current: state.current ? publicTask(state.current, true) : null,
      history: state.history.slice(),
      outputs: listOutputs(),
      // 前端用它渲染数量下拉/参考图上限，别在 client.js 里写死第二份
      limits: { maxGenImages: MAX_GEN_IMAGES, maxRefImages: MAX_REF_IMAGES },
    })
  }

  /** GET /file?name=xxx —— 从 doubao_out 里读二进制产物 */
  function handleFile(res, url) {
    const name = String(url.searchParams.get('name') || '')
    // 文件名白名单：只允许字母数字点下划线横线，挡掉路径分隔符和控制字符
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
      return sendJson(res, 404, { ok: false, message: '文件名不合法' })
    }
    const abs = path.resolve(outDir, name)
    // 白名单正则放得过 ".." 里的点，所以还要再确认解析后没跳出 doubao_out：
    // 相对路径为空（就是目录本身）、以 .. 段开头、或是绝对路径，都算越界。
    const rel = path.relative(outDir, abs)
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      return sendJson(res, 404, { ok: false, message: '文件不存在' })
    }
    let st
    try {
      st = statSync(abs)
    } catch {
      return sendJson(res, 404, { ok: false, message: '文件不存在' })
    }
    if (!st.isFile()) return sendJson(res, 404, { ok: false, message: '文件不存在' })

    const ext = path.extname(abs).toLowerCase()
    if (res.writableEnded || res.headersSent) return
    try {
      res.writeHead(200, {
        'content-type': MIME_BY_EXT[ext] || 'application/octet-stream',
        'content-length': st.size,
        // 契约要求：不支持 Range，也不让浏览器缓存（产物名带时间戳，但 login_qr 会刷新）
        'accept-ranges': 'none',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
    } catch {
      return
    }
    const stream = createReadStream(abs)
    stream.on('error', (err) => {
      console.warn('[dsh-doubao] 读取产物失败:', errMsg(err))
      try {
        res.destroy()
      } catch {
        /* 忽略 */
      }
    })
    stream.pipe(res)
  }

  /** POST /generate */
  async function handleGenerate(req, res) {
    const body = await readJsonBody(req)
    if (!body.ok) return sendJson(res, 200, { ok: false, message: body.message })
    const b = body.value || {}

    const kind = String(b.kind || '').toLowerCase()
    if (kind !== 'image' && kind !== 'video') {
      return sendJson(res, 200, { ok: false, message: 'kind 必须是 image 或 video' })
    }

    const prompt = String(b.prompt ?? '').trim()
    // 空描述直接拒，绝不跑子进程（一跑就可能烧额度）
    if (!prompt) return sendJson(res, 200, { ok: false, message: '描述不能为空' })
    // 脚本用 argv 顺序取参数，描述以 -- 开头会被当成下一个开关，提前拦下给个明白话
    if (prompt.startsWith('--')) {
      return sendJson(res, 200, { ok: false, message: '描述不能以 -- 开头' })
    }

    const rawMode = String(b.mode || '').toLowerCase()
    const mode = rawMode === 'direct' || rawMode === 'browser' || rawMode === 'auto' ? rawMode : 'auto'

    const model = String(b.model || '').trim() || (kind === 'image' ? 'Seedream 4.5' : 'Seedance 2.0 Mini')
    const ratio = String(b.ratio || '').trim() || '16:9'
    const rawDuration = String(b.duration ?? '').trim()
    const duration = /^\d+$/.test(rawDuration) ? rawDuration : '4'
    const resolution = String(b.resolution || '').trim() || '720P'

    // ── 参考图（2026-11-14 新增；两种 kind 都支持）
    // 前端只传原样字符串，路径解析全在这里做：绝对路径直接用，裸文件名去 doubao_out 找。
    // 不存在必须报错而不是静默跳过 —— 否则用户会以为参考图生效了，白烧一次额度。
    const refCheck = resolveRefs(b.refs)
    if (!refCheck.ok) return sendJson(res, 200, { ok: false, message: refCheck.message })
    const refPaths = refCheck.paths
    const warnings = refCheck.warnings

    const args = [kind, '--prompt', prompt, '--model', model, '--ratio', ratio]
    let count = 1
    if (kind === 'image') {
      // --count 只对生图有效；视频传了也忽略（不报错），免得前端两处逻辑打架
      count = clampCount(b.count)
      args.push('--count', String(count))
    }
    // 每个参考图一个 --ref（doubao.mjs 支持重复；逗号分隔会破坏含逗号的路径，所以不用）
    for (const p of refPaths) args.push('--ref', p)
    if (kind === 'video') args.push('--duration', duration, '--resolution', resolution)
    args.push('--mode', mode)
    // 注意：不带 --timeout，脚本自己有默认值

    // multi：多图任务的日志上限更大，避免 [saved] 行被 poll 日志挤掉
    const started = startTask({ kind, script: 'doubao.mjs', args, prompt, multi: count > 1 })
    // 有截断警告时一并带回，前端可以直接提示用户
    if (started.ok && warnings.length) return sendJson(res, 200, { ...started, warnings })
    return sendJson(res, 200, started)
  }

  /** POST /login —— 起扫码登录任务（login.mjs 无参数 = 默认浏览器方式） */
  function handleLogin(res) {
    const r = startTask({ kind: 'login', script: 'login.mjs', args: [], prompt: '' })
    return sendJson(res, 200, r)
  }

  /**
   * POST /logout —— 退登 / 清理登录信息（2026-11-14 新增）
   *
   * `status` 是只读查询，同步跑完秒回，**不占任务槽**（用户想随时看一眼当前登录态）；
   * `purge` 会真删 cookie + Edge 配置目录，走任务槽，避免和生成/登录并行踩踏。
   *
   * 注意 `--yes` 必须带：logout.mjs 在非 TTY 环境下不加 --yes 会直接打印
   * 「非交互环境，未加 --yes 就退出」然后什么都不做，看起来像成功了。
   */
  async function handleLogout(req, res) {
    const body = await readJsonBody(req)
    if (!body.ok) return sendJson(res, 200, { ok: false, message: body.message })
    const b = body.value || {}
    const mode = String(b.mode || 'status').toLowerCase()

    if (mode === 'status') {
      const out = await runSync('doubao.mjs', ['logout', '--status'], LOGOUT_STATUS_TIMEOUT_MS)
      if (!out.ok) return sendJson(res, 200, { ok: false, message: out.message })
      // 只回纯文本，前端直接塞进 <pre>，不去解析它的排版
      return sendJson(res, 200, { ok: true, output: stripAnsi(out.stdout) })
    }

    const args = ['logout', '--yes']
    if (b.keepProfile === true) args.push('--keep-profile')
    if (b.keepCookie === true) args.push('--keep-cookie')
    const r = startTask({ kind: 'logout', script: 'doubao.mjs', args, prompt: '' })
    return sendJson(res, 200, r)
  }

  /**
   * 同步跑一个短命令（只给 /logout --status 用）。
   * 用 spawn 而不是 spawnSync：spawnSync 会卡住 Electron 主进程的事件循环。
   */
  function runSync(script, args, timeoutMs) {
    return new Promise((resolve) => {
      const node = resolveNode()
      let proc
      try {
        proc = spawn(node.command, [path.join(toolkitDir, script), ...args], {
          cwd: toolkitDir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv(),
        })
      } catch (err) {
        return resolve({ ok: false, message: `无法启动子进程：${errMsg(err)}`, stdout: '' })
      }
      let out = ''
      let errOut = ''
      let settled = false
      // timer 先声明：done() 在任何路径上都可能先于下面的 setTimeout 执行（比如 spawn 立刻报错），
      // 用 let 声明在 done 之前才不会撞 TDZ。
      let timer = null
      const done = (v) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(v)
      }
      proc.stdout?.setEncoding('utf8')
      proc.stderr?.setEncoding('utf8')
      proc.stdout?.on('data', (s) => {
        if (out.length < 256 * 1024) out += s
      })
      proc.stderr?.on('data', (s) => {
        if (errOut.length < 256 * 1024) errOut += s
      })
      timer = setTimeout(() => {
        killTree(proc)
        done({ ok: false, message: '查询超时', stdout: out })
      }, timeoutMs)
      proc.on('error', (err) => done({ ok: false, message: `无法启动子进程：${errMsg(err)}`, stdout: out }))
      proc.on('close', (code) => {
        if (code === 0) return done({ ok: true, stdout: out })
        done({ ok: false, message: tailError(out + '\n' + errOut) || `退出码 ${code}`, stdout: out })
      })
    })
  }

  /** POST /cancel —— 杀掉当前任务 */
  async function handleCancel(req, res) {
    const body = await readJsonBody(req)
    const id = body.ok && body.value && typeof body.value.id === 'string' ? body.value.id : ''
    const task = state.current
    if (!task) return sendJson(res, 200, { ok: true, cancelled: false })
    if (id && id !== task.id) return sendJson(res, 200, { ok: false, message: '任务不存在或已结束' })

    task._cancelled = true
    appendLog(task, '\n[取消] 用户取消了任务\n')
    killTree(task.proc)
    // 同样加保险：杀完等 close，等不到就自己结算。
    // 如果这一瞬间进程刚好自己退了（close 已触发 finalize），就别再挂一个空定时器。
    if (!task._finalized) {
      if (task._safety) clearTimeout(task._safety)
      task._safety = setTimeout(() => finalize(task, -1), KILL_SAFETY_MS)
    }
    return sendJson(res, 200, { ok: true, cancelled: true, id: task.id })
  }

  /** 跑 `doubao_http.mjs models --for image|video`，把 stdout 的 JSON 解析出来 */
  function runModels(forKind) {
    return new Promise((resolve) => {
      const node = resolveNode()
      let proc
      try {
        proc = spawn(node.command, [path.join(toolkitDir, 'doubao_http.mjs'), 'models', '--for', forKind], {
          cwd: toolkitDir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv(),
        })
      } catch (err) {
        return resolve({ ok: false, message: `无法启动子进程：${errMsg(err)}`, models: [], capabilities: {}, otherParams: [], raw: '' })
      }

      modelsProcs.add(proc)
      let out = ''
      let errOut = ''
      let settled = false
      let timer = null

      const done = (payload) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        modelsProcs.delete(proc)
        resolve(payload)
      }
      // raw 只留尾部，防止异常输出把响应撑爆
      const rawOf = (s) => {
        const t = stripAnsi(s).trim()
        return t.length > 20000 ? t.slice(-20000) : t
      }

      timer = setTimeout(() => {
        killTree(proc)
        done({ ok: false, message: '获取模型列表超时', models: [], capabilities: {}, otherParams: [], raw: rawOf(out) })
      }, MODELS_TIMEOUT_MS)

      proc.stdout?.setEncoding('utf8')
      proc.stderr?.setEncoding('utf8')
      proc.stdout?.on('data', (s) => {
        if (out.length < 4 * 1024 * 1024) out += s
      })
      proc.stderr?.on('data', (s) => {
        if (errOut.length < 1024 * 1024) errOut += s
      })
      proc.on('error', (err) =>
        done({ ok: false, message: `无法启动子进程：${errMsg(err)}`, models: [], capabilities: {}, otherParams: [], raw: rawOf(out) }),
      )
      proc.on('close', (code) => {
        const raw = rawOf(out)
        const parsed = parseJsonLoose(raw)
        const models = parsed && Array.isArray(parsed.models) ? parsed.models : []
        // capabilities：每个模型自己的 ratios / durations / range。前端拿它来生成比例和时长选项，
        // 这样豆包新增会员档（例如 Seedance 2.5 支持 4-30s）时前端不用跟着改代码。
        const capabilities =
          parsed && parsed.capabilities && typeof parsed.capabilities === 'object' && !Array.isArray(parsed.capabilities)
            ? parsed.capabilities
            : {}
        // otherParams：脚本目前只把比例/风格/运镜「报出来」，还没接成 --style / --movement 参数，
        // 所以原样透传给前端备用，但不参与生成。
        const otherParams = parsed && Array.isArray(parsed.otherParams) ? parsed.otherParams : []
        if (code === 0) return done({ ok: true, models, capabilities, otherParams, raw })
        // 非 0：把脚本最后几行错误回给前端，好判断是 cookie 失效还是网络问题
        const message = tailError(out + '\n' + errOut) || `获取模型列表失败（退出码 ${code}）`
        return done({ ok: false, message, models: [], capabilities: {}, otherParams: [], raw })
      })
    })
  }

  /** POST /models */
  async function handleModels(req, res) {
    const body = await readJsonBody(req)
    if (!body.ok) return sendJson(res, 200, { ok: false, message: body.message })
    const b = body.value || {}
    const forKind = String(b.for || b.kind || 'image').toLowerCase() === 'video' ? 'video' : 'image'
    const result = await runModels(forKind)
    return sendJson(res, 200, result)
  }

  /**
   * POST /reveal —— 打开产物目录。
   *
   * 2026-11-14 修：以前直接 spawn explorer.exe 就返回 ok:true，实际有两个问题：
   *   1) `spawn` 的 error 是异步事件，函数早就回成功了 —— 真失败也会显示「已打开」；
   *   2) Windows 的「前台锁定」会挡住后台进程抢焦点：窗口确实开出来了，但压在
   *      DSH 窗口后面，用户以为没反应；而且每点一次就多开一个重复窗口。
   *
   * 现在的做法：
   *   - 已有该目录的窗口 → 复用并强行前置（AttachThreadInput 绕开前台锁定，
   *     比 SetForegroundWindow 单打独斗可靠；不用 AppActivate 是因为它按标题匹配，
   *     同名的多个窗口会打错）；
   *   - 没有就打开，再前置；
   *   - 全都靠 PowerShell 做，并且**等结果**，真失败会返回 ok:false + 原因。
   */
  function handleReveal(res) {
    try {
      mkdirSync(outDir, { recursive: true })
    } catch (err) {
      return sendJson(res, 200, { ok: false, message: `产物目录不可用：${errMsg(err)}` })
    }

    // Windows：优先「复用已有窗口 + 前置」。非 Windows 保持原来的系统命令。
    if (process.platform !== 'win32') {
      let cmd = 'open'
      if (process.platform !== 'win32' && process.platform !== 'darwin') cmd = 'xdg-open'
      try {
        const p = spawn(cmd, [outDir], { detached: true, stdio: 'ignore' })
        p.on('error', (err) => console.warn('[dsh-doubao] 打开产物目录失败:', errMsg(err)))
        p.unref?.()
        return sendJson(res, 200, { ok: true, dir: outDir })
      } catch (err) {
        return sendJson(res, 200, { ok: false, message: `打开产物目录失败：${errMsg(err)}` })
      }
    }

    return revealWindows(res)
  }

  /**
   * Windows 专用：找到/打开目录窗口并前置。
   *
   * 为什么必须 AttachThreadInput：Windows 只允许「当前前台线程」把焦点交给别人，
   * 后台进程直接调 SetForegroundWindow 会被静默拒绝（实测返回 False）。把自己
   * 的线程输入挂到前台线程上再调，就拿到了一次合法机会。
   *
   * 路径用单引号包进 PowerShell 字面量，内部的 ' 按 PowerShell 规则翻倍转义。
   */
  function revealWindows(res) {
    const pathLiteral = String(outDir).replace(/'/g, "''")
    const script = `
$ErrorActionPreference = 'Stop'
$target = '${pathLiteral}'
$shell = New-Object -ComObject Shell.Application

# 1) 先找已经打开的该目录窗口，避免重复开窗
$hits = @()
foreach ($w in $shell.Windows()) {
  try {
    if ($w.Document.Folder.Self.Path -eq $target) { $hits += $w.HWND }
  } catch {}
}

$reused = $hits.Count -gt 0
if (-not $reused) {
  $shell.Explore($target) | Out-Null
  Start-Sleep -Milliseconds 700
  foreach ($w in $shell.Windows()) {
    try {
      if ($w.Document.Folder.Self.Path -eq $target) { $hits += $w.HWND }
    } catch {}
  }
}

if ($hits.Count -eq 0) { Write-Output 'NO_WINDOW'; exit 0 }

# 2) 前置：挂到前台线程上再抢，绕开前台锁定
Add-Type -Namespace DshReveal -Name Win -MemberDefinition '
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'
$h = [IntPtr]$hits[0]
$fg = [DshReveal.Win]::GetForegroundWindow()
$tidFg = [DshReveal.Win]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$tidMe = [DshReveal.Win]::GetCurrentThreadId()
$attached = $false
try {
  $attached = [DshReveal.Win]::AttachThreadInput($tidMe, $tidFg, $true)
  [DshReveal.Win]::ShowWindow($h, 9) | Out-Null
  [DshReveal.Win]::BringWindowToTop($h) | Out-Null
  $ok = [DshReveal.Win]::SetForegroundWindow($h)
} finally {
  if ($attached) { [DshReveal.Win]::AttachThreadInput($tidMe, $tidFg, $false) | Out-Null }
}
Write-Output ('DONE reused=' + $reused + ' activated=' + $ok)
`
    // 用 powershell 而不是 pwsh：Windows PowerShell 一定能用 COM + Add-Type，
    // 而且这段脚本很短，启动开销可以接受。
    let proc
    try {
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      return sendJson(res, 200, { ok: false, message: `打开产物目录失败：${errMsg(err)}` })
    }

    let out = ''
    let errOut = ''
    let settled = false
    let timer = null
    const done = (payload) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      sendJson(res, 200, payload)
    }
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', (s) => {
      out += s
    })
    proc.stderr?.on('data', (s) => {
      errOut += s
    })
    proc.on('error', (err) => done({ ok: false, message: `打开产物目录失败：${errMsg(err)}` }))
    proc.on('close', (code) => {
      const text = String(out).trim()
      if (code !== 0 || /NO_WINDOW/.test(text)) {
        const why = tailError(errOut || text) || `退出码 ${code}`
        return done({ ok: false, message: `打开产物目录失败：${why}` })
      }
      const reused = /reused=True/.test(text)
      const activated = /activated=True/.test(text)
      return done({ ok: true, dir: outDir, reused, activated })
    })
    // 3 秒内没结果就按成功返回（窗口通常已经开了，别让 UI 一直转）
    timer = setTimeout(() => done({ ok: true, dir: outDir, reused: false, activated: false }), 3000)
  }

  /** 插件卸载：杀子进程、清定时器，别留孤儿 */
  function disposeAll() {
    const task = state.current
    if (task) {
      task._cancelled = true
      if (task._timer) clearTimeout(task._timer)
      if (task._safety) clearTimeout(task._safety)
      task._timer = null
      task._safety = null
      killTree(task.proc)
      finalize(task, -1)
    }
    for (const proc of modelsProcs) killTree(proc)
    modelsProcs.clear()
  }

  // ── 总入口：安全闸 → 分发 ───────────────────────────────────────────────
  async function handle(req, res) {
    // 第一道：只允许本机访问（这个接口能用你的会员额度，绝不能暴露到局域网）
    if (!isLoopback(req.socket && req.socket.remoteAddress)) {
      return sendJson(res, 403, { ok: false, message: '仅允许本机访问' })
    }
    const method = String(req.method || 'GET').toUpperCase()

    // 第二道：写方法带 Origin 的必须是本机来源，挡掉跨站请求
    if (method !== 'GET' && method !== 'HEAD' && !isAllowedOrigin(req)) {
      return sendJson(res, 403, { ok: false, message: '来源不被允许' })
    }

    let url
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      return sendJson(res, 200, { ok: false, message: '请求地址不合法' })
    }

    const pathname = url.pathname
    if (pathname !== PREFIX && !pathname.startsWith(PREFIX + '/')) {
      return sendJson(res, 404, { ok: false, message: '未知接口' })
    }
    let sub = pathname.slice(PREFIX.length)
    if (!sub) sub = '/'
    if (sub.length > 1 && sub.endsWith('/')) sub = sub.slice(0, -1)

    if (sub === '/state') {
      if (method !== 'GET') return sendJson(res, 200, { ok: false, message: '不支持的方法' })
      return handleState(res)
    }
    if (sub === '/file') {
      if (method !== 'GET') return sendJson(res, 200, { ok: false, message: '不支持的方法' })
      return handleFile(res, url)
    }
    if (sub === '/generate') {
      if (method !== 'POST') return sendJson(res, 200, { ok: false, message: '不支持的方法' })
      return handleGenerate(req, res)
    }
    if (sub === '/login') {
      if (method !== 'POST') return sendJson(res, 200, { ok: false, message: '不支持的方法' })
      return handleLogin(res)
    }
    if (sub === '/cancel') {
      if (method !== 'POST') return sendJson(res, 200, { ok: false, message: '不支持的方法' })
      return handleCancel(req, res)
    }
    if (sub === '/logout') {
      if (method !== 'POST') return sendJson(res, 200, { ok: false, message: '不支持的方法' })
      return handleLogout(req, res)
    }
    if (sub === '/models') {
      if (method !== 'POST') return sendJson(res, 200, { ok: false, message: '不支持的方法' })
      return handleModels(req, res)
    }
    if (sub === '/reveal') {
      if (method !== 'POST') return sendJson(res, 200, { ok: false, message: '不支持的方法' })
      return handleReveal(res)
    }
    return sendJson(res, 404, { ok: false, message: '未知接口' })
  }

  /** 最外层兜底：任何漏出来的异常都变成 JSON，绝不冒到 DSH 进程 */
  function handler(req, res) {
    Promise.resolve()
      .then(() => handle(req, res))
      .catch((err) => {
        console.warn('[dsh-doubao] 处理请求失败:', errMsg(err))
        sendJson(res, 200, { ok: false, message: `内部错误：${errMsg(err)}` })
      })
  }

  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    console.warn('[dsh-doubao] 未拿到 webServer 服务，接口未注册')
    return
  }

  // 一条前缀路由，卸载时自动摘除，同时把还在跑的子进程一起清掉
  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (err) {
        console.warn('[dsh-doubao] 摘除路由失败:', errMsg(err))
      }
      disposeAll()
    }
  }, 'dsh-doubao: 路由 /doubao/api')
}
