import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "../../src/logger.js";
import { extensionsDir, loadExtensions } from "../../src/extensions/loader.js";
import { createFetchRegistry } from "../../src/fetch/plugins/index.js";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-extensions-loader-"));
  tempDirs.push(dir);
  return dir;
}

function writeExtension(
  root: string,
  dirName: string,
  manifest: Record<string, unknown>,
  entryText: string,
  entryName = "index.mjs",
): string {
  const dir = path.join(extensionsDir(root), dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "asg-plugin.json"), JSON.stringify(manifest), "utf8");
  fs.writeFileSync(path.join(dir, entryName), entryText, "utf8");
  return dir;
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "demo-fetch",
    name: "Demo Fetch",
    version: "1.0.0",
    api_version: 1,
    provides: ["fetch"],
    entry: "index.mjs",
    ...overrides,
  };
}

const FETCH_ENTRY = [
  "export const fetch = {",
  '  platform: "example",',
  '  capabilities: ["page"],',
  "  match: (url) => url.hostname === 'example.com',",
  "  async fetch() { return { ok: true, status: 200 }; },",
  "};",
  "",
].join("\n");

const ENGINE_ENTRY = [
  "export const engine = {",
  '  id: "gateway.search:demo",',
  '  group: "gateway.search",',
  '  name: "demo",',
  '  kind: "gateway",',
  '  displayName: "Demo 搜索",',
  "  routing: () => ['category:demo'],",
  "  available: () => true,",
  "  runtime: {",
  '    kind: "search",',
  "    plan: () => undefined,",
  "    search: async () => ({ ok: false, error: { kind: 'api', message: 'x' }, latencyMs: 0 }),",
  "  },",
  "};",
  "",
].join("\n");

function fakeLogger(warnings: string[]): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (message: string) => warnings.push(message),
    error: () => {},
    close: () => {},
  } as unknown as Logger;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("加载 fetch 扩展", () => {
  it("读取命名导出并用 manifest 覆盖身份元数据", async () => {
    const root = tempRoot();
    writeExtension(root, "demo-fetch", manifest(), FETCH_ENTRY);

    const loaded = await loadExtensions(root);

    expect(loaded.errors).toEqual([]);
    expect(loaded.engines).toEqual([]);
    expect(loaded.fetch).toHaveLength(1);
    const plugin = loaded.fetch[0]!;
    expect(plugin).toMatchObject({
      id: "demo-fetch",
      name: "demo-fetch",
      displayName: "Demo Fetch",
      platform: "example",
      capabilities: ["page"],
    });
    expect(plugin.match(new URL("https://example.com/a"))).toBe(true);
    expect(plugin.match(new URL("https://other.com/a"))).toBe(false);
    await expect(plugin.fetch(new URL("https://example.com/a"), {} as never)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("platform 缺省回落到 manifest.id", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-fetch",
      manifest(),
      ["export const fetch = {", "  match: () => true,", "  async fetch() { return { ok: true }; },", "};"].join(
        "\n",
      ),
    );

    const loaded = await loadExtensions(root);
    expect(loaded.fetch[0]!.platform).toBe("demo-fetch");
    expect(loaded.fetch[0]!.capabilities).toEqual([]);
  });
});

describe("加载 search 扩展", () => {
  it("读取 engine 导出并用于引擎注册表", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      ENGINE_ENTRY,
    );

    const loaded = await loadExtensions(root);

    expect(loaded.errors).toEqual([]);
    expect(loaded.fetch).toEqual([]);
    expect(loaded.engines).toHaveLength(1);
    expect(loaded.engines[0]).toMatchObject({
      id: "gateway.search:demo",
      group: "gateway.search",
      name: "demo",
      kind: "gateway",
      displayName: "Demo 搜索",
    });
    expect(loaded.engines[0]!.runtime?.kind).toBe("search");
  });

  it("同一插件可同时提供 fetch 与 search", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-both",
      manifest({ id: "demo-both", name: "Demo Both", provides: ["search", "fetch"] }),
      `${FETCH_ENTRY}\n${ENGINE_ENTRY}`,
    );

    const loaded = await loadExtensions(root);
    expect(loaded.errors).toEqual([]);
    expect(loaded.fetch.map((plugin) => plugin.id)).toEqual(["demo-both"]);
    expect(loaded.engines.map((engine) => engine.id)).toEqual(["gateway.search:demo"]);
  });
});

describe("坏包隔离与校验", () => {
  it("单个插件失败只记录 error，不影响其它插件", async () => {
    const root = tempRoot();
    writeExtension(root, "good-fetch", manifest({ id: "good-fetch" }), FETCH_ENTRY);
    writeExtension(root, "broken", manifest({ id: "broken" }), "export const fetch = {};\n");

    const warnings: string[] = [];
    const loaded = await loadExtensions(root, { logger: fakeLogger(warnings) });

    expect(loaded.fetch.map((plugin) => plugin.id)).toEqual(["good-fetch"]);
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]).toMatchObject({
      id: "broken",
      error: expect.stringContaining("match / fetch"),
    });
    expect(warnings[0]).toContain("broken");
  });

  it("目录名与 manifest.id 不一致时跳过", async () => {
    const root = tempRoot();
    writeExtension(root, "wrong-dir", manifest({ id: "demo-fetch" }), FETCH_ENTRY);

    const loaded = await loadExtensions(root);
    expect(loaded.fetch).toEqual([]);
    expect(loaded.errors[0]).toMatchObject({
      id: "wrong-dir",
      error: expect.stringContaining("目录名"),
    });
  });

  it("api_version 不兼容时跳过并记录 error", async () => {
    const root = tempRoot();
    writeExtension(root, "demo-fetch", manifest({ api_version: 2 }), FETCH_ENTRY);

    const loaded = await loadExtensions(root);
    expect(loaded.fetch).toEqual([]);
    expect(loaded.errors[0]).toMatchObject({
      id: "demo-fetch",
      error: expect.stringContaining("api_version"),
    });
  });

  it("缺少 manifest / 条目导入失败时只记录对应错误", async () => {
    const root = tempRoot();
    const missing = path.join(extensionsDir(root), "no-manifest");
    fs.mkdirSync(missing, { recursive: true });
    writeExtension(root, "import-fails", manifest({ id: "import-fails" }), FETCH_ENTRY);

    const warnings: string[] = [];
    const loaded = await loadExtensions(root, {
      logger: fakeLogger(warnings),
      importModule: async (url) => {
        if (url.includes("import-fails")) throw new Error("boom");
        return import(url);
      },
    });

    expect(loaded.fetch).toEqual([]);
    expect(loaded.errors).toEqual([
      { id: "import-fails", error: expect.stringContaining("boom") },
      { id: "no-manifest", error: expect.stringContaining("asg-plugin.json") },
    ]);
    expect(warnings).toHaveLength(2);
  });

  it("search 导出缺少 runtime 时跳过", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "bad-engine",
      manifest({ id: "bad-engine", provides: ["search"] }),
      [
        "export const engine = {",
        '  id: "gateway.search:bad",',
        '  group: "gateway.search",',
        '  name: "bad",',
        "};",
      ].join("\n"),
    );

    const loaded = await loadExtensions(root);
    expect(loaded.engines).toEqual([]);
    expect(loaded.errors[0]!.error).toContain("runtime");
  });

  it("扩展目录不存在时返回空结果", async () => {
    const loaded = await loadExtensions(tempRoot());
    expect(loaded).toEqual({ fetch: [], engines: [], errors: [] });
  });
});

describe("外部插件注册", () => {
  it("加载官方 id 后注册到 fetch 注册表", async () => {
    const root = tempRoot();
    writeExtension(root, "bilibili", manifest({ id: "bilibili", name: "外部 B 站" }), FETCH_ENTRY);

    const loaded = await loadExtensions(root);
    expect(loaded.fetch.map((plugin) => plugin.id)).toEqual(["bilibili"]);

    const registry = createFetchRegistry(loaded.fetch);
    expect(registry.list().map((plugin) => plugin.id)).toEqual(["bilibili"]);
    const matched = registry.find(new URL("https://example.com/a"), {} as never);
    expect(matched?.id).toBe("bilibili");
    expect(matched?.displayName).toBe("外部 B 站");
  });
});

describe("扩展配置覆盖（routing / secret）", () => {
  const ctx = { config: {}, secrets: {} } as const;

  it("routing.category / hot_category 同步覆盖 routing() 与 plan()", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      ENGINE_ENTRY,
    );

    const loaded = await loadExtensions(root, {
      extensionConfig: {
        "gateway.search:demo": {
          routing: { category: "news", hot_category: "news_hot" },
        },
      },
    });

    const provider = loaded.engines[0]!;
    expect(provider.routing(ctx)).toEqual(["category:news", "category:news_hot"]);
    const runtime = provider.runtime!;
    if (runtime.kind !== "search") throw new Error("expected search runtime");
    expect(runtime.plan("foo, NEWS_HOT", ctx)).toEqual({ hot: true });
    expect(runtime.plan("news", ctx)).toEqual({ hot: false });
    expect(runtime.plan("other", ctx)).toBeUndefined();
  });

  it("只覆盖普通类别时 hot 不命中", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      ENGINE_ENTRY,
    );

    const loaded = await loadExtensions(root, {
      extensionConfig: { "gateway.search:demo": { routing: { category: "news" } } },
    });
    const runtime = loaded.engines[0]!.runtime!;
    if (runtime.kind !== "search") throw new Error("expected search runtime");
    expect(loaded.engines[0]!.routing(ctx)).toEqual(["category:news"]);
    expect(runtime.plan("news", ctx)).toEqual({ hot: false });
    expect(runtime.plan("news_hot", ctx)).toBeUndefined();
  });

  it("pluginSecrets 注入到插件 plan/search", async () => {
    const root = tempRoot();
    const entry = [
      "export const engine = {",
      '  id: "gateway.search:demo",',
      '  group: "gateway.search",',
      '  name: "demo",',
      '  kind: "gateway",',
      '  displayName: "Demo",',
      "  routing: () => ['category:demo'],",
      "  available: () => true,",
      "  runtime: {",
      '    kind: "search",',
      "    plan: (categories, ctx) => (ctx.pluginSecrets?.cookie ? { hot: true } : undefined),",
      "    search: async () => ({ ok: false, error: { kind: 'api', message: 'x' }, latencyMs: 0 }),",
      "  },",
      "};",
      "",
    ].join("\n");
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      entry,
    );

    const loaded = await loadExtensions(root, {
      extensionSecrets: { "gateway.search:demo": { cookie: "env:DEMO_COOKIE" } },
      env: { DEMO_COOKIE: "cookie-value" },
    });
    const runtime = loaded.engines[0]!.runtime!;
    if (runtime.kind !== "search") throw new Error("expected search runtime");
    expect(runtime.plan("demo", ctx)).toEqual({ hot: true });

    const missing = await loadExtensions(root, {
      extensionSecrets: { "gateway.search:demo": { cookie: "env:DEMO_COOKIE" } },
      env: {},
    });
    const missingRuntime = missing.engines[0]!.runtime!;
    if (missingRuntime.kind !== "search") throw new Error("expected search runtime");
    expect(missingRuntime.plan("demo", ctx)).toBeUndefined();
  });

  it("secret: 依赖缺失时 available=false，含 env: 解析", async () => {
    const root = tempRoot();
    const entry = [
      "export const engine = {",
      '  id: "gateway.search:demo",',
      '  group: "gateway.search",',
      '  name: "demo",',
      '  kind: "gateway",',
      '  displayName: "Demo",',
      "  routing: () => ['category:demo'],",
      "  available: () => true,",
      '  requires: ["secret:cookie"],',
      "  runtime: {",
      '    kind: "search",',
      "    plan: () => undefined,",
      "    search: async () => ({ ok: false, error: { kind: 'api', message: 'x' }, latencyMs: 0 }),",
      "  },",
      "};",
      "",
    ].join("\n");
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      entry,
    );

    const missing = await loadExtensions(root);
    expect(missing.engines[0]!.available(ctx)).toBe(false);

    const unresolved = await loadExtensions(root, {
      extensionSecrets: { "gateway.search:demo": { cookie: "env:DEMO_COOKIE" } },
      env: {},
    });
    expect(unresolved.engines[0]!.available(ctx)).toBe(false);

    const satisfied = await loadExtensions(root, {
      extensionSecrets: { "gateway.search:demo": { cookie: "env:DEMO_COOKIE" } },
      env: { DEMO_COOKIE: "cookie-value" },
    });
    expect(satisfied.engines[0]!.available(ctx)).toBe(true);
  });

  it("未配置扩展时不改变插件默认行为", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      ENGINE_ENTRY,
    );

    const loaded = await loadExtensions(root);
    const provider = loaded.engines[0]!;
    expect(provider.routing(ctx)).toEqual(["category:demo"]);
    const runtime = provider.runtime!;
    if (runtime.kind !== "search") throw new Error("expected search runtime");
    expect(runtime.plan("anything", ctx)).toBeUndefined();
  });

  it("防御性忽略非对象的扩展配置", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      ENGINE_ENTRY,
    );

    const loaded = await loadExtensions(root, {
      extensionConfig: { "gateway.search:demo": "not-an-object" } as never,
      extensionSecrets: { "gateway.search:demo": ["nope"] } as never,
    });
    expect(loaded.engines[0]!.routing(ctx)).toEqual(["category:demo"]);
  });

  it("图搜源的 routing 不受 extensions.routing 影响", async () => {
    const root = tempRoot();
    const entry = [
      "export const engine = {",
      '  id: "gateway.reverse_image:demo",',
      '  group: "gateway.reverse_image",',
      '  name: "demo",',
      '  kind: "gateway",',
      '  displayName: "Demo 图搜",',
      "  routing: () => ['source'],",
      "  available: () => true,",
      "  runtime: {",
      '    kind: "reverse_image",',
      "    search: async () => ({ ok: true, results: [], latencyMs: 0 }),",
      "  },",
      "};",
      "",
    ].join("\n");
    writeExtension(
      root,
      "demo-image",
      manifest({ id: "demo-image", name: "Demo 图搜", provides: ["search"] }),
      entry,
    );

    const loaded = await loadExtensions(root, {
      extensionConfig: {
        "gateway.reverse_image:demo": { routing: { category: "news" } },
      },
    });
    expect(loaded.engines[0]!.routing(ctx)).toEqual(["source"]);
  });
});
