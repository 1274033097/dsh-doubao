/* eslint-disable */
/**
 * @local/dsh-doubao —— Client 半边
 *
 * DSH「动态 Client 模块」格式：最外层 window.__ModuleLoader__.load(...)，
 * factory 里只能 require('react')（禁止 require 任何 deepseek 内部包，会崩）。
 * 纯 JS，无 JSX，无构建步骤，全部用 React.createElement（别名 h）手写。
 *
 * 数据来源：Host 半边 index.js 暴露的同源 HTTP 接口 /doubao/api/*（见 doubao-plugin-contract.md 第 1 节）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-doubao',
  factory: (require) => {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const PANEL_ID = 'doubao'
    const API = '/doubao/api'

    // 轮询节奏（契约 2.3）：有任务在跑 1.5s，空闲 4s
    const POLL_RUNNING_MS = 1500
    const POLL_IDLE_MS = 4000
    // 登录二维码刷新节奏（契约 2.2 第 5 条）
    const QR_REFRESH_MS = 3000
    // 产物网格最多渲染多少个（契约 2.2 第 6 条）
    const MAX_OUTPUTS = 24
    // /state.limits 的兜底值（契约 v2 §2.5：读不到就用它，别把 limits 变成结构性依赖）
    const DEFAULT_LIMITS = { maxGenImages: 8, maxRefImages: 10 }

    // POST /models 拿不到时用的内置兜底目录（含会员档，接口挂了也能选到会员模型）。
    // 注意：name 才是发给 Host 的值；key 只用于查 capabilities（视频的 key 和显示名不同）。
    const FALLBACK_MODELS = {
      image: [
        { name: 'Seedream 5.0 Pro', key: 'Seedream 5.0 Pro', desc: '专业出图', member: true, source: 'live' },
        {
          name: 'Seedream 5.0 Lite',
          key: 'Seedream 5.0 Lite',
          desc: '智能理解升级，画面细节丰富',
          member: false,
          source: 'live',
        },
        { name: 'Seedream 4.5', key: 'Seedream 4.5', desc: '多图精准参考，人像更加自然', member: false, source: 'live' },
        { name: 'Seedream 4.0', key: 'Seedream 4.0', desc: '精准指令编辑，高度特征保持', member: false, source: 'live' },
        { name: 'Seedream 5.5', key: 'Seedream 5.5', desc: '旗舰生图', member: false, source: 'builtin' },
        { name: 'Seedream 5.0 Flash', key: 'Seedream 5.0 Flash', desc: '专业快速', member: false, source: 'builtin' },
      ],
      video: [
        { name: 'Seedance 2.0', key: 'seedance_v2.0_std', desc: '', member: false, source: 'live' },
        { name: 'Seedance 2.0 Fast', key: 'seedance_v2.0', desc: '', member: false, source: 'live' },
        { name: 'Seedance 2.0 Mini', key: 'seedance_v2.0_mini', desc: '', member: false, source: 'live' },
        { name: 'Seedance 2.5', key: 'seedance_v2.5', desc: '旗舰视频标杆 · 5 倍消耗', member: true, source: 'builtin' },
        {
          name: 'Seedance 2.5 Flash',
          key: 'seedance_v2.5_flash',
          desc: '旗舰高性价比 · 2 倍消耗',
          member: true,
          source: 'builtin',
        },
      ],
    }
    // 模型没有 capabilities 条目时退回的默认比例（Host 实测值）
    const RATIOS = {
      image: ['auto', '9:16', '2:3', '3:4', '1:1', '4:3', '3:2', '16:9'],
      video: ['auto', '3:4', '4:3', '9:16', '16:9', '1:1'],
    }
    // 时长区间：会员档没有 capabilities 条目，按官方文档支持 4-30s；基础档实测 4-15s
    const MEMBER_RANGE = { min: 4, max: 30, step: 1 }
    const BASE_RANGE = { min: 4, max: 15, step: 1 }
    const RESOLUTIONS = ['720P', '1080P']
    const MODES = [
      { value: 'auto', label: '自动降级' },
      { value: 'direct', label: '只走直连' },
      { value: 'browser', label: '走浏览器' },
    ]

    // 默认值跟 Host 侧一致：图 Seedream 4.5、视频 Seedance 2.0 Mini、比例 16:9、时长 5 秒
    const INITIAL_FORM = {
      image: { prompt: '', model: 'Seedream 4.5', ratio: '16:9', count: '1', duration: '5', resolution: '720P', mode: 'auto' },
      video: { prompt: '', model: 'Seedance 2.0 Mini', ratio: '16:9', duration: '5', resolution: '720P', mode: 'auto' },
    }

    // ---------------------------------------------------------------- 工具函数

    /** GET JSON：统一 cache: 'no-store'，非 2xx / 非对象一律 throw，交给调用方兜住 */
    async function apiGet(path) {
      const res = await fetch(API + path, {
        method: 'GET',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      if (!data || typeof data !== 'object') throw new Error('响应不是 JSON 对象')
      return data
    }

    /** POST JSON：契约 2.3 统一 headers + JSON.stringify */
    async function apiPost(path, body) {
      const res = await fetch(API + path, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      if (!data || typeof data !== 'object') throw new Error('响应不是 JSON 对象')
      return data
    }

    /** 把任意异常翻成一句人话，绝不把 undefined 拼进界面 */
    function errText(err) {
      if (err === undefined || err === null) return '未知错误'
      if (typeof err === 'string') return err
      const name = err && err.name
      const message = err && err.message
      if (name === 'TypeError') return '网络请求失败（Host 可能没启动）'
      if (message) return String(message)
      return String(err)
    }

    function clip(text, max) {
      const s = text === undefined || text === null ? '' : String(text)
      const limit = max || 90
      return s.length > limit ? s.slice(0, limit - 1) + '…' : s
    }

    function formatBytes(n) {
      const v = Number(n)
      if (!Number.isFinite(v) || v <= 0) return '—'
      if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB'
      if (v >= 1024) return Math.round(v / 1024) + ' KB'
      return v + ' B'
    }

    function formatMb(mb, bytes) {
      const v = Number(mb)
      if (Number.isFinite(v) && v > 0) return v.toFixed(1) + ' MB'
      return formatBytes(bytes)
    }

    /** 只要带小数的 MB 文案，没有就返回空串（多图状态行要拼接，不能塞「—」） */
    function formatMbValue(mb) {
      const v = Number(mb)
      if (!Number.isFinite(v) || v <= 0) return ''
      return v.toFixed(1) + ' MB'
    }

    /**
     * 本次产物文件列表。
     * 新结构是 { files:[{file,path,bytes,mb}], count, elapsedSec }；旧结构是单个 { file, mb }。
     * 两种都认，取不到就给空数组，绝不让调用方对 undefined 取属性。
     */
    function resultFiles(result) {
      if (!result || typeof result !== 'object') return []
      if (Array.isArray(result.files)) return result.files.filter((f) => f && typeof f === 'object')
      if (typeof result.file === 'string' && result.file) return [result]
      return []
    }

    /** 本次产物总大小（MB）：先看旧的 result.mb，再累加 files[].mb，最后用 bytes 兜底 */
    function resultTotalMb(result) {
      const files = resultFiles(result)
      const legacyMb = Number(result && result.mb)
      if (Number.isFinite(legacyMb) && legacyMb > 0) return legacyMb
      let sumMb = 0
      let sawMb = false
      let sumBytes = 0
      for (let i = 0; i < files.length; i += 1) {
        const mb = Number(files[i].mb)
        if (Number.isFinite(mb) && mb > 0) {
          sumMb += mb
          sawMb = true
        }
        const bytes = Number(files[i].bytes)
        if (Number.isFinite(bytes) && bytes > 0) sumBytes += bytes
      }
      if (sawMb) return sumMb
      if (sumBytes > 0) return sumBytes / 1048576
      return 0
    }

    /** 本次产物张数：优先 result.count，其次 files 长度 */
    function resultCount(result) {
      const c = Number(result && result.count)
      if (Number.isFinite(c) && c > 0) return c
      return resultFiles(result).length
    }

    /** 规整 /state.limits，字段缺失/类型错就退回兜底值 */
    function normalizeLimits(raw) {
      const l = raw && typeof raw === 'object' ? raw : {}
      const maxGen = Number(l.maxGenImages)
      const maxRef = Number(l.maxRefImages)
      const gen = Number.isFinite(maxGen) && maxGen >= 1 ? Math.min(20, Math.round(maxGen)) : DEFAULT_LIMITS.maxGenImages
      const ref = Number.isFinite(maxRef) && maxRef >= 1 ? Math.min(50, Math.round(maxRef)) : DEFAULT_LIMITS.maxRefImages
      return { maxGenImages: gen, maxRefImages: ref }
    }

    /** 数量夹到 [1, max] */
    function clampCount(value, max) {
      const m = Number.isFinite(Number(max)) && Number(max) >= 1 ? Math.round(Number(max)) : DEFAULT_LIMITS.maxGenImages
      let n = Number(value)
      if (!Number.isFinite(n)) n = 1
      n = Math.round(n)
      if (n < 1) n = 1
      if (n > m) n = m
      return n
    }

    /** 数量下拉的候选：[{value:'1',label:'1 张'} …] */
    function countOptions(max) {
      const m = Number.isFinite(Number(max)) && Number(max) >= 1 ? Math.round(Number(max)) : DEFAULT_LIMITS.maxGenImages
      const out = []
      for (let i = 1; i <= m; i += 1) out.push({ value: String(i), label: i + ' 张' })
      return out
    }

    /** 参考图去重（Windows 路径大小写不敏感），保持首次出现的顺序 */
    function dedupeRefs(list) {
      const out = []
      const seen = Object.create(null)
      const items = Array.isArray(list) ? list : []
      for (let i = 0; i < items.length; i += 1) {
        const raw = items[i]
        if (typeof raw !== 'string') continue
        const item = raw.trim()
        if (!item) continue
        const key = item.toLowerCase()
        if (seen[key]) continue
        seen[key] = 1
        out.push(item)
      }
      return out
    }

    function formatTime(ms) {
      const v = Number(ms)
      if (!Number.isFinite(v) || v <= 0) return '—'
      try {
        return new Date(v).toLocaleString('zh-CN', { hour12: false })
      } catch (e) {
        return '—'
      }
    }

    /** cookie 年龄（小时，1 位小数）→「2.5 小时前」这种口语说法 */
    function formatAge(hours) {
      const n = Number(hours)
      if (!Number.isFinite(n) || n < 0) return ''
      if (n < 0.05) return '刚刚'
      if (n < 1) return Math.max(1, Math.round(n * 60)).toLocaleString('zh-CN') + ' 分钟前'
      if (n < 48) return (Math.round(n * 10) / 10).toLocaleString('zh-CN') + ' 小时前'
      return (Math.round((n / 24) * 10) / 10).toLocaleString('zh-CN') + ' 天前'
    }

    function shortenPath(p) {
      const s = p === undefined || p === null ? '' : String(p)
      if (s.length <= 64) return s
      return s.slice(0, 26) + '…' + s.slice(-30)
    }

    function baseName(p) {
      const s = p === undefined || p === null ? '' : String(p)
      const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
      return i >= 0 ? s.slice(i + 1) : s
    }

    function kindLabel(kind) {
      if (kind === 'image') return '生图'
      if (kind === 'video') return '生视频'
      if (kind === 'login') return '扫码登录'
      if (kind === 'logout') return '退出登录'
      return '任务'
    }

    /** 规整一个模型对象，字段缺失 / 类型不对也不会炸 */
    function normalizeModel(raw) {
      const m = raw && typeof raw === 'object' ? raw : {}
      const name = typeof m.name === 'string' ? m.name : ''
      if (!name) return null
      return {
        name: name,
        key: typeof m.key === 'string' && m.key ? m.key : name,
        desc: typeof m.desc === 'string' ? m.desc : '',
        member: m.member === true,
        source: typeof m.source === 'string' ? m.source : 'unknown',
      }
    }

    /** 当前标签可用的模型列表：优先 Host 返回值，其次内置兜底目录 */
    function modelsFor(cached, kind) {
      const list = Array.isArray(cached) ? cached.map(normalizeModel).filter(Boolean) : []
      if (list.length > 0) return list
      return FALLBACK_MODELS[kind] || FALLBACK_MODELS.image
    }

    function findModel(list, name) {
      const items = Array.isArray(list) ? list : []
      for (let i = 0; i < items.length; i += 1) {
        if (items[i] && items[i].name === name) return items[i]
      }
      return null
    }

    /** 模型下拉文案：会员档带星标，避免误点烧额度 */
    function modelLabel(model) {
      if (!model) return ''
      return model.member ? '★ ' + model.name + '（会员）' : model.name
    }

    /** capabilities 是按内部 key 索引的（视频 key 和显示名不同），别拿 name 去查 */
    function capsFor(capsByKind, model) {
      const table = capsByKind && typeof capsByKind === 'object' ? capsByKind : {}
      if (!model || !model.key) return null
      const cap = table[model.key]
      return cap && typeof cap === 'object' ? cap : null
    }

    /** 比例候选：capabilities.ratios 优先，没有就退回该 kind 的默认 8/6 项 */
    function ratiosFor(cap, kind) {
      const list = cap && Array.isArray(cap.ratios) ? cap.ratios.filter((x) => typeof x === 'string' && x) : []
      if (list.length > 0) return list
      return RATIOS[kind] || RATIOS.image
    }

    /** 时长区间：capabilities.range 优先；没有条目时会员档 4-30、基础档 4-15 */
    function rangeFor(cap, model) {
      const r = cap && cap.range
      if (r && typeof r === 'object') {
        const lower = Number(r.lower)
        const upper = Number(r.upper)
        const step = Number(r.step)
        if (Number.isFinite(lower) && Number.isFinite(upper) && upper >= lower) {
          return { min: lower, max: upper, step: Number.isFinite(step) && step > 0 ? step : 1 }
        }
      }
      return model && model.member ? MEMBER_RANGE : BASE_RANGE
    }

    /** 把时长夹进区间（并尽量对齐 step），返回数字 */
    function clampDuration(value, range) {
      const r = range || BASE_RANGE
      const min = Number.isFinite(Number(r.min)) ? Number(r.min) : BASE_RANGE.min
      const max = Number.isFinite(Number(r.max)) ? Number(r.max) : BASE_RANGE.max
      const step = Number.isFinite(Number(r.step)) && Number(r.step) > 0 ? Number(r.step) : 1
      let n = Number(value)
      if (!Number.isFinite(n)) n = min
      if (n < min) n = min
      if (n > max) n = max
      if (step > 1) {
        n = min + Math.round((n - min) / step) * step
        if (n > max) n = max
      } else {
        n = Math.round(n)
      }
      return n
    }

    /** 运行日志卡片右上角的状态行（契约 2.2 第 4 条 / v2 §2.4 多图与退登） */
    function describeStatus(current, running) {
      if (!current) return { text: '空闲', tone: 'is-idle' }
      const status = current.status
      const kind = current.kind
      if (status === 'running') {
        const startedAt = Number(current.startedAt)
        const base = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now()
        const secs = Math.max(0, Math.round((Date.now() - base) / 1000))
        const label = kind === 'logout' ? '正在退登… ' : '运行中… '
        return { text: label + secs + 's', tone: 'is-running' }
      }
      if (status === 'done') {
        const result = current.result || null
        // 退登任务：Host 给 { loggedOut: true }
        if (kind === 'logout' || (result && result.loggedOut === true)) {
          return { text: '已退登', tone: 'is-ok' }
        }
        if (result && result.loggedIn === true) return { text: '完成 · 已登录', tone: 'is-ok' }
        // 新 result 结构 { files:[...], count, elapsedSec }：多张时带上张数
        const n = resultCount(result)
        const size = formatMbValue(resultTotalMb(result))
        const parts = ['完成']
        if (n > 1) parts.push(n.toLocaleString('zh-CN') + ' 张')
        if (size) parts.push(size)
        return { text: parts.join(' · '), tone: 'is-ok' }
      }
      if (status === 'cancelled') return { text: '已取消', tone: 'is-warn' }
      if (status === 'failed') {
        const prefix = kind === 'logout' ? '退登失败：' : '失败：'
        return { text: prefix + clip(current.error || '未知原因', 80), tone: 'is-error' }
      }
      return { text: String(status || '未知状态'), tone: 'is-idle' }
    }

    // ---------------------------------------------------------------- 图标

    /** 侧栏图标：{ size, active }，currentColor，选中时更实 */
    function DoubaoIcon(props) {
      const size = Number(props && props.size) || 16
      const active = !!(props && props.active)
      const strokeWidth = active ? 1.9 : 1.5
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          style: { display: 'block', opacity: active ? 1 : 0.65 },
        },
        // 画框
        h('rect', {
          x: 2.6,
          y: 4.6,
          width: 18.8,
          height: 14.8,
          rx: 4,
          stroke: 'currentColor',
          strokeWidth: strokeWidth,
        }),
        // 山峦（生图）
        h('path', {
          d: 'M5.4 16.6 L9.4 11.6 L12.2 14.6 L14.7 11.9 L18.7 16.6',
          stroke: 'currentColor',
          strokeWidth: strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          fill: 'none',
        }),
        // 星点
        h('circle', { cx: 16.5, cy: 8.7, r: 1.2, fill: 'currentColor', opacity: active ? 1 : 0.85 })
      )
    }

    // ---------------------------------------------------------------- 小片段

    function pill(tone, text, title) {
      return h(
        'span',
        { className: 'db-pill ' + tone, title: title || undefined },
        h('span', { className: 'db-dot' }),
        h('span', { className: 'db-pill-text' }, text)
      )
    }

    function loginPill(login) {
      const info = login || {}
      const hasCookies = info.hasCookies === true
      const ageText = formatAge(info.cookieAgeHours)
      const titleParts = []
      if (hasCookies) {
        titleParts.push('doubao_cookies.txt 存在且含 sessionid')
        if (ageText) titleParts.push('约 ' + ageText + '更新')
      } else {
        titleParts.push('还没有可用 cookie，点下方「扫码登录」')
      }
      if (info.hasProfile === true) titleParts.push('浏览器 profile 已就绪')
      if (info.hasIdentity === true) titleParts.push('identity 已就绪')
      const text = hasCookies ? '已登录' + (ageText ? ' · ' + ageText : '') : '未登录'
      return pill(hasCookies ? 'is-ok' : 'is-warn', text, titleParts.join('；'))
    }

    function jobPill(current, running) {
      if (running) {
        return pill('is-running', '运行中 · ' + kindLabel(current && current.kind), '有任务在跑，同一时刻只能跑一个')
      }
      return pill('is-idle', '空闲', '当前没有任务在跑')
    }

    function nodePill(nodePath) {
      const text = nodePath ? 'node ' + baseName(nodePath) : 'node 未检测到'
      return pill(nodePath ? 'is-idle' : 'is-warn', text, nodePath || 'Host 还没解析出 node 路径')
    }

    function field(labelText, control) {
      return h(
        'label',
        { className: 'db-field' },
        h('span', { className: 'db-label' }, labelText),
        control
      )
    }

    function selectBox(value, options, onChange, extra) {
      const props = Object.assign(
        {
          className: 'db-select',
          value: value,
          onChange: (e) => onChange(e.target.value),
        },
        extra || {}
      )
      return h(
        'select',
        props,
        options.map((opt) =>
          typeof opt === 'string'
            ? h('option', { key: opt, value: opt }, opt)
            : h('option', { key: opt.value, value: opt.value }, opt.label)
        )
      )
    }

    // ---------------------------------------------------------------- 主页面

    function DoubaoPage() {
      const [st, setSt] = useState(null)
      const [toast, setToast] = useState('')
      const [toastTone, setToastTone] = useState('error')
      const [tab, setTab] = useState('image')
      const [imageForm, setImageForm] = useState(INITIAL_FORM.image)
      const [videoForm, setVideoForm] = useState(INITIAL_FORM.video)
      const [models, setModels] = useState({ image: [], video: [] }) // 每项 { name, key, desc, member, source }
      const [caps, setCaps] = useState({ image: {}, video: {} }) // capabilities[key] 表，按 kind 分开缓存
      const [modelsBusy, setModelsBusy] = useState(false)
      const [submitting, setSubmitting] = useState(false)
      const [qrTick, setQrTick] = useState(() => Date.now())
      const [qrBroken, setQrBroken] = useState(false)
      // 参考图：产物里点选的名字（有序，角标就是这里的下标+1） + 手填路径原文
      const [refNames, setRefNames] = useState([])
      const [refText, setRefText] = useState('')
      // 退登二次确认条（面板内，不用 window.confirm）
      const [logoutAsk, setLogoutAsk] = useState(false)

      const logRef = useRef(null)
      const toastTimerRef = useRef(null)
      const pollFailRef = useRef(false)
      const aliveRef = useRef(true)

      // 卸载标记：所有异步回调落地前都看一眼，避免卸载后 setState
      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
        }
      }, [])

      /** 轻提示（3 秒淡出由 CSS 动画 + 定时器共同完成） */
      const showToast = useCallback((message, tone) => {
        const text = message === undefined || message === null ? '' : String(message)
        if (!text) return
        setToast(text)
        setToastTone(tone === 'ok' ? 'ok' : 'error')
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
        toastTimerRef.current = setTimeout(() => {
          toastTimerRef.current = null
          if (aliveRef.current) setToast('')
        }, 3000)
      }, [])

      // 卸载时清掉 toast 定时器
      useEffect(() => {
        return () => {
          if (toastTimerRef.current) {
            clearTimeout(toastTimerRef.current)
            toastTimerRef.current = null
          }
        }
      }, [])

      // ---- 派生值（全部兜底，任何字段缺失都不会炸） ----
      const login = (st && st.login) || {}
      const current = (st && st.current) || null
      const outputs = st && Array.isArray(st.outputs) ? st.outputs : []
      const toolkitDir = st && typeof st.toolkitDir === 'string' ? st.toolkitDir : ''
      const nodePath = st && typeof st.nodePath === 'string' ? st.nodePath : ''
      const running = !!(current && current.status === 'running')
      const busy = running || !!(st && st.busy === true)
      const loginRunning = !!(running && current && current.kind === 'login')
      const logText = current && typeof current.log === 'string' ? current.log : ''

      const form = tab === 'image' ? imageForm : videoForm
      const setForm = tab === 'image' ? setImageForm : setVideoForm

      // ---- 模型能力派生值 ----
      // 当前标签的模型目录 → 当前选中的模型对象 → 它在 capabilities 里的条目（按 key 查）。
      // 会员档 builtin 模型没有 capabilities 条目，比例/区间自动退回默认值。
      const modelOptions = modelsFor(models[tab], tab)
      const currentModel = findModel(modelOptions, form.model) || modelOptions[0] || null
      const currentCap = capsFor(caps[tab], currentModel)
      const ratioOptions = ratiosFor(currentCap, tab)
      const durationRange = rangeFor(currentCap, currentModel)

      // ---- limits / 参考图派生值（契约 v2 §2.2、§2.5） ----
      const limits = normalizeLimits(st && st.limits)
      // 只有图片产物能当参考图
      const imageOutputs = outputs.filter((o) => o && o.kind === 'image' && typeof o.name === 'string' && o.name)
      // 手填路径：每行一个，空行忽略
      const manualRefs = String(refText || '')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      // 合并顺序：先产物选中（传 name），再手填（原样）；去重后按上限截断
      const allRefs = dedupeRefs(refNames.concat(manualRefs))
      const refs = allRefs.slice(0, limits.maxRefImages)
      const refsOverflow = allRefs.length - refs.length

      /** 点缩略图切换选中/取消，选中顺序就是角标顺序 */
      const toggleRef = useCallback(
        (name) => {
          const n = typeof name === 'string' ? name : ''
          if (!n) return
          if (refNames.indexOf(n) >= 0) {
            setRefNames(refNames.filter((x) => x !== n))
            return
          }
          if (refNames.length >= limits.maxRefImages) {
            showToast('参考图最多 ' + limits.maxRefImages + ' 张')
            return
          }
          setRefNames(refNames.concat([n]))
        },
        [refNames, limits.maxRefImages, showToast]
      )

      const patch = useCallback(
        (key, value) => {
          setForm((prev) => Object.assign({}, prev, { [key]: value }))
        },
        [setForm]
      )

      // 切模型 / 切标签后纠正选项：比例不在新模型能力里就重置成 16:9（没有就取第一项），
      // 视频时长超出新区间就 clamp。返回 prev 时 React 会 bail out，不会造成循环。
      useEffect(() => {
        const ratios = ratioOptions
        const range = durationRange
        setForm((prev) => {
          const next = {}
          if (ratios.indexOf(prev.ratio) < 0) {
            next.ratio = ratios.indexOf('16:9') >= 0 ? '16:9' : ratios[0]
          }
          if (tab === 'video') {
            const clamped = String(clampDuration(prev.duration, range))
            if (clamped !== String(prev.duration)) next.duration = clamped
          }
          return Object.keys(next).length > 0 ? Object.assign({}, prev, next) : prev
        })
        // ratioOptions / durationRange 都是每次渲染新算的派生值，用它们的内容做依赖
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tab, currentModel ? currentModel.name : '', ratioOptions.join('|'), durationRange.min, durationRange.max, durationRange.step, setForm])

      // ---- 轮询 /state ----
      // 策略：挂载即拉一次；此后按「有没有 running 任务」选 1.5s / 4s。
      // running 一旦翻转，effect 重建 → 立刻补拉一次（避免从 4s 节奏里等下一次），
      // 属于有意为之的即时刷新；清理函数里 clearInterval + alive 标记双保险。
      useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const next = await apiGet('/state')
            if (!alive) return
            if (!next || next.ok !== true) {
              throw new Error((next && next.message) || '状态接口返回 ok:false')
            }
            pollFailRef.current = false
            setSt(next)
          } catch (err) {
            if (!alive) return
            // 轮询失败只在「由好变坏」时提示一次，否则每 1.5s 会刷一条 toast
            if (!pollFailRef.current) {
              pollFailRef.current = true
              showToast('状态刷新失败：' + errText(err))
            }
          }
        }
        tick()
        const timer = setInterval(tick, running ? POLL_RUNNING_MS : POLL_IDLE_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [running, showToast])

      /** 动作完成后立刻补一次状态，不必等下一轮轮询 */
      const refreshOnce = useCallback(async () => {
        try {
          const next = await apiGet('/state')
          if (!aliveRef.current) return
          if (next && next.ok === true) setSt(next)
        } catch (err) {
          // 动作后的补刷失败不打扰用户，交给轮询继续重试
        }
      }, [])

      // 退登：面板内二次确认 → 起 logout 任务（Host 会带 --yes）。
      // 必须声明在 refreshOnce 之后：useCallback 的依赖数组在渲染期就被求值，
      // 放在前面会撞 TDZ（Cannot access 'refreshOnce' before initialization）。
      const doLogout = useCallback(async () => {
        try {
          const res = await apiPost('/logout', { mode: 'purge' })
          if (!aliveRef.current) return
          if (res && res.ok === false) {
            showToast(res.message || '退登失败')
            return
          }
          setLogoutAsk(false)
          showToast('已开始退登，日志在下面滚动', 'ok')
          await refreshOnce()
        } catch (err) {
          if (aliveRef.current) showToast('退登失败：' + errText(err))
        }
      }, [showToast, refreshOnce])

      // ---- 模型列表：切到某个标签且该 kind 还没缓存时静默拉一次 ----
      // /models 同时返回 models（{ name, key, desc, member, source }）和 capabilities
      // （按 key 索引的 ratios / durations / range），两者一起缓存，比例与时长都从这里取。
      const loadModels = useCallback(
        async (forKind, silent) => {
          setModelsBusy(true)
          try {
            const res = await apiPost('/models', { for: forKind })
            if (!aliveRef.current) return
            const list = res && Array.isArray(res.models) ? res.models.map(normalizeModel).filter(Boolean) : []
            if (res && res.ok === true && list.length > 0) {
              setModels((prev) => Object.assign({}, prev, { [forKind]: list }))
              const table = res.capabilities && typeof res.capabilities === 'object' ? res.capabilities : {}
              setCaps((prev) => Object.assign({}, prev, { [forKind]: table }))
              if (!silent) {
                const memberCount = list.filter((m) => m.member).length
                showToast('模型列表已更新（' + list.length + ' 个，会员 ' + memberCount + ' 个）', 'ok')
              }
            } else {
              showToast((res && res.message) || '模型列表获取失败，已用内置列表')
            }
          } catch (err) {
            if (!aliveRef.current) return
            showToast('模型列表获取失败，已用内置列表（' + errText(err) + '）')
          } finally {
            if (aliveRef.current) setModelsBusy(false)
          }
        },
        [showToast]
      )

      useEffect(() => {
        const cached = models[tab]
        if (Array.isArray(cached) && cached.length > 0) return
        loadModels(tab, true)
        // 只依赖 tab：models 变化不应触发重复拉取
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tab, loadModels])

      // ---- 二维码每 3 秒换 t 重新拉（登录任务运行时才开） ----
      useEffect(() => {
        if (!loginRunning) return undefined
        const timer = setInterval(() => {
          setQrTick(Date.now())
        }, QR_REFRESH_MS)
        return () => clearInterval(timer)
      }, [loginRunning])

      // 换 t 时重置「二维码还没生成」的占位状态
      useEffect(() => {
        setQrBroken(false)
      }, [qrTick])

      // ---- 日志自动滚到底（依赖日志字符串本身） ----
      useEffect(() => {
        const el = logRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [logText])

      // ---- 动作 ----

      const startGenerate = useCallback(async () => {
        const currentForm = tab === 'image' ? imageForm : videoForm
        const prompt = String(currentForm.prompt || '').trim()
        if (!prompt) {
          showToast('请先填写画面描述')
          return
        }
        // 用 name 发给 Host（视频的 name 是显示名，doubao.mjs 会自己翻成内部 key）
        const list = modelsFor(models[tab], tab)
        const picked = findModel(list, currentForm.model) || list[0] || null
        if (!picked) {
          showToast('模型列表还没就绪，点「刷新模型」再试')
          return
        }
        const cap = capsFor(caps[tab], picked)
        const ratios = ratiosFor(cap, tab)
        const range = rangeFor(cap, picked)
        // 兜底再夹一次：万一 state 里的 ratio 不在当前模型能力里
        const ratio =
          ratios.indexOf(currentForm.ratio) >= 0
            ? currentForm.ratio
            : ratios.indexOf('16:9') >= 0
              ? '16:9'
              : ratios[0]
        const body = {
          kind: tab,
          prompt: prompt,
          model: picked.name,
          ratio: ratio,
          mode: currentForm.mode,
        }
        if (tab === 'image') {
          // 数量只对生图生效（脚本会把它写进提示词前缀）
          body.count = clampCount(currentForm.count, limits.maxGenImages)
        }
        if (tab === 'video') {
          // 时长一定是数字：区间按当前模型的 capabilities.range（会员档没有条目时 4-30）
          body.duration = clampDuration(currentForm.duration, range)
          body.resolution = currentForm.resolution
        }
        // 参考图：产物选中（name）+ 手填路径，原样交给 Host 去解析/校验
        if (refs.length > 0) body.refs = refs
        setSubmitting(true)
        try {
          const res = await apiPost('/generate', body)
          if (!aliveRef.current) return
          if (!res || res.ok !== true) {
            showToast((res && res.message) || '提交失败')
            return
          }
          // Host 可能对 refs 截断，warnings 一并透出
          const warnings = res && Array.isArray(res.warnings) ? res.warnings : []
          if (warnings.length > 0) showToast(warnings.join('；'), 'error')
          showToast(
            '任务已提交' + (refs.length > 0 ? '（含参考图 ' + refs.length + ' 张）' : '') + '，日志在下面实时滚动',
            'ok'
          )
          await refreshOnce()
        } catch (err) {
          if (aliveRef.current) showToast('提交失败：' + errText(err))
        } finally {
          if (aliveRef.current) setSubmitting(false)
        }
      }, [tab, imageForm, videoForm, models, caps, showToast, refreshOnce])

      const doCancel = useCallback(async () => {
        try {
          const body = current && current.id ? { id: current.id } : {}
          const res = await apiPost('/cancel', body)
          if (!aliveRef.current) return
          if (res && res.ok === false) showToast(res.message || '取消失败')
          else showToast('已发送取消', 'ok')
          await refreshOnce()
        } catch (err) {
          if (aliveRef.current) showToast('取消失败：' + errText(err))
        }
      }, [current, showToast, refreshOnce])

      const doLogin = useCallback(async () => {
        try {
          const res = await apiPost('/login', {})
          if (!aliveRef.current) return
          if (res && res.ok === false) showToast(res.message || '启动扫码登录失败')
          else showToast('已启动扫码登录，二维码在下方', 'ok')
          await refreshOnce()
        } catch (err) {
          if (aliveRef.current) showToast('启动扫码登录失败：' + errText(err))
        }
      }, [showToast, refreshOnce])

      const doReveal = useCallback(async () => {
        try {
          const res = await apiPost('/reveal', {})
          if (!aliveRef.current) return
          if (res && res.ok === false) {
            showToast(res.message || '打开产物目录失败')
            return
          }
          // Host 现在会回报是否复用已有窗口 / 是否成功前置（Windows 前台锁定很容易让
          // 窗口开在 DSH 后面，用户以为没反应），所以按实际结果给话。
          const reused = res && res.reused === true
          const activated = res && res.activated === true
          if (activated) showToast(reused ? '已切到产物目录窗口' : '已打开产物目录', 'ok')
          else showToast('已打开产物目录（窗口可能被挡住，看任务栏）', 'ok')
        } catch (err) {
          if (aliveRef.current) showToast('打开产物目录失败：' + errText(err))
        }
      }, [showToast])

      const doRefreshModels = useCallback(() => {
        loadModels(tab, false)
      }, [loadModels, tab])

      // ---- 渲染片段 ----

      const header = h(
        'header',
        { className: 'db-head' },
        h(
          'div',
          { className: 'db-head-main' },
          h('h1', { className: 'db-title' }, '豆包 生图 / 生视频'),
          h(
            'p',
            { className: 'db-sub', title: toolkitDir || '工具目录未知' },
            toolkitDir ? '工具目录：' + shortenPath(toolkitDir) : '工具目录：读取中…'
          )
        ),
        h('div', { className: 'db-pills' }, loginPill(login), jobPill(current, running), nodePill(nodePath))
      )

      const tabs = h(
        'div',
        { className: 'db-tabs', role: 'tablist' },
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': tab === 'image',
            className: 'db-tab' + (tab === 'image' ? ' is-active' : ''),
            onClick: () => setTab('image'),
          },
          '生图'
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': tab === 'video',
            className: 'db-tab' + (tab === 'video' ? ' is-active' : ''),
            onClick: () => setTab('video'),
          },
          '生视频'
        )
      )

      const modelValue = currentModel ? currentModel.name : ''

      // 模型下方小字：desc（可能为空）+ 额度提示
      const modelHint = h(
        'div',
        { className: 'db-hint' },
        currentModel && currentModel.desc ? h('span', null, currentModel.desc + ' · ') : null,
        h(
          'span',
          { className: currentModel && currentModel.member ? 'db-hint-member' : '' },
          currentModel && currentModel.member ? '会员模型，按倍率消耗额度' : '基础档，走每日免费额度'
        )
      )

      const formCard = h(
        'section',
        { className: 'db-card' },
        h(
          'h2',
          { className: 'db-card-title' },
          h('span', null, tab === 'image' ? '生成图片' : '生成视频'),
          h('span', { className: 'db-card-hint' }, busy ? '当前有任务在运行，提交会被拒绝' : '描述越具体，成片越稳')
        ),
        h(
          'div',
          { className: 'db-form' },
          field(
            '画面描述（必填）',
            h('textarea', {
              className: 'db-textarea',
              rows: 4,
              value: form.prompt,
              spellCheck: false,
              placeholder:
                tab === 'image'
                  ? '例如：雪山下的湖泊，清晨薄雾，超广角，写实摄影'
                  : '例如：雪山下的湖泊，镜头缓慢推进，晨雾流动，电影感',
              onChange: (e) => patch('prompt', e.target.value),
            })
          ),
          h(
            'div',
            { className: 'db-row' },
            field(
              '模型',
              h(
                'div',
                { className: 'db-stack' },
                selectBox(
                  modelValue,
                  modelOptions.map((m) => ({ value: m.name, label: modelLabel(m) })),
                  (v) => patch('model', v)
                ),
                modelHint
              )
            ),
            field('比例', selectBox(form.ratio, ratioOptions, (v) => patch('ratio', v))),
            tab === 'video'
              ? field(
                  '时长（秒）',
                  h(
                    'div',
                    { className: 'db-stack' },
                    h('input', {
                      className: 'db-input',
                      type: 'number',
                      min: durationRange.min,
                      max: durationRange.max,
                      step: durationRange.step,
                      value: form.duration,
                      onChange: (e) => patch('duration', e.target.value),
                      onBlur: (e) => patch('duration', String(clampDuration(e.target.value, durationRange))),
                    }),
                    h(
                      'div',
                      { className: 'db-hint' },
                      durationRange.min +
                        '–' +
                        durationRange.max +
                        ' 秒' +
                        (currentModel && currentModel.member ? '（会员档）' : '')
                    )
                  )
                )
              : null,
            tab === 'video'
              ? field(
                  '分辨率',
                  h(
                    'div',
                    { className: 'db-stack' },
                    selectBox(form.resolution, RESOLUTIONS, (v) => patch('resolution', v)),
                    h('div', { className: 'db-hint' }, '1080P 仅会员档，脚本会自动夹取')
                  )
                )
              : null,
            field('方式', selectBox(form.mode, MODES, (v) => patch('mode', v)))
          ),
          // 数量只对生图有意义：视频一次只出一条，豆包也没有视频数量参数
          tab === 'image'
            ? h(
                'div',
                { className: 'db-field' },
                h('span', { className: 'db-label' }, '数量'),
                h(
                  'div',
                  { className: 'db-stack' },
                  selectBox(String(form.count || '1'), countOptions(limits.maxGenImages), (v) => patch('count', v), {
                    style: { maxWidth: 160 },
                  }),
                  h(
                    'div',
                    { className: 'db-hint' },
                    '豆包没有数量参数，脚本会自动把「生成N张构图各不相同的图片：」写进提示词'
                  ),
                  Number(form.count) > 1
                    ? h('div', { className: 'db-hint db-hint-member' }, '一次生成多张会扣多次额度')
                    : null
                )
              )
            : null,
          // 参考图：产物缩略图点选 + 手填路径，图/视频都支持
          h(
            'div',
            { className: 'db-field' },
            h(
              'div',
              { className: 'db-ref-head' },
              h('span', { className: 'db-label' }, '参考图（最多 ' + limits.maxRefImages + ' 张）'),
              h('span', { className: 'db-ref-count' }, '已选 ' + refs.length + ' / ' + limits.maxRefImages + ' 张')
            ),
            imageOutputs.length > 0
              ? h(
                  'div',
                  { className: 'db-ref-grid' },
                  imageOutputs.slice(0, 24).map((o) => {
                    const idx = refNames.indexOf(o.name)
                    const picked = idx >= 0
                    return h(
                      'button',
                      {
                        key: 'ref-' + o.name,
                        type: 'button',
                        className: 'db-ref-thumb' + (picked ? ' is-picked' : ''),
                        title: o.name,
                        onClick: () => toggleRef(o.name),
                      },
                      h('img', {
                        className: 'db-ref-img',
                        src: API + '/file?name=' + encodeURIComponent(o.name),
                        alt: o.name,
                        loading: 'lazy',
                      }),
                      picked ? h('span', { className: 'db-ref-badge' }, String(idx + 1)) : null
                    )
                  })
                )
              : h('div', { className: 'db-hint' }, 'doubao_out 里还没有图片产物，可以先在下面手填路径'),
            h('textarea', {
              className: 'db-textarea db-ref-text',
              rows: 2,
              spellCheck: false,
              value: refText,
              placeholder: 'D:\\pics\\a.png（每行一个，最多 ' + limits.maxRefImages + ' 张；也可以只写 doubao_out 里的文件名）',
              onChange: (e) => setRefText(e.target.value),
            }),
            refsOverflow > 0
              ? h('div', { className: 'db-hint db-hint-member' }, '超出上限，已忽略多余的 ' + refsOverflow + ' 张')
              : null
          ),
          h('p', { className: 'db-foot-note' }, '豆包网页还支持风格 / 运镜，脚本暂未接入'),
          h(
            'div',
            { className: 'db-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'db-btn is-primary',
                disabled: running || submitting,
                title: running ? '已有任务在运行' : '提交到 Host 开始生成',
                onClick: startGenerate,
              },
              submitting ? '提交中…' : '开始生成'
            ),
            running
              ? h(
                  'button',
                  { type: 'button', className: 'db-btn is-danger', onClick: doCancel, title: '杀掉当前任务进程' },
                  '取消'
                )
              : null,
            h(
              'button',
              { type: 'button', className: 'db-btn', onClick: doRefreshModels, disabled: modelsBusy },
              modelsBusy ? '拉取中…' : '刷新模型'
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'db-btn',
                onClick: doLogin,
                disabled: busy,
                title: busy ? '等当前任务结束再登录' : '起一个扫码登录任务',
              },
              '扫码登录'
            ),
            h(
              'button',
              { type: 'button', className: 'db-btn', onClick: doReveal, title: '用资源管理器打开 doubao_out' },
              '打开产物目录'
            ),
            // 退登：会让 cookie + Edge 配置目录一起消失，所以走二次确认
            h(
              'button',
              {
                type: 'button',
                className: 'db-btn is-danger',
                onClick: () => setLogoutAsk(true),
                disabled: busy || logoutAsk,
                title: busy ? '等当前任务结束' : '退出登录并清理本机登录信息',
              },
              '退出登录'
            )
          ),
          // 退登二次确认条：面板内嵌，不用 window.confirm（阻塞式弹窗在宿主里体验很差）
          logoutAsk
            ? h(
                'div',
                { className: 'db-confirm', role: 'alertdialog' },
                h(
                  'div',
                  { className: 'db-confirm-text' },
                  '会删掉 cookie 文件和 Edge 配置目录（约 700 MB），不可恢复。',
                  h('br', null),
                  '服务端退登接口被风控挡死，所以这里是本地彻底清理；下次用要先扫码登录。'
                ),
                h(
                  'div',
                  { className: 'db-confirm-actions' },
                  h('button', { type: 'button', className: 'db-btn is-danger', onClick: doLogout }, '确认退登'),
                  h('button', { type: 'button', className: 'db-btn', onClick: () => setLogoutAsk(false) }, '取消')
                )
              )
            : null
        )
      )

      const status = describeStatus(current, running)

      const logCard = h(
        'section',
        { className: 'db-card' },
        h(
          'h2',
          { className: 'db-card-title' },
          h('span', null, '运行日志'),
          h('span', { className: 'db-status ' + status.tone }, status.text)
        ),
        current
          ? h('pre', { className: 'db-log', ref: logRef }, logText || '（暂无输出）')
          : h('div', { className: 'db-empty' }, '还没有任务。填好描述点「开始生成」，日志会实时出现在这里。')
      )

      const loginCard = loginRunning
        ? h(
            'section',
            { className: 'db-card' },
            h(
              'h2',
              { className: 'db-card-title' },
              h('span', null, '扫码登录'),
              h('span', { className: 'db-card-hint' }, '二维码每 3 秒自动刷新')
            ),
            h(
              'div',
              { className: 'db-qr' },
              qrBroken
                ? h('div', { className: 'db-qr-img db-qr-fallback' }, '二维码生成中…')
                : h('img', {
                    key: 'qr-' + qrTick,
                    className: 'db-qr-img',
                    src: API + '/file?name=login_qr.png&t=' + qrTick,
                    alt: '豆包登录二维码',
                    onError: () => setQrBroken(true),
                  }),
              h(
                'div',
                { className: 'db-qr-tip' },
                h('p', null, '用豆包 App 扫码，手机点确认。'),
                h('p', { className: 'db-muted' }, '登录任务跑在后台，成功后 cookie 会写回插件目录。'),
                h(
                  'div',
                  { className: 'db-actions' },
                  h('button', { type: 'button', className: 'db-btn is-danger', onClick: doCancel }, '取消登录')
                )
              )
            )
          )
        : null

      const shownOutputs = outputs.slice(0, MAX_OUTPUTS)
      const restCount = outputs.length - shownOutputs.length

      const outputItem = (item, index) => {
        const out = item || {}
        const name = typeof out.name === 'string' ? out.name : ''
        if (!name) return null
        const href = API + '/file?name=' + encodeURIComponent(name)
        const isVideo = out.kind === 'video' || /\.(mp4|webm|mov)$/i.test(name)
        const key = name + '#' + (out.mtime || index)
        const media = isVideo
          ? h('video', { className: 'db-out-media', src: href, controls: true, preload: 'metadata' })
          : h('img', { className: 'db-out-media', src: href, alt: name, loading: 'lazy' })
        return h(
          'div',
          { className: 'db-out', key: key },
          isVideo
            ? media
            : h('a', { className: 'db-out-link', href: href, target: '_blank', rel: 'noreferrer' }, media),
          h(
            'div',
            { className: 'db-out-meta' },
            h(
              'a',
              { className: 'db-out-name', href: href, target: '_blank', rel: 'noreferrer', title: name },
              name
            ),
            h('span', null, formatBytes(out.bytes) + ' · ' + formatTime(out.mtime))
          )
        )
      }

      const outputsCard = h(
        'section',
        { className: 'db-card' },
        h(
          'h2',
          { className: 'db-card-title' },
          h('span', null, '最近产物'),
          h(
            'span',
            { className: 'db-card-hint' },
            outputs.length > 0 ? outputs.length.toLocaleString('zh-CN') + ' 个文件' : 'doubao_out'
          )
        ),
        outputs.length === 0
          ? h('div', { className: 'db-empty' }, 'doubao_out 里还没有产物。')
          : h('div', { className: 'db-grid' }, shownOutputs.map(outputItem)),
        restCount > 0
          ? h('p', { className: 'db-more' }, '还有 ' + restCount.toLocaleString('zh-CN') + ' 个，去 doubao_out 看')
          : null
      )

      return h(
        'div',
        { className: 'db-root' },
        h('style', { key: 'db-css' }, CSS),
        h(
          'div',
          { className: 'db-inner' },
          toast
            ? h(
                'div',
                {
                  key: 'toast:' + toast,
                  className: 'db-toast ' + (toastTone === 'ok' ? 'is-ok' : 'is-error'),
                  role: 'status',
                },
                h('span', { className: 'db-dot' }),
                h('span', { className: 'db-toast-text' }, toast)
              )
            : null,
          header,
          tabs,
          formCard,
          logCard,
          loginCard,
          outputsCard
        )
      )
    }

    // ---------------------------------------------------------------- 样式
    // 只在 .db-root 作用域内定义自有变量；颜色一律走宿主主题 token（--dsw-alias-*），
    // 深色/浅色自动跟随。渲染成 React 元素，随组件卸载自动移除。

    const CSS = `
.db-root {
  --db-radius: 12px;
  --db-radius-sm: 10px;
  height: 100%;
  overflow: auto;
  padding: 24px 28px;
  box-sizing: border-box;
  /* 主面板是一整页，得自己铺底色，否则会露出宿主的容器底色 */
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.55;
}
.db-root *, .db-root *::before, .db-root *::after { box-sizing: border-box; }
.db-inner {
  max-width: 1080px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.db-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.db-head-main { min-width: 0; }
.db-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.2px;
  color: var(--dsw-alias-label-primary);
}
.db-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  max-width: 560px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.db-pills {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.db-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 280px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
}
.db-pill-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.db-pill.is-ok { color: var(--dsw-alias-state-success-primary); }
.db-pill.is-warn { color: var(--dsw-alias-state-warn-primary); }
.db-pill.is-error { color: var(--dsw-alias-state-error-primary); }
.db-pill.is-running { color: var(--dsw-alias-brand-primary); }
.db-pill.is-idle { color: var(--dsw-alias-label-secondary); }
.db-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex: 0 0 auto;
}
.db-tabs {
  display: inline-flex;
  align-self: flex-start;
  gap: 3px;
  padding: 3px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
.db-tab {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  padding: 5px 16px;
  border-radius: 999px;
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.db-tab:hover { color: var(--dsw-alias-label-primary); }
.db-tab.is-active {
  background: var(--dsw-alias-bg-layer-1);
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.db-card {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--db-radius);
  padding: 16px 18px;
}
.db-card-title {
  margin: 0 0 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.db-card-hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--dsw-alias-label-secondary);
}
.db-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.db-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}
.db-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.db-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.db-hint {
  font-size: 11px;
  line-height: 1.45;
  color: var(--dsw-alias-label-secondary);
}
.db-hint-member {
  color: var(--dsw-alias-state-warn-primary);
}
/* 参考图区：产物缩略图可点选，选中项加边框 + 序号角标 */
.db-ref-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.db-ref-count {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.db-ref-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 8px;
  margin: 8px 0;
}
.db-ref-thumb {
  position: relative;
  padding: 0;
  border: 2px solid var(--dsw-alias-border-l1);
  border-radius: var(--db-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
  cursor: pointer;
  overflow: hidden;
  line-height: 0;
  transition: border-color 0.15s ease;
}
.db-ref-thumb:hover { border-color: var(--dsw-alias-border-l2); }
.db-ref-thumb.is-picked {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary);
}
.db-ref-img {
  display: block;
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
}
.db-ref-badge {
  position: absolute;
  top: 3px;
  right: 3px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  font-weight: 600;
}
.db-ref-text {
  min-height: 52px;
  margin-top: 8px;
  font-size: 12px;
}
/* 退登二次确认条：内嵌，不用 window.confirm */
.db-confirm {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: var(--db-radius-sm);
  background: var(--dsw-alias-bg-overlay);
}
.db-confirm-text {
  flex: 1 1 320px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-primary);
}
.db-confirm-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.db-foot-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.85;
}
.db-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.db-input, .db-select, .db-textarea {
  width: 100%;
  font: inherit;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--db-radius-sm);
  padding: 7px 10px;
  outline: none;
  transition: border-color 0.15s ease;
}
.db-textarea {
  resize: vertical;
  min-height: 88px;
  line-height: 1.6;
  font-family: inherit;
}
.db-select { cursor: pointer; }
.db-input:focus, .db-select:focus, .db-textarea:focus {
  border-color: var(--dsw-alias-brand-primary);
}
.db-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.db-btn {
  font: inherit;
  font-size: 13px;
  padding: 7px 14px;
  border-radius: var(--db-radius-sm);
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  transition: border-color 0.15s ease, opacity 0.15s ease;
}
.db-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.db-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.db-btn.is-primary {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
  font-weight: 600;
}
.db-btn.is-primary:hover:not(:disabled) { opacity: 0.92; }
.db-btn.is-danger { color: var(--dsw-alias-state-error-primary); }
.db-log {
  margin: 0;
  max-height: 240px;
  overflow: auto;
  padding: 12px;
  border-radius: var(--db-radius-sm);
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.db-status {
  font-size: 12px;
  font-weight: 400;
}
.db-status.is-running { color: var(--dsw-alias-brand-primary); }
.db-status.is-ok { color: var(--dsw-alias-state-success-primary); }
.db-status.is-warn { color: var(--dsw-alias-state-warn-primary); }
.db-status.is-error { color: var(--dsw-alias-state-error-primary); }
.db-status.is-idle { color: var(--dsw-alias-label-secondary); }
.db-empty {
  padding: 18px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  border: 1px dashed var(--dsw-alias-border-l1);
  border-radius: var(--db-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
}
.db-qr {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.db-qr-img {
  width: 180px;
  height: 180px;
  flex: 0 0 auto;
  object-fit: contain;
  border-radius: var(--db-radius-sm);
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
.db-qr-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  border-style: dashed;
}
.db-qr-tip {
  min-width: 200px;
  flex: 1 1 200px;
}
.db-qr-tip p {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.db-qr-tip p.db-muted {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.db-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}
.db-out {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--db-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
}
.db-out-link {
  display: block;
  line-height: 0;
}
.db-out-media {
  display: block;
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
  background: var(--dsw-alias-bg-overlay);
}
.db-out-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 10px 10px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.db-out-name {
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.db-out-name:hover { text-decoration: underline; }
.db-more {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.db-toast {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--db-radius-sm);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  animation: db-toast-life 3s ease forwards;
}
.db-toast.is-ok { color: var(--dsw-alias-state-success-primary); }
.db-toast.is-error { color: var(--dsw-alias-state-error-primary); }
.db-toast-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes db-toast-life {
  0% { opacity: 0; transform: translateY(-4px); }
  8% { opacity: 1; transform: none; }
  82% { opacity: 1; transform: none; }
  100% { opacity: 0; transform: none; }
}
`

    // ---------------------------------------------------------------- 注册

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return
        // 主面板：key 必须与侧栏 id 一致，侧栏按钮靠它切到本页
        slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, DoubaoPage))
        slots.inject('sidebar.panellist', () =>
          slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => '豆包生成' }, DoubaoIcon)
        )
      },
    }
  },
})
