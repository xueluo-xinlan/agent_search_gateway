/**
 * 后端健康状态持久化。
 *
 * 存在意义：区分「这个后端从来没通过」和「它曾经通，现在挂了」。
 * 这两种情况处置完全不同——
 *   - 从来没通过 → 八成是配置写错/服务根本没装（unverified）
 *   - 曾经通、现在失败 → 服务挂了或过载（down）
 * 只看当次探测的话，两者都表现为 "down"，排查时会走错方向。
 *
 * 实现刻意做小：一个 JSON 文件，只记每个后端最后一次成功的时间。
 * 读失败 / 文件损坏 / 无写权限一律静默降级为空状态（退化成「从未成功」），
 * 绝不让健康检查本身成为故障点。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface HealthState {
  /** 后端名 → 最后一次成功探测的时间（ISO 字符串） */
  lastOkAt: Record<string, string>;
}

export function loadHealthState(path: string): HealthState {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<HealthState>;
    const lastOkAt = parsed.lastOkAt;
    if (lastOkAt && typeof lastOkAt === "object") {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(lastOkAt)) {
        if (typeof v === "string") clean[k] = v;
      }
      return { lastOkAt: clean };
    }
    return { lastOkAt: {} };
  } catch {
    return { lastOkAt: {} };
  }
}

/** 记录一次成功。写盘失败不影响调用方（健康检查必须永远不抛）。 */
export function markHealthy(path: string, backend: string, now = new Date()): void {
  const state = loadHealthState(path);
  state.lastOkAt[backend] = now.toISOString();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* 只读文件系统 / 磁盘满：内存态已更新，落盘失败可接受 */
  }
}

/** 该后端是否曾经成功过（决定失败时报 unverified 还是 down）。 */
export function hasEverBeenHealthy(state: HealthState, backend: string): boolean {
  return typeof state.lastOkAt[backend] === "string";
}
