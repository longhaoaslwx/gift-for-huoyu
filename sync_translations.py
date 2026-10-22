#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全刷后同步译文：找出 all.json 里正文发生变化的条目，定向重译。

日常增量更新不需要它（translate_dynamics.py 会补新增条目）；只有
--refresh-stats 全刷之后，少数老动态的正文才可能因接口返回差异而
变化，此时译文还是按旧正文翻的，需要重翻保持同步。

做法：用 git show 取上一版 all.json，与当前版本按 id 对比 text，
把有变化的 id 交给 translate_dynamics.py --ids= 定向重译。
"""

import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ALL = os.path.join(ROOT, "data", "bilibili", "2094031249", "dynamics", "all.json")
GIT_OLD = "HEAD:data/bilibili/2094031249/dynamics/all.json"


def load_new():
    with open(ALL, encoding="utf-8") as f:
        return json.load(f)


def load_old():
    """从 git 取上一版 all.json；非 git 环境或首次运行返回空列表。"""
    try:
        out = subprocess.run(
            ["git", "show", GIT_OLD], capture_output=True, text=True,
            cwd=ROOT, check=True).stdout
        return json.loads(out) if out.strip() else []
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] 取旧版 all.json 失败（跳过对比）: {e}")
        return []


def main():
    new = load_new()
    old = {str(r["id"]): r for r in load_old()}
    if not old:
        print("无旧版可比，跳过")
        return
    ids = [str(r["id"]) for r in new
           if str(r["id"]) in old and r.get("text") != old[str(r["id"])].get("text")]
    if not ids:
        print("正文无变化，无需重译")
        return
    print(f"正文有变化 {len(ids)} 条，定向重译: {','.join(ids)}")
    subprocess.run(
        [sys.executable, os.path.join(ROOT, "translate_dynamics.py"),
         "--ids=" + ",".join(ids)],
        cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
