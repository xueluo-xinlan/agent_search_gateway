#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Hermes: 为 PC 上的 SearXNG 启用 Clash 出站代理。

背景：PC 上 Clash Verge 在跑（mixed port 127.0.0.1:7897），但系统代理开关关闭，
      而 pythonw/node 都不读 WinINET 系统代理 -> 被墙引擎（brave/duckduckgo/
      wikipedia/wikidata）全部 timeout -> SearXNG 返回 0 条结果。
      本脚本把 SearXNG 自身的 outgoing 出站指向 Clash 的 mixed 端口。

特性：幂等 / 自动备份 / YAML 校验 / 回滚命令打印。
"""
import pathlib
import re
import shutil
import sys
import time

SETTINGS = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "searx/settings.yml")
PROXY_URL = "http://127.0.0.1:7897"

ACTIVE_BLOCK = """  # ── Hermes patch: 出站走 Clash Verge mixed 端口（被墙引擎可达）──
  proxies:
    all://:
      - {proxy}
  extra_proxy_timeout: 10
""".format(proxy=PROXY_URL)

# 默认文件里那段"如何使用 proxy"的注释示例（整段替换）
COMMENT_BLOCK_RE = re.compile(
    r"  # uncomment below section if you want to use a proxy.*?#  extra_proxy_timeout: 10\r?\n",
    re.DOTALL,
)
ACTIVE_RE = re.compile(r"^\s{2}proxies:\s*$", re.MULTILINE)


def fail(msg: str) -> "None":
    print("FAIL: " + msg)
    sys.exit(1)


def main() -> None:
    if not SETTINGS.is_file():
        fail("settings.yml 不存在: %s" % SETTINGS)

    text = SETTINGS.read_text(encoding="utf-8")
    newline = "\r\n" if "\r\n" in text else "\n"

    # 幂等检查：outgoing 下已有生效的 proxies 段
    if ACTIVE_RE.search(text):
        if PROXY_URL in text:
            print("ALREADY_PATCHED: outgoing.proxies 已指向 " + PROXY_URL)
            sys.exit(0)
        fail("已存在生效的 outgoing.proxies 段但未指向 %s，请人工检查" % PROXY_URL)

    m = COMMENT_BLOCK_RE.search(text)
    if not m:
        fail("未找到默认 settings.yml 中的 proxy 注释示例块，拒绝盲改")

    stamp = time.strftime("%Y%m%d_%H%M%S")
    backup = SETTINGS.with_suffix(".yml.bak_hermes_" + stamp)
    shutil.copy2(SETTINGS, backup)
    print("BACKUP: " + str(backup))

    block = ACTIVE_BLOCK.replace("\n", newline)
    patched = text[: m.start()] + block + text[m.end():]

    # YAML 校验（venv 里 searxng 自带 pyyaml）
    try:
        import yaml  # type: ignore
    except ImportError:
        fail("当前解释器没有 pyyaml，请用 searxng 的 .venv\\Scripts\\python.exe 运行")

    try:
        data = yaml.safe_load(patched)
    except Exception as exc:  # noqa: BLE001
        fail("打补丁后 YAML 解析失败，未写入: %s" % exc)

    out = (data or {}).get("outgoing", {}) or {}
    if out.get("proxies") != {"all://": [PROXY_URL]}:
        fail("校验失败，outgoing.proxies = %r" % (out.get("proxies"),))

    SETTINGS.write_text(patched, encoding="utf-8", newline="")
    print("PATCHED: outgoing.proxies = all:// -> " + PROXY_URL)
    print("PATCHED: extra_proxy_timeout = " + str(out.get("extra_proxy_timeout")))
    print("ROLLBACK: copy \"%s\" \"%s\"" % (backup, SETTINGS))


if __name__ == "__main__":
    main()
