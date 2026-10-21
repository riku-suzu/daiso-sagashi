"""商品の色を 1 つずつ決めて public/data/catalog.json の 11 番目（index 10）に入れる。
Pillow が要る。GitHub Actions で build.py のあとに動かす。

  python3 scripts/colors.py                 タイトルで決め、足りない分は画像で決める
  python3 scripts/colors.py --minutes 40    画像の処理をこの分数で打ち切る（既定 40）
  python3 scripts/colors.py --limit 300     新しく処理する画像を最大 N 枚にする（試し用）

決め方:
  1. タイトルの（）の中と全角スペースの後ろだけを見て、色の語で決める（確実なものだけ）
  2. 無ければ商品画像（64px）の色で決める。結果は data/colors.json に覚えておき、同じ画像は取り直さない
"""
import colorsys
import io
import json
import re
import sys
import time
import unicodedata
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "public" / "data" / "catalog.json"
CACHE = ROOT / "data" / "colors.json"   # {handle: [色, "t"|"i"]}  t=タイトルから、i=画像から
UA = "Mozilla/5.0 (compatible; daiso-sagashi/1.0)"
WORKERS = 6    # 画像を取る同時数（CDN への接続）
BATCH = 60     # この件数ごとに時間切れを確かめる

# 虹の順（フロントエンドと同じ並び）
KEYS = ["red", "orange", "yellow", "green", "blue", "purple", "pink", "brown", "beige", "white", "gray", "black", "clear"]

# 語 → 色。長い語から見る。香りや味と紛らわしい語（ワイン・ミント・ローズ・オリーブ）は入れない
WORDS = {
    "white": ["ホワイト", "白", "アイボリー", "オフホワイト"],
    "black": ["ブラック", "黒"],
    "gray": ["グレー", "グレイ", "チャコール", "灰"],
    "pink": ["ダストピンク", "ピンク"],
    "red": ["レッド", "赤", "ボルドー"],
    "orange": ["オレンジ"],
    "yellow": ["イエロー", "黄", "マスタード"],
    "green": ["グリーン", "緑", "カーキ"],
    "blue": ["ブルー", "青", "ネイビー", "水色", "サックス"],
    "purple": ["パープル", "紫", "ラベンダー"],
    "brown": ["ブラウン", "茶", "こげ茶"],
    "beige": ["ベージュ", "ナチュラル", "アイボリーベージュ"],
    "clear": ["クリア", "透明"],
}
WORD_LIST = sorted(((w, k) for k, ws in WORDS.items() for w in ws), key=lambda x: -len(x[0]))

# 略号（トークン全体が一致したときだけ）
ABBR = {
    "white": ["WH", "IV"], "black": ["BK", "BLK"], "gray": ["GY"],
    "green": ["GN", "GR", "KH"], "pink": ["PK", "PI"], "red": ["RD", "RE"],
    "orange": ["OR"], "yellow": ["YE", "YL"], "blue": ["BL", "BU", "NV", "NB", "LB"],
    "purple": ["PU", "PP", "LV"], "brown": ["BR", "BN"], "beige": ["BE", "BG"], "clear": ["CL"],
}
ABBR_MAP = {a: k for k, al in ABBR.items() for a in al}
# 漢字 1 文字の色は「赤」「赤色」「白黒」のように色だけの語のときに限る（赤ちゃん・白菜・黒糖を外す）
KANJI = "白黒灰赤黄緑青紫茶"


def title_color(title):
    """タイトルの（）内と全角スペースより後ろから、色の語を探す。見つからなければ空文字。"""
    parts = re.findall(r"[(（]([^()（）]*)[)）]", title)
    parts += title.split("　")[1:]
    for part in parts:
        text = unicodedata.normalize("NFKC", part)
        for tok in re.split(r"[、,，/\s]+", text):
            if not tok:
                continue
            if tok.upper() in ABBR_MAP:
                return ABBR_MAP[tok.upper()]
            # 含まれる語のうち、いちばん前にあって長いものを採る
            best = None
            for word, key in WORD_LIST:
                if word in KANJI and not re.fullmatch(f"[{KANJI}]+[色系]?", tok):
                    continue
                pos = tok.find(word)
                if pos >= 0 and (best is None or pos < best[0]):
                    best = (pos, key)
            if best:
                return best[1]
    return ""


def image_color(data):
    """64px の画像から色を決める。背景の白っぽい所は数えない。"""
    im = Image.open(io.BytesIO(data)).convert("RGB").resize((32, 32))
    px = list(im.getdata())
    ignored = 0
    score = Counter()
    for r, g, b in px:
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if v > 0.92 and s < 0.10:   # 背景（明るくて色がない）
            ignored += 1
            continue
        w = s + 0.2
        if s < 0.18:   # 色が薄い：明るさで決める
            k = "white" if v > 0.82 else "black" if v < 0.22 else "gray"
        else:
            deg = h * 360
            if 15 <= deg < 45 and v < 0.55:
                k = "brown"
            elif 15 <= deg < 45 and s < 0.40:   # ここまで来た時点で v >= 0.55
                k = "beige"
            elif deg < 15 or deg >= 345:
                k = "red"
            elif deg < 40:
                k = "orange"
            elif deg < 70:
                k = "yellow"
            elif deg < 170:
                k = "green"
            elif deg < 255:
                k = "blue"
            elif deg < 290:
                k = "purple"
            else:
                k = "pink"
        score[k] += w
    if ignored > 0.85 * len(px):
        return "white"
    return score.most_common(1)[0][0] if score else ""


def color_of_image(job):
    handle, url = job
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as res:
            return handle, image_color(res.read())
    except Exception:
        return handle, ""   # 取れなかったものは空で覚える（毎日取り直さない）


def option(args, name, default, conv):
    return conv(args[args.index(name) + 1]) if name in args else default


def main():
    args = sys.argv[1:]
    minutes = option(args, "--minutes", 40, float)
    limit = option(args, "--limit", None, int)
    started = time.time()
    deadline = started + minutes * 60

    doc = json.loads(CATALOG.read_text(encoding="utf-8"))
    items = doc["items"]
    img_prefix = doc["img"]
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    handles = {r[0] for r in items}
    cache = {h: v for h, v in cache.items() if h in handles}   # 販売終了した商品は落とす

    # タイトルで決まるものは毎回決め直す。画像で決めたものはキャッシュを使う
    need = []
    for r in items:
        h = r[0]
        tc = title_color(r[1])
        if tc:
            cache[h] = [tc, "t"]
        elif h not in cache or cache[h][1] == "t":
            cache.pop(h, None)
            need.append(r)

    jobs = []
    for r in need:
        path = r[9]
        if not path:
            cache[r[0]] = ["", "i"]
            continue
        url = path if path.startswith("http") else img_prefix + path
        jobs.append((r[0], url + "?width=64"))
    if limit is not None:
        jobs = jobs[:limit]

    done, stopped = 0, False
    with ThreadPoolExecutor(WORKERS) as ex:
        for i in range(0, len(jobs), BATCH):
            if time.time() >= deadline:
                stopped = True
                break
            futs = [ex.submit(color_of_image, j) for j in jobs[i:i + BATCH]]
            for f in as_completed(futs):
                h, c = f.result()
                cache[h] = [c, "i"]
                done += 1
                if done % 2000 == 0:
                    print(f"  画像 {done}件 処理（{int(time.time() - started)}秒）", flush=True)

    # 全商品に色を入れて、build.py と同じ 1 商品 1 行の形で書き直す
    counts, src = Counter(), Counter()
    for r in items:
        c, s = cache.get(r[0], ["", ""])
        r[10:] = [c]
        if s:
            src[s] += 1
            counts[c or "(なし)"] += 1
    body = (f'{{"updated":{json.dumps(doc["updated"])},"img":{json.dumps(img_prefix)},'
            f'"cats":{json.dumps(doc["cats"], ensure_ascii=False)},"items":[\n'
            + ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in items) + "\n]}\n")
    CATALOG.write_text(body, encoding="utf-8")
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")

    pending = sum(1 for r in items if r[0] not in cache)
    print(f"  画像の処理: {done}件（{'時間切れで打ち切り' if stopped else '完了'}）", flush=True)
    print(f"  色の決まり: タイトル {src['t']}件／画像 {src['i']}件／まだ未処理 {pending}件（全 {len(items)}件）")
    print("  色ごとの件数: " + "、".join(f"{k} {counts[k]}" for k in KEYS + ["(なし)"] if counts[k]))


if __name__ == "__main__":
    main()
