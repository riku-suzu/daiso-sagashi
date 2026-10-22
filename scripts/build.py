"""ダイソーネットストアの全商品と、ダイソー公式企業サイトの「話題の新商品」を集めて
public/data/ に書き出す。GitHub Actions で毎朝動かす（標準ライブラリだけで動く）。

  python3 scripts/build.py            全部取り直す
  python3 scripts/build.py --news     話題の新商品だけ取り直す
  python3 scripts/build.py --full     コレクション経由の取得を多めにする（初回と同じ量）

取り方:
  1. /products.json と /collections/all/products.json をそれぞれ最大 2.5 万件（API の上限）
  2. 1 で取れなかった商品は、カテゴリなどのコレクション経由で毎日少しずつ取り直す
  3. それでも取れない商品は、新しく増えたものだけ個別に取り、ほかは前回のデータを使う。
     個別取得の枠が余れば、取り直しが古い順に更新する
"""
import datetime
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data"
STATE = ROOT / "data" / "state.json"   # 上限の外にある商品の取得日と、コレクション巡回の続きの位置

STORE = "https://jp.daisonet.com"
IMG_PREFIX = "https://cdn.shopify.com/s/files/1/0557/3646/7629/"
UA = {"User-Agent": "Mozilla/5.0 (compatible; daiso-sagashi/1.0; personal product index, 1 request at a time)"}
WAIT = 1.0             # リクエストの間隔（秒）。速すぎると接続を断られる（GitHub 上で 0.25 秒にしたら 10 分で止められた）
MAX_SINGLE = 500       # 1 回の実行で個別に取る商品の上限
TIME_LIMIT = 75 * 60   # 取得に使う時間の上限（秒）。超えたら取れた分だけで書き出す
COLLECTION_BUDGET = 400  # 1 回の実行でコレクション経由に使うリクエスト数（初回と --full は 2 倍）
JST = datetime.timezone(datetime.timedelta(hours=9))


STARTED = time.time()
_fails = 0


class Stop(Exception):
    """接続を断られ続けている、または時間切れ。ここまでに取れた分で書き出す。"""


def get(url, tries=4):
    global _fails
    if time.time() - STARTED > TIME_LIMIT:
        raise Stop("時間切れ")
    # 日本語のハンドル（例：特集-製菓ツール）を含む URL はエンコードする
    url = urllib.parse.quote(url, safe=":/?&=%")
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                _fails = 0
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                _fails = 0
                return None
            reason = f"HTTP {e.code}"
            wait = min(int(e.headers.get("Retry-After") or 0) or 15 * (i + 1), 120)
        except Exception as e:
            reason = type(e).__name__
            wait = 15 * (i + 1)
        print(f"  再試行 {i + 1}/{tries}（{reason}）: {url}", file=sys.stderr, flush=True)
        time.sleep(wait)
    _fails += 1
    if _fails >= 3:
        raise Stop(f"接続を断られ続けています（{reason}）")
    raise RuntimeError(f"取得できませんでした: {url}")


def text_of(rendered):
    t = re.sub(r"<br\s*/?>|</p>|</div>", "\n", rendered or "")
    t = html.unescape(re.sub(r"<[^>]+>", "", t))
    return [l.strip() for l in t.split("\n") if l.strip()]


# ---------- ダイソーネットストアの全商品 ----------

BRANDS = {"StandardProducts": "sp", "THREEPPY": "tp"}
# 社内管理用のタグ。検索語には使わない
INTERNAL_TAG = re.compile(r"^(\[|label_|INV_|NL_|再掲載|マスタ|tax_|食品追加|giga_|sp_楽天|.*_NL$)")
TAG_WORDS = {"sanrio_all": "サンリオ", "disney_special": "ディズニー", "for_kids": "キッズ"}


def strip_brand(s):
    return re.sub(r"^(\[(SP|TP)\]|ＳＰ|ＴＰ|SP|TP)\s*", "", s or "").strip()


def record(p):
    """Shopify の商品 JSON を、サイトで使う 1 行（配列）に縮める。"""
    vendor = p.get("vendor") or ""
    brand = next((v for k, v in BRANDS.items() if vendor.startswith(k)), "daiso")
    tags = p.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",")]
    tag = lambda prefix: next((t[len(prefix):] for t in tags if t.startswith(prefix)), "")
    cl, sc = tag("[CL]"), tag("[SC]")
    if brand == "daiso":
        cats = [vendor, p.get("product_type") or "", sc or cl]
    else:
        cats = [strip_brand(p.get("product_type")), strip_brand(cl), strip_brand(sc)]
    cats = [c for c in cats if c]

    words = []
    for t in tags:
        if t in TAG_WORDS:
            words.append(TAG_WORDS[t])
        elif not INTERNAL_TAG.match(t) and not t.startswith("廃盤"):
            w = strip_brand(re.sub(r"^[A-Za-z]+_|[_%]?\d{4,}$", "", t))
            if len(w) >= 2 and re.search(r"[^\x00-\x7f]", w) and w not in cats and w not in words:
                words.append(w)
    if cl and strip_brand(cl) not in cats:
        words.append(strip_brand(cl))

    variants = p.get("variants") or []
    prices = sorted({int(float(v.get("price") or 0)) for v in variants if v.get("price") is not None}) or [0]
    # 個別取得の JSON には在庫の項目がない（None）。そのときは在庫ありとみなす
    available = any(v.get("available") in (True, None) for v in variants)
    flags = (1 if available else 0) | (2 if any(t.startswith("廃盤") for t in tags) else 0)

    images = p.get("images") or []
    img = images[0]["src"] if images and isinstance(images[0], dict) else (images[0] if images else "")
    img = img.split("?")[0]
    if img.startswith("//"):
        img = "https:" + img
    img = img.replace(IMG_PREFIX, "")

    created = (p.get("created_at") or p.get("published_at") or "")[:10].replace("-", "")
    return [p["handle"], p["title"].strip(), brand, cats, " ".join(words), prices[0], prices[-1],
            flags, int(created or 0), img]


def crawl_feed(base, quiet=False, found=None):
    # Stop で中断しても、それまでに取れた分は found に残る
    found = {} if found is None else found
    for page in range(1, 101):
        body = get(f"{base}?limit=250&page={page}")
        products = json.loads(body).get("products", []) if body else []
        for p in products:
            found[p["handle"]] = record(p)
        time.sleep(WAIT)
        if len(products) < 250:
            break
    if not quiet:
        print(f"  {base}: {len(found)}件", flush=True)
    return found


def collections():
    cols = []
    for page in range(1, 20):
        body = get(f"{STORE}/collections.json?limit=250&page={page}")
        got = json.loads(body).get("collections", []) if body else []
        cols += got
        time.sleep(WAIT)
        if len(got) < 250:
            break
    cols = [c for c in cols if c["handle"] != "all" and 0 < c.get("products_count", 0) <= 25000]
    cols.sort(key=lambda c: (-c["products_count"], c["handle"]))
    return cols


def crawl_collections(fresh, listed, start, budget):
    """API の上限で取りきれなかった商品を、カテゴリなどのコレクション経由で拾う。
    前回の続きのコレクションから順に、リクエストの予算が尽きるまで回る（毎日少しずつ一周する）。
    戻り値は次回の開始位置。"""
    cols = collections()
    if not cols:
        return 0
    used, i = 0, start % len(cols)
    for _ in range(len(cols)):
        if used >= budget or not set(listed) - set(fresh):
            break
        c = cols[i]
        before = len(fresh)
        got = {}
        try:
            crawl_feed(f"{STORE}/collections/{c['handle']}/products.json", quiet=True, found=got)
        except RuntimeError as e:
            print(f"  コレクション {c['handle']} を飛ばしました: {e}", flush=True)
        finally:
            for h, r in got.items():
                fresh.setdefault(h, r)
        used += -(-c["products_count"] // 250)
        if len(fresh) > before:
            print(f"  コレクション {c['handle']}: +{len(fresh) - before}件（未取得 {len(set(listed) - set(fresh))}件）", flush=True)
        i = (i + 1) % len(cols)
    print(f"  コレクション経由: {used}リクエスト", flush=True)
    return i


def sitemap():
    index = get(f"{STORE}/sitemap.xml").decode()
    out = {}
    for loc in re.findall(r"<loc>(https://jp\.daisonet\.com/sitemap_products_[^<]+)</loc>", index):
        xml = get(html.unescape(loc)).decode()
        for h, lm in re.findall(r"<loc>https://jp\.daisonet\.com/products/([^<]+)</loc>\s*<lastmod>([^<]+)</lastmod>", xml):
            out[h] = lm
        time.sleep(WAIT)
    print(f"  サイトマップ: {len(out)}件", flush=True)
    return out


def catalog():
    today = datetime.datetime.now(JST).strftime("%Y%m%d")
    prev = {}
    prev_file = OUT / "catalog.json"
    if prev_file.exists():
        old = json.loads(prev_file.read_text())
        cats = old["cats"]
        for r in old["items"]:
            r = list(r)
            r[3] = [cats[i] for i in r[3]]
            prev[r[0]] = r
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    fetched = state.get("fetched", {})   # 上限の外にある商品を、最後に取り直した日
    full = not prev or "--full" in sys.argv

    fresh, main, listed, single = {}, set(), {}, 0
    try:
        # 1. 新しい順の 2 本の一覧（ここで取れた商品は毎日新しい）
        crawl_feed(f"{STORE}/products.json", found=fresh)
        crawl_feed(f"{STORE}/collections/all/products.json", found=fresh)
        main = set(fresh)
        listed = sitemap()

        # 2. 残りはコレクション経由で、毎日少しずつ。初回と --full は多めに回る
        budget = COLLECTION_BUDGET * (2 if full else 1)
        state["collection_start"] = crawl_collections(fresh, listed, state.get("collection_start", 0), budget)

        # 3. まだ足りない商品：新しく増えたものから個別に取り、枠が余れば取り直しが古い順に更新する
        missing = [h for h in listed if h not in fresh]
        new = [h for h in missing if h not in prev]
        stale = sorted((h for h in missing if h in prev), key=lambda h: fetched.get(h, "0"))
        for h in (new + stale)[:MAX_SINGLE]:
            try:
                body = get(f"{STORE}/products/{h}.json", tries=2)
            except RuntimeError:
                body = None
            time.sleep(WAIT)
            single += 1
            if body:
                fresh[h] = record(json.loads(body)["product"])
    except Stop as e:
        print(f"  取得を打ち切りました：{e}。取れた分と前回のデータで書き出します", flush=True)
    main = main or set(fresh)
    for h in set(fresh) - main:
        fetched[h] = today

    # 取れなかった商品は前回のデータで埋める
    known = listed if len(listed) > 1000 else prev   # サイトマップを取れなかったときは前回の商品を全部残す
    reused = 0
    for h in known:
        if h not in fresh and h in prev:
            fresh[h] = prev[h]
            reused += 1
    # サイトマップから消えた商品（販売終了）は落とす
    if len(listed) > 1000:
        fresh = {h: r for h, r in fresh.items() if h in listed}
    print(f"  個別取得: {single}件／前回のデータを使った商品: {reused}件", flush=True)
    if len(listed) > 1000:
        print(f"  まだ一度も取れていない商品: {sum(1 for h in listed if h not in fresh)}件", flush=True)

    state["fetched"] = {h: d for h, d in fetched.items() if h in fresh and h not in main}
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return list(fresh.values())


def write_catalog(items, updated):
    cat_names = sorted({c for r in items for c in r[3]})
    index = {c: i for i, c in enumerate(cat_names)}
    rows = []
    for r in sorted(items, key=lambda r: (-r[8], r[0])):
        r = list(r)
        r[3] = [index[c] for c in r[3]]
        rows.append(json.dumps(r, ensure_ascii=False, separators=(",", ":")))
    # 1 商品 1 行にして、毎日のコミットの差分を小さくする
    body = (f'{{"updated":{json.dumps(updated)},"img":{json.dumps(IMG_PREFIX)},'
            f'"cats":{json.dumps(cat_names, ensure_ascii=False)},"items":[\n' + ",\n".join(rows) + "\n]}\n")
    (OUT / "catalog.json").write_text(body, encoding="utf-8")


# ---------- ダイソー公式企業サイト「話題の新商品」 ----------

NEWS_PAGES = 7  # 一覧 1 ページ 16 件 → 約 110 件（2 か月分ほど）


def news():
    base = "https://www.daiso-sangyo.co.jp"
    images = {}
    for page in range(1, NEWS_PAGES + 1):
        s = get(f"{base}/item" + (f"/page/{page}" if page > 1 else "")).decode()
        for pid, img in re.findall(r'item/(\d+)" class="items-item__wrap">\s*<span[^>]*background-image: url\(([^)]+)\)', s):
            images[int(pid)] = img
        time.sleep(WAIT)
    out = []
    for page in range(1, NEWS_PAGES // 3 + 2):
        posts = json.loads(get(f"{base}/wp-json/wp/v2/item?per_page=50&page={page}&_fields=id,date,link,title,content"))
        for p in posts:
            if p["id"] not in images:
                continue
            lines = text_of(p["content"]["rendered"])
            cut = next((i for i, l in enumerate(lines) if "商品詳細" in l), len(lines))
            body = [l for l in lines[:cut] if not re.fullmatch(r"[—\-ー]+", l)]
            lead = body[0].strip("＼／\\/ ") if body and body[0].startswith(("＼", "\\")) else ""
            price = next((m.group(0) for l in lines for m in [re.search(r"税込[^)）]*円", l)] if m), "")
            jans = re.findall(r"\b(45\d{11}|49\d{11})\b", " ".join(lines))
            out.append({
                "title": html.unescape(p["title"]["rendered"]),
                "lead": lead,
                "desc": " ".join(body[1:] if lead else body)[:160],
                "price": price.replace("税込", "").replace("(", "").strip(),
                "date": p["date"][:10],
                "image": images[p["id"]],
                "url": p["link"],
                "jan": sorted(set(jans)),
            })
        time.sleep(WAIT)
    out.sort(key=lambda x: x["date"], reverse=True)
    if not out:
        # サイトが止まっていると、お知らせのページが返ってきて 0 件になる（2026-10-22 に実際に起きた）
        raise RuntimeError("1 件も取れませんでした（サイトが止まっている可能性）")
    print(f"  話題の新商品: {len(out)}件", flush=True)
    return out


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now(JST).strftime("%Y-%m-%d %H:%M")
    print("話題の新商品を取得中…", flush=True)
    try:
        (OUT / "news.json").write_text(
            json.dumps({"updated": now, "items": news()}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    except Exception as e:
        # 公式企業サイトがおかしくても、全商品の更新は止めない
        print(f"  話題の新商品は前回のままにします：{type(e).__name__}: {e}", flush=True)
    _fails = 0
    if "--news" not in sys.argv:
        print("全商品を取得中…", flush=True)
        items = catalog()
        write_catalog(items, now)
        print(f"全商品: {len(items)}件", flush=True)
