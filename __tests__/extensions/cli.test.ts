import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run, setExtensionsApiForTests } from "../../src/cli/commands/extensions.js";
import type { Reporter } from "../../src/cli/output.js";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-extensions-cli-"));
  tempDirs.push(dir);
  return dir;
}

function fakeReporter(events: Array<Record<string, unknown>> = []): Reporter {
  return {
    mode: "jsonl",
    event: (event: Record<string, unknown>) => {
      events.push(event);
    },
    info: vi.fn(),
    line: vi.fn(),
    result: vi.fn(),
  } as unknown as Reporter;
}

function writeManifest(root: string, text: string, dir = "demo-fetch"): string {
  const target = path.join(root, "data", "extensions", dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "asg-plugin.json"), text, "utf8");
  return target;
}

const MANIFEST = JSON.stringify({
  id: "demo-fetch",
  name: "Demo Fetch",
  version: "1.0.0",
  api_version: 1,
  provides: ["fetch"],
  entry: "index.mjs",
});

afterEach(() => {
  setExtensionsApiForTests(null);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("asg extensions install", () => {
  it("解析 owner/repo@version 并提示重启后生效", async () => {
    const events: Array<Record<string, unknown>> = [];
    const install = vi.fn(async () => ({
      id: "demo-fetch",
      version: "1.0.0",
      name: "Demo Fetch",
      provides: ["fetch"],
      path: "/root/data/extensions/demo-fetch",
    }));
    setExtensionsApiForTests({ install });

    const result = await run({
      root: "/root",
      reporter: fakeReporter(events),
      rest: ["install", "owner/repo@v1.0.0"],
    });

    expect(install).toHaveBeenCalledWith({
      root: "/root",
      repo: "owner/repo",
      version: "1.0.0",
      logger: expect.any(Function),
    });
    expect(result.human).toContain("重启网关后生效。");
    expect(result.human).toContain("demo-fetch");
    expect(result.data).toMatchObject({ id: "demo-fetch", provides: ["fetch"] });

    const options = install.mock.calls[0]![0] as { logger: (message: string) => void };
    options.logger("下载中");
    expect(events[0]).toMatchObject({ event: "log", service: "extensions", message: "下载中" });
  });

  it("缺少参数 / 非法仓库 / 非法版本按用法错误处理", async () => {
    for (const args of [
      ["install"],
      ["install", "owner"],
      ["install", "owner/repo@nope"],
      ["install", "owner/repo@1.0.0", "extra"],
    ]) {
      await expect(
        run({ root: "/root", reporter: fakeReporter(), rest: args }),
      ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
    }
  });
});

describe("asg extensions search", () => {
  it("支持多词 query 与 --limit", async () => {
    const search = vi.fn(async () => [
      {
        repo: "owner/demo",
        description: "示例插件",
        url: "https://github.com/owner/demo",
        stars: 3,
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
    setExtensionsApiForTests({ search });

    const result = await run({
      root: "/root",
      reporter: fakeReporter(),
      rest: ["search", "foo", "bar", "--limit", "5"],
    });

    expect(search).toHaveBeenCalledWith({ query: "foo bar", limit: 5 });
    expect(result.human).toContain("owner/demo");
    expect(result.human).toContain("示例插件");
    expect(result.data).toMatchObject({ query: "foo bar" });
  });

  it("拒绝非法 --limit 与未知选项", async () => {
    for (const args of [
      ["search", "--limit", "0"],
      ["search", "--limit", "abc"],
      ["search", "--nope"],
    ]) {
      await expect(
        run({ root: "/root", reporter: fakeReporter(), rest: args }),
      ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
    }
  });
});

describe("asg extensions list", () => {
  it("输出 ID / VERSION / PROVIDES / ENTRY 并提供 JSON 数据", async () => {
    const root = tempRoot();
    const target = writeManifest(root, MANIFEST);

    const result = await run({ root, reporter: fakeReporter(), rest: ["list"] });

    expect(result.human).toContain("ID");
    expect(result.human).toContain("VERSION");
    expect(result.human).toContain("PROVIDES");
    expect(result.human).toContain("ENTRY");
    expect(result.human).toContain("demo-fetch");
    expect(result.human).toContain("1.0.0");
    expect(result.human).toContain("fetch");
    expect(result.human).toContain("index.mjs");
    expect(result.data).toMatchObject({
      extensions: [
        {
          id: "demo-fetch",
          name: "Demo Fetch",
          version: "1.0.0",
          provides: ["fetch"],
          entry: "index.mjs",
          path: target,
        },
      ],
    });
  });

  it("空目录给出提示", async () => {
    const result = await run({ root: tempRoot(), reporter: fakeReporter(), rest: ["list"] });
    expect(result.human).toContain("未安装任何第三方插件");
    expect(result.data).toEqual({ extensions: [] });
  });
});

describe("asg extensions remove", () => {
  it("删除后输出已卸载", async () => {
    const remove = vi.fn(async () => ({ id: "demo-fetch", removed: true as const }));
    setExtensionsApiForTests({ remove });

    const result = await run({
      root: "/root",
      reporter: fakeReporter(),
      rest: ["remove", "demo-fetch"],
    });

    expect(remove).toHaveBeenCalledWith("/root", "demo-fetch");
    expect(result.human).toContain("已卸载");
    expect(result.data).toEqual({ id: "demo-fetch", removed: true });
  });

  it("未知目录报 PLUGIN_UNKNOWN / 退出码 4", async () => {
    await expect(
      run({ root: tempRoot(), reporter: fakeReporter(), rest: ["remove", "nope"] }),
    ).rejects.toMatchObject({ code: "PLUGIN_UNKNOWN", exitCode: 4 });
  });

  it("缺少参数按用法错误处理", async () => {
    await expect(
      run({ root: "/root", reporter: fakeReporter(), rest: ["remove"] }),
    ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
  });
});

describe("asg extensions 顶层", () => {
  it("未知子命令与帮助", async () => {
    await expect(
      run({ root: "/root", reporter: fakeReporter(), rest: ["nope"] }),
    ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });

    const help = await run({ root: "/root", reporter: fakeReporter(), rest: ["--help"] });
    expect(help.human).toContain("asg extensions");
    expect(help.data).toMatchObject({ usage: expect.stringContaining("install") });
  });
});
