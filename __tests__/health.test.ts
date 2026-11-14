import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { GatewayConfig } from "../src/config.js";
import { getHealth } from "../src/health.js";

const MOCK = {
  up: createHttpServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>ok</body></html>");
  }),
  down: createHttpServer((_req, res) => {
    res.destroy(); // 模拟不可达
  }),
};

let upPort = 0;
let downPort = 0;
let stateDir = "";
let seq = 0;

/** 每个用例一个独立状态文件，避免用例之间互相「记住成功过」。 */
function freshState(): string {
  return join(stateDir, `health-${seq++}.json`);
}

beforeAll(async () => {
  await new Promise<void>((r) => MOCK.up.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => MOCK.down.listen(0, "127.0.0.1", r));
  upPort = (MOCK.up.address() as AddressInfo).port;
  downPort = (MOCK.down.address() as AddressInfo).port;
  stateDir = mkdtempSync(join(tmpdir(), "gw-health-"));
});

afterAll(async () => {
  MOCK.up.close();
  MOCK.down.close();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

function makeConfig(
  searxngPort: number,
  fsPort: number,
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: undefined,
    logLevel: "info",
    logFile: undefined,
    searxngUrl: `http://127.0.0.1:${searxngPort}`,
    searxngTimeoutMs: 3000,
    flaresolverrUrl: `http://127.0.0.1:${fsPort}`,
    flaresolverrEnabled: true,
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
    healthStatePath: freshState(),
    ...overrides,
  } as GatewayConfig;
}

describe("getHealth 四态", () => {
  it("两后端均可达 → on", async () => {
    const h = await getHealth(makeConfig(upPort, upPort), Date.now());
    expect(h.searxng.status).toBe("on");
    expect(h.flaresolverr.status).toBe("on");
    expect(h.searxng.lastOkAt).toBeTruthy();
    expect(h.gateway.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it("从未成功过且不可达 → unverified（不是 down）", async () => {
    const h = await getHealth(makeConfig(downPort, downPort), Date.now());
    expect(h.searxng.status).toBe("unverified");
    expect(h.flaresolverr.status).toBe("unverified");
    expect(h.searxng.error).toBeTruthy();
    // 从未成功过，就不该给出「上次成功时间」这个误导性字段
    expect(h.searxng.lastOkAt).toBeUndefined();
  });

  it("先成功、后不可达 → down（同一状态文件）", async () => {
    const state = freshState();
    const okReport = await getHealth(
      makeConfig(upPort, upPort, { healthStatePath: state }),
      Date.now(),
    );
    expect(okReport.searxng.status).toBe("on");

    const failReport = await getHealth(
      makeConfig(downPort, downPort, { healthStatePath: state }),
      Date.now(),
    );
    expect(failReport.searxng.status).toBe("down");
    expect(failReport.searxng.lastOkAt).toBeTruthy();
  });

  it("flaresolverr 未启用 → off，且不发探测", async () => {
    const h = await getHealth(
      makeConfig(upPort, downPort, { flaresolverrEnabled: false }),
      Date.now(),
    );
    expect(h.searxng.status).toBe("on");
    expect(h.flaresolverr.status).toBe("off");
    expect(h.flaresolverr.error).toBeUndefined();
  });

  it("混合情况分别报告", async () => {
    const h = await getHealth(makeConfig(upPort, downPort), Date.now());
    expect(h.searxng.status).toBe("on");
    expect(h.flaresolverr.status).toBe("unverified");
  });
});
