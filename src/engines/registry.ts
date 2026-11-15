/**
 * 网关原生引擎注册表：编译期静态注册 + 运行期外部 overlay。
 *
 * 新增内置引擎 = 新建 `providers/<name>.ts` + 在这里加一行；CLI 与运行期都从这里取。
 * 第三方扩展（`data/extensions`）加载后通过 `setExternalEngineProviders` 合并；
 * 同 id 的外部 provider 覆盖内置项。
 */

import type { EngineProvider } from "./provider.js";
import type { EngineGroup } from "./types.js";
import { tracemoeProvider } from "./providers/tracemoe.js";
import { saucenaoProvider } from "./providers/saucenao.js";
import { baiduProvider } from "./providers/baidu.js";

export const ENGINE_PROVIDERS: readonly EngineProvider[] = [
  tracemoeProvider,
  saucenaoProvider,
  baiduProvider,
];

// 内置 provider 的 id 是编程契约；重复说明注册表写错了，直接 fail fast。
const seen = new Set<string>();
for (const provider of ENGINE_PROVIDERS) {
  if (seen.has(provider.id)) {
    throw new Error(`重复的引擎 provider id：${provider.id}`);
  }
  seen.add(provider.id);
}

/** 运行期外部 provider：同 id 覆盖内置，其余追加在内置之后。 */
let externalProviders: readonly EngineProvider[] = [];

export function setExternalEngineProviders(list: readonly EngineProvider[]): void {
  const ids = new Set<string>();
  for (const provider of list) {
    if (ids.has(provider.id)) {
      throw new Error(`外部扩展内重复的引擎 provider id：${provider.id}`);
    }
    ids.add(provider.id);
  }
  externalProviders = [...list];
}

/** 当前生效的 provider 列表（内置 + 外部 overlay）。 */
export function allProviders(): readonly EngineProvider[] {
  if (externalProviders.length === 0) return ENGINE_PROVIDERS;
  const externalIds = new Set(externalProviders.map((provider) => provider.id));
  return [
    ...ENGINE_PROVIDERS.filter((provider) => !externalIds.has(provider.id)),
    ...externalProviders,
  ];
}

/** 测试辅助：清空外部 overlay，恢复纯内置视图。 */
export function resetExternalEngineProvidersForTests(): void {
  externalProviders = [];
}

export function engineProvider(group: EngineGroup, name: string): EngineProvider | undefined {
  return allProviders().find((provider) => provider.group === group && provider.name === name);
}

export function providersForGroup(group: EngineGroup): readonly EngineProvider[] {
  return allProviders().filter((provider) => provider.group === group);
}
