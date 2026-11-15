# 第三方扩展：声明与安装

本文说明第三方插件（extension）的 manifest、发布资产、安装目录与 `asg extensions` 命令。

> **当前范围**：插件声明、安装薄层与运行时加载。网关启动（或 `asg engines list`）时会扫描
> `data/extensions` 并 import 已安装插件；安装命令本身仍**不会重启**网关，需要重启一次让新插件生效。
> 权限与沙箱仍留到后续版本。

## 1. 安装目录与状态

- 安装根目录：`<root>/data/extensions/<id>/`
- **目录存在即视为已安装**，不额外维护注册表或数据库；目录名必须与 manifest 的 `id` 一致。
- 安装过程中会短暂出现 `.staging-*` 与 `.trash-*` 目录；命令结束后会清理。
- 卸载只删除 `data/extensions/<id>`，不修改 `gateway.yaml` / `secrets.yaml`。
- `asg extensions list` 遇到损坏的安装目录时只把该条标记为错误（JSON 里有 `error` 字段），不会让整条命令失败。

`bilibili`、`weibo`、`cnki` 是官方插件 id：核心不再内置对应实现，需通过
`asg extensions install` 安装官方插件仓库；安装后由扩展机制加载。

## 2. manifest：`asg-plugin.json`

插件根目录必须包含 `asg-plugin.json`，字段严格校验（未知字段直接报错）：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | 3–64 位小写字母/数字/`.` `_` `-`，首尾必须是字母或数字；安装目录名必须与它一致 |
| `name` | 是 | 1–80 个字符的显示名 |
| `version` | 是 | 语义化版本，如 `1.2.3`、`1.2.3-beta.1`；必须与 Release tag 去掉 `v` 后一致 |
| `api_version` | 是 | 当前只接受字面量 `1` |
| `provides` | 是 | 非空数组，元素只能是 `"search"` / `"fetch"`，不能重复 |
| `entry` | 是 | 单个 `.mjs` / `.js` 文件名；不能含 `/`、`\`、`..`，不能是绝对路径 |
| `platform` | 否 | 小写字母/数字/`-`；作为 fetch 插件的平台回退，缺省用 `id` |
| `description` | 否 | 任意字符串 |

示例：

```json
{
  "id": "example-fetch",
  "name": "Example Fetch Plugin",
  "version": "0.1.0",
  "api_version": 1,
  "provides": ["fetch"],
  "entry": "index.mjs",
  "description": "示例：接管 example.com 的抓取"
}
```

## 3. `provides` 的语义

| 值 | 含义 | 运行时约定 |
| --- | --- | --- |
| `search` | 提供搜索源/搜索计划 | 从 `entry` 读取命名导出 `engine` |
| `fetch` | 提供抓取实现 | 从 `entry` 读取命名导出 `fetch` |
| `["search", "fetch"]` | 同时提供两类能力 | 同一文件可同时导出 `engine` 与 `fetch` |

`provides` 同时决定运行时校验：`fetch` 必须导出带 `match` / `fetch` 函数的对象，
`search` 必须导出带 `id` / `group` / `name` / `runtime` 的对象。导出缺失或类型不符时，
该插件会被跳过并在日志中告警，不影响其它插件与内置实现。

## 4. 发布资产

一个插件 Release（推荐 tag 为 `v<version>`，例如 `v0.1.0`；安装器也兼容不带 `v` 的 tag）至少包含三个资产：

| 资产 | 必填 | 说明 |
| --- | --- | --- |
| `asg-plugin.json` | 是 | manifest 本体 |
| `index.mjs`（或 manifest `entry` 指定的文件名） | 是 | 单文件 ESM 产物；不能依赖同目录其它文件 |
| `SHA256SUMS` | 是 | `sha256sum` 格式，必须覆盖 manifest 与 entry |

生成并发布示例：

```bash
npm ci
npm run build
sha256sum index.mjs asg-plugin.json > SHA256SUMS
gh release create v0.1.0 index.mjs asg-plugin.json SHA256SUMS
```

安装器会：

1. 解析 GitHub Release（指定版本时先查 `v<version>`，再回退到 `<version>`；否则查 `latest`）。
2. 先下载 `asg-plugin.json` 到 staging 并校验。
3. 再下载 `entry` 与 `SHA256SUMS`。
4. 用 `SHA256SUMS` 校验 manifest 与 entry；缺失或不匹配立即失败并清理 staging。
5. 旧目录移到 `.trash-*`，staging 原子换到 `data/extensions/<id>/`；失败时回滚旧目录。

所有下载地址只接受 **https**。下载复用 `scripts/install/http.mjs`，因此会自动遵循
`HTTPS_PROXY` / `https_proxy` 等代理变量。

限制：私有仓库的 Release 资产目前按 `browser_download_url` 下载，不会额外带
GitHub Release asset API 的鉴权；私有仓库安装暂不保证可用。

## 5. CLI

```text
asg extensions search [query] [--limit N]
asg extensions install <owner/repo>[@version]
asg extensions list
asg extensions remove <id>
```

- `search`：搜索 GitHub 上带 `topic:asg-plugin` 的公开仓库；默认按更新时间倒序。
- `install`：从 `owner/repo` 的 GitHub Release 安装；`@version` 可锁定版本。
- `list`：表格输出 `ID / VERSION / PROVIDES / ENTRY`；JSON 模式返回 `{ "extensions": [...] }`。
- `remove`：删除 `data/extensions/<id>`。

示例：

```bash
asg extensions search bilibili
asg extensions install someone/asg-plugin-example@0.1.0
asg extensions list
asg extensions list --json
asg extensions remove example-fetch
```

安装成功后人类输出会明确提示：

```text
重启网关后生效。
```

### GitHub API 限流

`search` 以及私有仓库的 Release 查询会读取 `GITHUB_TOKEN`（或 `GH_TOKEN`）。
未设置 token 时 GitHub 对匿名请求限制较严；遇到 403 / 429 时请设置 token 后重试：

```bash
export GITHUB_TOKEN=ghp_xxx
```

请求头固定包含 `Accept: application/vnd.github+json`、
`X-GitHub-Api-Version: 2022-11-28`、`User-Agent: asg/<version>`；有 token 时加
`Authorization: Bearer <token>`。

## 6. 安全与边界

- manifest 的 `id` 与 `entry` 都做了路径约束，安装目录不会逃出 `data/extensions/`。
- 只接受 https 资产地址，并用 `SHA256SUMS` 校验 manifest 与 entry。
- 官方 id（`bilibili` / `weibo` / `cnki`）与普通第三方 id 一样安装/卸载。
- 插件代码在网关进程内 import，**没有沙箱**；可读取宿主传入的 `ctx.settings` / `ctx.secrets` 与 `getSecret()`。只安装可信来源。

## 7. 运行时加载

网关启动时（`createServer` 首次调用，进程级只执行一次）以及 `asg engines list|enable|disable|route|secret`
会扫描 `data/extensions`：

1. 读取 `data/extensions/<id>/asg-plugin.json`，校验 `api_version === 1`，目录名必须等于 `manifest.id`。
2. `import()` 安装目录内 `entry` 指向的文件（单个 ESM 文件，不得引用其它插件文件）。
3. 按 `provides` 读取命名导出：
   - `fetch`：抓取插件对象（`match` / `enabled` / `available` / `fetch`），manifest 覆盖 `id` / `name` / `displayName` / `platform`；
   - `engine`：搜索源对象（`id` / `group` / `name` / `runtime` 等）。
4. 同一批外部插件内 id 重复视为扩展自身错误；重复插件会被跳过并记录错误。
5. 单个插件加载失败只影响该插件，不影响网关启动与其它插件。

引擎插件的用户级配置不进 manifest：

```bash
asg engines route gateway.search:weibo --category news --hot-category news_hot
asg engines secret gateway.search:weibo --name cookie --stdin
```

- 路由写入 `gateway.yaml` 的 `extensions.<engineId>.routing`，覆盖插件的 `routing()` / `plan()`；
- 密钥写入 `secrets.yaml` 的 `extensions.<engineId>.<name>`，支持 `env:NAME`，
  运行期通过 `ctx.pluginSecrets` 注入；插件用 `requires: ["secret:<name>"]` 声明依赖。

插件不得 import 网关内部模块，也不得依赖宿主 `node_modules` 中的非内置包；
需要跨进程能力时应通过 CLI / HTTP 自行实现。

插件模板见 `examples/asg-plugin/`，发布时请给仓库加 `asg-plugin` topic。
