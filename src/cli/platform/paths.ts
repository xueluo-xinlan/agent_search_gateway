/** 服务管理器相关的固定名称与路径。名称必须与 scripts/install/service.mjs 保持一致。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { runSync } from "../runtime/process.js";

export const SERVICE_NAME = "agent-search-gateway";
export const SYSTEMD_UNIT_NAME = `${SERVICE_NAME}.service`;
export const LAUNCHD_LABEL = "com.djasdh.agent-search-gateway";
export const WINDOWS_TASK_NAME = "AgentSearchGateway";

export function systemdUnitPath(home: string = os.homedir()): string {
  return path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
}

export function launchdPlistPath(home: string = os.homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** launchd 的用户域：gui/<uid>。 */
export function launchdDomain(uid: string): string {
  return `gui/${uid}`;
}

/** 两个路径是否指向同一安装根（尽量解析符号链接；Windows 忽略大小写）。 */
export function samePath(a: string, b: string, platform: string = process.platform): boolean {
  const pathApi = platform === "win32" ? path.win32 : path;
  const normalize = (value: string): string => {
    let resolved = pathApi.resolve(value);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {
      // 路径不存在时保留 resolve 结果即可。
    }
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

/** 从 `<root>/bin/asg.mjs` 反推安装根。 */
export function rootFromLauncherPath(
  launcherPath: string,
  platform: string = process.platform,
): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path;
  if (pathApi.basename(launcherPath).toLowerCase() !== "asg.mjs") return undefined;
  const binDir = pathApi.dirname(launcherPath);
  if (pathApi.basename(binDir).toLowerCase() !== "bin") return undefined;
  return pathApi.dirname(binDir);
}

/** 取当前 uid；没有 process.getuid 时执行 id -u。 */
export function currentUid(): string {
  if (typeof process.getuid === "function") return String(process.getuid());
  const result = runSync("id", ["-u"], { timeoutMs: 5000 });
  const value = result.stdout.trim();
  return value || "501";
}
