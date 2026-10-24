// 検索エンジン本体。画面から切り離してあるので、Node でもそのまま試せる。
(function (root) {
  // ---- 表記ゆれの吸収 ----
  // 全角/半角・大文字/小文字・カタカナ/ひらがなを揃え、記号と空白を落とす
  const SYMBOLS = /[\s・･、。,.，．:：;；!！?？'"“”‘’`´()（）\[\]［］{}｛｝「」『』【】〔〕〈〉《》<>＜＞\/／\\＼|｜_＿\-－‐–—~〜～=＝+＊*#＃&＆@＠^＾♪☆★◆◇○●※…]/g;
  function norm(s) {
    return String(s || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .replace(/[ｰー−]/g, "ー")
      .replace(SYMBOLS, "");
  }

  // ---- 言い換え辞書 ----
  // 同じ行の言葉はどれで探しても同じものが見つかる。漢字をひらがなで打っても当たるようにする
  const SYNONYMS = [
    "スマホ スマートフォン 携帯電話 iphone",
    "充電器 ACアダプター アダプター チャージャー",
    "モバイルバッテリー 携帯充電器",
    "ケーブル コード",
    "イヤホン イヤフォン イヤーホン",
    "ワイヤレス Bluetooth ブルートゥース",
    "延長コード テーブルタップ 電源タップ",
    "電池 乾電池 バッテリー",
    "電球 LED電球",
    "保存容器 タッパー フードコンテナ 密閉容器",
    "保存袋 ジップロック ジッパー付き袋 チャック袋 チャック付き袋 ジッパーバッグ",
    "ラップ 食品用ラップ",
    "ゴミ袋 ごみ袋 ポリ袋 ゴミぶくろ",
    "ゴミ箱 ごみ箱 ダストボックス くずかご",
    "はさみ ハサミ 鋏 シザー",
    "包丁 ナイフ",
    "まな板 カッティングボード",
    "鍋 なべ",
    "コップ グラス タンブラー",
    "水筒 ボトル マイボトル",
    "弁当 お弁当 ランチ べんとう",
    "箸 はし おはし",
    "皿 さら プレート",
    "茶碗 ちゃわん",
    "鞄 かばん カバン バッグ",
    "財布 さいふ ウォレット",
    "傘 かさ アンブレラ",
    "靴 くつ シューズ",
    "靴下 くつした ソックス",
    "手袋 てぶくろ グローブ",
    "毛布 ブランケット ひざ掛け",
    "湯たんぽ ゆたんぽ",
    "カイロ 使い捨てカイロ",
    "鏡 かがみ ミラー",
    "化粧 けしょう コスメ メイク",
    "爪 つめ ネイル",
    "髪 かみ ヘア",
    "歯ブラシ はぶらし ハブラシ",
    "掃除 そうじ クリーナー",
    "洗濯 せんたく ランドリー",
    "収納 しゅうのう",
    "時計 とけい クロック",
    "犬 いぬ ドッグ",
    "猫 ねこ キャット",
    "子供 こども 子ども キッズ",
    "赤ちゃん ベビー",
    "毛糸 けいと",
    "手芸 しゅげい ハンドメイド",
    "文房具 文具 ぶんぐ ステーショナリー",
    "鉛筆 えんぴつ",
    "消しゴム けしごむ イレーサー",
    "定規 じょうぎ ものさし",
    "付箋 ふせん",
    "ノート 帳面",
    "封筒 ふうとう",
    "シール ステッカー",
    "磁石 じしゃく マグネット",
    "両面テープ りょうめんテープ",
    "工具 こうぐ ツール",
    "ドライバー ねじ回し",
    "植木鉢 うえきばち プランター 鉢",
    "種 たね",
    "肥料 ひりょう",
    "虫よけ 虫除け 防虫",
    "防災 ぼうさい 非常用",
    "ぬいぐるみ ぬい マスコット",
    "キーホルダー チャーム",
    "加湿器 かしつき",
    "扇風機 せんぷうき ファン",
    "パソコン PC",
    "ラッピング 包装 ギフト",
    "お菓子 おかし 菓子",
    "飲み物 飲料 ドリンク",
  ].map((line) => line.split(" ").map(norm));
  const SYN = new Map();
  for (const group of SYNONYMS) for (const w of group) SYN.set(w, [...new Set([...(SYN.get(w) || []), ...group])]);

  // 探す対象として意味のない語（「100均 ノート」の「100均」など）は無視する
  const STOP = new Set(["100均", "百均", "100円", "ひゃっきん", "だいそー", "daiso", "ダイソー"].map(norm));

  // ---- クエリの解析 ----
  // スペース区切りは AND。「-語」は除外。"語" は言い換えなしの完全一致
  function parse(q) {
    const terms = [], excludes = [];
    const re = /(-?)"([^"]+)"|(-?)(\S+)/g;
    let m;
    const raw = String(q || "").normalize("NFKC").replace(/　/g, " ");
    while ((m = re.exec(raw))) {
      const neg = m[1] || m[3];
      const exact = m[2] !== undefined;
      const word = norm(exact ? m[2] : m[4]);
      if (!word || (!exact && STOP.has(word))) continue;
      if (neg) { excludes.push(word); continue; }
      const alts = exact ? [word] : expand(word);
      terms.push({ word, alts, digits: /^\d{6,}$/.test(word) });
    }
    return { terms, excludes };
  }
  function expand(word) {
    const alts = new Set([word]);
    if (SYN.has(word)) SYN.get(word).forEach((w) => alts.add(w));
    // 「マグカップ」のように言い換え語を含む語も、含まれる部分で広げる（長い語だけ）
    for (const [w, group] of SYN) {
      if (w.length >= 2 && word.length > w.length && word.includes(w)) {
        for (const g of group) if (!g.includes(w) && !w.includes(g)) alts.add(word.replace(w, g));
      }
    }
    return [...alts];
  }

  // ---- 索引 ----
  // 商品ごとに、商品名・カテゴリ・タグを正規化した文字列を持っておく
  function buildIndex(items, catNames, brandLabels) {
    for (const it of items) {
      it._t = norm(it.title);
      // かっこや区切りより前の「商品名の頭」。日本語は最後の語が何の商品かを表す（三徳包丁、マグネットフック）
      it._h = norm(it.title.split(/[（(【\[「〈《―－\-‐　 ]/)[0]);
      it._c = norm(it.cats.map((i) => catNames[i]).join(" ") + " " + it.words + " " + (brandLabels[it.brand] || ""));
    }
  }

  function bigrams(s) {
    const out = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  }

  // ---- 検索 ----
  // 戻り値: { hits: [{item, score}], mode: "all" | "some" | "fuzzy" | "none" }
  function search(items, query, { today = 0 } = {}) {
    const { terms, excludes } = parse(query);
    const passExclude = (it) => !excludes.some((w) => it._t.includes(w) || it._c.includes(w));
    if (!terms.length) {
      return { mode: "none", terms, hits: items.filter(passExclude).map((item) => ({ item, score: 0 })) };
    }

    const termScore = (it, t) => {
      if (t.digits) return it.handle.startsWith(t.word) ? 100 : 0; // JAN コード
      let best = 0;
      for (const a of t.alts) {
        const exactWord = a === t.word;
        let s = 0;
        if (it._t === a || it._h === a) s = 60;
        else if (it._t.startsWith(a)) s = 30;
        else if (it._t.includes(a)) s = 20;
        else if (it._c.includes(a)) s = 8;
        // 「はさみ」で探したとき、ハサミホルダーよりハサミそのものを上にする
        if (s >= 20 && s < 60 && it._h.endsWith(a)) s += 14;
        // 入力どおりの語で当たったものを、言い換えで当たったものより必ず上にする
        if (s && !exactWord) s *= 0.3;
        // 商品名とカテゴリの両方に当たるもの（「はさみ」で探したときの本物のハサミ）を少し上げる
        if (s >= 20 && it._c.includes(a)) s += 6;
        if (s > best) best = s;
      }
      return best;
    };
    const bonus = (it) => (it.flags & 1 ? 3 : 0) - (it.flags & 2 ? 6 : 0) + (today - it.day <= 30 ? 2 : 0) - it._t.length / 40;

    let hits = [];
    for (const it of items) {
      if (!passExclude(it)) continue;
      let total = 0, ok = true;
      for (const t of terms) {
        const s = termScore(it, t);
        if (!s) { ok = false; break; }
        total += s;
      }
      if (ok) hits.push({ item: it, score: total + bonus(it) });
    }
    if (hits.length) return { mode: "all", terms, hits: sortHits(hits) };

    // 全部の語を含む商品がないときは、一部の語に当たる商品を出す
    if (terms.length > 1) {
      for (const it of items) {
        if (!passExclude(it)) continue;
        let total = 0, matched = 0;
        for (const t of terms) { const s = termScore(it, t); if (s) { matched++; total += s; } }
        if (matched) hits.push({ item: it, score: matched * 100 + total + bonus(it) });
      }
      if (hits.length) return { mode: "some", terms, hits: sortHits(hits) };
    }

    // 打ち間違い・送り仮名の違いに備えて、2 文字ずつの一致率で探す
    const longest = terms.map((t) => t.word).filter((w) => w.length >= 3 && !/^\d+$/.test(w)).sort((a, b) => b.length - a.length)[0];
    if (longest) {
      const grams = bigrams(longest);
      const need = Math.max(2, Math.ceil(grams.length * 0.6));
      for (const it of items) {
        if (!passExclude(it)) continue;
        let n = 0;
        for (const g of grams) if (it._t.includes(g)) n++;
        if (n >= need) hits.push({ item: it, score: (n / grams.length) * 50 + bonus(it) });
      }
      if (hits.length) return { mode: "fuzzy", terms, hits: sortHits(hits) };
    }
    return { mode: "all", terms, hits: [] };
  }
  function sortHits(hits) {
    return hits.sort((a, b) => b.score - a.score || b.item.created - a.item.created);
  }

  root.DaisoSearch = { norm, parse, expand, buildIndex, search };
  if (typeof module !== "undefined") module.exports = root.DaisoSearch;
})(typeof window !== "undefined" ? window : globalThis);
