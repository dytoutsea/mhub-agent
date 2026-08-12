# MHub Agent

MHub Windows、macOS、Android 和 iOS 客户端的独立 monorepo。桌面端使用 Electron，移动端和共享界面使用 Expo；项目当前处于工程骨架阶段，尚未实现激活、控制 WSS 或代理数据转发。

## 当前边界

- Windows/macOS：Electron Main Process 将承载 AgentRuntime，Renderer 使用 Expo Web 导出。
- Android/iOS：第一期只在 App 前台运行，进入后台或锁屏时必须下线。
- 移动数据通道后续由 Kotlin/Swift 原生模块完成，业务字节不得经过 React Native JS Bridge。
- Relay 协议 v1 Schema 的权威仓库尚未决议，本仓库当前不定义该契约。
- 不包含 Android Foreground Service、iOS Network Extension、后台保活或真实代理逻辑。

## 目录

```text
apps/
  mobile/      Expo App 与 Expo Web Renderer
  desktop/     Electron Main、Preload 与打包配置
packages/
  shared/      平台无关状态类型
modules/       后续 Expo Native Module 边界
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

桌面开发需要两个终端。先启动 Expo Web，再启动 Electron Host：

```bash
npm run dev:web
npm run dev:desktop
```

完整验证包含 Biome、严格类型检查、单元测试、Expo 依赖兼容检查、Web 导出和 Electron 编译。

SDK 前置门禁工具和执行限制见 [`tools/sdk-poc/README.md`](./tools/sdk-poc/README.md)。PoC 默认只绑定回环地址、强制 SOCKS5 用户名密码并阻断非公网目标；真实 SDK 有副作用调用不包含在自动化脚本中。

## 安全约束

Electron 保持 `nodeIntegration: false`、`contextIsolation: true` 和 `sandbox: true`。长期设备凭证必须使用各平台安全存储，任何激活码、私钥、ticket、连接令牌、SOCKS5 凭证和业务正文都不得进入仓库、Renderer 存储或日志。

跨仓库接口以根元数据仓库中的 `architecture/CONTRACTS.md` 及后续接受的 Schema 为准。
