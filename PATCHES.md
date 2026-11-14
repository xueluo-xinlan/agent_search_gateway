# 本部署相对于上游 master 的分叉记录

- **基线**：`djasdh/agent_search_gateway` @ `c7f44d5`（2026-11-01）
- **部署方式**：文件复制（本目录**不是** git 仓库），升级靠整目录替换
- **上游最新**（2026-11-14 核对）：`d7e1300` v0.2.3（2026-11-10），领先 13 个提交
- **本目录版本号**：`package.json` 仍写 0.1.0（未跟上游发版号）

## 九处本地补丁（合并上游时必须重放）

| # | 文件 | 补丁 | 为什么上游不能直接用 |
|---|---|---|---|
| 1 | `src/index.ts` | `startStdioServer` + `--stdio`/`GATEWAY_TRANSPORT=stdio` + Logger `useStderr` | master 删掉了 stdio，但 Hermes 以 `--stdio` 拉起，日志必须走 stderr 否则污染 JSON-RPC |
| 2 | `src/search/fallback.ts` + `config.ts` + `service.ts` | 上游全部批次失败时补 Tavily → DDG 直连兜底 | master 已移除该能力，但本部署依赖 |
| 3 | `src/config.ts` | `getProjectRoot()` + `defaultConfigPath()` 四级回退 | master 只认 cwd，Hermes 从 `~/.hermes` 拉起时找不到 `gateway.yaml` |
| 4 | `src/config.ts` + `filter/domain-filter.ts` | `ads+porn` 档补 enum 与 `HOSTS_SOURCES` | zod 曾静默降级为 `ads`，防护面少一半 |
| 5 | `src/health.ts` | FlareSolverr `enabled:false` 时返回 `status:"disabled"` 且不探测 | 否则报假 down |
| 6 | `src/search/service.ts` | METRICS 自动落盘（`METRICS_FILE`，默认 `/var/lib/research/runs.jsonl`） | master 只打日志，不做持久化 |
| 7 | `src/search/embedding/store.ts` | `corpus.knn` 增加 `expires_at > ?` | 字段有但代码不校验，过期条目仍会被召回 |
| 8 | `src/fetch/service.ts` | `isShellJs` 改「CF 特征优先」 | **上游 bug**：长度门限在最前，2KB 以上验证页判非壳 → 把验证页当正文（见 `__tests__/fetch-service.test.ts` 的 `/shell-big`） |
| 9 | `src/search/service.ts` | 反向图搜时若 searxng 无图片引擎则跳过它 | **上游 bug**：本机 SearXNG 无 tineye，图片 URL 被当关键词搜，返回无关文本污染结果集 |
| 10 | `src/fetch/wayback.ts` + `service.ts` + `cache.ts` | Wayback 兜底：404/410 时查 archive.org 存档，命中则返回存档正文并标注来源 | 上游无此档位（借鉴 `TadMSTR/searxng-mcp` 的 tier4） |
| 11 | `src/health.ts` + `health-state.ts` | 健康四态 `on/down/unverified/off`，落盘 `lastOkAt` 区分「从未通过」与「曾通过后挂了」 | 上游只有 `up/down/disabled`，排障分不清配置错还是服务挂 |

配套测试：`__tests__/fetch-service.test.ts`（`/shell-big` 用例）、`__tests__/reverse-image.test.ts`（mock `/config` 需含 tineye + 「无 tineye 时跳过」用例）、`__tests__/wayback.test.ts`（快照/无快照/403 不触发/开关关闭）、`__tests__/health.test.ts`（四态各自成立）。全量 **365** 用例。

## 上游 `c7f44d5..d7e1300` 的 13 个提交，分成三类

### 1. 架构重构（不建议跟）

`48376cc refactor(settings)`：`gateway.yaml` 不再接受密钥，密钥迁到 `secrets.yaml` + 环境变量；删除扁平 `GatewayConfig`，各组件只接收自己的切片；配置改为 `.strict()` 严格校验。

**对本部署净收益为负**：没有行为改变，但上表 9 处补丁全部要按新结构重写（`config.ts` 甚至被删除，改成 `src/settings/` 五个文件）。

### 2. 新功能（按需，成本中等）

`bfd6093 feat(weibo)`：微博搜索/热搜（`categories=weibo` / `weibo_hot`）+ 取件插件（`?weibo=post|comments|user|user-posts`），约 800 行。

**依赖外部 CLI（`OpenCLI`）**，不是纯 HTTP 实现。对技术检索场景价值有限；要移植得连 CLI 一起装。

### 3. 发布工程（与本部署无关）

一键安装器、Windows zip 打包、`irm | iex` 引导、网关自更新、macOS runner 修正 —— 面向普通用户产出的安装体验，我们是源码部署。

## 上游没有修的

`c7f44d5..d7e1300` 期间，`src/fetch/service.ts` 与 `src/search/service.ts` 的实质改动**只有把参数从 `config` 换成切片**，没有一处行为修复。上表第 8、9 两项 bug 在上游仍然存在。

## 什么时候值得再看上游

- 上游开始修 `fetch` / `search` 的**行为** bug（而非只重构参数传递）
- 上游加上本部署缺的能力（如 SearXNG 侧 tineye、小红书/知乎采集）
- 上游的 `secrets.yaml` 方案被其他工具复用，需要对齐格式

## 合并上游的标准流程

1. `git diff c7f44d5..<新tag> -- src/` 先看是否碰了 `fetch/service.ts`、`search/service.ts`、`config.ts`
2. 备份当前目录：`cp -a /opt/agent_search_gateway /opt/agent_search_gateway.bak-<日期>`
3. 用干净上游覆盖 `src/ dist/ package.json`，**保留** `gateway.yaml`、`data/`、`scripts/`
4. 按上表 9 项逐一重放，每放一项跑对应测试
5. `npx vitest run` 必须全过，再 `npm run build`，最后重启并看 `health`
