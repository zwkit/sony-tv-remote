# 索尼电视网页遥控器（tv-remote）

一个**零第三方依赖**的网页版遥控器，专门给索尼 BRAVIA 电视用。手机/电脑浏览器打开一个页面，就能方向键、电源、音量、中英文输入、切换应用、语音搜片；开启「实时预览」后还能在页面里看到电视当前画面。

> 测试机型：**Sony XR-75X90K 75"（BRAVIA 4K / Google TV）**。其它 Android TV / 索尼机型大多也能用，个别键名或画面参数可能需要按下面的环境变量微调。

**关于实时预览**：走 ADB `screenrecord` 抓 H.264 流，服务端只做拆帧，浏览器用 **WebCodecs** 解码画到 canvas。受系统 DRM 保护，**加密版权内容（Netflix / Disney+ / 爱奇艺 DRM 片源等）在预览里会是黑屏或不显示**，这是电视系统本身的行为，不是本项目的 bug。日常桌面、设置、应用列表、无 DRM 的视频都能正常预览。

---

## 功能

- **遥控**：方向键 / 确认 / 返回 / 主页 / 菜单 / 电源 / 音量 / 频道 / 播放控制，支持长按连发。
- **输入**：中文/英文文字输入（自动安装并切换 `ADBKeyboard` 输入法，用完可一键还原），不用在电视上逐字按。
- **应用**：列出电视已装应用、一键启动、懒加载并缓存应用图标（从 APK 二进制里直接提取 launcher 图标）。
- **实时预览**：ADB 投屏 + WebCodecs 解码；也可装电视端推流 App（`vendor/tvcast.apk`）走独立通道，不依赖 ADB。
- **索尼 IP 控制**：关掉 ADB 调试后，按键可改走 80 端口的 `/sony/IRCC`，应用列表走 `appControl`，仍可遥控（只有中文输入必须 ADB）。
- **语音**：手机浏览器自带语音识别优先，不可用时可接任意 OpenAI 兼容的 Whisper 接口做语音搜片。
- **PWA**：可「添加到主屏幕」，全屏、竖屏、独立图标，像一个原生 App。
- **自动发现**：电视 DHCP 换 IP 后会自动扫网段（5555 端口）找回，并验明正身（只认 `characteristics` 含 `tv` 的真电视，避开模拟器）。
- **鉴权**：`AUTH_TOKEN` 可选，设置后所有 `/api` 请求需带 `?t=` 或 `x-token` 头。

---

## 快速开始

### 方式 A：本地直接跑（Node.js，无需 Docker）

需要 **Node.js 18+** 和 **adb**（Android Platform Tools，确保在 `PATH` 里，或用 `ADB_PATH` 指定）。

```bash
# 1. 电视：设置 → 开发者选项 → 打开「网络调试 / ADB 调试」，记下电视 IP
# 2. 电脑先连一次，并在电视上点「允许调试」：
adb connect 192.168.1.50:5555

# 3. 启动（把地址换成你电视的 IP）：
TV_ADB=192.168.1.50:5555 node server.js
```

浏览器打开 `http://<本机IP>:8787` 即可遥控。
**实时预览必须走 HTTPS**：打开 `https://<本机IP>:8788`（首次会提示自签证书，点「高级 → 继续前往」）。`localhost` / `127.0.0.1` 算安全上下文，http 下也能预览。

> Windows PowerShell 设环境变量用 `$env:TV_ADB="192.168.1.50:5555"; node server.js`。

### 方式 B：Docker / 群晖 NAS（推荐长期挂着）

```bash
# 先把 docker-compose.yml 里的 TV_ADB 改成你电视的 IP，然后：
docker compose up -d --build
```

- 访问 `http://<NAS的IP>:8787`，预览走 `https://<NAS的IP>:8788`。
- `data/` 卷会持久化 adb 授权密钥、原输入法记录、应用图标缓存和自签证书，重建容器不用重新授权。
- 群晖 DSM 7.2 Container Manager 的图形化步骤、电视二次授权、升级不删项目、排障速查表，见 **[群晖部署.md](群晖部署.md)**。

国内 NAS 拉 `deb.debian.org` 慢时，compose 已默认注入 `DEBIAN_MIRROR=mirrors.aliyun.com`；能直连官方源就删掉那行。

---

## 配置

所有配置都是**环境变量**，见 [.env.example](.env.example) 与 `docker-compose.yml`。常用项：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TV_ADB` | `192.168.1.50:5555`（示例，务必改） | 电视的 adb 地址。连不上会自动扫网段找回。 |
| `PORT` | `8787` | HTTP 端口（遥控页面 / API）。 |
| `HTTPS_PORT` | `8788` | HTTPS 端口，实时预览必须走这个；`0` = 关闭。 |
| `AUTH_TOKEN` | 空 | 留空 = 不鉴权；**暴露到公网/VPN 前务必设一个随机长令牌**。 |
| `ADB_PATH` | 自动探测 | adb 可执行文件路径。 |
| `DATA_DIR` | `./data` | 运行数据目录（证书、图标缓存、状态、输入法记录）。 |
| `DISCOVER` | `1` | 自动发现电视；`0` = 关闭（局域网有开 5555 的模拟器时建议关）。 |
| `LAN_SUBNET` | 空（自动） | 扫描网段，桥接网络/跨网段时手动填。 |
| `SONY_HOST` | 取 `TV_ADB` 去端口 | 索尼 IP 控制的电视地址。 |
| `SONY_PSK` | 空 | 索尼 IP 控制预共享密钥；不用就留空。 |
| `IRCC_KEYS` | `{}` | IRCC 键名重映射，例 `'{"66":"Enter","219":"Assists"}'`。 |
| `PREVIEW_SIZE` | `848x480` | 预览分辨率，**宽高必须是 16 的倍数**（`854x480` 会补绿条）。 |
| `PREVIEW_BITRATE` | `2500000` | 预览码率 bps。 |
| `PREVIEW_RANGE` | 自动纠正 | 这台电视把全范围画面标成 limited 导致暗部压黑，默认纠正；标得正确的电视设 `limited` 关掉。 |
| `CAST_PORT` | `8790` | 电视端推流 App 通道；`0` = 关闭，不装 App 不受影响。 |
| `CAST_TOKEN` | 回退 `AUTH_TOKEN` | 推流通道的令牌。 |
| `SEARCH_ACTION` | `com.dangbei.intent.search` | 语音搜片用的桌面搜索 action（当贝桌面默认）。 |
| `ASR_URL` / `ASR_KEY` / `ASR_MODEL` | 空 / 空 / `whisper-1` | 兼容 OpenAI `/v1/audio/transcriptions` 的语音识别服务。 |
| `TZ` | `Asia/Shanghai` | 容器时区。 |

完整清单以 `server.js` 顶部注释和 [.env.example](.env.example) 为准。

---

## 安全提示

- **不要直接把 8787/8788 暴露到公网**。要远程用，走 VPN / 反向代理，并务必设置 `AUTH_TOKEN`（随机长令牌），访问时带 `?t=你的令牌` 或请求头 `x-token`。
- `AUTH_TOKEN` / `SONY_PSK` / `CAST_TOKEN` 默认值都是空，仓库里没有任何真实密钥或令牌；请只通过环境变量或 `.env`（已被 `.gitignore` 忽略）提供。
- 自签证书有效期 397 天（>398 天 Chrome/Edge 会报 `ERR_CERT_VALIDITY_TOO_LONG`），到期前 7 天重启会自动重签。
- `TV_ADB` 默认是**示例占位地址**，务必改成你电视的真实 IP。

---

## 预览为什么黑屏 / 不显示

| 现象 | 原因 |
| --- | --- |
| 加密版权片源黑屏 | 系统 DRM 保护，电视不允许抓取，属正常。 |
| http 打开预览按钮灰/无效 | WebCodecs 只在安全上下文可用，请改用 `https://...:8788` 或 `localhost`。 |
| 画面底部一条绿条 | 分辨率不是 16 的倍数，用 `848x480`。 |
| 画面暗部发黑 | 色彩范围标记问题，默认已自动纠正（见 `PREVIEW_RANGE`）。 |
| 预览卡顿 | 480p 约占用电视 4 核 MT5895 的 1.7 核；720p 反而更卡，不建议升。 |

---

## 目录结构

```
server.js            后端全部逻辑（零依赖 Node：HTTP/HTTPS + ADB + 索尼 IP 控制 + 投屏 + 预览）
apkicon.js          从 APK 二进制（AXML/ARSC）提取 launcher 图标，server.js 唯一 require 的模块
public/index.html    PWA 前端（WebCodecs 预览、遥控 UI、安装到主屏幕）
public/*.png / icon.svg / manifest.json   PWA 图标与清单
tools/make_pwa_icons.py  用 Pillow 重新生成 PWA 图标（可选）
assets/icon-livetv.png   「电视直播」自绘图标（server.js 内嵌了一份 base64 兜底，缺了也能跑）
vendor/ADBKeyboard.apk   中文输入用的输入法
vendor/tvcast.apk        电视端推流 App（可选，装了预览就不依赖 ADB）
Dockerfile / docker-compose.yml   容器部署
群晖部署.md          群晖 NAS 逐步部署 + 排障表 + 变更史
data/                运行时生成（证书、图标缓存、状态），不入库
```

---

## API（节选）

| 端点 | 作用 |
| --- | --- |
| `GET /api/health` | 健康检查，返回 `{ok,tv,ver,ui,started,up}` 与 `X-App-Ver` 头 |
| `GET /api/status` | 连接状态、预览/HTTPS 能力 |
| `POST /api/key` / `POST /api/text` | 发按键 / 输入文字 |
| `GET /api/apps` / `/api/app` / `/api/appdrawer` | 应用列表 / 启动应用 / 应用抽屉 |
| `GET /api/icon/<包名>` / `/api/ipicon` | 应用图标（懒加载 + 缓存） |
| `POST /api/ime/install\|activate\|restore` | 安装 / 切换 / 还原输入法 |
| `POST /api/search` / `/api/asr` | 搜片 / 语音识别 |
| `GET /api/nowplaying` | 当前播放 |
| `GET|POST /api/settings` | 设置读写 |
| `POST /api/connect` | 手动重连电视 |
| `GET /api/preview` / `POST /api/preview/kick` | 预览流 / 踢掉重连 |
| `POST /api/admin/restart` | 重启服务 |

设了 `AUTH_TOKEN` 时，以上 `/api` 请求都要带令牌。

---

## 许可

[MIT](LICENSE) © 2026 zwkit
