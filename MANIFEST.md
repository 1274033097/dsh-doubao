# 豆包生图/生视频工具包 · 清单

- 平台：Windows 10/11 + Microsoft Edge 157 + Node.js 24
- **本仓库不含任何登录态**：`doubao_cookies.txt`（含 session cookie）、`doubao_identity.json`（设备身份）和 `doubao_edge_profile/` 都未包含，首次使用需自行登录并生成身份文件（见 §六）

## 一、两种运行方式（+ 自动降级）

| | **方式 A · 完全脱离浏览器** | **方式 B · 需要浏览器进程** |
|---|---|---|
| 原理 | 纯 HTTP 调 `/chat/completion`，cookie 认证 | CDP 驱动 Edge，点 UI 传参 |
| 需要浏览器 | ❌ Edge 可完全关闭 | ✅ 拉起 Edge 窗口 |
| 速度 | 图 14~25s / 视频 2~4min | 图 20~40s / 视频 3~15min |
| 模型清单 | 接口返回 3~4 个 | 网页下拉全部（含 2.5 / 2.5 Flash） |
| 双击入口 | `生图-直连.cmd` / `生视频-直连.cmd` | `生图-浏览器.cmd` / `生视频-浏览器.cmd` |
| 命令行 | `--mode direct` | `--mode browser` |

**默认入口 `生图.cmd` / `生视频.cmd` 走 auto**，降级阶梯：
1. 方式 A（cookie 就绪时）
2. cookie 缺失/失效 → `get_cookies.mjs` 重新解密 → 再试一次 A
3. 仍失败 → 方式 B（浏览器）

调度器 `doubao.mjs` 负责选方式、把显示名翻译成各方式需要的模型标识（视频：`Seedance 2.0 Fast` ↔ `seedance_v2.0`）、逐级重试。

两者都复用豆包会员额度，无需 Ark API Key，无需「豆包工作」订阅。

## 二、包内容

### 调度层
| 文件 | 作用 |
|---|---|
| `doubao.mjs` | **统一调度器**：模式选择、参数翻译、降级重试 |
| `生图.cmd` / `生视频.cmd` | 双击入口：**auto**（直连优先，失败降级浏览器） |
| `生图-直连.cmd` / `生视频-直连.cmd` | 双击入口：强制方式 A |
| `生图-浏览器.cmd` / `生视频-浏览器.cmd` | 双击入口：强制方式 B |
| `登录.cmd` | 双击入口：扫码登录（不启动浏览器） |
| `退登.cmd` | 双击入口：退登 + 清理登录信息（cookie + Edge 配置目录） |

### 方式 A（直连）
| 文件 | 作用 |
|---|---|
| `doubao_http.mjs` | 主程序：`models` / `image` / `video` / `poll`（支持 `--count` 多图、`--ref` 参考图） |
| `doubao_upload.mjs` | **参考图纯 HTTP 上传**：prepare_upload → ApplyImageUpload(AWS4) → TOS → CommitImageUpload；浏览器不用启动 |
| `get_cookies.mjs` | 从 Edge 配置目录解密 cookie（DPAPI + AES-256-GCM），Edge 无需运行 |
| `login.mjs` | **扫码登录**：默认用屏幕外 Edge 打开真实登录页并截取页面二维码（绕开 passport 风控）；`--mode http` 为纯 HTTP 备选 |
| `logout.mjs` | **退登 / 清理登录信息**：服务端退登接口被风控挡死，改为本地彻底清理（cookie 清空 + profile 删除 + 残留清理）；支持 `--status` / `--dry-run` / `--yes` / `--keep-profile` / `--keep-cookie` |
| `doubao_identity.json` | 设备身份参数（device_id / web_id / fp / tea_uuid 等） |

### 方式 B（浏览器）
| 文件 | 作用 |
|---|---|
| `doubao_gen.mjs` | 主程序：`image` / `video` / `models`（支持 `--count` 多图、`--ref` 参考图） |
| `watch-video.mjs` | 只查询不生成，盯当前对话自动下载 |
| `capture_api.mjs` | 抓包工具（重新提取身份参数 / 调试改版） |

### 诊断与维护
| 文件 | 作用 |
|---|---|
| `check_conv.mjs` | 会话体检：数对话里的图片/视频资源，判断是否重复生成 |
| `capture_member_request.mjs` | 抓「会员模型」的真实请求体，用来拿到新模型的 key（花 1 次额度） |

### DSH 插件包装层（可选）
| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：把脚本包成 `/doubao/api` 下的 HTTP 接口 |
| `client.js` | Web 面板（左侧栏入口） |
| `package.json` / `cordis.patch.yml` | 插件声明与注册补丁（`@local/dsh-doubao`） |
| `icon.svg` / `locale/*.json` | 图标与中英文文案 |

### 文档与产物
| 文件 | 作用 |
|---|---|
| `使用说明.md` | 完整使用文档（含两种方式对比、降级逻辑、技术说明） |
| `项目维护.md` | **维护手册**：分层定位法、新模型接入、接口/DOM 改版修复、回归清单、踩坑速查 |
| `doubao_dom_map.md` | 网页 DOM 契约（选择器、档位差异、踩坑记录） |
| `doubao_out/` | 产物目录（图片/视频/二维码截图）。**备份包不含产物**，运行时自动生成 |

## 三、能力状态（本次实测）

| 能力 | 状态 | 实测数据 |
|---|---|---|
| 直连生图 | ✅ | 2848×1600 原图，4.1-4.9 MB，14-21 秒 |
| 直连生视频 | ✅ | 1280×720 / 4.06s，1.7 MB，157 秒（含轮询） |
| 直连查模型 | ✅ | 图片 6 个、视频 5 个（含会员档，标 `member: true`） |
| 会员模型（直连） | ✅ | 会员档仅 4 个：图片 `Seedream 5.0 Pro`；视频 `Seedance 2.5` / `2.5 Flash` / `2.0`。其余模型免费。Seedream 5.5 实测可用（2.36 MB / 23 秒） |
| 直连查结果 | ✅ | `poll --conv <id>` 可取回历史结果 |
| cookie 自动解密 | ✅ | 35 条全部成功，Edge 关闭状态下完成 |
| 浏览器模式 | ✅ | 生图 / 生视频均正常 |
| 时长精确控制 | ✅ | 请求 4s → 实测 4.063991s |

## 四、关键技术发现（维护必读）

1. **`a_bogus` 签名非强制**：URL 上的 `a_bogus` / `msToken` 全部省略，`/chat/completion` 依然 200 正常返回。只靠 cookie 就能认证。
2. **参数写在请求体里**：`chat_ability.ability_param`（JSON 字符串）直接携带 `model` / `ratio` / `duration` / `resolution`，**不需要点任何 UI**。
3. **`ability_type`**：图片外层 `3`（内层 `1`），视频外层 `17`。
4. **视频模型用内部 key**：`seedance_v2.0_std`(2.0) / `seedance_v2.0`(Fast) / `seedance_v2.0_mini`(Mini)，不是显示名；`resolution` 小写 `"720p"`；`duration` 是数字。
5. **`/im/*` 接口有编码要求**：必须 `content-type: application/json; encoding=utf-8` + `agw-js-conv: str`，否则返回 `712012002 不支持编码类型`。
6. **结果地址形态**：图片 `rc_gen_image/...image_raw.png`（原图）；视频 `https://v26-vdl.doubao.com/.../video/tos/...`（按 content-length 取最大）。
7. **视频回执有三种，判断错会重复生成**：
   - 「本次使用 X 生成，大约需要 1-3 分钟」→ 已开工，**不要再发任何确认**
   - 「…请先确认以下参数…」→ 回「确认，开始生成」
   - 「…是否继续生成？」→ 回「继续生成」
   - **坑**：免费额度用完后豆包会说「…将消耗付费额度，**并使用优先生成通道。**」——这是陈述句，按关键字「付费额度」回「继续生成」会**多生成一条**（实测出现 2 个不同视频资源）。判断必须只认疑问句。
8. **cookie 解密坑**：`v10` + AES-256-GCM，主密钥在 `Local State` 的 `os_crypt.encrypted_key`（DPAPI 包裹）；Edge/Chrome 130+ 会在明文前加 **32 字节 `SHA256(host_key)`** 前缀，必须先剥掉。
9. **模型清单有两处坑**：①`skill/pack` 只返回基础档（图片 4 / 视频 3），Seedream 5.5、Seedance 2.5、2.5 Flash 不在里面，需内置目录补；②接口不标会员身份，需人工维护 `MEMBER_KEYS`（实测会员档只有：图片 `Seedream 5.0 Pro`，视频 `Seedance 2.5` / `2.5 Flash` / `2.0`）。补全 key 的来源：
   - 图片：key 就是显示名（`"model":"Seedream 5.5"`，实测可直连生成）
   - 视频：key 是内部标识，来自 `/alice/slot/action_bar_v3/get_item_conf` 的 `option_key`
     （`Seedance 2.5` → `seedance_v2.5`；`Seedance 2.5 Flash` → `seedance_v2.5_flash`）
   - 代码里维护了内置目录 `MEMBER_MODELS`（`doubao_http.mjs` 顶部），`models` 会合并输出
10. **扫码登录接口**（无需登录态、无需 SDK 签名参数）：
   - 取码 `GET https://accounts.doubao.com/passport/web/get_qrcode/` → base64 PNG + token（有效期约 60 秒）
   - 轮询 `GET /passport/web/check_qrconnect/?token=...` → `new` / `scanning` / `confirmed`
   - 注意登录域名是 **`accounts.doubao.com`**，`sso.doubao.com` DNS 不通

## 五、关键约束

- **不要强杀 Edge**（`Stop-Process -Force` 会丢 cookie）。要重启用 `--restart-edge true` 或 CDP `Browser.close`。
- **不要对 CDP 连接调 `browser.close()` 就以为关掉了**：本机实测有时不生效，用显式 `Browser.close` 并等端口消失。
- `.cmd` 必须是 **GBK(936) + CRLF**，UTF-8/LF 会导致双击打不开。
- 直连模式读 cookie 时 **Edge 必须关闭**（cookie 库被锁）。
- 非会员档位视频面板无「分辨率」分区（固定 720P），时长 4-15s。
- 额度：Seedance 2.5 = 5×、2.0 = 2×、Fast/Mini 低。

## 六、首次使用步骤

1. 安装 Node.js **22.5+**（`node:sqlite` 需要，建议 24）
2. **先登录**（本仓库不含登录态）：双击 `登录.cmd` 扫码 → 自动写入 `doubao_cookies.txt`（不需要浏览器）
   - 或让 Edge 登录豆包后关闭 Edge，跑 `node get_cookies.mjs`
3. **生成设备身份文件**（本仓库不含）：`node capture_api.mjs --send "测试" --out cap.json`
   - 或复制 `doubao_identity.example.json` 为 `doubao_identity.json` 并填入自己的值
4. 双击 `生图.cmd` / `生视频.cmd` 即可（自动走直连，失败降级浏览器）

## 七、常用命令

```bash
node get_cookies.mjs                                  # 解密 cookie（Edge 需关闭）
node doubao_http.mjs models --for video               # 列视频模型 + 内部 key（不耗额度）
node doubao_http.mjs image --prompt "..." --model "Seedream 4.5" --ratio 16:9
node doubao_http.mjs video --prompt "..." --model seedance_v2.0 --duration 4
node doubao_http.mjs poll --conv <会话ID>              # 只查结果
node doubao_gen.mjs video --prompt "..." --dry-run true   # 浏览器模式：只校验参数不生成

# 多图 + 参考图（两种方式都支持）
node doubao.mjs image --prompt "..." --count 8                          # 一次 8 张
node doubao.mjs image --prompt "..." --count 2 --ref a.png --ref b.png  # 参考图 + 多图
node doubao.mjs video --prompt "..." --ref frame.png                    # 视频参考首帧
```

> 上限：参考图 **10 张**，一次生成 **8 张**。
> ⚠ 豆包没有数量参数，`--count` 会自动转成提示词前缀「生成N张构图各不相同的图片：」。
> 想自己控制措辞时加 `--no-count-hint true` 并自己在 prompt 里写张数。
