(() => {
  const S = window.DaisoSearch;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const STORE = "https://jp.daisonet.com/products/";
  const BRAND = { daiso: "DAISO", sp: "Standard Products", tp: "THREEPPY" };
  const PRICES = [110, 220, 330, 440, 550, 770, 1100, 1650, 2200, 3300, 5500];
  const PAGE = 48;
  const WD = ["日", "月", "火", "水", "木", "金", "土"];

  let items = [], cats = [], imgBase = "", todayDay = 0;
  let current = { hits: [], mode: "none" }, filtered = [];
  const state = { q: "", brands: new Set(), cat: [], min: 0, max: 0, stock: false, fresh: false, hideDiscon: true, sort: "rel", shown: PAGE };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const dayOf = (n) => Date.UTC(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100) / 864e5;

  // ---------- URL と状態 ----------
  function readURL() {
    const p = new URLSearchParams(location.search);
    state.q = p.get("q") || "";
    state.brands = new Set((p.get("brand") || "").split(",").filter((b) => BRAND[b]));
    state.cat = (p.get("cat") || "").split(">").filter(Boolean);
    state.min = +p.get("min") || 0;
    state.max = +p.get("max") || 0;
    state.stock = p.get("stock") === "1";
    state.fresh = p.get("new") === "1";
    state.hideDiscon = p.get("discon") !== "1";
    state.sort = p.get("sort") || "rel";
  }
  function writeURL() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.brands.size) p.set("brand", [...state.brands].join(","));
    if (state.cat.length) p.set("cat", state.cat.join(">"));
    if (state.min) p.set("min", state.min);
    if (state.max) p.set("max", state.max);
    if (state.stock) p.set("stock", "1");
    if (state.fresh) p.set("new", "1");
    if (!state.hideDiscon) p.set("discon", "1");
    if (state.sort !== "rel") p.set("sort", state.sort);
    const qs = p.toString();
    history.replaceState(null, "", (qs ? "?" + qs : location.pathname) + location.hash);
  }

  // ---------- 絞り込み ----------
  const catName = (i) => cats[i];
  function passes(it, skip) {
    if (skip !== "brand" && state.brands.size && !state.brands.has(it.brand)) return false;
    if (skip !== "cat") for (let i = 0; i < state.cat.length; i++) if (catName(it.cats[i]) !== state.cat[i]) return false;
    if (state.min && it.priceMax < state.min) return false;
    if (state.max && it.price > state.max) return false;
    if (state.stock && !(it.flags & 1)) return false;
    if (state.hideDiscon && it.flags & 2) return false;
    if (state.fresh && todayDay - it.day > 30) return false;
    return true;
  }
  function sortList(list) {
    const by = {
      new: (a, b) => b.item.created - a.item.created,
      cheap: (a, b) => a.item.price - b.item.price || b.score - a.score,
      high: (a, b) => b.item.price - a.item.price || b.score - a.score,
    }[state.sort];
    if (by) return list.slice().sort(by);
    // 検索語がないときの「関連度順」は新しい順にする
    return current.mode === "none" ? list.slice().sort((a, b) => b.item.created - a.item.created) : list;
  }

  function runSearch() {
    current = S.search(items, state.q, { today: todayDay });
    refresh();
  }
  function refresh(keepShown) {
    if (!keepShown) state.shown = PAGE;
    filtered = sortList(current.hits.filter((h) => passes(h.item)));
    renderFilters();
    renderResults();
    writeURL();
  }

  // ---------- 絞り込み欄 ----------
  function renderFilters() {
    // ブランド（ブランド以外の条件で数える）
    const bc = { daiso: 0, sp: 0, tp: 0 };
    for (const h of current.hits) if (passes(h.item, "brand")) bc[h.item.brand]++;
    $("#f-brand").innerHTML = Object.keys(BRAND).map((b) =>
      `<label class="check"><input type="checkbox" value="${b}" ${state.brands.has(b) ? "checked" : ""}><span class="tri b-${b}" aria-hidden="true"></span>${BRAND[b]}<span class="n">${bc[b].toLocaleString()}</span></label>`).join("");

    // カテゴリ（いまの階層の 1 つ下を数える）
    const level = state.cat.length;
    const counts = new Map();
    for (const h of current.hits) {
      const it = h.item;
      if (!passes(it, "cat")) continue;
      let ok = true;
      for (let i = 0; i < level; i++) if (catName(it.cats[i]) !== state.cat[i]) { ok = false; break; }
      if (!ok || it.cats[level] === undefined) continue;
      const name = catName(it.cats[level]);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const kids = [...counts].sort((a, b) => b[1] - a[1]);
    const limit = $("#f-cat").dataset.all === "1" ? Infinity : 12;
    let html = "";
    if (level) {
      html += `<button type="button" class="cat up" data-depth="0">← すべてのカテゴリ</button>`;
      state.cat.forEach((c, i) => {
        html += `<button type="button" class="cat lv${Math.min(i + 1, 3)}" aria-pressed="true" data-depth="${i + 1}">${esc(c)}</button>`;
      });
    }
    html += kids.slice(0, limit).map(([name, n]) =>
      `<button type="button" class="cat lv${Math.min(level + 1, 3)}" aria-pressed="false" data-pick="${esc(name)}">${esc(name)}<span class="n">${n.toLocaleString()}</span></button>`).join("");
    if (kids.length > limit) html += `<button type="button" class="catmore" data-more="1">ほか${kids.length - limit}件を表示</button>`;
    if (!kids.length && !level) html += `<p class="path">該当なし</p>`;
    $("#f-cat").innerHTML = html;

    $("#f-min").value = state.min || "";
    $("#f-max").value = state.max || "";
    $("#f-stock").checked = state.stock;
    $("#f-new").checked = state.fresh;
    $("#f-hidediscon").checked = state.hideDiscon;
    $("#sort").value = state.sort;

    // 付いている条件のチップ
    const chips = [];
    state.brands.forEach((b) => chips.push([`${BRAND[b]}`, () => state.brands.delete(b)]));
    if (state.cat.length) chips.push([state.cat.join(" › "), () => (state.cat = [])]);
    if (state.min || state.max) chips.push([`${state.min ? state.min + "円" : ""}〜${state.max ? state.max + "円" : ""}`, () => (state.min = state.max = 0)]);
    if (state.stock) chips.push(["ネット在庫あり", () => (state.stock = false)]);
    if (state.fresh) chips.push(["30日以内に登録", () => (state.fresh = false)]);
    if (!state.hideDiscon) chips.push(["廃盤も表示", () => (state.hideDiscon = true)]);
    chipActions = chips.map((c) => c[1]);
    $("#chips").innerHTML = chips.map((c, i) => `<button type="button" class="chip" data-chip="${i}">${esc(c[0])}<span aria-label="外す">×</span></button>`).join("");
    $("#filterBadge").textContent = chips.length || "";
  }
  let chipActions = [];

  // ---------- 結果 ----------
  function highlight(title, terms) {
    if (!terms.length) return esc(title);
    // 正規化した文字列の位置を、元の文字列の位置に戻せるようにしておく
    let normStr = "";
    const map = [];
    for (let i = 0; i < title.length; i++) {
      const n = S.norm(title[i]);
      for (const ch of n) { normStr += ch; map.push(i); }
    }
    const marks = new Array(title.length).fill(false);
    for (const t of terms) for (const a of t.alts) {
      if (!a) continue;
      let from = 0, at;
      while ((at = normStr.indexOf(a, from)) !== -1) {
        for (let k = at; k < at + a.length; k++) marks[map[k]] = true;
        from = at + a.length;
      }
    }
    let out = "", open = false;
    for (let i = 0; i < title.length; i++) {
      if (marks[i] && !open) { out += "<mark>"; open = true; }
      if (!marks[i] && open) { out += "</mark>"; open = false; }
      out += esc(title[i]);
    }
    return out + (open ? "</mark>" : "");
  }
  const yen = (n) => n.toLocaleString();
  // 100円（税込110円、食品は108円）の商品は値札を出さない
  const isBasic = (lo, hi) => lo === hi && lo <= 110;
  const priceTag = (text) => `<span class="pricetag">${esc(text).replace(/円$/, "<em>円</em>")}</span>`;
  function card(it, terms) {
    const flag = it.flags & 2 ? `<span class="flag">廃盤</span>`
      : !(it.flags & 1) ? `<span class="flag">在庫なし</span>`
      : todayDay - it.day <= 30 ? `<span class="flag new">NEW</span>` : "";
    const img = it.img ? (it.img.startsWith("http") ? it.img : imgBase + it.img) + "?width=360" : "";
    const price = isBasic(it.price, it.priceMax) ? ""
      : priceTag(it.price === it.priceMax ? `${yen(it.price)}円` : `${yen(it.price)}〜${yen(it.priceMax)}円`);
    return `<a class="card b-${it.brand} ${it.flags & 1 ? "" : "out"}" href="${STORE}${encodeURIComponent(it.handle)}" target="_blank" rel="noopener">
      <div class="thumb">${img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">` : ""}${flag}${price}</div>
      <div class="title"><span class="sr">${BRAND[it.brand]}：</span>${highlight(it.title, terms)}</div>
    </a>`;
  }

  function renderResults() {
    const n = filtered.length;
    $("#count").innerHTML = state.q || n !== items.length
      ? `<b>${n.toLocaleString()}</b>件${state.q ? `　「${esc(state.q)}」` : ""}`
      : `全<b>${n.toLocaleString()}</b>件`;

    const notice = $("#notice");
    const words = current.terms.map((t) => t.word);
    if (current.mode === "some") {
      notice.hidden = false;
      notice.textContent = `すべての語を含む商品がなかったので、どれかの語を含む商品を表示しています。`;
    } else if (current.mode === "fuzzy") {
      notice.hidden = false;
      notice.textContent = `「${state.q}」と完全に一致する商品がなかったので、似た表記の商品を表示しています。`;
    } else notice.hidden = true;

    const terms = current.mode === "fuzzy" ? [] : current.terms;
    if (!n) {
      const any = current.hits.length > 0;
      $("#grid").innerHTML = `<div class="empty"><b>見つかりませんでした</b>${any
        ? `<span>検索語には${current.hits.length.toLocaleString()}件が当たっています。絞り込みを外すと表示されます。</span><button type="button" class="ex" id="emptyReset">絞り込みを外す</button>`
        : `<span>言葉を短くするか、ひらがな・カタカナを変えてみてください。${words.length > 1 ? "語を減らすのも効きます。" : ""}</span>`}</div>`;
      $("#more").hidden = true;
      return;
    }
    $("#grid").innerHTML = filtered.slice(0, state.shown).map((h) => card(h.item, terms)).join("");
    $("#more").hidden = n <= state.shown;
    $("#moreBtn").textContent = `もっと見る（残り${(n - state.shown).toLocaleString()}件）`;
  }
  function showMore() {
    if (state.shown >= filtered.length) return;
    const terms = current.mode === "fuzzy" ? [] : current.terms;
    const next = filtered.slice(state.shown, state.shown + PAGE).map((h) => card(h.item, terms)).join("");
    state.shown += PAGE;
    $("#grid").insertAdjacentHTML("beforeend", next);
    $("#more").hidden = filtered.length <= state.shown;
    $("#moreBtn").textContent = `もっと見る（残り${(filtered.length - state.shown).toLocaleString()}件）`;
  }

  // ---------- 候補（サジェスト） ----------
  let sugg = [], suggIdx = -1;
  function renderSuggest() {
    const q = S.norm($("#q").value);
    const box = $("#suggest");
    sugg = [];
    if (!q) {
      sugg = store.get("recent", []).slice(0, 6).map((w) => ({ kind: "履歴", label: w, act: () => setQuery(w) }));
    } else if (q.length >= 1 && !/^\d+$/.test(q)) {
      const seen = new Map();
      for (const it of items) {
        it.cats.forEach((ci, depth) => {
          const name = cats[ci];
          if (!S.norm(name).includes(q)) return;
          const path = it.cats.slice(0, depth + 1).map(catName);
          const key = path.join(">");
          const e = seen.get(key) || { path, n: 0 };
          e.n++;
          seen.set(key, e);
        });
      }
      sugg = [...seen.values()].sort((a, b) => b.n - a.n).slice(0, 6).map((e) => ({
        kind: "カテゴリ", label: e.path.join(" › "), n: e.n,
        act: () => { state.cat = e.path; $("#q").value = ""; setQuery(""); },
      }));
    }
    suggIdx = -1;
    box.hidden = !sugg.length || document.activeElement !== $("#q");
    box.innerHTML = sugg.map((s, i) => `<li role="option" id="sg${i}" data-i="${i}" aria-selected="false"><span class="kind">${s.kind}</span><span>${esc(s.label)}</span>${s.n ? `<span class="n">${s.n.toLocaleString()}件</span>` : ""}</li>`).join("");
  }
  function moveSuggest(d) {
    if (!sugg.length) return;
    suggIdx = (suggIdx + d + sugg.length) % sugg.length;
    document.querySelectorAll(".suggest li").forEach((li, i) => li.setAttribute("aria-selected", i === suggIdx));
    $("#q").setAttribute("aria-activedescendant", "sg" + suggIdx);
  }
  function closeSuggest() { $("#suggest").hidden = true; suggIdx = -1; }

  function setQuery(q) {
    $("#q").value = q;
    state.q = q;
    $("#clear").hidden = !q;
    runSearch();
  }
  function remember(q) {
    q = q.trim();
    if (!q) return;
    store.set("recent", [q, ...store.get("recent", []).filter((w) => w !== q)].slice(0, 10));
  }

  // ---------- 話題の新商品 ----------
  function renderNews(news) {
    const groups = [];
    for (const n of news) {
      const g = groups[groups.length - 1];
      if (g && g.date === n.date) g.items.push(n); else groups.push({ date: n.date, items: [n] });
    }
    $("#news").innerHTML = groups.map((g) => {
      const d = new Date(g.date + "T00:00:00");
      return `<section class="day"><div class="day-head"><span class="day-date">${g.date.slice(5).replace("-", ".")}</span><span class="day-wd">${WD[d.getDay()]}曜日</span><span class="day-count">${g.items.length}件</span></div>
        <div class="grid news">${g.items.map((n) => {
          const basic = /^10[0-9]円$|^110円$/.test(n.price);
          return `<div class="card b-daiso">
          <a class="thumb" href="${esc(n.url)}" target="_blank" rel="noopener"><img src="${esc(n.image)}" alt="" loading="lazy" decoding="async">${n.price && !basic ? priceTag(n.price.replace("～", "〜")) : ""}</a>
          <a class="title" href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>
          <button type="button" class="find" data-find="${esc(n.jan && n.jan.length ? n.jan.join(" | ") : n.title)}">ネットストアで探す →</button>
        </div>`;
        }).join("")}</div></section>`;
    }).join("");
  }

  function showView(v) {
    $("#view-search").hidden = v !== "search";
    $("#view-news").hidden = v !== "news";
    $("#form").hidden = v !== "search";
    $("#hint").hidden = v !== "search";
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === v));
    $("#tabs").dataset.active = v;
    $("#searchToggle").hidden = v !== "search";
    history.replaceState(null, "", location.search + (v === "news" ? "#news" : ""));
  }

  // ---------- イベント ----------
  function bind() {
    let timer;
    $("#q").addEventListener("input", (e) => {
      $("#clear").hidden = !e.target.value;
      renderSuggest();
      clearTimeout(timer);
      timer = setTimeout(() => { state.q = e.target.value; runSearch(); }, 140);
    });
    $("#q").addEventListener("focus", renderSuggest);
    $("#q").addEventListener("blur", () => setTimeout(closeSuggest, 150));
    $("#q").addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); moveSuggest(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveSuggest(-1); }
      // 候補が開いているときの Esc は候補を閉じるだけにする（ブラウザ標準だと検索語も消える）
      else if (e.key === "Escape" && !$("#suggest").hidden) { e.preventDefault(); closeSuggest(); }
      else if (e.key === "Enter" && suggIdx >= 0) { e.preventDefault(); sugg[suggIdx].act(); closeSuggest(); }
    });
    $("#form").addEventListener("submit", (e) => {
      e.preventDefault();
      clearTimeout(timer);
      state.q = $("#q").value;
      remember(state.q);
      closeSuggest();
      $("#q").blur();
      runSearch();
    });
    $("#suggest").addEventListener("mousedown", (e) => {
      const li = e.target.closest("li");
      if (li) { e.preventDefault(); sugg[+li.dataset.i].act(); closeSuggest(); }
    });
    $("#clear").addEventListener("click", () => { setQuery(""); $("#q").focus(); });
    document.querySelectorAll(".ex").forEach((b) => b.addEventListener("click", () => { setQuery(b.textContent); remember(b.textContent); }));

    $("#f-brand").addEventListener("change", (e) => {
      const b = e.target.value;
      e.target.checked ? state.brands.add(b) : state.brands.delete(b);
      refresh();
    });
    $("#f-cat").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.more) { $("#f-cat").dataset.all = "1"; renderFilters(); return; }
      $("#f-cat").dataset.all = "";
      if (b.dataset.pick) state.cat = [...state.cat, b.dataset.pick];
      else state.cat = state.cat.slice(0, +b.dataset.depth);
      refresh();
    });
    const priceOpts = (label) => `<option value="">${label}</option>` + PRICES.map((p) => `<option value="${p}">${p.toLocaleString()}円</option>`).join("");
    $("#f-min").innerHTML = priceOpts("下限なし");
    $("#f-max").innerHTML = priceOpts("上限なし");
    $("#f-min").addEventListener("change", (e) => { state.min = +e.target.value || 0; refresh(); });
    $("#f-max").addEventListener("change", (e) => { state.max = +e.target.value || 0; refresh(); });
    $("#f-stock").addEventListener("change", (e) => { state.stock = e.target.checked; refresh(); });
    $("#f-new").addEventListener("change", (e) => { state.fresh = e.target.checked; refresh(); });
    $("#f-hidediscon").addEventListener("change", (e) => { state.hideDiscon = e.target.checked; refresh(); });
    $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; refresh(); });
    const resetAll = () => {
      Object.assign(state, { brands: new Set(), cat: [], min: 0, max: 0, stock: false, fresh: false, hideDiscon: true });
      refresh();
    };
    $("#reset").addEventListener("click", resetAll);
    $("#grid").addEventListener("click", (e) => { if (e.target.id === "emptyReset") resetAll(); });
    $("#chips").addEventListener("click", (e) => {
      const c = e.target.closest("[data-chip]");
      if (c) { chipActions[+c.dataset.chip](); refresh(); }
    });
    $("#moreBtn").addEventListener("click", showMore);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((es) => { if (es[0].isIntersecting && !$("#view-search").hidden) showMore(); }, { rootMargin: "800px" }).observe($("#sentinel"));
    }

    // スマホの絞り込みシート（動きは CSS の transition）
    const sheet = $("#filters");
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    document.body.append(scrim);
    const openSheet = (open) => { sheet.classList.toggle("open", open); scrim.classList.toggle("show", open); };
    const phone = matchMedia("(max-width: 820px)");

    // パソコン：絞り込み欄をまるごと閉じて、左端の細い帯から開き直す
    const applyCollapsed = (c) => {
      $("#view-search").classList.toggle("collapsed", c);
      $("#railOpen").setAttribute("aria-expanded", String(!c));
      store.set("filtersCollapsed", c);
    };
    applyCollapsed(store.get("filtersCollapsed", false));

    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const EASE_OUT = "cubic-bezier(.22, .8, .24, 1)";
    let busy = false;
    // 並びが変わる前後の位置を測り、カードを前の位置から新しい位置へすべらせる（FLIP）
    function flip(change, extra = "") {
      const els = [...document.querySelectorAll("#grid .card, .resbar, .chips, .notice" + extra)].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > -100 && r.top < innerHeight + 100;
      });
      const before = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
      change();
      const anims = [];
      for (const el of els) {
        const a = before.get(el), b = el.getBoundingClientRect();
        if (!b.width) continue;
        const dx = a.left - b.left, dy = a.top - b.top, sx = a.width / b.width, sy = a.height / b.height;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < .01) continue;
        // 縦横比を保つため、カードは幅の比で拡大縮小する
        const scale = el.classList.contains("card") ? `scale(${sx})` : "";
        anims.push(el.animate(
          [{ transformOrigin: "0 0", transform: `translate(${dx}px, ${dy}px) ${scale}` }, { transformOrigin: "0 0", transform: "none" }],
          { duration: 420, easing: EASE_OUT }).finished.catch(() => {}));
      }
      return Promise.all(anims);
    }
    async function setCollapsed(c) {
      if (busy || $("#view-search").classList.contains("collapsed") === c) return;
      if (reduceMotion.matches) { applyCollapsed(c); return; }
      busy = true;
      const side = $("#filters"), rail = $("#railOpen");
      if (c) {
        // 閉じる：欄が左へ抜ける → カードが広がる → 帯が出る
        const out = side.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-18px)" }],
          { duration: 170, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" });
        await out.finished.catch(() => {});
        const moving = flip(() => { applyCollapsed(true); out.cancel(); });
        rail.animate([{ opacity: 0, transform: "translateX(-10px)" }, { opacity: 1, transform: "none" }],
          { duration: 260, delay: 160, easing: EASE_OUT, fill: "backwards" });
        await moving;
      } else {
        // 開く：帯が消える → カードが縮む間に、欄が左から入ってくる
        const out = rail.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: "ease-in", fill: "forwards" });
        await out.finished.catch(() => {});
        const moving = flip(() => { applyCollapsed(false); out.cancel(); });
        side.animate([{ opacity: 0, transform: "translateX(-18px)" }, { opacity: 1, transform: "none" }],
          { duration: 320, delay: 90, easing: EASE_OUT, fill: "backwards" });
        await moving;
      }
      busy = false;
    }
    $("#sideClose").addEventListener("click", () => (phone.matches ? openSheet(false) : setCollapsed(true)));
    $("#railOpen").addEventListener("click", () => setCollapsed(false));
    $("#filterOpen").addEventListener("click", () => openSheet(true));

    // 検索バーの開け閉め
    const applySearchOpen = (open) => {
      document.body.classList.toggle("search-closed", !open);
      $("#searchToggle").setAttribute("aria-expanded", String(open));
      $("#searchToggle").title = $("#searchToggleLabel").textContent = open ? "検索バーを閉じる" : "検索する";
      store.set("searchOpen", open);
    };
    applySearchOpen(store.get("searchOpen", true));
    // 絞り込み欄と同じ考え方：検索欄が上へ抜け（入り）、その下の一覧は前の位置からすべって動く
    let searchBusy = false;
    async function setSearchOpen(open) {
      if (searchBusy) return;
      const parts = [$("#form"), $("#hint")];
      const below = ", #filters, #railOpen";
      if (reduceMotion.matches) { applySearchOpen(open); if (open) $("#q").focus(); return; }
      searchBusy = true;
      if (!open) {
        const outs = parts.map((el) => el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-10px)" }],
          { duration: 160, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" }));
        await Promise.all(outs.map((a) => a.finished.catch(() => {})));
        await flip(() => { applySearchOpen(false); outs.forEach((a) => a.cancel()); }, below);
      } else {
        const moving = flip(() => applySearchOpen(true), below);
        parts.forEach((el, i) => el.animate([{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "none" }],
          { duration: 300, delay: 120 + i * 50, easing: EASE_OUT, fill: "backwards" }));
        $("#q").focus({ preventScroll: true });
        await moving;
      }
      searchBusy = false;
    }
    $("#searchToggle").addEventListener("click", () => setSearchOpen(document.body.classList.contains("search-closed")));
    scrim.addEventListener("click", () => openSheet(false));

    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
    $("#news").addEventListener("click", (e) => {
      const b = e.target.closest("[data-find]");
      if (!b) return;
      showView("search");
      // JAN が複数あるときは、どれかに当たるものを出す
      const q = b.dataset.find;
      if (q.includes("|")) {
        state.q = "";
        $("#q").value = "";
        const jans = q.split(" | ");
        current = { mode: "all", terms: [], hits: items.filter((it) => jans.includes(it.handle)).map((item) => ({ item, score: 0 })) };
        refresh();
        $("#count").innerHTML += "　（話題の新商品から）";
      } else setQuery(q);
      window.scrollTo({ top: 0 });
    });
  }

  // ---------- 読み込み ----------
  async function load() {
    $("#grid").innerHTML = Array.from({ length: 12 }, () => `<div class="skeleton"></div>`).join("");
    readURL();
    $("#q").value = state.q;
    $("#clear").hidden = !state.q;
    bind();
    if (location.hash === "#news") showView("news");

    fetch("data/news.json").then((r) => r.json()).then((d) => renderNews(d.items)).catch(() => {
      $("#news").innerHTML = `<p class="empty">話題の新商品を読み込めませんでした。時間をおいて開き直してください。</p>`;
    });

    try {
      const data = await (await fetch("data/catalog.json")).json();
      cats = data.cats;
      imgBase = data.img;
      items = data.items.map((r) => ({
        handle: r[0], title: r[1], brand: r[2], cats: r[3], words: r[4],
        price: r[5], priceMax: r[6], flags: r[7], created: r[8], day: dayOf(r[8]), img: r[9],
      }));
      const now = new Date();
      todayDay = Math.floor((now.getTime() + 9 * 3600e3) / 864e5);
      S.buildIndex(items, cats, { daiso: "", sp: "Standard Products スタンダードプロダクツ SP", tp: "THREEPPY スリーピー" });
      $("#updated").textContent = `最終更新：${data.updated}（全${items.length.toLocaleString()}件）`;
      runSearch();
    } catch (e) {
      $("#count").textContent = "";
      $("#grid").innerHTML = `<div class="empty"><b>商品データを読み込めませんでした</b><span>通信状態を確かめて、ページを開き直してください。</span></div>`;
    }
  }
  load();
})();
