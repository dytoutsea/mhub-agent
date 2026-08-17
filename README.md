# MHub Agent

MHub Windows、macOS、Android 和 iOS 客户端的独立 monorepo。桌面端使用 Electron，移动端和共享界面使用 Expo。当前已实现 Node/Electron 控制链路、桌面 Renderer 操作界面、Android/iOS 前台原生数据通道，以及移动端激活、设备签名和控制 WSS 编排。

## 当前边界

- Windows/macOS：Electron Main Process 持有 AgentRuntime，Renderer 使用 Expo Web 导出。
- Android/iOS：第一期只在 App 前台运行，进入后台或锁屏时必须下线。
- Android 数据通道由 Kotlin 实现，iOS 数据通道由 Swift、Network.framework 和 `URLSessionWebSocketTask` 实现。业务字节不得经过 React Native JS Bridge。
- Relay 协议 v1 Schema 由 `mhub-relay` 持有，本仓库维护严格消费者实现和兼容测试。
- 不包含 Android Foreground Service、iOS Network Extension 或后台保活。

## 目录

```text
apps/
  mobile/      Expo App 与 Expo Web Renderer
  desktop/     Electron Main、Preload 与打包配置
packages/
  shared/      平台无关状态类型
  relay-protocol/ Relay v1 严格消费者
  mobile-runtime/ 移动控制通道与设备身份协议
modules/       Expo 原生数据通道边界
tools/
  sdk-poc/     SDK SOCKS5、DNS、端口和断线行为验证工具
```

## 本地开发

需要 Node 24 和 npm 11：

```bash
npm ci
npm run verify
```

### M1 Node Agent

`tools/relay-agent` 是 M1 数据链路 CLI，也是后续 Electron Main Process 复用的运行时核心。它连接 Relay control WebSocket，收到 `OPEN_REQUEST` 后校验目标 IP、建立目标 TCP 和每流 data WebSocket，并在 Node 运行时内执行二进制转发和背压。

Node Agent 默认通过设备签名向 `mhub-server` 获取短期 relay session ticket。配置 `MHUB_AGENT_API_URL`、`MHUB_AGENT_CREDENTIAL_ID` 和 `MHUB_AGENT_DEVICE_PRIVATE_KEY`（PKCS#8 Ed25519 私钥的 Base64URL）后，启动时会调用 `POST /agent-api/v1/session-tickets`，请求使用 `X-Credential-Id`、`X-Timestamp`、`X-Nonce` 和 `X-Signature` 认证。`MHUB_AGENT_SESSION_TICKET` 仅保留给隔离的协议测试，不应作为生产配置。

```bash
cp .env.example .env
# 在 shell 或本地 secret runner 中加载配置后：
npm run relay-agent
```

默认只允许公网 IP，拒绝域名、回环和私网地址。`MHUB_AGENT_ALLOW_PRIVATE_TARGETS=true` 只用于隔离的本机 E2E。

构建 `mhub-relay` 后可执行跨仓库本机链路测试：

```bash
MHUB_RELAY_JAR=/absolute/path/to/mhub-relay.jar npm run test:relay-e2e
```

测试使用临时自签证书覆盖 WSS、成功的 IPv4 出口、错误 SOCKS5 凭证和 domain address 拒绝；临时进程、日志、证书和测试凭证在退出时删除。

启动移动端/浏览器界面：

```bash
npm run dev:mobile
```

Android/iOS 激活与代理运行需要公开构建配置 `EXPO_PUBLIC_MHUB_AGENT_ACTIVATION_API_URL`、`EXPO_PUBLIC_MHUB_RELAY_CONTROL_URL` 和 `EXPO_PUBLIC_MHUB_RELEASE_CHANNEL`。正式通道前者必须是 `/agent-api/v1/activations:exchange` HTTPS 端点，后者必须是 `/agent/v1/control` WSS 端点；`dev` 通道可使用明确配置的开发服 HTTP/WS。`EXPO_PUBLIC_*` 会进入客户端包，只能放公开地址和通道名，不能放激活码、credential、ticket、私钥或内部代理 URI。

移动端激活时生成 Ed25519 设备密钥，使用 Expo SecureStore 保存到 Android Keystore/iOS Keychain 保护的本机存储；每次控制 WSS 重连重新签名获取短期 ticket。当前不支持 Expo Go，需使用 Prebuild 后的开发客户端或原生构建。

iOS 原生确定性门禁可在 macOS 执行：

```bash
npm run mobile:ios:native:test
```

该门禁对 Swift 数据流源码执行类型检查，并验证 IP 字面量/保留地址策略、WSS 路径编码、严格 `DATA_HELLO`/`DATA_ACCEPTED` 和错误码脱敏。完整 iOS App 编译、签名和真机数据转发仍需要当前 Xcode、CocoaPods 和开发设备。

桌面开发需要两个终端。先启动 Expo Web，再启动 Electron Host：

```bash
npm run dev:web
npm run dev:desktop
```

完整验证包含 Biome、严格类型检查、单元测试、Expo 依赖兼容检查、Web 导出和 Electron 编译。

### 平台打包（当前为 unsigned preview）

桌面端先导出 Expo Web Renderer，再由 Electron Builder 生成 Windows NSIS `.exe` 和 macOS Universal `.dmg`：

```bash
npm run package:unsigned
```

GitHub Actions 的 macOS job 使用 Universal 架构打包，同时包含 `x86_64` 与 `arm64`，可在 Intel Mac 和 Apple Silicon Mac 上运行。需要在 macOS 本机生成相同产物时执行：

```bash
npm run build:mobile
npm run package:unsigned:mac:universal --workspace @mhub/desktop
```

产物位于 `apps/desktop/release/`，只用于内部预览或开发环境验收。GitHub Actions 按平台仅上传 Windows `.exe` 或 macOS `.dmg`，不上传解包目录、macOS ZIP、blockmap 或更新元数据。`dev` 构建从 Repository Variables `MHUB_DEV_AGENT_ACTIVATION_API_URL` 和 `MHUB_DEV_RELAY_CONTROL_URL` 内置开发服地址，`main` 构建使用对应的 `MHUB_PROD_*` Variables 内置生产地址；配置缺失或正式地址不是 HTTPS/WSS 时构建直接失败。地址是公开构建信息，不得在这些 Variables 中放入凭据。当前构建明确关闭证书自动发现，不配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、Apple Developer 证书或 notarization，因此不能宣称通过 Windows SmartScreen 或 macOS Gatekeeper。Universal 仅解决 CPU 架构兼容，不替代签名或公证。`MHUB_UPDATE_FEED_URL` 仅在已打包应用中启用，且必须为 HTTPS；更新检查、下载和安装均由 Electron Main/托盘发起，Renderer 不直接访问更新服务。

移动端的 `apps/mobile/eas.json` 已定义 development、preview（Android APK）和 production（Android AAB）配置。`Mobile CI` 在 `dev` 推送、手动触发或移动端相关 Pull Request 时运行：`dev` 推送和手动运行使用 GitHub Actions Secrets 中的 Android keystore、密码及 alias 生成 `mhub-agent-android-signed` 安装包；Pull Request 不接触签名 Secret，只上传 unsigned 编译验证包。iOS 仍上传 unsigned Simulator `.app` 压缩包，只能安装到模拟器，不能安装到真机。Artifact 保留 14 天。

Android CI 签名需要仓库 Secrets `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS` 和 `ANDROID_KEY_PASSWORD`。keystore 只在 Runner 临时目录恢复，签名后立即删除；签名文件和密码不得写入仓库、日志或 Expo 公共配置。EAS credentials、iOS 真机签名和商店上传仍属于后续发布阶段。

### Electron Agent Runtime 开发配置

Electron Main Process 持有 Relay Agent 生命周期，Renderer 只通过版本化 IPC 获取快照、激活、启动/停止和接收脱敏状态事件。桌面 Renderer 已支持激活码输入、代理 ID 复制、状态与活动连接展示、启停控制，以及最多 100 条脱敏状态事件。关闭窗口后 Agent 继续由系统托盘托管；正式配置分发、品牌托盘图标和安装包平台验收仍待完成。

当前桌面激活入口为 `agent.activate({ activationCode })`。Main 使用 Electron `safeStorage` 保存设备私钥和一次性 refresh credential 的加密配置；需要设置 `MHUB_AGENT_ACTIVATION_API_URL` 与 `MHUB_RELAY_CONTROL_URL` 才会启用该入口。

生产构建通过受限的 `mhub://renderer/` 安全协议加载 Expo Web 静态资源，只允许访问打包后的 Renderer 目录。Renderer 不导入 Electron、Node、文件系统、Socket 或凭证 API；Preload 之外运行页面时会显示宿主不可用状态并禁用敏感操作。

隔离本地协议测试可通过被忽略的进程环境变量注入配置：`MHUB_RELAY_CONTROL_URL`、`MHUB_PROXY_ID`，以及静态测试 ticket `MHUB_RELAY_TICKET`，或动态 ticket 组合 `MHUB_AGENT_API_URL`、`MHUB_CREDENTIAL_ID`、`MHUB_DEVICE_PRIVATE_KEY`。这些值不会展示或写入日志。

SDK 前置门禁工具和执行限制见 [`tools/sdk-poc/README.md`](./tools/sdk-poc/README.md)。PoC 默认只绑定回环地址、强制 SOCKS5 用户名密码并阻断非公网目标；真实 SDK 有副作用调用不包含在自动化脚本中。

## 安全约束

Electron 保持 `nodeIntegration: false`、`contextIsolation: true` 和 `sandbox: true`。长期设备凭证必须使用各平台安全存储，任何激活码、私钥、ticket、连接令牌、SOCKS5 凭证和业务正文都不得进入仓库、Renderer 存储或日志。

跨仓库接口以根元数据仓库中的 `architecture/CONTRACTS.md` 及后续接受的 Schema 为准。
