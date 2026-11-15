/** Linux / systemd --user 用户单元控制。 */

import fs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../errors.js";
import type { CommandResult, PlatformEnv } from "./index.js";
import { rootFromLauncherPath, samePath, SERVICE_NAME, systemdUnitPath } from "./paths.js";

export interface DetectResult {
  registered: boolean;
  active: boolean;
  detail?: string;
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/)[0] ?? "").trim();
}

function detailOf(result: CommandResult): string {
  return (result.stderr || result.stdout || result.error || "").trim() || `退出码 ${result.status}`;
}

function assertOk(result: CommandResult, action: string): void {
  if (!result.ok) {
    throw new CliError(
      "START_FAILED",
      EXIT.FAIL,
      `${action}失败：systemctl ${SERVICE_NAME}（${detailOf(result)}）`,
    );
  }
}

/** systemd ExecStart 的简单分词：支持单/双引号与反斜杠转义。 */
export function splitSystemdCommand(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let has = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      has = true;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      has = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      has = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      has = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (has) {
        args.push(current);
        current = "";
        has = false;
      }
      continue;
    }
    current += char;
    has = true;
  }
  if (has) args.push(current);
  return args;
}

/** 从单元文件文本解析安装根；优先 WorkingDirectory，其次 ExecStart 的 bin/asg.mjs。 */
export function unitRoot(text: string): string | undefined {
  const workingDirectory = /^WorkingDirectory\s*=\s*(.*)$/m.exec(text)?.[1]?.trim();
  if (workingDirectory) {
    const value = workingDirectory.replace(/^"(.*)"$/, "$1");
    if (path.isAbsolute(value)) return value;
  }

  for (const match of text.matchAll(/^ExecStart\s*=\s*(.*)$/gm)) {
    for (const token of splitSystemdCommand(match[1] ?? "")) {
      const root = rootFromLauncherPath(token, "linux");
      if (root) return root;
    }
  }
  return undefined;
}

function readUnitText(env: PlatformEnv, active: boolean): string | undefined {
  const file = systemdUnitPath(env.home);
  if (fs.existsSync(file)) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      // 继续尝试 systemctl cat。
    }
  }

  const cat = env.runner("systemctl", ["--user", "cat", SERVICE_NAME], { timeoutMs: 5000 });
  if (cat.ok && cat.stdout.trim()) return cat.stdout;

  if (active) {
    const show = env.runner(
      "systemctl",
      ["--user", "show", SERVICE_NAME, "-p", "WorkingDirectory"],
      { timeoutMs: 5000 },
    );
    if (show.ok && show.stdout.trim()) return show.stdout;
  }
  return undefined;
}

/**
 * 只认属于当前安装根的单元。
 *
 * 同名单元可能属于另一个安装根；这种情况回退 pid 模式，避免
 * `asg start --root B` 去启动 A 的 systemd 服务。
 */
export function detect(env: PlatformEnv, root: string): DetectResult {
  const activeResult = env.runner("systemctl", ["--user", "is-active", SERVICE_NAME], {
    timeoutMs: 5000,
  });
  const statusText = firstLine(activeResult.stdout || activeResult.stderr);
  const active = activeResult.ok && statusText === "active";

  const text = readUnitText(env, active);
  if (!text) return { registered: false, active: false, detail: statusText || "未注册" };

  const ownerRoot = unitRoot(text);
  if (!ownerRoot) {
    return { registered: false, active: false, detail: "无法识别服务单元所属安装根" };
  }
  if (!samePath(ownerRoot, root, "linux")) {
    return {
      registered: false,
      active: false,
      detail: `服务单元属于其他安装根：${ownerRoot}`,
    };
  }

  return { registered: true, active, detail: statusText || undefined };
}

export function start(env: PlatformEnv): void {
  assertOk(
    env.runner("systemctl", ["--user", "start", SERVICE_NAME], { timeoutMs: 30_000 }),
    "启动 systemd 服务",
  );
}

export function stop(env: PlatformEnv): void {
  assertOk(
    env.runner("systemctl", ["--user", "stop", SERVICE_NAME], { timeoutMs: 30_000 }),
    "停止 systemd 服务",
  );
}

export function restart(env: PlatformEnv): void {
  assertOk(
    env.runner("systemctl", ["--user", "restart", SERVICE_NAME], { timeoutMs: 60_000 }),
    "重启 systemd 服务",
  );
}
