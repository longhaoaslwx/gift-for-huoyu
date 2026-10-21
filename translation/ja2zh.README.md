# ja2zh.json —— AI 机器翻译，仅供参考

> **AI-TRANS｜本文件中的中文译文由 AI（机器翻译）生成，未经人工逐条校对，含义可能不准确。**
> **请以 `data/bilibili/2094031249/dynamics/*.json` 里的日文原文为准，使用前需人工复核。**

## 这是什么

`{动态ID: 中文译文}` 的扁平映射，由 `translate_dynamics.py` 用 Google ja→zh 引擎
加术语表（`glossary_patch.json`）与正则矫正生成，供站点 RING / 图集 / 全文页展示。

## 哪些不是 AI 翻的

`fixes.json` 里 `fixes` 数组登记的条目是人工确认过的译文，属于本项目的「人工真值」。
`apply_fixes.py` 会在机翻之后把它们盖回去，所以一个条目如果同时出现在两个文件里，
**以 `fixes.json` 为准**。

- 机器翻译条目数 / 人工确认条目数：见 `ai_notice.json` 的 `summary`
- 逐条清单与检索方式：见 `ai_notice.json` 的 `human_confirmed_ids` 与 `rule`

## 为什么没有把标注写进本文件

JSON 不支持注释。往里加一个 `_ai_notice` 键会让 `audit_translations.py`、
`fix_translations.py` 这类 `for pid, zh in tr.items()` 的脚本把该键当成动态 ID 处理，
所以标注放在同目录的这份说明与 `ai_notice.json` 里，数据文件本身保持纯净。

## 怎么检索

```bash
grep -rn 'AI-TRANS' .                      # 全项目所有 AI 标注
python mark_ai_translations.py --check     # 校验标注是否与当前数据同步
```

## 怎么改错译

1. 把修正写进 `translation/fixes.json`（记 id、原文、旧译文、新译文、错在哪）；
2. `python apply_fixes.py`；
3. `python build_site_data.py`；
4. `python mark_ai_translations.py`（同步标注统计）。
