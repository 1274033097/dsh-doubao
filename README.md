# dsh-doubao

豆包生图 / 生视频的 **DeepSeek Harness 插件**。在 DSH 左侧栏加一个「豆包生成」入口，打开是一整页面板，可以直接用你自己的豆包会员额度生图、生视频，不用再双击 `.cmd`。

## 特性

- **左侧栏入口 + 整页 Web 面板**：填描述、选模型/比例/时长，日志实时滚动，产物网格直接预览
- **两种运行方式，自动降级**
  - 直连模式：纯 HTTP 调豆包内部接口，**不需要浏览器**，快（图 14-25s / 视频 2-4min）
  - 浏览器模式：CDP 驱动本机 Edge，作为直连失效时的保底
- **会员模型**：支持 Seedream 5.5 / 5.0 Pro / 5.0 Flash、Seedance 2.5 / 2.5 Flash
- **一次多张**：`--count 1-8`，脚本会自动把张数织进提示词
- **参考图**：`--ref` 最多 10 张，直连走纯 HTTP 上传，不用开浏览器
- **扫码登录 / 退登**：面板内直接显示二维码；退登做本地彻底清理
- **产物管理**：图片/视频缩略图网格，「打开产物目录」会复用窗口并前置

## 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | **Windows 10 / 11**（当前唯一支持平台） |
| Node.js | **22.5+**（`get_cookies.mjs` 用到 `node:sqlite`，建议装 24） |
| 浏览器 | Microsoft Edge（浏览器模式 / 扫码登录用） |
| DSH | 已在 profile 中启用插件管理器 |

浏览器模式还需要 `playwright-core`。直连模式不需要。想用浏览器兜底就装一下：

```bash
npm i -g @playwright/cli
```

## 安装

### 1. 装进 DSH

把本目录的绝对路径交给 DSH 助手安装（它会调用 `plugin_manager install_bundle`），或参考 `README-DSH.md`。

装好后左侧栏会出现「豆包生成」。

### 2. 准备登录态（必须，本仓库**不含**任何账号数据）

本仓库**故意不包含**登录凭据，所以你必须自己登录一次：

- 打开面板 → 点「扫码登录」→ 用豆包 App 扫码确认
- 或者双击 `登录.cmd`

登录后 cookie 会写进本目录的 `doubao_cookies.txt`。

### 3. 准备设备身份文件（必须）

`doubao_identity.json` 是请求必带的设备参数，**仓库里没有**（因为那是抓包得到的本机数据）。
本仓库提供了一个模板：`doubao_identity.example.json`。

生成方式二选一：

```bash
# 方式 A（推荐）：抓一次包，自动提取并生成 doubao_identity.json
node capture_api.mjs --send "测试" --out cap.json

# 方式 B：手动复制模板并填值
copy doubao_identity.example.json doubao_identity.json
```

### 4. 验证

```bash
# 列出模型（不耗额度）
node doubao_http.mjs models --for image
node doubao_http.mjs models --for video
```

## 用法

### 面板里用

左侧栏「豆包生成」→ 填描述 → 选模型/比例 → 开始生成 → 产物在 `doubao_out/`

### 命令行

```bash
# 统一调度器，自动降级
node doubao.mjs image --prompt "雪山下的湖泊" --model "Seedream 4.5" --ratio 16:9
node doubao.mjs video --prompt "城市夜景" --model "Seedance 2.0 Mini" --duration 5

# 一次 8 张 + 参考图
node doubao.mjs image --prompt "把这些配色做成色卡" --count 8 --ref a.png --ref b.png

# 只走直连 / 只走浏览器
node doubao.mjs image --prompt "..." --mode direct
node doubao.mjs image --prompt "..." --mode browser

# 只查结果，不生成
node doubao_http.mjs poll --conv <会话ID>
```

完整参数、维护手册见 [`使用说明.md`](使用说明.md) 和 [`项目维护.md`](项目维护.md)。

## 文件结构

```
index.js               Host 半边：/doubao/api 下的 HTTP 接口，驱动子进程
client.js              Client 半边：左侧栏图标 + 整页 Web 面板
package.json           插件清单
cordis.patch.yml       插件注册补丁
icon.svg / locale/     图标与中英文文案

doubao.mjs            统一调度器（选方式、参数翻译、降级重试）
doubao_http.mjs       直连模式主程序
doubao_upload.mjs     参考图纯 HTTP 上传（TOS）
doubao_gen.mjs        浏览器模式主程序
login.mjs / logout.mjs / get_cookies.mjs   登录态管理
watch-video.mjs       盯当前对话自动下载
capture_api.mjs       抓包工具（提取设备身份参数）
check_conv.mjs        会话体检
*.cmd                 双击入口（生图/生视频/登录/退登）
```

## 安全与隐私

- **本仓库不含任何账号数据**。`.gitignore` 挡掉了 `doubao_cookies.txt`、`doubao_identity.json`、`doubao_edge_profile/`
- 使用前请确认你已阅读并遵守豆包的服务条款
- 这是**非官方**工具，通过逆向网页版内部接口实现，接口随时可能改变
- 面板接口只允许本机回环访问（`127.0.0.1`），不会暴露到局域网

## 已知限制

- 只支持 Windows
- `*.cmd` 是 **GBK(936) + CRLF** 编码，用 UTF-8 编辑器另存会导致双击打不开
- 直连模式读 cookie 时 Edge 需关闭（cookie 库被锁）
- 模型清单随豆包更新变化，以 `models` 命令实测输出为准

## 许可证

[MIT](LICENSE)

## 致谢

接口逆向与实现思路来自本项目作者的实测。豆包、Seedream、Seedance 是字节跳动的商标，本项目与其无关联。