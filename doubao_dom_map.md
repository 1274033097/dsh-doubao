# 豆包网页版 DOM 契约速查（Edge + CDP 实测 · 会员环境）

> 环境：Microsoft Edge 157.0.4341.46 / 独立 profile `doubao_edge_profile` / 已登录 / **标准套餐（会员）**
> 采集方式：Playwright `connectOverCDP` 只读探针（现用 `capture_api.mjs`，或浏览器方式 `--dry-run true` 截图）
> 采集时间：2026-11-13（会员后重扫）

## 1. 输入区

| 用途 | 选择器 |
|---|---|
| 富文本输入框 | `[data-testid="chat_input_input"] .ProseMirror` |
| 发送按钮 | `[data-testid="chat_input_send_button"]`（有内容才出现且可用） |
| 新对话 | `[data-testid="create_conversation_button"]` |
| 速度/模式 | `[data-testid="chat_input_action_model"]`（「快速」）、`[data-testid="chat_input_action_mode"]`（「对话」） |

## 2. 技能 chip

| 用途 | 选择器 |
|---|---|
| 图像生成 | `[data-testid="skill_bar_button_3"]` |
| 视频生成 | `[data-testid="skill_bar_button_17"]` |
| 更多技能 | `[data-testid="skill_bar_button_more"]` |

- 未登录时**不渲染**
- 激活某个技能后，输入区进入该技能的专属输入态：**技能 chip 会消失**，只剩摘要条
- ⚠️ 视频 ↔ 图像 **不能靠点 chip 互相切换**；必须整页导航重置（`page.goto('https://www.doubao.com/chat/')`）

## 3. 视频模式（会员实测）

### 摘要条
```
视频生成   模型 Seedance 2.5   自动 · 10s · 720P
```

### 模型下拉（点「模型 …」→ `role="menuitem"`）
| 选项 | 说明 |
|---|---|
| Seedance 2.5 | 旗舰视频标杆 · 5 倍消耗 |
| Seedance 2.0 | 进阶画面表现 · 2 倍消耗 |
| Seedance 2.0 Fast | 快速出片选择 |
| Seedance 2.0 Mini | 日常生成使用 |

### 参数面板（点摘要条「自动 · 10s · 720P」）
面板 rect ≈ `{x:633, y:547, w:368, h:345}`，完整文本：
```
比例  自动 3:4 4:3 9:16 16:9 1:1 21:9
时长  10s  4s ─────── 30s
分辨率 720P 1080P
```

**比例（7 项，每项 80×56 的 div，无 testid）**

| 值 | 坐标 (中心) |
|---|---|
| 自动 | (686, 614) |
| 3:4 | (773, 614) |
| 4:3 | (861, 614) |
| 9:16 | (949, 614) |
| 16:9 | (686, 678) |
| 1:1 | (773, 678) |
| 21:9 | (861, 678) |

**时长**：`role="slider"`，`aria-valuemin=0`、`aria-valuemax=26`、`aria-valuenow=6` → 当前 10s
- ⚠️ 非会员时 `aria-valuemax=11`，**会员后变 26** → 必须运行时读取 aria 属性，不能硬编码
- 刻度：`4s` … `30s`；索引 0 = 4s，索引 6 = 10s（步进 1s）
- 校验方式：拖动后回读摘要条文本（形如 `自动 · 12s · 1080P`）

**分辨率（2 项，每项 167×36）**

| 值 | 坐标 (中心) |
|---|---|
| 720P | (729, 862) |
| 1080P | (905, 862) |

✅ 已验证：点 1080P 后摘要条实时变为 `自动 · 10s · 1080P`

## 4. 图像模式（会员实测）

### 摘要条
```
图像生成   模型 Seedream 5.0 Pro   比例 自动
```

### 模型下拉（5 项）
`Seedream 5.5 旗舰生图` / `Seedream 5.0 Pro 专业出图` / `Seedream 5.0 Flash 专业快速` / `Seedream 4.5 日常生成` / `Seedream 4.0 基础生图`

### 比例面板（点「比例 自动」）
**8 项**（每项 80×56）：`自动 / 9:16 / 2:3 / 3:4 / 1:1 / 4:3 / 3:2 / 16:9`

| 值 | 坐标 (中心) |
|---|---|
| 自动 | (692, 788) |
| 9:16 | (779, 788) |
| 2:3 | (867, 788) |
| 3:4 | (955, 788) |
| 1:1 | (692, 852) |
| 4:3 | (779, 852) |
| 3:2 | (867, 852) |
| 16:9 | (955, 852) |

> 生图**没有**时长/分辨率参数，只有比例。
> 生图**也没有「生成数量」控件**（2026-11-14 实测：面板浮层只有 `比例 自动 9:16 2:3 3:4 1:1 4:3 3:2 16:9`，底栏只有「模型」「比例」两个下拉）。
> 想出多张 → 必须在提示词里写「生成N张…」，实测要 8 张给 8 张，要 12/20 张只给 10 张。

### 参考图上传（图像 / 视频技能通用）

输入区有隐藏文件控件：

| 用途 | 选择器 |
|---|---|
| 上传控件 | `input[type=file][data-testid="upload-file-input"]`，`accept=".jpg,.png,.jpeg,.webp,.apng"`，`multiple=true` |

- 用 `setInputFiles(paths)` 直接投喂，无需点按钮
- 上传后底部出现缩略图：先是 `data:image/svg+xml` 占位，上传完成后变 `blob:https://www.doubao.com/...`
- **一次最多 10 张**：传 12 张只保留前 10 张（实测 `attachment_block.attachments.length === 10`）
- 图片进入请求体的位置：`messages[0].content_block[0]`，`block_type=10052`，
  内容是 `attachment_block.attachments[]`，每项 `{type:1, identifier, image:{name, uri:"tos-cn-i-.../<hex>.png", image_ori:{...}}, upload_status:1, progress:100}`

## 5. 结果抓取

### 图片
- `<img>` 按 `/rc_gen_image/<hash>` 去重，优选 `cgen_wm0.png`/`.webp`（无水印）
- 排除 `-cthumb` / `/rc/icon/` / `/static/image/` / `avatar` / `qrcode` / `.svg`
- 带 `Referer: https://www.doubao.com/` 直接 fetch 下载

### 视频
- 结果是**卡片**（海报 + 播放按钮），`<video>` **懒创建**
- 必须先点卡片，才出现 `<video src=https://v*-vdl.doubao.com/...mime_type=video_mp4&lr=unwatermarked>`
- 带 Referer 可直接下载（实测 1280×720 / 10.08s / 1.68 MB，`ftyp isom`+`moov`+`mdat`）

## 6. 视频生成流程

1. 激活「视频生成」→ 输入提示词 → 发送
2. 豆包先回**参数确认单**（模型/时长/比例/创作方向/声音/画面文字），末尾「确认后我再开始生成视频」
3. 必须再发「确认」才开始渲染
4. 提示「预计 5 分钟」，**实测 9~14 分钟**
5. ⚠️ **豆包不会把结果主动推到页面**：生成完后页面仍停在「预计等待 5 分钟」，
   必须 **`page.reload()` 刷新** 才会出现「你的视频生成好了」+ 视频卡片
6. 刷新后点视频卡片（海报）→ 才出现 `<video src>` → 下载
7. 消耗额度（2.5 = 5 倍、2.0 = 2 倍、Fast/Mini 较低）

## 6.1 档位差异（重要）

| 项 | 非会员档位（Seedance 2.0 Mini / Fast） | 会员档位（Seedance 2.5 / 2.0） |
|---|---|---|
| 时长 `aria-valuemax` | 11（4s~15s） | 26（4s~30s） |
| 分辨率分区 | **面板里没有**（固定 720P） | 有，720P / 1080P |
| 码率参考 | 1280 | 2591 |

- 生图同理：非会员档位只有比例，无时长/分辨率
- 设置时长：点轨道**不生效**（尤其左端），必须「点拇指聚焦 → 方向键微调」，脚本已实现三方案回退

## 7. 模型清单（会变，勿照抄）

本文列的模型是 2026-11-13 的快照。豆包会随版本 / 会员状态调整档位，**用脚本实时探测**：

```bash
node doubao_gen.mjs models --for image   # 当前生图模型
node doubao_gen.mjs models --for video   # 当前视频模型
```

2026-11-13 实测：

- 生图（5 个）：`Seedream 5.5`（旗舰生图）/ `Seedream 5.0 Pro`（专业出图）/ `Seedream 5.0 Flash`（专业快速）/ `Seedream 4.5`（日常生成）/ `Seedream 4.0`（基础生图）
- 视频（4 个）：`Seedance 2.5`（旗舰·5 倍消耗）/ `Seedance 2.0`（进阶·2 倍消耗）/ `Seedance 2.0 Fast`（快速出片）/ `Seedance 2.0 Mini`（日常生成）

探测原理：点开「模型」下拉 → 读 `role="menuitem"` 列表。勾选项是 SVG 图标（取不到文字），
因此用摘要条里的当前模型名反推哪一项被选中。

## 8. 工程坑（已踩）

- `connectOverCDP()` 的 browser 调 `close()` 会**真的关掉浏览器** → 缓存连接、不 close
- Edge 在 DSH `workspace-write` 沙箱下**起不来**（mojo 命名管道被拒 → FATAL），必须 `danger-full-access`
- 视频 URL 有 `x-expires`，需及时下载
- 参数面板选项**没有 testid**，只能按「文本 + 相对面板的坐标」定位
- `page.evaluate(fn, a, b)` 只接受两个参数，多传会报 "Too many arguments"
- 摘要条文本会换行（模型名可能独占一行），**不能按行过滤**，要取「含『模型』的最小容器」
