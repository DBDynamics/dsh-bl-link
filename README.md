# dsh-bl-link

把 **B-Link BLE 烧录器**接进 **DSH Go**：查询状态、烧固件、透传目标板串口。

插件跑在 DSH 引擎里，通过 B-Link App 内置的本地 HTTP 桥（`127.0.0.1:8737`）操作烧录器。
写操作永远不直接写 Flash：桥只负责把任务交给 App，由 App 走既有的 BLE 流程。

## 安装（3 步）

1. **装插件**（在 DSH Go 的终端里）：

   ```bash
   dsh plugin --profile web add github:DBDynamics/dsh-bl-link
   ```

   国内网络拉取 GitHub 经常 `GnuTLS recv error`，换成加速前缀（2026-11 实测可用）：

   ```bash
   dsh plugin --profile web add git+https://gh-proxy.org/https://github.com/DBDynamics/dsh-bl-link.git
   ```

   备用前缀：`ghfast.top`、`ghproxy.net`，拼法同上。
   若 dsh 不认 `git+` 前缀，先克隆再按本地目录装：

   ```bash
   git clone --depth 1 https://gh-proxy.org/https://github.com/DBDynamics/dsh-bl-link.git ~/dsh-bl-link
   dsh plugin --profile web add ~/dsh-bl-link
   ```

2. **重启内核**：设置 → 插件 → dsh-bl-link → 「重启内核以重载」。

3. **打开 B-Link App 并连上烧录器**（只需这一次）。在 B-Link App 里点一次「扫描设备」→ 选中你的 `B-Link-XXXX`。
   之后 App 被系统清掉也不用管：插件调用时会把 App 拉起来，App 自己扫描并连回上次的设备。

不需要填令牌：B-Link App 启动时会把自己导出的桥信息写到
`/sdcard/Download/DSH-GO/blink-bridge.json`，插件默认 `token=auto` 直接读它。

## 后台服务版（推荐）

`serviceB-Link` 是一个独立的后台服务 App（包名 `com.blink.service`），桥、BLE、烧录全部在服务里，
不依赖界面，因此插件调用时**不会弹出任何窗口**。

1. 安装 `serviceB-Link` 的 APK，打开一次：授权蓝牙通知 → 加入电池优化白名单 → 允许自启动；
2. 它会把自己的桥信息导出到 `/sdcard/Download/DSH-GO/blink-service.json`，端口 **8738**；
3. 插件 `token=auto` 时优先读这个文件（服务版存在就用 8738，否则退回 App 的 8737），无需改配置。

进程被系统杀掉后，插件用下面的命令无界面拉起：

```bash
am start-foreground-service -n com.blink.service/.BlinkService
```

服务自己会扫描并连回上次的设备。前提是已加入电池优化白名单，否则系统会拦下后台启动前台服务。

桥接口（都必须带 `X-Token` 头）：

| 接口 | 作用 |
| --- | --- |
| `GET /status` | 连接 / 目标 / 阶段 / 进度 / 上次结果 |
| `POST /burn` | 烧录（`confirm:true`，支持 url 或 base64） |
| `POST /uart/open` `write` `read` `close` | 目标板串口透传 |
| `POST /service/restart` | 原地重启：断开链路、重新扫描并连回上次设备 |
| `POST /service/stop` | 停止后台服务（先答复再退出，之后可用上面的命令唤醒） |

`/service/*` 在烧录进行中会返回 `{"ok":false,"error":"busy: 正在烧录"}`。

## 验证

在 DSH Go 里说一句「B-Link 现在什么状态」，应看到设备名、地址、`idle` 等真实数据。

链路不通时逐层看：

| 现象 | 原因 |
| --- | --- |
| 对话里没有 `blink_*` 工具 | 插件没装/没启用；或没重启内核 |
| `没有配置本地桥令牌` | B-Link App 没运行过（桥信息文件没生成），可在插件设置里手填 token |
| `令牌无效` | App 重装过、token 变了；重新打开 App 让文件刷新，或手填新 token |
| 连接被拒 / 超时 | B-Link App 没在运行，或 DSH 引擎不在同一台手机上（`127.0.0.1` 不共享） |
| `已尝试拉起 B-Link App 但没有权限` | 手机把「后台弹出界面」拦了。给 DSH Go 开「显示在其他应用上层」或允许后台弹出，保持对话时 DSH Go 在前台也能正常拉起 |
| 唤醒后仍显示未连接 | B-Link 烧录器没上电/不在范围内；App 已在扫描，等它连回或手动在 App 里连一次 |
| 烧录报「超过 252KB」 | B-Link 暂存区上限，换更小的镜像 |

## 配置

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `bridgeUrl` | `http://127.0.0.1:8737` | 手机本机引擎用默认值即可 |
| `token` | `auto` | `auto` = 读 `bridgeInfoPath` 里的令牌；也可手填 |
| `bridgeInfoPath` | `/sdcard/Download/DSH-GO/blink-bridge.json` | B-Link App 导出的桥信息 |
| `timeoutMs` | `15000` | 单次请求超时 |

都是 volatile 配置，改完不需要重启插件。

## 工具

| 工具 | 用途 |
| --- | --- |
| `blink_status` | 连接/目标/阶段/进度/上次结果，含 `ready` 字段 |
| `blink_burn` | 烧固件：`url` 直链或 `file` 本机 .bin（≤252KB），必须 `confirm:true` |
| `blink_uart_open` | 打开目标板串口桥（默认 115200 8N1，自动静音本机日志） |
| `blink_uart_write` | 发数据（`newline:true` 补 CRLF，单次 ≤8KB） |
| `blink_uart_read` | 续读（不传 `since` 自动接上次，一次 ≤4KB） |
| `blink_uart_wait` | 等正则匹配到再返回 |
| `blink_service_restart` | 重启后台服务的连接链路（断开重扫、连回上次设备；不弹界面） |

## 限制

- 单次镜像 ≤ **252KB**（B-Link 暂存区 `IMAGE_MAX_SIZE = 0x3F000`）
- 目标支持：CH32V007 / CH32V208 / STM32F0 / STM32F103
