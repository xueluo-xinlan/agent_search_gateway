# 本部署相对于上游 master 的分叉记录

- **当前版本**：**0.3.5**（2026-11-15 完成升级，前身是 0.1.0 分叉）
- **上游仓库**：`djasdh/agent_search_gateway`
- **部署方式**：文件复制（本目录**不是** git 仓库），升级靠整目录替换
- **工作副本**：`$ASG_WORK`（升级与重放补丁在这里做，验证通过后同步 dist/src 到本目录）

## 十四处本地补丁（已全部重放到 0.3.5 新结构）

0.1.0 时代这些补丁散在 `config.ts` 里；0.3.5 把 `config.ts` 拆成了 `src/settings/` 七个文件，
下面标注了每处补丁在 0.3.5 的落点。

| # | 0.3.5 落点 | 补丁 | 为什么上游不能直接用 |
|---|---|---|---|
| 1 | `src/index.ts` + `src/server.ts` + `src/logger.ts` | `startStdioServer` + `--stdio`/`GATEWAY_TRANSPORT=stdio` + Logger `useStderr` | **上游 0.3.x 只有 HTTP 传输**，而 Hermes 以 `--stdio` 拉起；日志不走 stderr 会污染 JSON-RPC |
| 2 | `src/search/fallback.ts` + `service.ts` + `settings/schema.ts` | 上游全部批次失败时补 Tavily → DDG 直连兜底 | 上游已移除该能力；searxng 是单点，挂了检索就归零 |
| 3 | `src/settings/load.ts` | `getProjectRoot()`（向上找 `package.json`）+ `defaultConfigPath()` 四级回退 | 上游只认 `cwd`，Hermes 从 `<MCP 客户端工作目录>` 拉起时找不到 `gateway.yaml` |
| 4 | `settings/schema.ts` + `filter/domain-filter.ts` | `ads+porn` 档补 enum 与 `HOSTS_SOURCES` | 上游删掉了该档，且 `full` 是 fakenews 列表**不含 porn**，防护面少一半 |
| 5 | `src/health.ts` | FlareSolverr `enabled:false` 时返回 `status:"off"` 且不探测 | 否则 health 永远显示一个假的失败态，排查时把「配置关闭」误读成「服务挂了」 |
| 6 | `src/search/service.ts` | METRICS 自动落盘（`metricsFile`，默认 `<metrics 落盘路径>`） | 上游只打日志不做持久化；靠「记得记录」的约束必然失效 |
| 7 | `src/search/embedding/store.ts` | `corpus.knn` 查询增加 `expires_at > ?` | 字段有但代码不校验，过期条目仍会被召回 |
| 8 | `src/fetch/service.ts` | `isShellJs` 改「CF 特征优先」 | **上游 bug**：长度门限在最前，2KB 以上验证页判非壳 → 把验证页当正文 |
| 9 | `src/search/service.ts` | 反向图搜时若 searxng 无图片引擎（tineye）则跳过它 | **上游 bug**：图片 URL 被当关键词搜，返回无关文本污染结果集 |
| 10 | `src/fetch/wayback.ts` + `service.ts` + `cache.ts` + `settings/schema.ts` | Wayback 兜底：404/410 时查 archive.org 存档，标注来源 | 上游无此档位 |
| 11 | `src/health.ts` + `health-state.ts` | 健康四态 `on/down/unverified/off` + `lastOkAt` 落盘 | 上游只有 `up/down`，排障分不清配置错还是服务挂 |
| 12 | `src/server.ts` | `getExtensions()` 用 `getProjectRoot()` 而非 `process.cwd()` | **上游 bug**：Hermes 从 `<MCP 客户端工作目录>` 拉起时扫到空的 `data/extensions`，第三方插件静默变成「0 个已加载」 |
| 13 | `src/search/clean.ts` | `cleanResults` 放行 `file:` 协议 | 上游只认 `http:`/`https:`，additive 本地书库插件返回的 `file://` 路径在清洗阶段被静默丢弃（插件加载正常、结果命中正常，只是最后一步消失，排查成本极高） |
| 14 | `src/search/service.ts` | additive 源保底：每个 `additive` provider 至少保留 1 条结果，满了就替换末尾条目 | MMR 多样性重排（`mmr_lambda=0.7`）按语义相似度压制同题材结果，本地书源 score 0.90 仍被压到第 7 位，`num_results=6` 时完全消失——用户搜不到自己的书，且没有任何提示 |

## 第三方插件

| 插件 | 位置 | 作用 |
|---|---|---|
| `tgbooks` | `<插件源目录>`（装到 `data/extensions/tgbooks/`） | `gateway.search:tgbooks` 搜索源，读 `<书源索引目录>/data/index.db` |
| `inbox` | `data/extensions/inbox/`（手写，无 install.sh） | `gateway.search:inbox` 搜索源，读 `inbox-index.json`；**依赖补丁 13**，否则结果在清洗阶段被丢弃 |

**安装**：`<插件源目录>/install.sh [网关根]`（构建 → 校验 manifest → 装目录 → 自检导出名）。

**两种触发方式**：

| 调用 | 行为 |
|---|---|
| 不带 `categories` | **叠加**：网页结果 + 书源结果并列（引擎字段里能同时看到 `bing`/`yandex`/`tgbooks`） |
| `categories=tgbooks` | **独占**：只返回书源结果 |

这靠新加的 `additive` 约定实现：`src/search/service.ts` 里，标了 `additive: true` 的 provider
在「没显式点名本类别」时不独占，收集到 `additiveSources`，在 searxng 结果之后用 `unionResults` 合并；
一旦 `categories` 显式包含该 provider 的 `name`，仍然独占。

**不要**把它写进 `search.engines.resident` —— 那会顶掉 searxng 的引擎分档，实测直接报 `no engine available`。

## 兜底检索的通道顺序（2026-11-15 实测重排）

`Tavily（有 key） → Bing HTML → DuckDuckGo HTML`

| 通道 | 实测结果 |
|---|---|
| Tavily | 无 key（旧配置里的 `tavily_api_key` 本来就是空值），跳过 |
| **Bing HTML** | **HTTP 200，10 条可解析**（`li.b_algo`），英文/中文查询都通；偶发返回变体页面时靠 2 次重试兜住 |
| DuckDuckGo | 两个 HTML 端一律 **HTTP 202 挑战页**（14KB、0 结果），`res.ok` 为真但内容是壳 → 降为最后一位 |
| 搜狗 | 首次 420KB 有 12 个结果节点，复测 405B 空页 → 不稳定，未接入 |
| 360 / Yandex / searx.be | 302 跳转或 0 结果，不可用 |

Bing 的结果链接是 `bing.com/ck/a?...&u=a1<base64url>` 跳转壳，`decodeBingUrl()` 负责还原，
否则每条结果都要多跳一次。

## 测试

全量 **624 通过 / 1 跳过**（共 625）。

补丁带来的行为变化同步改了测试：

- `__tests__/health.test.ts`：断言 `up` → `on`；每个用例用独立 `HERMES_HEALTH_STATE` 文件（四态依赖「是否曾成功过」，共用文件会串）
- `__tests__/reverse-image.test.ts`：mock 的 `/config` 默认返回 `tineye + exaapi`（否则补丁 9 会跳过 searxng，原有用例断言不到 forwarded query）；两例「故意让 searxng 失败」的用例关掉 `fallback`（否则兜底真联网，把断言换成网页结果）
- `__tests__/service.test.ts`：断言「上游失败必须报错」的两例关掉 `search.fallback`
- `__tests__/server.test.ts`：base 配置里 `search.fallback: false`（原因同上，searxng 指向 `127.0.0.1:1` 时兜底会真联网）

**原则**：断言的是「上游失败」这条路径时，必须先把兜底关掉 —— 兜底成功会让 `ok` 变 `true`，
测试表面失败、实际是补丁在正常工作。

## 自检脚本

```bash
$ASG_ROOT/verify-patches.sh              # 检查本目录
$ASG_ROOT/verify-patches.sh $ASG_WORK  # 检查指定根
```

逐项 grep 上面 12 处补丁 + additive 机制的标志性代码，**23 项全在才退出 0**。
正常目录、缺陷目录、不存在目录三种情况都实测过（退出码分别 0 / 1 / 1）。

**它能证明什么、不能证明什么**：

- 能：某处补丁的代码有没有被后续改动覆盖掉。升级 or 大改之后跑一次，比人眼可靠。
- 不能：行为是否正确。`grep` 到 `startStdioServer` 不等于 stdio 真能用。
  真判据仍是实测四件套（doctor 的 config、启动日志的 engine 数量、3000 端口不监听、health 三态）。

**为什么需要它**：本次升级过程中出现过两次「测试全绿但功能其实是坏」的情况 ——
① 改 schema 的 `ads+porn` 时漏了 CLI 里独立的 `LEVELS` 常量，单元测试覆盖不到，
只有跑 `asg adlist update` 才暴露；② 只同步了 `dist/` 没同步 `src/`，功能在跑但源码对不上。
两类问题都靠人眼看不出来。

## 升级到 0.3.5 时踩到的坑

1. **`gateway.yaml` 不再接受密钥** —— 5 个字段（`gateway.token`、`embedding.api_key`、`saucenao.api_key`、`browser.proxy_password`、`tavily_api_key`）必须迁到 `secrets.yaml`；`tavily` 在 0.3.5 已无对应位置，改由环境变量 `TAVILY_API_KEY` 提供。
2. **`search.engines` 不再是平铺数组** —— 必须写 `engines: { resident: [...], rotating: [...] }`。
3. **`ad_filter.level` 的 `ads+porn` 被删** —— 只剩 off/ads/ads+tracking/full。
4. **`search.fallback`、`search.tgbooks` 等自定义键被 strict schema 拒绝** —— 必须先在 `settings/schema.ts` 声明。
5. **`scripts/install/http.mjs` 不在 dist 里** —— 只复制 `dist/` 会导致 `ERR_MODULE_NOT_FOUND`，`scripts/` 必须一起同步。
6. **`getProjectRoot()` 层级变了** —— 0.3.5 的编译产物在 `dist/settings/`，比 0.1.0 的 `dist/` 深一级，硬编码 `".."` 会错；改为向上找 `package.json`。
7. **stdout 检查会骗人** —— `--stdio` 在 0.3.5 是无效参数（被忽略），若只看「能连 3000 端口」会误判成 stdio 可用。判据是：**3000 不应被监听** + `grep -c stdio dist/index.js` 非 0。

## 什么时候值得再看上游

- 上游修 `fetch` / `search` 的**行为** bug（第 8、9、12 项至今未修）
- 上游自己补回 stdio 传输与插件目录的 root 解析
- 上游加上本部署缺的能力（SearXNG 侧 tineye、小红书/知乎采集）

## 合并上游的标准流程

1. `git diff <旧tag>..<新tag> -- src/` 先看是否碰了 `fetch/service.ts`、`search/service.ts`、`settings/`、`server.ts`
2. 备份：`cp -a $ASG_ROOT $ASG_ROOT.bak-<日期>`（188 MB）
3. 克隆新 tag 到 `/opt/asg-XXX`，`npm ci && npm run build`
4. 迁移 `gateway.yaml`（密钥 → `secrets.yaml`，engines 结构，自定义键进 schema）
5. 按上表 12 项逐一重放，每放一项 `npm run build`
6. `npx vitest run` 必须全过
7. 同步 `dist/` **和** `scripts/` 到生产目录，保留 `data/`、`gateway.yaml`、`secrets.yaml`
8. 从 `<MCP 客户端工作目录>` 拉起验证：`engine N 个` 不为 0、3000 端口未监听、`health` 四态正常

## 回滚

```bash
cp -a $ASG_ROOT.bak-<timestamp>/. $ASG_ROOT/
```
