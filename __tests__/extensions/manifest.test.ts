import { describe, expect, it } from "vitest";
import {
  isValidEntryName,
  isValidExtensionId,
  isValidExtensionVersion,
  parseManifest,
} from "../../src/extensions/manifest.js";

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "demo-fetch",
    name: "Demo Fetch",
    version: "1.2.3",
    api_version: 1,
    provides: ["fetch"],
    entry: "index.mjs",
    ...overrides,
  });
}

describe("插件 manifest", () => {
  it("接受最小 manifest 与可选 description", () => {
    const parsed = parseManifest(manifest({ description: "示例插件" }));
    expect(parsed).toEqual({
      id: "demo-fetch",
      name: "Demo Fetch",
      version: "1.2.3",
      api_version: 1,
      provides: ["fetch"],
      entry: "index.mjs",
      description: "示例插件",
    });
  });

  it("接受 search、fetch 或两者，并保留声明顺序", () => {
    expect(parseManifest(manifest({ provides: ["search"] })).provides).toEqual(["search"]);
    expect(parseManifest(manifest({ provides: ["search", "fetch"] })).provides).toEqual([
      "search",
      "fetch",
    ]);
  });

  it("拒绝非法 JSON，并给出中文说明", () => {
    expect(() => parseManifest("{")).toThrow(/不是合法 JSON/);
  });

  it("拒绝未知字段", () => {
    expect(() => parseManifest(manifest({ extra: true }))).toThrow(/校验失败/);
    expect(() => parseManifest(manifest({ extra: true }))).toThrow(/[Uu]nrecognized|extra/);
  });

  it("校验 id 规则", () => {
    for (const id of ["ab", "ABC", "-abc", "abc-", ".abc", "a".repeat(65), "中文"]) {
      expect(() => parseManifest(manifest({ id })), id).toThrow(/id 必须/);
    }
    expect(isValidExtensionId("abc")).toBe(true);
    expect(isValidExtensionId("a.b_c-1")).toBe(true);
  });

  it("校验 name 与 version", () => {
    expect(() => parseManifest(manifest({ name: "" }))).toThrow(/name/);
    expect(() => parseManifest(manifest({ name: "x".repeat(81) }))).toThrow(/name/);
    expect(() => parseManifest(manifest({ version: "1.2" }))).toThrow(/version/);
    expect(() => parseManifest(manifest({ version: "v1.2.3" }))).toThrow(/version/);
    expect(isValidExtensionVersion("1.2.3-beta.1")).toBe(true);
  });

  it("api_version 只接受 1", () => {
    expect(() => parseManifest(manifest({ api_version: 2 }))).toThrow(/api_version/);
    expect(() => parseManifest(manifest({ api_version: "1" }))).toThrow(/api_version/);
  });

  it("provides 非空、不能重复、只能是 search/fetch", () => {
    expect(() => parseManifest(manifest({ provides: [] }))).toThrow(/至少声明一项/);
    expect(() => parseManifest(manifest({ provides: ["fetch", "fetch"] }))).toThrow(/重复/);
    expect(() => parseManifest(manifest({ provides: ["other"] }))).toThrow(/provides/);
  });

  it("entry 只能是单个 .mjs/.js 文件名", () => {
    for (const entry of [
      "dist/index.mjs",
      "../index.mjs",
      "/index.mjs",
      "index.txt",
      "C:\\index.mjs",
      "C:index.js",
      "index..mjs",
      ".mjs",
    ]) {
      expect(() => parseManifest(manifest({ entry })), entry).toThrow(/entry/);
    }
    expect(isValidEntryName("index.js")).toBe(true);
    expect(isValidEntryName("x.y.mjs")).toBe(true);
    expect(isValidEntryName("index_mjs.js")).toBe(true);
  });
});
