# MHub Agent

MHub Windows、macOS、Android 和 iOS 客户端的独立 monorepo。桌面端使用 Electron，移动端和共享界面使用 Expo。当前已实现 Node/Electron 控制链路、Android 前台数据通道，以及 Android/iOS 共用的移动激活、设备签名和控制 WSS 编排；iOS 原生数据通道仍在开发。

## 当前边界

- Windows/macOS：Electron Main Process 持有 AgentRuntime，Renderer 使用 Expo Web 导出。
- Android/iOS：第一期只在 App 前台运行，进入后台或锁屏时必须下线。
- Android 数据通道由 Kotlin 原生模块实现；iOS Swift 实现尚未完成。业务字节不得经过 React Native JS Bridge。
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

Android/iOS 激活与代理运行需要公开构建配置 `EXPO_PUBLIC_MHUB_AGENT_ACTIVATION_API_URL` 和 `EXPO_PUBLIC_MHUB_RELAY_CONTROL_URL`。前者必须是 `/agent-api/v1/activations:exchange` HTTPS 端点，后者必须是 `/agent/v1/control` WSS 端点。`EXPO_PUBLIC_*` 会进入客户端包，只能放公开地址，不能放激活码、credential、ticket、私钥或内部代理 URI。

移动端激活时生成 Ed25519 设备密钥，使用 Expo SecureStore 保存到 Android Keystore/iOS Keychain 保护的本机存储；每次控制 WSS 重连重新签名获取短期 ticket。当前不支持 Expo Go，需使用 Prebuild 后的开发客户端或原生构建。

桌面开发需要两个终端。先启动 Expo Web，再启动 Electron Host：

```bash
npm run dev:web
npm run dev:desktop
```

完整验证包含 Biome、严格类型检查、单元测试、Expo 依赖兼容检查、Web 导出和 Electron 编译。

### Electron Agent Runtime 开发配置

Electron Main Process 持有 Relay Agent 生命周期，Renderer 只通过版本化 IPC 获取快照、启动/停止和接收脱敏状态事件。桌面激活和安全存储已在当前切片接入，后续再补托盘交互和正式配置分发。

当前桌面激活入口为 `agent.activate({ activationCode })`。Main 使用 Electron `safeStorage` 保存设备私钥和一次性 refresh credential 的加密配置；需要设置 `MHUB_AGENT_ACTIVATION_API_URL` 与 `MHUB_RELAY_CONTROL_URL` 才会启用该入口。

隔离本地协议测试可通过被忽略的进程环境变量注入配置：`MHUB_RELAY_CONTROL_URL`、`MHUB_PROXY_ID`，以及静态测试 ticket `MHUB_RELAY_TICKET`，或动态 ticket 组合 `MHUB_AGENT_API_URL`、`MHUB_CREDENTIAL_ID`、`MHUB_DEVICE_PRIVATE_KEY`。这些值不会展示或写入日志。

SDK 前置门禁工具和执行限制见 [`tools/sdk-poc/README.md`](./tools/sdk-poc/README.md)。PoC 默认只绑定回环地址、强制 SOCKS5 用户名密码并阻断非公网目标；真实 SDK 有副作用调用不包含在自动化脚本中。

## 安全约束

Electron 保持 `nodeIntegration: false`、`contextIsolation: true` 和 `sandbox: true`。长期设备凭证必须使用各平台安全存储，任何激活码、私钥、ticket、连接令牌、SOCKS5 凭证和业务正文都不得进入仓库、Renderer 存储或日志。

跨仓库接口以根元数据仓库中的 `architecture/CONTRACTS.md` 及后续接受的 Schema 为准。
