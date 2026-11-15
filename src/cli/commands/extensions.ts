/** `asg extensions search|install|list|remove`。
 *
 * 只负责插件目录：安装/卸载后**不自动重启网关**；网关下次启动（或运行
 * `asg engines`）时由 `src/extensions/loader.ts` 加载。
 */

import { takeNumber } from "../args.js";
import type { CommandFn, CommandResult } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import type { Reporter } from "../output.js";
import {
  installExtension,
  isValidExtensionVersion,
  isValidRepo,
  listExtensions,
  removeExtension,
  searchExtensions,
  type ExtensionSearchItem,
  type InstalledExtension,
} from "../../extensions/index.js";

const USAGE = `用法: asg extensions <search|install|list|remove> ...

  search [query] [--limit N]       搜索 topic:asg-plugin 的 GitHub 仓库
  install <owner/repo>[@version]   下载、校验并安装第三方插件
  list                             列出已安装的第三方插件
  remove <id>                      删除 data/extensions/<id>

说明：安装后不会自动重启网关，重启服务（或下次运行 asg engines）后生效。`;

export interface ExtensionsApi {
  install: typeof installExtension;
  list: typeof listExtensions;
  remove: typeof removeExtension;
  search: typeof searchExtensions;
}

const DEFAULT_API: ExtensionsApi = {
  install: installExtension,
  list: listExtensions,
  remove: removeExtension,
  search: searchExtensions,
};

let api: ExtensionsApi = DEFAULT_API;

/** 测试钩子：替换扩展后端，传 null 恢复默认。 */
export function setExtensionsApiForTests(overrides: Partial<ExtensionsApi> | null): void {
  api = { ...DEFAULT_API, ...(overrides ?? {}) };
}

function usageError(message: string = USAGE): CliError {
  return new CliError("UNEXPECTED", EXIT.USAGE, message);
}

function makeLogger(reporter: Reporter): (message: string) => void {
  return (message) => reporter.event({ event: "log", service: "extensions", message });
}

function renderList(extensions: InstalledExtension[]): string {
  const header = ["ID", "VERSION", "PROVIDES", "ENTRY"];
  const rows = extensions.map((extension) => [
    extension.id,
    extension.version ?? "-",
    extension.provides && extension.provides.length > 0 ? extension.provides.join(",") : "-",
    extension.entry ?? "-",
  ]);

  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index]!.length)),
  );
  const format = (row: string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();

  const lines = [format(header), ...rows.map((row) => format(row))];
  if (extensions.length === 0) {
    lines.push("", "（未安装任何第三方插件）");
  }
  for (const extension of extensions) {
    if (extension.error) lines.push(`警告: ${extension.id} 无法读取：${extension.error}`);
  }
  return lines.join("\n");
}

function renderSearch(results: ExtensionSearchItem[]): string {
  if (results.length === 0) return "没有找到匹配的插件。";
  return results
    .map((item) => {
      const description = item.description || "（无描述）";
      return `${item.repo}  ★ ${item.stars}\n  ${description}\n  ${item.url}`;
    })
    .join("\n\n");
}

export function parseInstallTarget(value: string): { repo: string; version?: string } {
  const at = value.lastIndexOf("@");
  if (at === -1) return { repo: value };
  if (at === 0 || at === value.length - 1) {
    throw usageError(`安装目标格式应为 owner/repo[@version]：${value}`);
  }
  const repo = value.slice(0, at);
  const version = value.slice(at + 1).replace(/^[vV]/, "");
  if (!isValidExtensionVersion(version)) {
    throw usageError(`版本号不合法：${value.slice(at + 1)}（示例：1.2.3）`);
  }
  return { repo, version };
}

async function runSearch(args: string[]): Promise<CommandResult> {
  const limit = takeNumber(args, "--limit");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw usageError("--limit 必须是 1..100 的整数");
  }
  if (args.some((arg) => arg.startsWith("-"))) {
    throw usageError(`未知选项：${args.find((arg) => arg.startsWith("-"))}\n\n${USAGE}`);
  }

  const query = args.join(" ").trim();
  const results = await api.search({
    ...(query ? { query } : {}),
    ...(limit === undefined ? {} : { limit }),
  });
  return {
    data: { query: query || null, results },
    human: renderSearch(results),
  };
}

async function runInstall(
  root: string,
  reporter: Reporter,
  args: string[],
): Promise<CommandResult> {
  if (args.length !== 1) {
    throw usageError(`用法: asg extensions install <owner/repo>[@version]`);
  }
  const target = args[0]!;
  const { repo, version } = parseInstallTarget(target);
  if (!isValidRepo(repo)) {
    throw usageError(`仓库格式应为 owner/name：${repo}`);
  }

  const result = await api.install({
    root,
    repo,
    ...(version === undefined ? {} : { version }),
    logger: makeLogger(reporter),
  });

  return {
    data: result,
    human: [
      `已安装 ${result.name} (${result.id}) v${result.version}`,
      `能力: ${result.provides.join(", ")}`,
      `路径: ${result.path}`,
      "重启网关后生效。",
    ].join("\n"),
  };
}

function runList(root: string, args: string[]): CommandResult {
  if (args.length > 0) {
    throw usageError(`list 不接受额外参数：${args.join(" ")}`);
  }
  const extensions = api.list(root);
  return {
    data: { extensions },
    human: renderList(extensions),
  };
}

async function runRemove(root: string, args: string[]): Promise<CommandResult> {
  if (args.length !== 1) {
    throw usageError("用法: asg extensions remove <id>");
  }
  const result = await api.remove(root, args[0]!);
  return {
    data: result,
    human: `${result.id} 已卸载。`,
  };
}

export const run: CommandFn = async ({ root, reporter, rest }) => {
  const [subcommand, ...args] = rest;

  switch (subcommand) {
    case "search":
      return runSearch(args);
    case "install":
      return runInstall(root, reporter, args);
    case "list":
      return runList(root, args);
    case "remove":
      return runRemove(root, args);
    case "-h":
    case "--help":
      return { data: { usage: USAGE }, human: USAGE };
    case undefined:
      throw usageError(USAGE);
    default:
      throw usageError(`未知 extensions 子命令：${subcommand}（可用: search | install | list | remove）`);
  }
};
