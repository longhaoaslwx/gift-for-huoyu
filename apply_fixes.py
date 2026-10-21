# -*- coding: utf-8 -*-
"""把 translation/fixes.json 里人工确认的译文回写进 ja2zh.json。

为什么单独一个文件：
  translate_dynamics.py 是整体重写 ja2zh.json 的（Google 引擎 + 术语表），
  人工改过的条目会被它冲掉。所以人工修正单独存档，每次重建数据前跑一遍本脚本
  盖回去，机器翻译和人工校对各管一层，互不干扰。

用法
----
  python apply_fixes.py            # 回写全部修正
  python apply_fixes.py --dry      # 只看会改多少条
  python apply_fixes.py --check    # 只校验：id 是否存在、原文是否还匹配

回写后务必再跑 python build_site_data.py，否则站点数据不会更新。

AI-TRANS｜本脚本回写的是 **人工确认** 的译文，与机翻分属两层：
  ja2zh.json 里其余条目仍是 AI 机器翻译（含义可能不准确，需人工复核），
  fixes.json 登记过的条目才是人工真值。改完记得跑 mark_ai_translations.py
  同步 translation/ai_notice.json 的统计。
"""
import argparse
import json
import os
import shutil
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
TR = os.path.join(ROOT, "translation", "ja2zh.json")
FIX = os.path.join(ROOT, "translation", "fixes.json")
RAW = os.path.join(ROOT, "data", "bilibili", "2094031249", "dynamics", "all.json")


def load(p, d=None):
    if not os.path.exists(p):
        return d
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="只统计不落盘")
    ap.add_argument("--check", action="store_true", help="只校验 id 与原文")
    a = ap.parse_args()

    tr = load(TR, {})
    fixes = load(FIX, {}).get("fixes", [])
    if not fixes:
        print("fixes.json 里没有修正条目")
        return

    # 校验：原动态必须存在，且 fixes 里记录的 ja 与原始正文一致（防 id 打错）
    src = {}
    raw = load(RAW, [])
    items = raw if isinstance(raw, list) else raw.get("items", raw.get("dynamics", []))
    for it in items:
        if not isinstance(it, dict):
            continue
        i = str(it.get("id") or it.get("dynamic_id") or "")
        if i:
            src[i] = (it.get("content") or it.get("text") or "").strip()

    bad = []
    for f in fixes:
        i = str(f["id"])
        if i not in tr:
            bad.append("%s: ja2zh.json 里没有这个 id" % i)
            continue
        if f.get("ja") and i in src and src[i] != f["ja"].strip():
            bad.append("%s: 原文与 fixes 记录不一致\n    实际: %r" % (i, src[i][:60]))
    if bad:
        print("✗ 校验失败 %d 条：" % len(bad))
        for b in bad:
            print("  " + b)
        raise SystemExit(1)
    print("✓ 校验通过 %d 条" % len(fixes))
    if a.check:
        return

    changed = [f for f in fixes if tr.get(str(f["id"])) != f["zh"]]
    print("待回写 %d 条（共 %d 条修正，其余已是目标译文）" % (len(changed), len(fixes)))
    for f in changed[:10]:
        print("  %s\n    旧: %s\n    新: %s" % (
            f["id"], (tr.get(str(f["id"])) or "").replace("\n", " ")[:60],
            f["zh"].replace("\n", " ")[:60]))
    if a.dry:
        return
    if not changed:
        return

    bak = TR.replace(".json", ".bak_%s.json" % time.strftime("%Y%m%d_%H%M%S"))
    shutil.copy2(TR, bak)
    print("已备份 → %s" % os.path.basename(bak))

    for f in changed:
        tr[str(f["id"])] = f["zh"]
    with open(TR, "w", encoding="utf-8") as fh:
        json.dump(tr, fh, ensure_ascii=False, indent=0)
    print("✓ 已回写 %d 条到 ja2zh.json" % len(changed))
    print("下一步：python build_site_data.py 重建站点数据")


if __name__ == "__main__":
    main()
