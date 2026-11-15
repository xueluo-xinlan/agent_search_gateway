import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { Reporter } from "../../src/cli/output.js";
import {
  listEngines,
  parseEngineRef,
  readLocalEngines,
  setEngines,
} from "../../src/cli/config/engines.js";
import {
  run as enginesRun,
  setRestartForTests,
  setStdinReaderForTests,
} from "../../src/cli/commands/engines.js";

const reporter = new Reporter({ json: true, jsonl: false });
const dirs: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
const restartCalls: string[] = [];

const SETTINGS_PATH = path.join("data", "deps", "searxng", "settings.yml");

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-engines-"));
  dirs.push(dir);
  return dir;
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

const SETTINGS_YML = [
  "use_default_settings: true",
  "engines:",
  "  - name: bilibili",
  "    disabled: false",
  "    categories: [videos]",
  "  - name: google",
  "    disabled: true",
  "  - name: tavily",
  "    disabled: false",
  "",
].join("\n");

function gatewayConfig(searxngUrl: string, extra: string[] = []): string {
  return [
    "gateway:",
    "  port: 3000",
    "searxng:",
    `  url: ${searxngUrl}`,
    "search:",
    "  engines:",
    "    resident: [bilibili]",
    "    rotating: [tavily]",
    ...extra,
    "  reverse_image:",
    "    sources: [tracemoe, baidu]",
    "",
  ].join("\n");
}

function makeRoot(options: { searxngUrl?: string; saucenaoKey?: string; config?: string } = {}): string {
  const root = tempRoot();
  write(path.join(root, "gateway.yaml"), options.config ?? gatewayConfig(options.searxngUrl ?? "http://127.0.0.1:1"));
  write(path.join(root, SETTINGS_PATH), SETTINGS_YML);
  if (options.saucenaoKey !== undefined) {
    write(
      path.join(root, "secrets.yaml"),
      [
        "search:",
        "  reverse_image:",
        "    saucenao:",
        `      api_key: ${JSON.stringify(options.saucenaoKey)}`,
        "",
      ].join("\n"),
    );
  }
  return root;
}

function appendBaiduToSettings(root: string, disabled: boolean): void {
  const file = path.join(root, SETTINGS_PATH);
  fs.appendFileSync(file, `  - name: baidu\n    disabled: ${disabled}\n`, "utf8");
}

/** 安装一个最小 search 扩展，用于 gateway.search 的 route / secret 测试。 */
function writeSearchExtension(
  root: string,
  options: { dir: string; name: string; requires?: string[] },
): void {
  const dir = path.join(root, "data", "extensions", options.dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "asg-plugin.json"),
    JSON.stringify({
      id: options.dir,
      name: options.name,
      version: "1.0.0",
      api_version: 1,
      provides: ["search"],
      entry: "index.mjs",
    }),
    "utf8",
  );
  const requires = options.requires ? `  requires: ${JSON.stringify(options.requires)},\n` : "";
  fs.writeFileSync(
    path.join(dir, "index.mjs"),
    [
      "export const engine = {",
      `  id: "gateway.search:${options.name}",`,
      '  group: "gateway.search",',
      `  name: ${JSON.stringify(options.name)},`,
      '  kind: "gateway",',
      `  displayName: ${JSON.stringify(`Demo ${options.name}`)},`,
      "  routing: () => ['category:demo'],",
      "  available: () => true,",
      "  enabled: () => true,",
      ...(requires ? [requires.trimEnd()] : []),
      "  runtime: {",
      '    kind: "search",',
      "    plan: () => undefined,",
      "    search: async () => ({ ok: false, error: { kind: 'api', message: 'x' }, latencyMs: 0 }),",
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
}

function read(root: string, relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function parse(root: string, relative: string): Record<string, unknown> {
  return YAML.parse(read(root, relative)) as Record<string, unknown>;
}

function hasBak(root: string, relative: string): boolean {
  return fs.existsSync(path.join(root, `${relative}.bak`));
}

function listenConfig(payload: unknown): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

beforeEach(() => {
  restartCalls.length = 0;
  setRestartForTests(async (root) => {
    restartCalls.push(root);
  });
});

afterEach(() => {
  setRestartForTests(null);
  setStdinReaderForTests(null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("engines list（本地视图）", () => {
  it("合并 searxng 与网关源，routing / requires 正确", () => {
    const root = makeRoot();
    const engines = readLocalEngines(root);
    const byName = new Map(engines.map((engine) => [engine.name, engine]));

    expect(byName.get("bilibili")).toMatchObject({
      kind: "searxng",
      enabled: true,
      routing: ["resident"],
    });
    expect(byName.get("tavily")).toMatchObject({
      kind: "searxng",
      enabled: true,
      routing: ["rotating"],
    });
    expect(byName.get("google")).toMatchObject({
      kind: "searxng",
      enabled: false,
      routing: [],
    });

    expect(byName.get("tracemoe")).toMatchObject({
      kind: "gateway",
      enabled: true,
      available: true,
      routing: ["source"],
    });
    expect(byName.get("baidu")).toMatchObject({ kind: "gateway", enabled: true, available: true });

    const saucenao = byName.get("saucenao")!;
    expect(saucenao).toMatchObject({
      kind: "gateway",
      enabled: false,
      available: false,
      routing: ["source"],
    });
    expect(saucenao.requires).toEqual(["secrets.search.reverse_image.saucenao.api_key"]);
    expect(engines.every((engine) => engine.source === undefined)).toBe(true);
  });

  it("每条记录都有 id / group，且核心不再内置 gateway.search", () => {
    const root = makeRoot();
    const engines = readLocalEngines(root);
    const byId = new Map(engines.map((engine) => [engine.id, engine]));

    expect(engines.every((engine) => engine.id === `${engine.group}:${engine.name}`)).toBe(true);
    expect(byId.get("searxng:bilibili")).toMatchObject({ name: "bilibili", group: "searxng" });
    expect(byId.get("gateway.reverse_image:baidu")).toMatchObject({
      name: "baidu",
      group: "gateway.reverse_image",
    });
    expect(byId.get("gateway.search:weibo")).toBeUndefined();
  });

  it("有 saucenao 密钥时 available=true", () => {
    const root = makeRoot({ saucenaoKey: "abc" });
    const saucenao = readLocalEngines(root).find((engine) => engine.name === "saucenao")!;
    expect(saucenao.available).toBe(true);
    expect(saucenao.enabled).toBe(false);
  });

  it("settings.yml 缺失时仍显示网关源与配置里引用的引擎", () => {
    const root = makeRoot();
    fs.rmSync(path.join(root, SETTINGS_PATH));

    const engines = readLocalEngines(root);
    const names = engines.map((engine) => engine.name);
    expect(names).toEqual(expect.arrayContaining(["bilibili", "tavily", "tracemoe", "saucenao", "baidu"]));
  });
});

describe("engines list --all", () => {
  it("叠加 searxng /config 全量列表并标记 source", async () => {
    const url = await listenConfig({
      engines: [
        { name: "bilibili", enabled: true },
        { name: "google", enabled: true },
        { name: "bing", enabled: true },
        { name: "mojeek", enabled: false },
      ],
    });
    const root = makeRoot({ searxngUrl: url });

    const engines = await listEngines(root, { all: true });
    const byName = new Map(engines.map((engine) => [engine.name, engine]));

    // 本地条目以文件为准，并标记 local
    expect(byName.get("google")).toMatchObject({ enabled: false, source: "local" });
    expect(byName.get("bilibili")).toMatchObject({ source: "local" });
    // 远端独有条目
    expect(byName.get("bing")).toMatchObject({ kind: "searxng", enabled: true, source: "default" });
    expect(byName.get("mojeek")).toMatchObject({ enabled: false, source: "default" });
    // 网关源不受 --all 影响
    expect(byName.get("saucenao")!.source).toBeUndefined();

    const result = await enginesRun({ root, reporter, rest: ["list", "--all"] });
    expect(result.data).toMatchObject({ scope: "all" });
  });

  it("远端同名引擎不覆盖网关记录", async () => {
    const url = await listenConfig({
      engines: [
        { name: "baidu", enabled: true },
        { name: "weibo", enabled: true },
      ],
    });
    const root = makeRoot({ searxngUrl: url });

    const engines = await listEngines(root, { all: true });
    const gatewayBaidu = engines.find((engine) => engine.id === "gateway.reverse_image:baidu")!;
    expect(gatewayBaidu).toMatchObject({ kind: "gateway", enabled: true });
    expect(gatewayBaidu.source).toBeUndefined();

    // 远端确实带了同名的 searxng 条目，两条记录同时存在
    expect(engines.find((engine) => engine.id === "searxng:baidu")).toMatchObject({
      kind: "searxng",
      source: "default",
    });
    expect(engines.find((engine) => engine.id === "searxng:weibo")).toMatchObject({
      kind: "searxng",
      source: "default",
    });
  });

  it("searxng 不在线时报 BACKEND_DOWN（退出码 1）", async () => {
    const root = makeRoot({ searxngUrl: "http://127.0.0.1:1" });
    await expect(enginesRun({ root, reporter, rest: ["list", "--all"] })).rejects.toMatchObject({
      code: "BACKEND_DOWN",
      exitCode: 1,
    });
  });
});

describe("parseEngineRef", () => {
  it("按最长前缀识别限定名", () => {
    expect(parseEngineRef("gateway.reverse_image:baidu")).toEqual({
      group: "gateway.reverse_image",
      name: "baidu",
    });
    expect(parseEngineRef("gateway.search:weibo")).toEqual({
      group: "gateway.search",
      name: "weibo",
    });
    expect(parseEngineRef("searxng:google")).toEqual({ group: "searxng", name: "google" });
    expect(parseEngineRef("google")).toEqual({ name: "google" });
  });
});

describe("engines enable/disable", () => {
  it("批量修改两种文件后只重启一次", async () => {
    const root = makeRoot();
    const settingsBefore = read(root, SETTINGS_PATH);
    const configBefore = read(root, "gateway.yaml");

    const result = await enginesRun({ root, reporter, rest: ["enable", "google", "baidu"] });

    expect(result.data).toEqual({
      changed: ["google", "baidu"],
      restart: "all",
      restarted: true,
    });
    expect(result.human).toContain("MCP 连接");
    expect(restartCalls).toEqual([root]);

    const searxngDoc = parse(root, SETTINGS_PATH) as {
      engines: Array<{ name: string; disabled: boolean }>;
    };
    const google = searxngDoc.engines.find((engine) => engine.name === "google")!;
    expect(google.disabled).toBe(false);
    // 其它字段与注释不受影响（tavily 仍启用）
    expect(read(root, SETTINGS_PATH)).toMatch(/categories:\s*\[\s*videos\s*\]/);

    // baidu 本来就在 sources 中；config 无需重写
    expect(read(root, "gateway.yaml")).toBe(configBefore);
    expect(hasBak(root, "gateway.yaml")).toBe(false);
    expect(settingsBefore).not.toBe(read(root, SETTINGS_PATH));
  });

  it("disable 从 sources 数组移除网关源并写回 gateway.yaml", async () => {
    const root = makeRoot();
    await enginesRun({ root, reporter, rest: ["disable", "tracemoe", "google"] });

    const config = read(root, "gateway.yaml");
    expect(config).toContain("sources:");
    expect(config).not.toContain("tracemoe");
    expect(config).toContain("baidu");
    expect(hasBak(root, "gateway.yaml")).toBe(true);
    expect(restartCalls).toHaveLength(1);
  });

  it("本地 settings.yml 没有的引擎追加最小条目", async () => {
    const root = makeRoot();
    // resident 里引用 newengine，但 settings.yml 没有
    write(
      path.join(root, "gateway.yaml"),
      gatewayConfig("http://127.0.0.1:1").replace(
        "resident: [bilibili]",
        "resident: [bilibili, newengine]",
      ),
    );

    await enginesRun({ root, reporter, rest: ["enable", "newengine"] });

    const settings = read(root, SETTINGS_PATH);
    expect(settings).toContain("name: newengine");
    expect(settings).toContain("disabled: false");
    expect(restartCalls).toHaveLength(1);
  });

  it("缺 secret 时拒绝启用 saucenao，且一个文件都不写", async () => {
    const root = makeRoot();
    const settingsBefore = read(root, SETTINGS_PATH);
    const configBefore = read(root, "gateway.yaml");

    await expect(
      enginesRun({ root, reporter, rest: ["enable", "saucenao"] }),
    ).rejects.toMatchObject({ code: "MISSING_SECRET", exitCode: 4 });

    expect(read(root, SETTINGS_PATH)).toBe(settingsBefore);
    expect(read(root, "gateway.yaml")).toBe(configBefore);
    expect(restartCalls).toHaveLength(0);
  });

  it("批量全有或全无：任一缺 secret 时第一个文件也不改", async () => {
    const root = makeRoot();
    const settingsBefore = read(root, SETTINGS_PATH);
    const configBefore = read(root, "gateway.yaml");

    await expect(
      enginesRun({ root, reporter, rest: ["enable", "google", "saucenao"] }),
    ).rejects.toMatchObject({ code: "MISSING_SECRET", exitCode: 4 });

    expect(read(root, SETTINGS_PATH)).toBe(settingsBefore);
    expect(read(root, "gateway.yaml")).toBe(configBefore);
    expect(restartCalls).toHaveLength(0);
  });

  it("有 secret 时可以启用 saucenao", () => {
    const root = makeRoot({ saucenaoKey: "abc" });
    setEngines(root, ["saucenao"], true);

    expect(read(root, "gateway.yaml")).toContain("saucenao");
    expect(restartCalls).toHaveLength(0); // 纯函数不重启
  });

  it("未知引擎名报 ENGINE_NOT_FOUND，不写文件", async () => {
    const root = makeRoot();
    const configBefore = read(root, "gateway.yaml");

    await expect(enginesRun({ root, reporter, rest: ["enable", "nope"] })).rejects.toMatchObject({
      code: "ENGINE_NOT_FOUND",
      exitCode: 4,
    });
    expect(read(root, "gateway.yaml")).toBe(configBefore);
    expect(restartCalls).toHaveLength(0);
  });

  it("未知限定名报 ENGINE_NOT_FOUND", async () => {
    const root = makeRoot();

    await expect(
      enginesRun({ root, reporter, rest: ["enable", "gateway.reverse_image:nope"] }),
    ).rejects.toMatchObject({ code: "ENGINE_NOT_FOUND", exitCode: 4 });

    await expect(
      enginesRun({ root, reporter, rest: ["enable", "searxng:nope"] }),
    ).rejects.toMatchObject({
      code: "ENGINE_NOT_FOUND",
      exitCode: 4,
      message: expect.stringContaining("searxng 未运行"),
    });
    expect(restartCalls).toHaveLength(0);
  });

  it("只禁用 searxng 引擎时不改 gateway.yaml", async () => {
    const root = makeRoot();
    const configBefore = read(root, "gateway.yaml");

    await enginesRun({ root, reporter, rest: ["disable", "bilibili"] });

    expect(read(root, "gateway.yaml")).toBe(configBefore);
    expect(hasBak(root, "gateway.yaml")).toBe(false);
    expect(read(root, SETTINGS_PATH)).toMatch(/name: bilibili\n\s+disabled: true/);
    expect(restartCalls).toHaveLength(1);
  });

  it("无实际变化时不产生写入，changed 仍返回输入", () => {
    const root = makeRoot();
    const settingsBefore = read(root, SETTINGS_PATH);
    const configBefore = read(root, "gateway.yaml");

    const result = setEngines(root, ["bilibili"], true);

    expect(result.changed).toEqual(["bilibili"]);
    expect(read(root, SETTINGS_PATH)).toBe(settingsBefore);
    expect(read(root, "gateway.yaml")).toBe(configBefore);
    expect(hasBak(root, "gateway.yaml")).toBe(false);
  });
});

describe("限定名写入", () => {
  it("searxng:google 只改 settings.yml", async () => {
    const root = makeRoot();
    const configBefore = read(root, "gateway.yaml");

    await enginesRun({ root, reporter, rest: ["enable", "searxng:google"] });

    const searxngDoc = parse(root, SETTINGS_PATH) as {
      engines: Array<{ name: string; disabled: boolean }>;
    };
    expect(searxngDoc.engines.find((engine) => engine.name === "google")!.disabled).toBe(false);
    expect(read(root, "gateway.yaml")).toBe(configBefore);
    expect(hasBak(root, "gateway.yaml")).toBe(false);
    expect(restartCalls).toHaveLength(1);
  });

  it("gateway.reverse_image:tracemoe 只改 gateway.yaml", async () => {
    const root = makeRoot();
    const settingsBefore = read(root, SETTINGS_PATH);

    await enginesRun({ root, reporter, rest: ["disable", "gateway.reverse_image:tracemoe"] });

    const config = parse(root, "gateway.yaml") as {
      search: { reverse_image: { sources: string[] } };
    };
    expect(config.search.reverse_image.sources).toEqual(["baidu"]);
    expect(read(root, SETTINGS_PATH)).toBe(settingsBefore);
    expect(hasBak(root, "gateway.yaml")).toBe(true);
    expect(restartCalls).toHaveLength(1);
  });
});

describe("同名冲突", () => {
  it("裸名 baidu 报 ENGINE_AMBIGUOUS", async () => {
    const root = makeRoot();
    appendBaiduToSettings(root, false);

    await expect(enginesRun({ root, reporter, rest: ["enable", "baidu"] })).rejects.toMatchObject({
      code: "ENGINE_AMBIGUOUS",
      exitCode: 4,
      details: { engines: ["searxng:baidu", "gateway.reverse_image:baidu"] },
    });
    expect(restartCalls).toHaveLength(0);
  });

  it("searxng:baidu 与 gateway.reverse_image:baidu 分别写各自文件", async () => {
    const searxngRoot = makeRoot();
    appendBaiduToSettings(searxngRoot, true);
    const searxngConfigBefore = read(searxngRoot, "gateway.yaml");

    await enginesRun({ root: searxngRoot, reporter, rest: ["enable", "searxng:baidu"] });

    const searxngDoc = parse(searxngRoot, SETTINGS_PATH) as {
      engines: Array<{ name: string; disabled: boolean }>;
    };
    expect(searxngDoc.engines.find((engine) => engine.name === "baidu")!.disabled).toBe(false);
    expect(read(searxngRoot, "gateway.yaml")).toBe(searxngConfigBefore);

    const gatewayRoot = makeRoot();
    appendBaiduToSettings(gatewayRoot, false);
    const gatewaySettingsBefore = read(gatewayRoot, SETTINGS_PATH);

    await enginesRun({
      root: gatewayRoot,
      reporter,
      rest: ["disable", "gateway.reverse_image:baidu"],
    });

    const config = parse(gatewayRoot, "gateway.yaml") as {
      search: { reverse_image: { sources: string[] } };
    };
    expect(config.search.reverse_image.sources).toEqual(["tracemoe"]);
    expect(read(gatewayRoot, SETTINGS_PATH)).toBe(gatewaySettingsBefore);
  });
});

describe("组合与失败处理", () => {
  it("searxng + gateway 同时变化时写两个文件，只重启一次", async () => {
    const root = makeRoot();

    await enginesRun({
      root,
      reporter,
      rest: ["disable", "searxng:bilibili", "gateway.reverse_image:tracemoe"],
    });

    const searxngDoc = parse(root, SETTINGS_PATH) as {
      engines: Array<{ name: string; disabled: boolean }>;
    };
    expect(searxngDoc.engines.find((engine) => engine.name === "bilibili")!.disabled).toBe(true);

    const config = parse(root, "gateway.yaml") as {
      search: { reverse_image: { sources: string[] } };
    };
    expect(config.search.reverse_image.sources).toEqual(["baidu"]);
    expect(hasBak(root, "gateway.yaml")).toBe(true);
    expect(restartCalls).toEqual([root]);
  });

  it("gateway.yaml 校验失败时不写任何文件", async () => {
    const root = makeRoot({
      config: gatewayConfig("http://127.0.0.1:1", [
        "  weibo:",
        "    enabled: true",
        "    bogus: 1",
      ]),
    });
    const settingsBefore = read(root, SETTINGS_PATH);
    const configBefore = read(root, "gateway.yaml");

    await expect(
      enginesRun({
        root,
        reporter,
        rest: ["disable", "searxng:bilibili", "gateway.reverse_image:tracemoe"],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", exitCode: 4 });

    expect(read(root, SETTINGS_PATH)).toBe(settingsBefore);
    expect(read(root, "gateway.yaml")).toBe(configBefore);
    expect(restartCalls).toHaveLength(0);
  });

  it("第二个文件写失败时回滚已写文件", async () => {
    const root = makeRoot();
    const settingsBefore = read(root, SETTINGS_PATH);
    const configBefore = read(root, "gateway.yaml");
    // 让 writeConfigFile 的 .bak 备份失败（目标是目录）
    fs.mkdirSync(path.join(root, "gateway.yaml.bak"));

    await expect(
      enginesRun({
        root,
        reporter,
        rest: ["disable", "searxng:bilibili", "gateway.reverse_image:tracemoe"],
      }),
    ).rejects.toBeTruthy();

    expect(read(root, SETTINGS_PATH)).toBe(settingsBefore);
    expect(read(root, "gateway.yaml")).toBe(configBefore);
    expect(restartCalls).toHaveLength(0);
  });
});

describe("engines route", () => {
  it("searxng resident / rotating 互斥写入", async () => {
    const root = makeRoot();

    await enginesRun({ root, reporter, rest: ["route", "searxng:bilibili", "rotating"] });

    const config = parse(root, "gateway.yaml") as {
      search: { engines: { resident: string[]; rotating: string[] } };
    };
    expect(config.search.engines.resident).toEqual([]);
    expect(config.search.engines.rotating).toEqual(["tavily", "bilibili"]);
    expect(restartCalls).toEqual([root]);
  });

  it("searxng none 从两个列表移除", async () => {
    const root = makeRoot();

    await enginesRun({ root, reporter, rest: ["route", "tavily", "none"] });

    const config = parse(root, "gateway.yaml") as {
      search: { engines: { resident: string[]; rotating: string[] } };
    };
    expect(config.search.engines.resident).toEqual(["bilibili"]);
    expect(config.search.engines.rotating).toEqual([]);
  });

  it("searxng 位置策略不能与类别参数混用", async () => {
    const root = makeRoot();
    const before = read(root, "gateway.yaml");

    await expect(
      enginesRun({ root, reporter, rest: ["route", "bilibili", "resident", "--category", "news"] }),
    ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });

    expect(read(root, "gateway.yaml")).toBe(before);
    expect(restartCalls).toHaveLength(0);
  });

  it("gateway.search 写类别并能在 list 中看到", async () => {
    const root = makeRoot();
    writeSearchExtension(root, { dir: "demo-search", name: "demo" });

    await enginesRun({
      root,
      reporter,
      rest: ["route", "gateway.search:demo", "--category", "news", "--hot-category", "news_hot"],
    });

    const config = parse(root, "gateway.yaml") as {
      extensions: Record<string, { routing: { category: string; hot_category: string } }>;
    };
    expect(config.extensions["gateway.search:demo"]!.routing).toEqual({
      category: "news",
      hot_category: "news_hot",
    });
    expect(restartCalls).toHaveLength(1);

    const listed = await enginesRun({ root, reporter, rest: ["list"] });
    const engines = (listed.data as { engines: Array<{ id: string; routing: string[] }> }).engines;
    expect(engines.find((engine) => engine.id === "gateway.search:demo")!.routing).toEqual([
      "category:news",
      "category:news_hot",
    ]);
  });

  it("gateway.search --clear 删除 routing 并清理空 extensions.<id>", async () => {
    const root = makeRoot();
    writeSearchExtension(root, { dir: "demo-search", name: "demo" });
    await enginesRun({ root, reporter, rest: ["route", "gateway.search:demo", "--category", "news"] });

    await enginesRun({ root, reporter, rest: ["route", "gateway.search:demo", "--clear"] });

    const config = parse(root, "gateway.yaml") as { extensions?: unknown };
    expect(config.extensions).toEqual({});
    expect(restartCalls).toHaveLength(2);
  });

  it("gateway.search 必须至少给一个类别或 --clear", async () => {
    const root = makeRoot();
    writeSearchExtension(root, { dir: "demo-search", name: "demo" });

    await expect(
      enginesRun({ root, reporter, rest: ["route", "gateway.search:demo"] }),
    ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
    expect(restartCalls).toHaveLength(0);
  });

  it("gateway.search --clear 不能与类别同时使用", async () => {
    const root = makeRoot();
    writeSearchExtension(root, { dir: "demo-search", name: "demo" });

    await expect(
      enginesRun({
        root,
        reporter,
        rest: ["route", "gateway.search:demo", "--clear", "--category", "news"],
      }),
    ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
  });

  it("类别名禁止逗号与空值", async () => {
    const root = makeRoot();
    writeSearchExtension(root, { dir: "demo-search", name: "demo" });

    await expect(
      enginesRun({ root, reporter, rest: ["route", "gateway.search:demo", "--category", "a,b"] }),
    ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
    await expect(
      enginesRun({ root, reporter, rest: ["route", "gateway.search:demo", "--category", "  "] }),
    ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
  });

  it("gateway.reverse_image 报 ENGINE_NO_ROUTING", async () => {
    const root = makeRoot();

    await expect(
      enginesRun({ root, reporter, rest: ["route", "gateway.reverse_image:baidu", "resident"] }),
    ).rejects.toMatchObject({ code: "ENGINE_NO_ROUTING", exitCode: 4 });
    expect(restartCalls).toHaveLength(0);
  });

  it("未知引擎与裸名歧义", async () => {
    const root = makeRoot();
    writeSearchExtension(root, { dir: "baidu-search", name: "baidu" });

    await expect(
      enginesRun({ root, reporter, rest: ["route", "gateway.search:nope", "--category", "news"] }),
    ).rejects.toMatchObject({ code: "ENGINE_NOT_FOUND", exitCode: 4 });

    await expect(
      enginesRun({ root, reporter, rest: ["route", "baidu", "resident"] }),
    ).rejects.toMatchObject({ code: "ENGINE_AMBIGUOUS", exitCode: 4 });
  });

  it("searxng 远端默认引擎在线确认后可设置路由", async () => {
    const url = await listenConfig({ engines: [{ name: "bing", enabled: true }] });
    const root = makeRoot({ searxngUrl: url });

    await enginesRun({ root, reporter, rest: ["route", "bing", "resident"] });

    const config = parse(root, "gateway.yaml") as {
      search: { engines: { resident: string[]; rotating: string[] } };
    };
    expect(config.search.engines.resident).toEqual(["bilibili", "bing"]);
    expect(config.search.engines.rotating).toEqual(["tavily"]);
  });

  it("校验失败不写文件", async () => {
    const root = makeRoot({
      config: gatewayConfig("http://127.0.0.1:1", ["  weibo:", "    enabled: true", "    bogus: 1"]),
    });
    const before = read(root, "gateway.yaml");

    await expect(
      enginesRun({ root, reporter, rest: ["route", "bilibili", "rotating"] }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", exitCode: 4 });

    expect(read(root, "gateway.yaml")).toBe(before);
    expect(restartCalls).toHaveLength(0);
  });
});

describe("engines secret", () => {
  it("内置单密钥从 stdin 写入，secrets.yaml 权限 0600", async () => {
    const root = makeRoot();
    setStdinReaderForTests(async () => "abc-123\n");

    const result = await enginesRun({
      root,
      reporter,
      rest: ["secret", "saucenao", "--stdin"],
    });

    const secrets = parse(root, "secrets.yaml") as {
      search: { reverse_image: { saucenao: { api_key: string } } };
    };
    expect(secrets.search.reverse_image.saucenao.api_key).toBe("abc-123");
    expect(result.data).toMatchObject({
      secret: "secrets.search.reverse_image.saucenao.api_key",
      changed: ["secrets.search.reverse_image.saucenao.api_key"],
    });
    expect(fs.statSync(path.join(root, "secrets.yaml")).mode & 0o777).toBe(0o600);
    expect(restartCalls).toEqual([root]);
  });

  it("多个依赖必须给 --name，短名与完整路径都可选", async () => {
    const root = makeRoot();
    setStdinReaderForTests(async () => "cookie-value\n");
    writeSearchExtension(root, {
      dir: "multi-search",
      name: "multi",
      requires: ["secret:cookie", "secret:token"],
    });

    await expect(
      enginesRun({ root, reporter, rest: ["secret", "gateway.search:multi", "--stdin"] }),
    ).rejects.toMatchObject({ code: "ENGINE_SECRET_AMBIGUOUS", exitCode: 4 });

    await enginesRun({
      root,
      reporter,
      rest: ["secret", "gateway.search:multi", "--name", "cookie", "--stdin"],
    });

    const secrets = parse(root, "secrets.yaml") as {
      extensions: Record<string, Record<string, string>>;
    };
    expect(secrets.extensions["gateway.search:multi"]).toEqual({ cookie: "cookie-value" });
  });

  it("未知 --name 报 MISSING_SECRET", async () => {
    const root = makeRoot();
    writeSearchExtension(root, {
      dir: "demo-search",
      name: "demo",
      requires: ["secret:cookie"],
    });

    await expect(
      enginesRun({
        root,
        reporter,
        rest: ["secret", "gateway.search:demo", "--name", "nope", "--stdin"],
      }),
    ).rejects.toMatchObject({ code: "MISSING_SECRET", exitCode: 4 });
  });

  it("无密钥依赖且未给 --name 报 ENGINE_NO_SECRET", async () => {
    const root = makeRoot();

    await expect(
      enginesRun({ root, reporter, rest: ["secret", "tracemoe", "--stdin"] }),
    ).rejects.toMatchObject({ code: "ENGINE_NO_SECRET", exitCode: 4 });
  });

  it("扩展 secret:name 省略 --name 时自动选择，并可 --clear", async () => {
    const root = makeRoot();
    setStdinReaderForTests(async () => "cookie-value\n");
    writeSearchExtension(root, {
      dir: "demo-search",
      name: "demo",
      requires: ["secret:cookie"],
    });

    await enginesRun({ root, reporter, rest: ["secret", "gateway.search:demo", "--stdin"] });

    let secrets = parse(root, "secrets.yaml") as {
      extensions: Record<string, Record<string, string>>;
    };
    expect(secrets.extensions["gateway.search:demo"]).toEqual({ cookie: "cookie-value" });

    await enginesRun({
      root,
      reporter,
      rest: ["secret", "gateway.search:demo", "--name", "secret:cookie", "--clear"],
    });

    secrets = parse(root, "secrets.yaml") as {
      extensions: Record<string, Record<string, string>>;
    };
    expect(secrets.extensions).toEqual({});
    expect(restartCalls).toHaveLength(2);
  });

  it("--stdin 与 --clear 冲突、都缺失、位置值都报 usage", async () => {
    const root = makeRoot();

    await expect(
      enginesRun({ root, reporter, rest: ["secret", "saucenao", "--stdin", "--clear"] }),
    ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });

    await expect(
      enginesRun({ root, reporter, rest: ["secret", "saucenao"] }),
    ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });

    await expect(
      enginesRun({ root, reporter, rest: ["secret", "saucenao", "plaintext-value", "--stdin"] }),
    ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
    expect(restartCalls).toHaveLength(0);
  });

  it("stdin 空值报错且提示 --clear", async () => {
    const root = makeRoot();
    setStdinReaderForTests(async () => "\n");

    await expect(
      enginesRun({ root, reporter, rest: ["secret", "saucenao", "--stdin"] }),
    ).rejects.toMatchObject({
      code: "UNEXPECTED",
      exitCode: 2,
      message: expect.stringContaining("--clear"),
    });
    expect(fs.existsSync(path.join(root, "secrets.yaml"))).toBe(false);
  });

  it("校验失败时不写 secrets.yaml、不重启", async () => {
    const root = makeRoot({
      config: gatewayConfig("http://127.0.0.1:1", ["  weibo:", "    bogus: 1"]),
    });
    setStdinReaderForTests(async () => "abc\n");

    await expect(
      enginesRun({ root, reporter, rest: ["secret", "saucenao", "--stdin"] }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", exitCode: 4 });

    expect(fs.existsSync(path.join(root, "secrets.yaml"))).toBe(false);
    expect(restartCalls).toHaveLength(0);
  });

  it("secret: 依赖满足后 list 的 available 变 true", async () => {
    const root = makeRoot();
    setStdinReaderForTests(async () => "cookie-value\n");
    writeSearchExtension(root, {
      dir: "demo-search",
      name: "demo",
      requires: ["secret:cookie"],
    });

    const before = await enginesRun({ root, reporter, rest: ["list"] });
    const beforeEngine = (
      before.data as { engines: Array<{ id: string; available: boolean }> }
    ).engines.find((engine) => engine.id === "gateway.search:demo")!;
    expect(beforeEngine.available).toBe(false);

    await enginesRun({ root, reporter, rest: ["secret", "gateway.search:demo", "--stdin"] });

    const after = await enginesRun({ root, reporter, rest: ["list"] });
    const afterEngine = (
      after.data as { engines: Array<{ id: string; available: boolean }> }
    ).engines.find((engine) => engine.id === "gateway.search:demo")!;
    expect(afterEngine.available).toBe(true);
  });
});
