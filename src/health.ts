import type { GatewayConfig } from "./config.js";
import { hasEverBeenHealthy, loadHealthState, markHealthy } from "./health-state.js";

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

async function probe(
  url: string,
  backend: string,
  config: GatewayConfig,
  timeoutMs = 3000,
): Promise<BackendProbe> {
  const statePath = config.healthStatePath;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  const classifyFailure = (message: string): BackendProbe => {
    const latencyMs = Date.now() - start;
    const state = loadHealthState(statePath);
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
    if (!res.ok) return classifyFailure(`HTTP ${res.status}`);
    markHealthy(statePath, backend);
    return { status: "on", latencyMs, lastOkAt: new Date().toISOString() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return classifyFailure(message);
  } finally {
    clearTimeout(timer);
  }
}

export async function getHealth(
  config: GatewayConfig,
  startedAt: number,
  semantic?: SemanticHealth,
): Promise<HealthReport> {
  const [searxng, flaresolverr] = await Promise.all([
    probe(config.searxngUrl, "searxng", config),
    // 未启用的后端不做探测：否则 health 永远显示一个假的失败态，
    // 排查时会把「配置关闭」误读成「服务挂了」。
    config.flaresolverrEnabled
      ? probe(config.flaresolverrUrl, "flaresolverr", config)
      : Promise.resolve<BackendProbe>({ status: "off", latencyMs: 0 }),
  ]);
  const report: HealthReport = {
    gateway: {
      version: "0.1.0",
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    },
    searxng,
    flaresolverr,
  };
  if (config.embeddingEnabled) {
    const state = loadHealthState(config.healthStatePath);
    const up = Boolean(semantic?.embeddingUp);
    if (up) markHealthy(config.healthStatePath, "embedding");
    report.embedding = {
      status: up ? "on" : hasEverBeenHealthy(state, "embedding") ? "down" : "unverified",
      model: semantic?.model,
      dim: semantic?.dim,
    };
    if (semantic?.corpus) report.corpus = semantic.corpus;
  }
  return report;
}
