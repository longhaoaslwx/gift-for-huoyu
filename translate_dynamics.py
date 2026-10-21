# -*- coding: utf-8 -*-
"""把日文正文机翻成中文，并做术语与语体矫正。

为什么不能直接拿机翻结果用：
  Google 的 ja->zh 把「配信」译成「分发／交付／发放」，把「ビリビリ」译成「瞬间」，
  把「リスナー」译成「听众」。这些都是 B 站直播语境的专有说法，错得很显眼。

做法：
  1) 翻译前把高价值专有词替换成带标记的占位符（⟦T3⟧ 之类），机翻不会动它；
  2) 翻译后再还原成指定的中文译名；
  3) 对其余常见误译做正则矫正（例如「发放」->「开播」）。
  长文本按行切块，块内短于 MIN_CHUNK 的行合并，减少请求数又不破坏排版。

产出：translation/ja2zh.json  {动态ID: 中文}
可重复执行：已有结果的 ID 会跳过，中断后继续。

AI-TRANS｜本脚本产出的是 **AI 机器翻译**，不是人工译文。
  引擎：Google translate_a/single（ja→zh）+ 术语占位符 + 正则矫正。
  已知问题：主语/人称漂移（把「（我）觉得」翻成「你」）、长句被截断、
           惯用语直译（だらける→挤满）、数字与时刻偶有丢失。
  因此全量译文一律带 AI 标注（见 translation/ai_notice.json、ja2zh.README.md），
  含义可能不准确，需人工复核；人工确认过的条目存在 translation/fixes.json，
  机翻之后由 apply_fixes.py 盖回去。
"""
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "data", "bilibili", "2094031249", "dynamics", "all.json")
OUT_DIR = os.path.join(ROOT, "translation")
OUT = os.path.join(OUT_DIR, "ja2zh.json")

PROXY = "http://127.0.0.1:7897"
ENDPOINT = "https://translate.googleapis.com/translate_a/single"
WORKERS = 6
MIN_CHUNK = 180      # 合并到至少这么长再发一次，减少请求数
MAX_CHUNK = 1600     # 单次请求上限，URL 过长会被拒

# ---- 术语表：日文原词 -> 中文译名（按长度降序匹配，长词优先）
TERMS = {
    # 专有名词先行：她的名字必须原样保留，机翻会音译成「日目/火波/Hiba」
    "火羽ひのめ": "火羽ひのめ",
    "ひのめ": "火羽ひのめ",
    "ビリビリ": "B站",
    "bilibili": "B站",
    "配信": "直播",
    "リスナー": "观众",
    "サムネ": "封面",
    "切り抜き": "剪辑",
    "職人": "职人",
    "コラボ": "联动",
    "艦長": "舰长",
    "提督": "提督",
    "スパチャ": "SC",
    "ホラゲー": "恐怖游戏",
    "雑談": "杂谈",
    "アーカイブ": "录播",
    "グッズ": "周边",
    "イベント": "活动",
    "アプデ": "更新",
    "パッチ": "补丁",
    "メンテ": "维护",
    "ニンテンドーダイレクト": "任天堂直面会",
    "ダウンロードコンテンツ": "DLC",
    "ゲーム": "游戏",
    "アニメ": "动画",
    "ポケモン": "宝可梦",
    "ピカチュウ": "皮卡丘",
    "カービィ": "卡比",
    "マリオ": "马力欧",
    "ドラクエ": "勇者斗恶龙",
    "モンハン": "怪物猎人",
    "FF14": "FF14",
    "零式": "零式",
    "レイド": "副本",
    "ガチャ": "抽卡",
    "コメント": "弹幕",
    "ファン": "粉丝",
    "キャラ": "角色",
    "イラスト": "插画",
    "ストーリー": "剧情",
    "シリーズ": "系列",
    "コンテンツ": "内容",
    "クリスマス": "圣诞",
    "ハロウィン": "万圣节",
    "春節": "春节",
    "北京時間": "北京时间",
    "中国版": "国服",
    "日本版": "日服",
    "国際版": "国际服",
    "零式": "零式",

    # ---- v025 术语表补丁：100 条抽样人工重翻后沉淀，见 translation/glossary_patch.json
    # 句式级条目放这里：整句锁死，交给机翻必然译坏（「今日もこの後から配信する」
    # 被译成「今天之后我会做直播！」是全网最刺眼的一处）。按长度降序匹配，长句优先。
    "今日もこの後から配信できたらする": "今天稍后能开播就开",
    "今日もこの後から配信する": "今天稍后也开播",
    "今日はこの後から配信する": "今天待会儿就开播",
    # 少了「から」的变体（今日もこの後配信する）同样高频，必须一起锁死
    "今日もこの後配信する": "今天稍后也开播",
    "今日はこの後配信する": "今天待会儿就开播",
    "この後から配信": "待会儿开播",
    "この後配信": "待会儿开播",
    "配信します": "开播",
    "うちの配信室": "我的直播间",
    "うちの": "我的",
    "今日も22時から配信する": "今晚 22 点照常开播",
    "今日の配信も22時からやる": "今晚的直播也是 22 点开始",
    "今日の配信も22時からする": "今天的直播也是 22 点开始",
    "今日の配信も22時から": "今天的直播也是 22 点开始",
    "今週も1週間お疲れ様でした": "这一周大家也辛苦了",
    "動画は切り抜き職人さんが、サムネはMr-BBBBBさんが作ってくれました。":
        "视频由切片剪辑师制作，封面由 Mr-BBBBB 制作。",
    "動画は切り抜き職人さんが作ってくれました。": "视频由切片剪辑师制作。",
    # 词级条目
    "切り抜き職人": "切片剪辑师",
    "お疲れ様でした": "辛苦了",
    "お疲れ様": "辛苦了",
    "新年度": "新年度",
    "ひの雑": "火羽杂谈",
    "配信できない": "开不了播",
    "配信室": "直播间",
    "今から配信": "现在就开始直播",
    "このあと": "待会儿",
    "星之卡比": "星之卡比",
    "コダック": "可达鸭",
    "フシギダネ": "妙蛙种子",
    "ちいかわ": "吉伊卡哇",
    "カブタック": "铁甲小宝",
    "コミケ": "Comiket",
    "レート戦": "排位赛",
    "ランクマッチ": "排位赛",
    "偽中国語": "伪中国语",
    "ミクさん": "初音未来",
    "クリタワ演習場": "水晶塔演习场",
    "リセ日": "周常重置日",
    "仕事納め": "年底收工",
    "花火大会": "花火大会",
    "伝統的なお菓子": "传统点心",
    "木造住宅": "木造住宅",
    "鉄筋コンクリート": "钢筋混凝土",
    "光の戦士": "光之战士",
    "ファンアート": "粉丝图",
    "百艦": "百舰",
    "駆除": "扑杀",
    "人糞": "粪便",
    "静電気": "静电",
    "辣条": "辣条",
}

# 机翻常见误译的后置矫正（按顺序执行）。
# 注意只能修正「在直播语境下几乎一定错」的译法，不要用宽泛的动词，
# 否则会把本来正确的「交付/发放（物品）」也改坏。
FIXES = [
    (r"瞬间交付|瞬间", "B站"),
    (r"分发", "直播"),
    (r"配信", "直播"),
    (r"听众", "观众"),
    (r"缩略图", "封面"),
    # 原规则方向写反了：术语表现在直接产出「切片剪辑师」，
    # 这条会把正确的「剪辑师」再改回「剪辑职人」，故删除。
    (r"财政年度|会计年度", "新年度"),
    # 机翻会把连续的「！！」「？？」拆成「！ ！」「？ ？」，视觉上很散
    (r"([！？])\s+([！？])", r"\1\2"),
    (r"发放来", "开播"),      # 「今日のこの後から配信」句式
    (r"で发放", "开播"),
    # 「公式配信やってたけど」被译成「我玩的是官方直播」，这里的主语是她在看直播
    (r"我玩的是([^，。]{0,8}?)直播", r"看了\1直播"),
    (r"我在玩([^，。]{0,6}?)直播", r"我看了\1直播"),
]

# 判断原文是否本就是中文：日语里几乎不会出现这些简体字组合，
# 她有一部分公告是直接用中文写的，送去 ja->zh 会被译坏，必须跳过。
ZH_MARKERS = ("我们", "你们", "这个", "什么", "因为", "所以", "已经",
              "现在", "可以", "没有", "就是", "还是", "大家", "非常",
              "但是", "如果", "而且", "时候", "一个", "不要", "知道")
HIRA = re.compile(r"[ぁ-ん]")


def looks_chinese(text):
    """判断这段文字的主体是否为中文。

    她的中文公告常在开头带一句日文、或夹几个日文词，
    只看平假名数量会误判，因此改成「中文虚词密度」为主判据。
    """
    if not text.strip():
        return False
    plain = re.sub(r"\s+", "", text)
    hits = sum(plain.count(w) for w in ZH_MARKERS)
    # 中文虚词出现 3 次以上，且平假名占比很低（<6%），视为主体是中文
    hira_ratio = len(HIRA.findall(plain)) / max(len(plain), 1)
    return hits >= 3 and hira_ratio < 0.06

TOKEN_FMT = "⟦T{}⟧"
TOKEN_RE = re.compile(r"⟦T(\d+)⟧")


def build_token_map(text):
    """把术语替换成占位符；返回 (替换后文本, 占位符->中文 映射)。"""
    mapping = {}
    ordered = sorted(TERMS.items(), key=lambda kv: -len(kv[0]))
    out = text
    for i, (ja, zh) in enumerate(ordered):
        if ja in out:
            tok = TOKEN_FMT.format(i)
            mapping[tok] = zh
            out = out.replace(ja, tok)
    return out, mapping


def restore(text, mapping):
    for tok, zh in mapping.items():
        text = text.replace(tok, zh)
    # 机翻偶尔会吃掉/挪动方括号，兜底再扫一遍残留
    text = TOKEN_RE.sub(lambda m: "", text)
    return text


def apply_fixes(text):
    for pat, rep in FIXES:
        text = re.sub(pat, rep, text)
    return text


def split_chunks(text):
    """按行切块，短行合并，长行硬切，保证每块不超过 MAX_CHUNK。"""
    lines = text.split("\n")
    chunks, buf = [], ""
    for ln in lines:
        piece = ln + "\n"
        if len(piece) > MAX_CHUNK:
            if buf:
                chunks.append(buf)
                buf = ""
            for i in range(0, len(piece), MAX_CHUNK):
                chunks.append(piece[i:i + MAX_CHUNK])
            continue
        if len(buf) + len(piece) > MAX_CHUNK or len(buf) >= MIN_CHUNK:
            chunks.append(buf)
            buf = piece
        else:
            buf += piece
    if buf:
        chunks.append(buf)
    return chunks


_opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))


def gtranslate(text, sl="ja", tl="zh-CN", tries=3):
    q = urllib.parse.quote(text)
    url = f"{ENDPOINT}?client=gtx&sl={sl}&tl={tl}&dt=t&q={q}"
    last = None
    for k in range(tries):
        try:
            with _opener.open(url, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
            parts = [seg[0] for seg in data[0] if seg and seg[0]]
            return "".join(parts)
        except Exception as e:
            last = e
            time.sleep(1.2 * (k + 1))
    raise last


def translate_text(text):
    """逐块翻译并拼回，保留原有换行结构。"""
    if not text.strip():
        return text
    # 原文就是中文：只把零星日文行（如开头那句「大事なお知らせ」）译出来，
    # 其余中文正文原样保留，绝不整段送翻译。
    if looks_chinese(text):
        out_lines = []
        for ln in text.split("\n"):
            # 一行里平假名占比明显偏高，才认为是日文行
            plain = re.sub(r"\s+", "", ln)
            if plain and len(HIRA.findall(plain)) >= max(2, len(plain) * 0.25):
                try:
                    ln = gtranslate(ln)
                except Exception:
                    pass
            out_lines.append(ln)
        return "\n".join(out_lines).strip()
    tok_text, mapping = build_token_map(text)
    chunks = split_chunks(tok_text)
    outs = []
    for c in chunks:
        if not c.strip():
            outs.append(c)
            continue
        outs.append(gtranslate(c))
        time.sleep(0.05)
    zh = "".join(outs)
    zh = restore(zh, mapping)
    zh = apply_fixes(zh)
    return zh.strip()


_lock = threading.Lock()


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    posts = json.load(open(SRC, encoding="utf-8"))

    done = {}
    if os.path.exists(OUT):
        done = json.load(open(OUT, encoding="utf-8"))
        print(f"已有译文 {len(done)} 条，继续补齐")

    # --redo：术语表升级后统一重翻（忽略已有译文，成功才覆盖）
    # --redo-flagged：只重翻体检（audit_translations.py）判定有问题的那批，省请求
    if "--redo" in sys.argv:
        todo = [p for p in posts if (p.get("text") or "").strip()]
        print(f"--redo：重翻全部 {len(todo)} 条（按新术语表统一口径）")
    elif any(a.startswith("--ids=") for a in sys.argv):
        # 定向重翻：只处理指定 ID（机翻偶发乱码、或新术语只影响少数条目时用）
        want = set()
        for a in sys.argv:
            if a.startswith("--ids="):
                want |= {x.strip() for x in a.split("=", 1)[1].split(",") if x.strip()}
        todo = [p for p in posts if str(p["id"]) in want and (p.get("text") or "").strip()]
        print(f"--ids：定向重翻 {len(todo)} 条")
    elif "--redo-flagged" in sys.argv:
        rep = os.path.join(os.path.dirname(OUT), "audit_report.json")
        ids = set()
        if os.path.exists(rep):
            ids = {s["id"] for s in json.load(open(rep, encoding="utf-8"))
                   .get("suspects", [])}
        todo = [p for p in posts if str(p["id"]) in ids and (p.get("text") or "").strip()]
        print(f"--redo-flagged：只重翻体检命中的 {len(todo)} 条")
    else:
        todo = [p for p in posts if str(p["id"]) not in done and (p.get("text") or "").strip()]
    print(f"待翻译 {len(todo)} 条 / 共 {len(posts)} 条")
    if not todo:
        return

    limit = None
    for a in sys.argv[1:]:
        if a.startswith("--limit="):
            limit = int(a.split("=", 1)[1])
    if limit:
        todo = todo[:limit]
        print(f"本次只跑前 {len(todo)} 条")

    cnt = [0]
    t0 = time.time()

    def work(p):
        pid = str(p["id"])
        try:
            zh = translate_text(p["text"])
            with _lock:
                done[pid] = zh
                cnt[0] += 1
                if cnt[0] % 25 == 0:
                    el = time.time() - t0
                    rate = cnt[0] / max(el, 1e-6)
                    left = (len(todo) - cnt[0]) / max(rate, 1e-6)
                    print(f"  {cnt[0]}/{len(todo)}  {rate:.1f}/s  剩余 ~{left/60:.1f} min")
                    json.dump(done, open(OUT, "w", encoding="utf-8"),
                              ensure_ascii=False, indent=0)
        except Exception as e:
            with _lock:
                print(f"  失败 {pid}: {e}")

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(work, todo))

    json.dump(done, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print(f"完成 {cnt[0]} 条，累计 {len(done)} 条，用时 {(time.time()-t0)/60:.1f} min")


if __name__ == "__main__":
    main()
