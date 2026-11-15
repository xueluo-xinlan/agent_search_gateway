#!/usr/bin/env bash
# 本地补丁存在性自检。
#
# 作用范围（务必看清）：只检查「补丁的标志性代码还在不在」，不检查「跑得好不好」。
# grep 到 startStdioServer ≠ stdio 真能用；真正的行为判据是实测（见文末提示）。
#
# 用法：
#   ./verify-patches.sh            # 检查本目录
#   ./verify-patches.sh /opt/asg-035   # 检查指定网关根
#   退出码 0 = 全部存在；1 = 有缺失
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
S="$ROOT/src"

if [ ! -d "$S" ]; then
  echo "错误：$ROOT 下没有 src/，不像 asg 源码目录" >&2
  exit 1
fi

pass=0
fail=0
declare -a MISSING=()

chk() {
  local name="$1" pat="$2" file="$3"
  if grep -qF -- "$pat" "$file" 2>/dev/null; then
    printf '  \033[32m✓\033[0m %s\n' "$name"
    pass=$((pass + 1))
  else
    printf '  \033[31m✗\033[0m %s  \033[90m(%s)\033[0m\n' "$name" "${file#"$ROOT"/}"
    MISSING+=("$name → ${file#"$ROOT"/}")
    fail=$((fail + 1))
  fi
}

echo "检查根目录: $ROOT"
echo "=== 补丁 1：stdio 传输（上游 0.3.x 无此能力，删了就断 MCP）==="
chk "startStdioServer"                  "startStdioServer"                      "$S/server.ts"
chk "Logger useStderr"                  "useStderr"                             "$S/logger.ts"
chk "--stdio 分支"                      'process.argv.includes("--stdio")'      "$S/index.ts"

echo "=== 补丁 2：兜底检索（Tavily → Bing → DDG）==="
chk "searchFallback 入口"               "searchFallback"                        "$S/search/fallback.ts"
chk "Bing 结果选择器"                   "li.b_algo"                             "$S/search/fallback.ts"
chk "Bing 跳转链接解码"                 "decodeBingUrl"                         "$S/search/fallback.ts"
chk "schema 里的 fallback 开关"         "fallback: z.boolean()"                 "$S/settings/schema.ts"

echo "=== 补丁 3：配置查找四级回退 ==="
chk "项目根向上找 package.json"         'resolve(dir, "package.json")'          "$S/settings/load.ts"
chk "GATEWAY_CONFIG 环境变量"           "GATEWAY_CONFIG"                        "$S/settings/load.ts"

echo "=== 补丁 4：ads+porn 档（三处都要改，漏一处就整份配置被拒）==="
chk "schema enum"                       "ads+porn"                              "$S/settings/schema.ts"
chk "HOSTS_SOURCES"                     "ads+porn"                              "$S/filter/domain-filter.ts"
chk "CLI LEVELS 常量"                   "ads+porn"                              "$S/cli/commands/adlist.ts"

echo "=== 补丁 5：FlareSolverr 关闭时不误报故障 ==="
chk 'status: "off"'                     'status: "off"'                         "$S/health.ts"

echo "=== 补丁 6：METRICS 落盘 ==="
chk "appendMetricsLine"                 "appendMetricsLine"                     "$S/search/service.ts"

echo "=== 补丁 7：corpus 过期校验 ==="
chk "expires_at 过滤"                   "expires_at > ?"                        "$S/search/embedding/store.ts"

echo "=== 补丁 8：反爬判定 CF 优先（上游 bug）==="
chk "cfFeatures 先判"                   "if (cfFeatures) return true"           "$S/fetch/service.ts"

echo "=== 补丁 9：反图搜跳过无图片引擎（上游 bug）==="
chk "skipSearxngForReverseImage"        "skipSearxngForReverseImage"            "$S/search/service.ts"

echo "=== 补丁 10：Wayback 兜底 ==="
chk "fetchViaWayback 调用"              "fetchViaWayback"                       "$S/fetch/service.ts"
chk "缓存桶 wayback"                    '"wayback"'                             "$S/fetch/cache.ts"

echo "=== 补丁 11：健康四态 ==="
chk "unverified 状态"                   "unverified"                            "$S/health.ts"
chk "markHealthy 落盘"                  "markHealthy"                           "$S/health-state.ts"

echo "=== 补丁 12：插件目录用项目根（上游 bug）==="
chk "loadExtensions(getProjectRoot())"  "loadExtensions(getProjectRoot()"       "$S/server.ts"

echo "=== 扩展：additive 叠加机制（让插件能与网页结果并列）==="
chk "additiveSources"                   "additiveSources"                       "$S/search/service.ts"

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32m结果: %d 通过 / 0 失败\033[0m\n' "$pass"
  echo
  echo "注意：本脚本只证明代码在。行为仍须实测，最低四判据："
  echo "  ① doctor 的 config 为 ok"
  echo "  ② 启动日志「第三方扩展已加载：engine N 个」N 与预期一致"
  echo "  ③ ss -lnt | grep 3000 为空（真 stdio）"
  echo "  ④ health 三后端为 on/off，不是 down/unverified"
  exit 0
else
  printf '\033[31m结果: %d 通过 / %d 失败\033[0m\n' "$pass" "$fail"
  echo
  echo "缺失项："
  for m in "${MISSING[@]}"; do echo "  - $m"; done
  exit 1
fi
