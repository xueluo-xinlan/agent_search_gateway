#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Hermes patch #2: 让 PC 上的 SearXNG 真正能搜出东西。

问题：settings.yml 里 general/web 类只有 duckduckgo / brave / wikipedia / wikidata
      四个引擎是启用的（google / bing / mojeek 全被 disabled），所以任何查询几乎
      都只有 0~1 条结果。
修复：1) 启用 google / bing / mojeek
      2) extra_proxy_timeout 从 10 降到 3（该值是【叠加到每个引擎】的超时上，
         10 会让每个引擎都等 13s，整体搜索延迟爆炸）

幂等 / 自动备份 / 结构校验 / 打印回滚命令。
"""
import pathlib
import re
import shutil
import sys
import time

SETTINGS = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "searx/settings.yml")
ENABLE_ENGINES = ("google", "bing", "mojeek")
NEW_EXTRA_PROXY_TIMEOUT = 3


def fail(msg: str):
    print("FAIL: " + msg)
    sys.exit(1)


def main():
    text = SETTINGS.read_text(encoding="utf-8")
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.split(newline)

    stamp = time.strftime("%Y%m%d_%H%M%S")
    backup = SETTINGS.with_suffix(".yml.bak_hermes2_" + stamp)
    shutil.copy2(SETTINGS, backup)
    print("BACKUP: " + str(backup))

    changed = []

    # ---- 1) 启用指定引擎 ----
    for eng in ENABLE_ENGINES:
        name_re = re.compile(r"^\s*-\s*name:\s*" + re.escape(eng) + r"\s*$")
        idx = next((i for i, ln in enumerate(lines) if name_re.match(ln)), None)
        if idx is None:
            fail("找不到引擎条目: " + eng)

        # 在该引擎条目后 12 行内找 disabled: true
        done = False
        for j in range(idx + 1, min(idx + 13, len(lines))):
            if re.match(r"^\s*-\s*name:\s*", lines[j]):      # 撞到下一个引擎，停
                break
            if re.match(r"^\s*disabled:\s*true\s*$", lines[j]):
                indent = lines[j][: len(lines[j]) - len(lines[j].lstrip())]
                lines[j] = indent + "disabled: false"
                changed.append("%s: line %d disabled true -> false" % (eng, j + 1))
                done = True
                break
            if re.match(r"^\s*disabled:\s*false\s*$", lines[j]):
                changed.append("%s: already enabled (line %d)" % (eng, j + 1))
                done = True
                break
        if not done:
            fail("引擎 %s 的 disabled 行未找到/未变更" % eng)

    # ---- 2) extra_proxy_timeout ----
    for i, ln in enumerate(lines):
        if re.match(r"^\s*extra_proxy_timeout:\s*\d+\s*$", ln):
            indent = ln[: len(ln) - len(ln.lstrip())]
            old = ln.strip()
            lines[i] = indent + "extra_proxy_timeout: %d" % NEW_EXTRA_PROXY_TIMEOUT
            changed.append("extra_proxy_timeout: %s -> %d (line %d)" % (old, NEW_EXTRA_PROXY_TIMEOUT, i + 1))
            break

    patched = newline.join(lines)

    # ---- 校验 ----
    try:
        import yaml  # type: ignore
    except ImportError:
        fail("需要 pyyaml，请用 searxng 的 .venv python 运行")

    try:
        data = yaml.safe_load(patched)
    except Exception as exc:  # noqa: BLE001
        fail("YAML 解析失败，未写入: %s" % exc)

    eng_map = {e.get("name"): e for e in (data.get("engines") or []) if isinstance(e, dict) and e.get("name")}
    for eng in ENABLE_ENGINES:
        entry = eng_map.get(eng)
        if entry is None:
            fail("校验失败: 解析后找不到引擎 " + eng)
        if entry.get("disabled") is True:
            fail("校验失败: %s 仍是 disabled" % eng)

    got = (data.get("outgoing") or {}).get("extra_proxy_timeout")
    if got != NEW_EXTRA_PROXY_TIMEOUT:
        fail("校验失败: extra_proxy_timeout=%r" % got)

    SETTINGS.write_text(patched, encoding="utf-8", newline="")
    print("PATCHED:")
    for c in changed:
        print("  - " + c)
    print("ROLLBACK: copy \"%s\" \"%s\"" % (backup, SETTINGS))


if __name__ == "__main__":
    main()
