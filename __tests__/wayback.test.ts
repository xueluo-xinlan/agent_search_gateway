import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createFetchService } from "../src/fetch/service.js";
import { fetchViaWayback } from "../src/fetch/wayback.js";
import type { Logger } from "../src/logger.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
} as Logger;

// ── mock：原站（404 / 403 / 正常）+ archive API（有快照 / 无快照） ──
let site: ReturnType<typeof createHttpServer>;
let archive: ReturnType<typeof createHttpServer>;
let siteBase = "";
let archiveApi = "";
let archiveHasSnapshot = true;
let archiveHitCount = 0;
let siteHitCount = 0;

const SNAPSHOT_HTML =
  "<html><head><title>已删除的文章</title></head><body><article><h1>已删除的文章</h1><p>这是存档里的正文内容，原站已经 404。</p></article></body></html>";

beforeAll(async () => {
  site = createHttpServer((req, res) => {
    siteHitCount++;
    if (req.url?.startsWith("/gone")) {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<html><body>not found</body></html>");
      return;
    }
    if (req.url?.startsWith("/blocked")) {
      res.writeHead(403, { "Content-Type": "text/html" });
      res.end("<html><body>forbidden</body></html>");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body><article><h1>正常页</h1><p>正常内容</p></article></body></html>");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  siteBase = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  archive = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/available") {
      archiveHitCount++;
      if (!archiveHasSnapshot) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ archived_snapshots: {} }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          archived_snapshots: {
            closest: {
              available: true,
              url: `${archiveBase()}/snapshot`,
              timestamp: "20250315120000",
              status: "200",
            },
          },
        }),
      );
      return;
    }
    if (url.pathname === "/snapshot") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SNAPSHOT_HTML);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => archive.listen(0, "127.0.0.1", r));
  archiveApi = `${archiveBase()}/available`;
});

function archiveBase(): string {
  return `http://127.0.0.1:${(archive.address() as AddressInfo).port}`;
}

afterAll(() => {
  site.close();
  archive.close();
});

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: undefined,
    logLevel: "info",
    logFile: undefined,
    searxngUrl: "http://127.0.0.1:1",
    searxngTimeoutMs: 3000,
    flaresolverrUrl: "http://127.0.0.1:1",
    flaresolverrEnabled: false,
    flaresolverrTimeoutMs: 5000,
    flaresolverrMaxConcurrent: 2,
    flaresolverrTriggerStatus: [403, 405, 429],
    flaresolverrFallbackOnEmpty: true,
    searchMaxResults: 10,
    searchMaxResultsCap: 50,
    searchMaxResultChars: 500,
    searchCacheTtlMs: 300000,
    searchCacheMaxEntries: 200,
    searchMaxConcurrent: 2,
    adFilterEnabled: false,
    adFilterLevel: "off",
    adFilterExtraDomains: [],
    adFilterHostsFile: "data/adblock/hosts",
    adFilterAllowlist: [],
    adFilterAutoUpdate: false,
    adFilterAutoUpdateIntervalMs: 86400000,
    fetchTimeoutMs: 3000,
    fetchMaxBytes: 65536,
    fetchUserAgent: "",
    fetchBlockPrivateIps: false,
    fetchStructural: "clean",
    fetchMaxOutputChars: 20000,
    fetchCacheTtlMs: 600000,
    fetchCacheMaxEntries: 200,
    fetchMaxDownloadBytes: 1073741824,
    fetchDownloadDir: "data/downloads",
    fetchDownloadTtlMs: 604800000,
    fetchDownloadMaxTotalBytes: 4294967296,
    fetchFilesRoute: true,
    fetchWaybackEnabled: true,
    fetchWaybackTimeoutMs: 5000,
    fetchWaybackApiBase: archiveApi,
    healthStatePath: "/tmp/wayback-test-health.json",
    ...overrides,
  } as GatewayConfig;
}

const fresh = () => createFetchService(makeConfig(), silentLogger);

describe("fetchViaWayback（单元）", () => {
  it("有快照 → 返回 html 与时间戳", async () => {
    archiveHasSnapshot = true;
    const r = await fetchViaWayback(`${siteBase}/gone`, 5000, archiveApi);
    expect(r.ok).toBe(true);
    expect(r.html).toContain("存档里的正文");
    expect(r.timestamp).toBe("20250315120000");
  });

  it("无快照 → ok:false 且说明原因", async () => {
    archiveHasSnapshot = false;
    const r = await fetchViaWayback(`${siteBase}/gone`, 5000, archiveApi);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("无存档");
    archiveHasSnapshot = true;
  });

  it("API 不可达 → 静默失败，不抛异常", async () => {
    const r = await fetchViaWayback(`${siteBase}/gone`, 1000, "http://127.0.0.1:1/available");
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBeTruthy();
  });
});

describe("fetch 服务集成：Wayback 兜底", () => {
  it("404 → 走存档并标注来源", async () => {
    archiveHasSnapshot = true;
    const svc = fresh();
    const r = await svc.fetch({ url: `${siteBase}/gone` });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("存档里的正文");
    expect(r.text).toContain("Wayback Machine 存档");
    expect(r.text).toContain("2025-03-15");
  });

  it("403 是反爬不是删除 → 不查存档", async () => {
    archiveHitCount = 0;
    const svc = fresh();
    const r = await svc.fetch({ url: `${siteBase}/blocked` });
    expect(r.ok).toBe(false);
    expect(archiveHitCount).toBe(0);
  });

  it("开关关闭 → 404 原样报错，不查存档", async () => {
    archiveHitCount = 0;
    const svc = createFetchService(
      makeConfig({ fetchWaybackEnabled: false }),
      silentLogger,
    );
    const r = await svc.fetch({ url: `${siteBase}/gone` });
    expect(r.ok).toBe(false);
    expect(archiveHitCount).toBe(0);
  });

  it("无存档 → 仍按原错误返回", async () => {
    archiveHasSnapshot = false;
    const svc = fresh();
    const r = await svc.fetch({ url: `${siteBase}/gone` });
    expect(r.ok).toBe(false);
    archiveHasSnapshot = true;
  });

  it("正常页不触发存档查询", async () => {
    archiveHitCount = 0;
    const svc = fresh();
    const r = await svc.fetch({ url: `${siteBase}/ok` });
    expect(r.ok).toBe(true);
    expect(archiveHitCount).toBe(0);
  });
});
