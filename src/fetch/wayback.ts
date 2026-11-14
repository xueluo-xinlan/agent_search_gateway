/**
 * Wayback Machine 兜底取件。
 *
 * 只在 direct 明确返回 404 / 410 时调用 —— 原页面已经不在，但存档可能还在。
 * 不参与正常路径：能正常打开的页面永远不该被替换成存档副本。
 *
 * 两段请求：
 *   1. `https://archive.org/wayback/available?url=<原URL>` → 是否存在最近的快照
 *   2. 抓快照本身的 URL（archive.org 返回的静态页，普通 HTTP 即可，无需渲染）
 *
 * 失败一律静默（返回 ok:false），由调用方决定是否继续报原来的 404。
 */

export interface WaybackResult {
  ok: boolean;
  /** 快照 HTML（供上层转 markdown）。 */
  html?: string;
  /** 快照地址（archive.org 的 URL）。 */
  finalUrl?: string;
  /** 快照时间戳，形如 20230115120000。 */
  timestamp?: string;
  errorMessage?: string;
}

const AVAILABLE_API = "https://archive.org/wayback/available";
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

interface AvailableResponse {
  archived_snapshots?: {
    closest?: { available?: boolean; url?: string; timestamp?: string; status?: string };
  };
}

export async function fetchViaWayback(
  url: string,
  timeoutMs = 5000,
  apiBase = AVAILABLE_API,
): Promise<WaybackResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const probeUrl = `${apiBase}?url=${encodeURIComponent(url)}`;
    const res = await fetch(probeUrl, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) return { ok: false, errorMessage: `availability HTTP ${res.status}` };

    const data = (await res.json()) as AvailableResponse;
    const closest = data.archived_snapshots?.closest;
    if (!closest?.available || !closest.url) {
      return { ok: false, errorMessage: "无存档快照" };
    }

    const snap = await fetch(closest.url, { signal: controller.signal, redirect: "follow" });
    if (!snap.ok) return { ok: false, errorMessage: `snapshot HTTP ${snap.status}` };

    const buf = await snap.arrayBuffer();
    if (buf.byteLength > MAX_SNAPSHOT_BYTES) {
      return { ok: false, errorMessage: `快照过大（${buf.byteLength} 字节）` };
    }

    const html = new TextDecoder("utf-8").decode(buf);
    return { ok: true, html, finalUrl: closest.url, timestamp: closest.timestamp };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errorMessage: message };
  } finally {
    clearTimeout(timer);
  }
}
