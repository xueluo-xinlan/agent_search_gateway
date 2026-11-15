/** macOS / LaunchAgent 控制。 */

import fs from "node:fs";
import { CliError, EXIT } from "../errors.js";
import type { CommandResult, PlatformEnv } from "./index.js";
import { LAUNCHD_LABEL, launchdDomain, launchdPlistPath, samePath } from "./paths.js";

export interface DetectResult {
  registered: boolean;
  active: boolean;
  detail?: string;
}

function target(env: PlatformEnv): string {
  return `${launchdDomain(env.uid)}/${LAUNCHD_LABEL}`;
}

function detailOf(result: CommandResult): string {
  return (result.stderr || result.stdout || result.error || "").trim() || `退出码 ${result.status}`;
}

function assertOk(result: CommandResult, action: string): void {
  if (!result.ok) {
    throw new CliError(
      "START_FAILED",
      EXIT.FAIL,
      `${action}失败：${LAUNCHD_LABEL}（${detailOf(result)}）`,
    );
  }
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 从 LaunchAgent plist 的 WorkingDirectory 解析安装根。 */
export function plistRoot(text: string): string | undefined {
  const match = /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(text);
  return match ? xmlUnescape(match[1]!.trim()) : undefined;
}

/** 从 `launchctl print` 输出解析 working directory。 */
export function printRoot(text: string): string | undefined {
  return /working directory = ([^\n]+)/.exec(text)?.[1]?.trim();
}

/** 只认属于当前安装根的 LaunchAgent。 */
export function detect(env: PlatformEnv, root: string): DetectResult {
  const printed = env.runner("launchctl", ["print", target(env)], { timeoutMs: 5000 });
  const loaded = printed.ok;
  let active = false;
  let state: string | undefined;

  if (loaded) {
    const stateMatch = /state = ([^\n]+)/.exec(printed.stdout);
    if (stateMatch) state = stateMatch[1]!.trim();
    const hasPid = /pid = \d+/.test(printed.stdout);
    active = state === "running" || hasPid;
  }

  let plist = "";
  try {
    plist = fs.readFileSync(launchdPlistPath(env.home), "utf8");
  } catch {
    // 未安装时没有 plist。
  }

  const ownerRoot = plistRoot(plist) ?? (loaded ? printRoot(printed.stdout) : undefined);
  if (!ownerRoot) {
    return { registered: false, active: false, detail: state ?? "未注册或无法识别安装根" };
  }
  if (!samePath(ownerRoot, root, "darwin")) {
    return {
      registered: false,
      active: false,
      detail: `服务属于其他安装根：${ownerRoot}`,
    };
  }

  return {
    registered: true,
    active,
    detail: state ?? (loaded ? "已加载" : "未加载"),
  };
}

export function start(env: PlatformEnv): void {
  assertOk(
    env.runner("launchctl", ["kickstart", target(env)], { timeoutMs: 30_000 }),
    "启动 launchd 服务",
  );
}

export function stop(env: PlatformEnv): void {
  assertOk(
    env.runner("launchctl", ["bootout", launchdDomain(env.uid), launchdPlistPath(env.home)], {
      timeoutMs: 30_000,
    }),
    "停止 launchd 服务",
  );
}

export function restart(env: PlatformEnv): void {
  assertOk(
    env.runner("launchctl", ["kickstart", "-k", target(env)], { timeoutMs: 60_000 }),
    "重启 launchd 服务",
  );
}
