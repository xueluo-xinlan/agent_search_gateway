import { join } from "node:path";
import type { EmbeddingSettings, FlaresolverrSettings, SearxngSettings } from "./settings/index.js";
import { getProjectRoot } from "./settings/load.js";
import { GATEWAY_VERSION } from "./version.js";
import { hasEverBeenHealthy, loadHealthState, markHealthy } from "./health-state.js";

/**
 * 健康状态落盘位置：区分「从未通过」与「曾经通过后挂了」。
 * 用项目根下的 data/ 而不是硬编码 /var/lib —— Windows 上没有 /var/lib，
 * 落盘失败会让每次探测都退化成 unverified。可用 env 覆盖（测试用）。
 */
function healthStatePath(): string {
  // 每次调用时解析而不是模块级常量：测试要用 HERMES_HEALTH_STATE 隔离，
  // 常量会在 import 时求值，stubEnv 来不及生效。
  return process.env.HERMES_HEALTH_STATE || join(getProjectRoot(), "data", "health-state.json");
}

/**
 * 后端探测结果。
 *
 * 四态而非两态，因为「失败」有两种完全不同的成因：
 *   - `on`         本次探测成功
 *   - `down`       本次探测失败，但该后端**曾经成功过** → 服务挂了 / 过载 / 端口变了
 *   - `unverified` 本次探测失败，且**从未成功过** → 多半是配置写错、服务没装、URL 打错
 *   - `off`        配置里关掉了，根本没发探测请求
 *
 * 把后两者混成一个 `down`，排障时会查错方向：去重启一个根本不存在的服务，
 * 而真正的问题在配置里。这个区分是刻意维护的，不要为了少一个枚举值而合并。
 */
export interface BackendProbe {
  status: "on" | "down" | "unverified" | "off";
  latencyMs: number;
  error?: string;
  /** 该后端最后一次成功探测的时间（从未成功时不出现）。 */
  lastOkAt?: string;
}

export interface SemanticHealth {
  embeddingUp: boolean;
  model?: string;
  dim?: number;
  corpus?: { namespace: string; entries: number };
}

export interface HealthReport {
  gateway: { version: string; uptimeSec: number };
  searxng: BackendProbe;
  flaresolverr: BackendProbe;
  embedding?: { status: "on" | "down" | "unverified"; model?: string; dim?: number };
  corpus?: { namespace: string; entries: number };
}

/** 健康检查只关心各后端地址与 embedding 开关。 */
export interface HealthSettings {
  searxng: SearxngSettings;
  flaresolverr: FlaresolverrSettings;
  embedding: EmbeddingSettings;
}

async function probe(url: string, backend: string, timeoutMs = 3000): Promise<BackendProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  const classifyFailure = (message: string): BackendProbe => {
    const latencyMs = Date.now() - start;
    const state = loadHealthState(healthStatePath());
    if (hasEverBeenHealthy(state, backend)) {
      return { status: "down", latencyMs, error: message, lastOkAt: state.lastOkAt[backend] };
    }
    return { status: "unverified", latencyMs, error: message };
  };

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "manual",
    });
    const latencyMs = Date.now() - start;
    if (res.ok) {
      markHealthy(healthStatePath(), backend);
      return { status: "on", latencyMs, lastOkAt: new Date().toISOString() };
    }
    return classifyFailure(`HTTP ${res.status}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
    const code = cause && typeof cause === "object" && typeof cause.code === "string" ? cause.code : "";
    return classifyFailure(code ? `${message} (${code})` : message);
  } finally {
    clearTimeout(timer);
  }
}

export async function getHealth(
  deps: HealthSettings,
  startedAt: number,
  semantic?: SemanticHealth,
): Promise<HealthReport> {
  const [searxng, flaresolverr] = await Promise.all([
    probe(deps.searxng.url, "searxng"),
    // 未启用的后端不做探测：否则 health 永远显示一个假的失败态，
    // 排查时会把「配置关闭」误读成「服务挂了」。
    deps.flaresolverr.enabled
      ? probe(deps.flaresolverr.url, "flaresolverr")
      : Promise.resolve<BackendProbe>({ status: "off", latencyMs: 0 }),
  ]);
  const report: HealthReport = {
    gateway: {
      version: GATEWAY_VERSION,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    },
    searxng,
    flaresolverr,
  };
  if (deps.embedding.enabled) {
    const state = loadHealthState(healthStatePath());
    const up = Boolean(semantic?.embeddingUp);
    if (up) markHealthy(healthStatePath(), "embedding");
    report.embedding = {
      status: up ? "on" : hasEverBeenHealthy(state, "embedding") ? "down" : "unverified",
      model: semantic?.model,
      dim: semantic?.dim,
    };
    if (semantic?.corpus) report.corpus = semantic.corpus;
  }
  return report;
}
