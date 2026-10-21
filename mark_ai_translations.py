# -*- coding: utf-8 -*-
"""给项目里所有「非人工」译文打统一标注，并生成可检索的标注清单。

为什么需要它
------------
站内 2000+ 条中文译文是 Google 引擎 + 术语表机翻出来的（见 translate_dynamics.py），
只有极少数条目经过人工确认（见 fixes.json）。读者与后来维护的人都应该一眼看出
「这段是 AI 翻的，别当权威」。JSON 不允许写注释，所以在数据文件旁用保留键
`_ai_notice`，在源码/文档里用 `AI-TRANS` 注释标记，检索时统一 grep `AI-TRANS` 即可。

做法
----
1) 统计：ja2zh.json 里除 fixes.json 人工确认之外的条目 = AI 生成；
2) 在对象型 JSON 里幂等写入 `_ai_notice`（已有则原地更新，不会重复堆叠）；
3) 产出 translation/ai_notice.json —— 机器可读的总清单（范围、数量、位置、免责文案）；
4) 逐个 json.load 校验，任何文件解析失败立即报错退出。

不改动：原文、ja2zh.json 的 key（动态 ID）与译文、任何代码逻辑。

用法
----
  python mark_ai_translations.py          # 打标 + 生成清单
  python mark_ai_translations.py --check  # 只校验现有标注是否齐全，不写盘
"""
import argparse
import datetime
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
TR = os.path.join(ROOT, "translation")
JA2ZH = os.path.join(TR, "ja2zh.json")
FIXES = os.path.join(TR, "fixes.json")
NOTICE = os.path.join(TR, "ai_notice.json")

MARK = "AI-TRANS"
NOTE_ZH = ("本内容由 AI 机器翻译生成，未经人工逐条校对，含义可能不准确；"
           "请以日文原文为准，并需人工复核。")
NOTE_JA = ("この翻訳は AI（機械翻訳）による自動生成です。内容が不正確な場合があります。"
           "原文を必ず参照してください。")

# 需要写入 _ai_notice 的对象型 JSON：路径 → (分类, 一句话范围, 免责文案覆盖，可选)
HUMAN_NOTE = ("本文件是人工确认过的译文，不属于 AI 生成内容，无需再按 AI 译文复核；"
              "它同时是 ja2zh.json 里对应条目的「人工真值」，机翻之后由 apply_fixes.py 盖回去。")
TARGETS = [
    ("translation/glossary_patch.json", "AI 生成的术语补丁",
     "由 AI 审阅沉淀的术语/句式替换表，合并进翻译脚本前需人工确认。", None),
    ("translation/review_100_llm.json", "AI 重译样本",
     "100 条抽样重译，整份由 AI 生成，仅作质量比对用，未全部回写站内。", None),
    ("translation/audit_report.json", "AI 机器审计",
     "机器扫描出的可疑译文清单（错译/数字丢失/日文残留），结论需人工复核。", None),
    ("translation/fixes.json", "人工确认（非 AI）",
     "人工确认过的译文修正表，是本项目唯一的「人工真值」，不属于 AI 生成内容。", HUMAN_NOTE),
]


def load(p, d=None):
    if not os.path.exists(p):
        return d
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def dump(p, obj, indent=1):
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent)
        f.write("\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只校验，不写盘")
    a = ap.parse_args()

    tr = load(JA2ZH, {})
    fixes = load(FIXES, {}).get("fixes", [])
    human = [str(f["id"]) for f in fixes if str(f.get("id")) in tr]
    ai_ids = [k for k in tr if k not in set(human)]

    print("译文总量 %d 条：AI 生成 %d 条，人工确认 %d 条" % (len(tr), len(ai_ids), len(human)))

    # ---- 1. 对象型 JSON 幂等写入 _ai_notice ----
    changed = 0
    missing = []
    for rel, kind, scope, note in TARGETS:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            print("  - 跳过（不存在）%s" % rel)
            continue
        obj = load(path)
        if not isinstance(obj, dict):
            print("  ! 跳过（不是对象，无法加键）%s" % rel)
            continue
        notice = "[%s] %s｜%s｜%s" % (MARK, kind, scope, note or NOTE_ZH)
        if obj.get("_ai_notice") == notice:
            print("  = 已标注 %s" % rel)
            continue
        missing.append(rel)
        if a.check:
            continue
        # 置顶：_ai_notice 放到第一个键，人打开文件第一眼就能看到
        rest = {k: v for k, v in obj.items() if k != "_ai_notice"}
        newobj = {"_ai_notice": notice}
        newobj.update(rest)
        dump(path, newobj)
        changed += 1
        print("  + 已标注 %s" % rel)

    if a.check:
        if missing:
            print("✗ 以下文件缺标注：%s" % ", ".join(missing))
            raise SystemExit(1)
    else:
        print("写入 %d 个文件" % changed)

    # ---- 2. 总清单 ----
    locations = [
        {"file": "translation/ja2zh.json", "kind": "译文数据（AI 生成）",
         "form": "同目录 ja2zh.README.md 声明 + ai_notice.json 登记",
         "scope": "%d 条（除 human_confirmed_ids 外全部）" % len(ai_ids)},
        {"file": "site/assets/data/posts.json", "kind": "站点数据 zh 字段（AI 生成，构建产物）",
         "form": "生成脚本 build_site_data.py 内 AI-TRANS 注释 + 本清单登记",
         "scope": "%d 条 zh（数组结构无法加键，故不内嵌标注）" % len(ai_ids)},
        {"file": "translation/fixes.json", "kind": "人工确认（非 AI）",
         "form": "_ai_notice 键", "scope": "%d 条" % len(human)},
        {"file": "translation/glossary_patch.json", "kind": "AI 生成的术语补丁",
         "form": "_ai_notice 键", "scope": "全部 terms"},
        {"file": "translation/review_100_llm.json", "kind": "AI 重译样本",
         "form": "_ai_notice 键", "scope": "items 全部条目"},
        {"file": "translation/audit_report.json", "kind": "AI 机器审计",
         "form": "_ai_notice 键", "scope": "suspects 全部条目"},
        {"file": "translate_dynamics.py", "kind": "译文生产脚本",
         "form": "AI-TRANS 注释块", "scope": "文件头 + 写盘处"},
        {"file": "build_site_data.py", "kind": "译文注入站点",
         "form": "AI-TRANS 注释块", "scope": "zh 字段注入处"},
        {"file": "apply_fixes.py", "kind": "人工修正回写",
         "form": "AI-TRANS 注释块", "scope": "文件头"},
        {"file": "site/assets/app.js", "kind": "前端渲染译文",
         "form": "AI-TRANS 注释", "scope": "译文渲染处"},
        {"file": "site/index.html", "kind": "UI 文案（面向读者的免责说明）",
         "form": "AI-TRANS 注释 + 可见文案 .lv-ainote", "scope": "信笺头部"},
        {"file": "site/assets/style.css", "kind": "UI 样式",
         "form": "AI-TRANS 注释", "scope": ".lv-ainote"},
    ]
    notice_doc = {
        "_ai_notice": "[%s] 全院译文标注总清单｜%s" % (MARK, NOTE_ZH),
        "marker": MARK,
        "notice_zh": NOTE_ZH,
        "notice_ja": NOTE_JA,
        "review_required": True,
        "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "rule": ("translation/ja2zh.json 中除 human_confirmed_ids 以外的条目均为 AI 机器翻译，"
                 "一律带本标注；human_confirmed_ids 里的是人工确认过的真值，不带 AI 标注。"
                 "检索方式：grep -rn 'AI-TRANS' ."),
        "summary": {
            "translated_total": len(tr),
            "ai_generated": len(ai_ids),
            "human_confirmed": len(human),
        },
        "human_confirmed_ids": human,
        "locations": locations,
    }
    if a.check:
        old = load(NOTICE, {})
        if old.get("summary", {}).get("ai_generated") != len(ai_ids):
            print("✗ ai_notice.json 与当前数据不同步（AI 条数 %s ≠ %d）"
                  % (old.get("summary", {}).get("ai_generated"), len(ai_ids)))
            raise SystemExit(1)
        print("✓ 标注齐全且与数据同步")
        return
    dump(NOTICE, notice_doc)
    print("已生成 %s" % os.path.relpath(NOTICE, ROOT))

    # ---- 3. 校验所有被写过的 JSON 仍可解析 ----
    bad = []
    for rel, _, _, _ in TARGETS:
        p = os.path.join(ROOT, rel)
        if os.path.exists(p):
            try:
                json.load(io.open(p, encoding="utf-8"))
            except Exception as e:
                bad.append("%s: %s" % (rel, e))
    try:
        json.load(io.open(NOTICE, encoding="utf-8"))
    except Exception as e:
        bad.append("translation/ai_notice.json: %s" % e)
    if bad:
        print("✗ JSON 校验失败：")
        for b in bad:
            print("  " + b)
        sys.exit(1)
    print("✓ 所有 JSON 仍可正常解析")


if __name__ == "__main__":
    main()
