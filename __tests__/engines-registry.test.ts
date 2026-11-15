import { afterEach, describe, expect, it } from "vitest";
import {
  ENGINE_PROVIDERS,
  engineProvider,
  providersForGroup,
  resetExternalEngineProvidersForTests,
  setExternalEngineProviders,
} from "../src/engines/registry.js";
import type { EngineProvider, EngineProviderContext } from "../src/engines/provider.js";
import { tracemoeProvider } from "../src/engines/providers/tracemoe.js";
import { saucenaoProvider } from "../src/engines/providers/saucenao.js";
import { baiduProvider } from "../src/engines/providers/baidu.js";
import { GATEWAY_SOURCE_SPECS } from "../src/settings/gateway-sources.js";

function ctx(
  config: Record<string, unknown> = {},
  secrets: Record<string, unknown> = {},
): EngineProviderContext {
  return { config, secrets };
}

function fakeProvider(overrides: Partial<EngineProvider> = {}): EngineProvider {
  return {
    id: "gateway.search:demo",
    group: "gateway.search",
    name: "demo",
    kind: "gateway",
    displayName: "Demo",
    routing: () => ["category:demo"],
    available: () => true,
    runtime: {
      kind: "search",
      plan: () => undefined,
      search: async () => ({ ok: false, error: { kind: "api", message: "stub" }, latencyMs: 0 }),
    },
    ...overrides,
  };
}

afterEach(() => {
  resetExternalEngineProvidersForTests();
});

describe("引擎 provider 注册表", () => {
  it("provider id 唯一", () => {
    const ids = ENGINE_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("GATEWAY_SOURCE_SPECS 每个源都有 provider，requires 一致", () => {
    for (const spec of GATEWAY_SOURCE_SPECS) {
      const provider = engineProvider("gateway.reverse_image", spec.name);
      expect(provider, spec.name).toBeDefined();
      expect([...(provider!.requires ?? [])]).toEqual([...spec.requires]);
    }
    expect(providersForGroup("gateway.reverse_image")).toHaveLength(GATEWAY_SOURCE_SPECS.length);
  });

  it("核心不再内置 gateway.search 文本源", () => {
    expect(providersForGroup("gateway.search")).toEqual([]);
    expect(engineProvider("gateway.search", "weibo")).toBeUndefined();
  });
});

describe("provider 元数据", () => {
  it("百度 available：缺省 true，baidu.enabled=false 时 false", () => {
    expect(baiduProvider.available(ctx({ search: { reverse_image: {} } }))).toBe(true);
    expect(
      baiduProvider.available(ctx({ search: { reverse_image: { baidu: { enabled: false } } } })),
    ).toBe(false);
    expect(
      baiduProvider.available(ctx({ search: { reverse_image: { baidu: { enabled: true } } } })),
    ).toBe(true);
  });

  it("trace.moe available 恒 true", () => {
    expect(tracemoeProvider.available(ctx())).toBe(true);
    expect(tracemoeProvider.available(ctx({ search: { reverse_image: { enabled: false } } }))).toBe(true);
  });

  it("SauceNAO available 取决于 secrets 中的 api_key", () => {
    expect(saucenaoProvider.available(ctx())).toBe(false);
    expect(
      saucenaoProvider.available(
        ctx({}, { search: { reverse_image: { saucenao: { api_key: "  " } } } }),
      ),
    ).toBe(false);
    expect(
      saucenaoProvider.available(
        ctx({}, { search: { reverse_image: { saucenao: { api_key: "abc" } } } }),
      ),
    ).toBe(true);
  });

  it("反向图搜 provider 的 runtime kind 正确", () => {
    for (const name of ["tracemoe", "saucenao", "baidu"]) {
      expect(engineProvider("gateway.reverse_image", name)!.runtime!.kind).toBe("reverse_image");
    }
  });
});

describe("外部引擎 provider overlay", () => {
  it("外部同 id 覆盖内置，ENGINE_PROVIDERS 本身不变", () => {
    const external = fakeProvider({
      id: "gateway.reverse_image:baidu",
      group: "gateway.reverse_image",
      name: "baidu",
      kind: "gateway",
      displayName: "外部百度",
      runtime: { kind: "reverse_image", search: async () => ({ ok: false, error: { kind: "api", message: "stub" } }) },
    });

    setExternalEngineProviders([external]);

    expect(engineProvider("gateway.reverse_image", "baidu")).toBe(external);
    const group = providersForGroup("gateway.reverse_image");
    expect(group).toContain(external);
    expect(group.filter((provider) => provider.id === "gateway.reverse_image:baidu")).toHaveLength(1);
    expect(ENGINE_PROVIDERS.find((provider) => provider.id === "gateway.reverse_image:baidu")).toBe(
      baiduProvider,
    );
  });

  it("providersForGroup 包含新增的外部 provider", () => {
    const external = fakeProvider();
    setExternalEngineProviders([external]);

    expect(providersForGroup("gateway.search").map((provider) => provider.id)).toContain(
      "gateway.search:demo",
    );
    expect(engineProvider("gateway.search", "demo")).toBe(external);
    // 反向图搜组不受影响
    expect(providersForGroup("gateway.reverse_image")).toHaveLength(GATEWAY_SOURCE_SPECS.length);
  });

  it("同一批内 id 重复时抛错", () => {
    expect(() =>
      setExternalEngineProviders([fakeProvider(), fakeProvider({ displayName: "重复" })]),
    ).toThrow(/重复/);
  });

  it("清空外部 overlay 后恢复纯内置视图", () => {
    setExternalEngineProviders([fakeProvider()]);
    expect(engineProvider("gateway.search", "demo")).toBeDefined();

    resetExternalEngineProvidersForTests();
    expect(engineProvider("gateway.search", "demo")).toBeUndefined();
    expect(engineProvider("gateway.search", "weibo")).toBeUndefined();
  });
});
