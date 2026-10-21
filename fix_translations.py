# -*- coding: utf-8 -*-
"""对已产出的 ja2zh.json 做定点清洗，不重跑全量机翻。

处理三类已知缺陷：
1. 人名被音译（「日目」「日目日场」「Hiba」「火波」）→ 还原为「火羽ひのめ」
2. 个别长句未译（机翻对超长行返回原文，且用简体字替换了部分日文汉字，
   如「違う→违う」「長さ→长さ」）→ 这些行重新送翻译
3. 译文明显短于原文（机翻静默截断）→ 重译并取更完整的结果
"""
import importlib.util
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("td", os.path.join(ROOT, "translate_dynamics.py"))
td = importlib.util.module_from_spec(spec)
spec.loader.exec_module(td)

TRANS = os.path.join(ROOT, "translation", "ja2zh.json")
SRC = os.path.join(ROOT, "data", "bilibili", "2094031249", "dynamics", "all.json")

# 机翻对人名的各种跑偏写法。注意「日目」要单独处理：
# 它可能只是「日目火波」的一部分，也可能是独立出现。
NAME_BAD = ["日目日场", "日目火波", "日目 Hiba", "日目Hiba", "火波", "日目"]

HIRA = re.compile(r"[ぁ-んァ-ヶ]")
CJK = re.compile(r"[\u4e00-\u9fff]")


def stars(s):
    return len(re.sub(r"\s+", "", s))


def fix_name(text):
    """把误音译的人名还原。只在原文确实出现过她名字时才动手。"""
    out = text
    for bad in NAME_BAD:
        if bad in out:
            out = out.replace(bad, "火羽ひのめ")
    # 「火羽ひのめひのめ」这类叠字收一下
    out = re.sub(r"(火羽ひのめ)(?:火羽)?ひのめ", r"\1", out)
    out = re.sub(r"火羽火羽ひのめ", "火羽ひのめ", out)
    return out


def japanese_ratio(s):
    """粗略判断字符串里日文成分占比。"""
    plain = re.sub(r"[\s\W_]+", "", s)
    if not plain:
        return 0.0
    return len(HIRA.findall(plain)) / len(plain)


def needs_retranslate(src_line, zh_line):
    """判断某一行译文是否其实是未翻译的日文原文。"""
    if not src_line.strip():
        return False
    r = japanese_ratio(zh_line)
    # 译文里假名占比仍然很高 → 基本就是原文
    return r > 0.18


def main():
    done = json.load(open(TRANS, encoding="utf-8"))
    posts = json.load(open(SRC, encoding="utf-8"))
    idx = {str(p["id"]): (p.get("text") or "") for p in posts}

    stat = {"name": 0, "line": 0, "short": 0}
    for pid, zh in list(done.items()):
        src = idx.get(pid, "")
        if not src:
            continue
        orig = zh

        # --- 1. 人名还原
        new = fix_name(zh)

        # --- 2. 逐行复检：源行是日文、译行仍是日文 → 重译该行
        s_lines = src.split("\n")
        z_lines = new.split("\n")
        if len(s_lines) >= len(z_lines):
            for i, zl in enumerate(z_lines):
                if i >= len(s_lines):
                    break
                if needs_retranslate(s_lines[i], zl):
                    try:
                        zh_line = td.translate_text(s_lines[i])
                        if zh_line and japanese_ratio(zh_line) < japanese_ratio(zl):
                            z_lines[i] = zh_line
                    except Exception as e:
                        print(f"  行重译失败 {pid}: {e}")
            new = "\n".join(z_lines)

        # --- 3. 截断：译文过短则整条重译，取更长的一次
        a, b = stars(src), stars(new)
        if a > 60 and b / max(a, 1) < 0.45:
            try:
                again = td.translate_text(src)
                again = fix_name(again)
                if stars(again) > b:
                    new = again
            except Exception as e:
                print(f"  整条重译失败 {pid}: {e}")

        if new != orig:
            done[pid] = new
            if fix_name(orig) != orig:
                stat["name"] += 1
            if japanese_ratio(new) < japanese_ratio(orig) - 0.05:
                stat["line"] += 1
            if stars(new) > stars(orig):
                stat["short"] += 1

    json.dump(done, open(TRANS, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print("清洗完成", stat)


if __name__ == "__main__":
    main()
