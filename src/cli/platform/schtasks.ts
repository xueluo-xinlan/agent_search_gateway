/** Windows / 登录计划任务控制（schtasks，参数数组，不经过 shell）。 */

import { CliError, EXIT } from "../errors.js";
import type { CommandResult, PlatformEnv } from "./index.js";
import { rootFromLauncherPath, samePath, WINDOWS_TASK_NAME } from "./paths.js";

export interface DetectResult {
  registered: boolean;
  active: boolean;
  detail?: string;
}

function detailOf(result: CommandResult): string {
  return (result.stderr || result.stdout || result.error || "").trim() || `退出码 ${result.status}`;
}

function assertOk(result: CommandResult, action: string): void {
  if (!result.ok) {
    throw new CliError(
      "START_FAILED",
      EXIT.FAIL,
      `${action}失败：${WINDOWS_TASK_NAME}（${detailOf(result)}）`,
    );
  }
}

/** 从 `schtasks /fo LIST /v` 的 Task To Run 解析安装根。 */
export function taskRoot(text: string): string | undefined {
  const line = /^(?:Task To Run|要运行的任务)\s*[:：]\s*(.*)$/im.exec(text)?.[1]?.trim();
  if (!line) return undefined;

  const tokens = line.match(/"[^"]*"|\S+/g) ?? [];
  for (const token of tokens) {
    const root = rootFromLauncherPath(token.replace(/^"|"$/g, ""), "win32");
    if (root) return root;
  }

  const fallback = /([A-Za-z]:\\[^"\r\n]*?\\bin\\asg\.mjs)/i.exec(line)?.[1];
  return fallback ? rootFromLauncherPath(fallback, "win32") : undefined;
}

/** 只认属于当前安装根的计划任务。 */
export function detect(env: PlatformEnv, root: string): DetectResult {
  const query = env.runner(
    "schtasks",
    ["/query", "/tn", WINDOWS_TASK_NAME, "/fo", "LIST", "/v"],
    { timeoutMs: 10_000 },
  );
  if (!query.ok) return { registered: false, active: false, detail: "未注册" };

  const text = query.stdout;
  const statusLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^(Status|状态)\s*[:：]/i.test(line));
  const active = Boolean(statusLine && /[:：]\s*(Running|正在运行)/i.test(statusLine));

  const ownerRoot = taskRoot(text);
  if (!ownerRoot) {
    return { registered: false, active: false, detail: "无法识别计划任务所属安装根" };
  }
  if (!samePath(ownerRoot, root, "win32")) {
    return {
      registered: false,
      active: false,
      detail: `计划任务属于其他安装根：${ownerRoot}`,
    };
  }

  return { registered: true, active, detail: statusLine ?? undefined };
}

export function start(env: PlatformEnv): void {
  assertOk(
    env.runner("schtasks", ["/run", "/tn", WINDOWS_TASK_NAME], { timeoutMs: 30_000 }),
    "启动计划任务",
  );
}

export function stop(env: PlatformEnv): void {
  assertOk(
    env.runner("schtasks", ["/end", "/tn", WINDOWS_TASK_NAME], { timeoutMs: 30_000 }),
    "停止计划任务",
  );
}

export function restart(env: PlatformEnv): void {
  // 未在运行时 /end 会失败，忽略即可，最终以 /run 是否成功为准。
  env.runner("schtasks", ["/end", "/tn", WINDOWS_TASK_NAME], { timeoutMs: 30_000 });
  assertOk(
    env.runner("schtasks", ["/run", "/tn", WINDOWS_TASK_NAME], { timeoutMs: 30_000 }),
    "重启计划任务",
  );
}
