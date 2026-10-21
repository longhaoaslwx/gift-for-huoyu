/**
 * STAGE —— 录制舞台
 *
 * 这一页要解决的矛盾和其余四页不同：
 *   其余四页是给人「浏览」的，控件越多越好用；
 *   这一页是给人「录屏」的，控件越少、越不挡画面越好。
 *
 * 所以做法是：
 *   · 画幅（.stg-frame）里只有场景内容，控件全在画幅外面；
 *   · 每段素材是一个独立的「场景」，互不共享 DOM，切段 = 切换 active；
 *   · 重播不做时间轴 seek，而是把场景重建一次 —— 相机式的确定性重放，
 *     比维护一堆 animation.currentTime 稳得多，也永远不会状态漂移。
 *
 * 素材分两类：
 *   ① 数据驱动的（quote / count / bars / hours / words / ring / mood / cloud），
 *      内容从 posts.json / meta.json 里取，所以每次打开都不一样的那几段自动更新；
 *   ② 设计稿式的（hero / title），文案写死，属于站点的视觉身份。
 */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);

  let POSTS = [], META = null;
  let items = [];            // 素材清单
  let cur = 0;               // 当前段
  let playing = false;
  let allMode = false;       // 「全部」连播
  let dur = 6000;            // 单段时长（ms）
  let raf = 0, t0 = 0, elapsed = 0;
  let clean = false;
  let progOn = true;
  let fit = '16:9';
  let inited = false;
  // 自动续播的竞态防护：
  //   播完到跳下一段之间有 340ms 空档，这期间用户可能手动切段、
  //   按停止、或重播。靠一个自增 token 作废掉过期的跳转，
  //   比只判 playing 可靠（手动切段后可能马上又开了播）。
  let advanceToken = 0;
  let pendingAdvance = 0;
  // 用户主动停止（区别于「自然播完」）：主动停止后不应再自动续播。
  let userStopped = false;
  let endHintTimer = 0;

  const FITS = {
    '16:9': [16, 9],
    '21:9': [21, 9],
    '4:3': [4, 3],
    '1:1': [1, 1],
    '9:16': [9, 16],
  };

  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtNum = n => n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);

  /* ============================================================
     场景定义
     ============================================================ */

  /**
   * 每个场景的 build() 返回一段 HTML。
   * 之所以「每次重播都重建」而不是「重置动画 class」：
   * 重建能保证所有内联变量（--i / --h / --w）都是最初的初值，
   * 重置 class 只能复位 CSS 动画，管不到这些由数据算出来的变量，
   * 多播几次就会出现柱子停在半路、文字宽度不回零这类脏状态。
   */
  const SCENES = {

    /* ---------- 1. 首屏意象 ---------- */
    hero: {
      label: '首屏意象',
      desc: '火羽纹章描边绘出 · 标题与统计浮现',
      build() {
        const years = META.years.length;
        const st = [
          [META.total, '条动态'],
          [META.total_chars.toLocaleString(), '字正文'],
          [META.videos, '段影像'],
        ];
        return `<div class="scn-hero">
          <svg class="h-mark" viewBox="0 0 120 120" aria-hidden="true">
            <defs>
              <linearGradient id="sgStage" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#ff9a6c"/>
                <stop offset="1" stop-color="#c0261a"/>
              </linearGradient>
            </defs>
            <path class="ring" d="M60 8a52 52 0 1 0 0 104a52 52 0 1 0 0-104"
                  fill="none" stroke="url(#sgStage)" stroke-width="1.4" opacity=".6"/>
            <path class="flame" d="M60 18 C74 40 92 52 92 70 A32 32 0 0 1 28 70 C28 52 46 40 60 18 Z"
                  fill="none" stroke="url(#sgStage)" stroke-width="2.1"
                  stroke-linejoin="round"/>
          </svg>
          <div class="h-title">守约未停</div>
          <div class="h-sub">时间替她告白</div>
          <div class="h-rule"></div>
          <div class="h-stats">${st.map(([v, k], i) => `
            <div style="animation-delay:${(0.9 + i * 0.14).toFixed(2)}s">
              <b>${v}</b><span>${k}</span>
            </div>`).join('')}</div>
          <div class="stg-mono" style="margin-top:1.2cqw;opacity:.7">
            ${META.span_days} 天 · ${years} 年 · ${META.months.length} 个月
          </div>
        </div>`;
      },
    },

    /* ---------- 2. 标题逐字 ---------- */
    title: {
      label: '标题逐字',
      desc: '「时间，把守约写成最浪漫的告白」逐字浮现',
      build() {
        const line = '守约未停';
        let i = 0;
        const chars = [...line].map(c =>
          `<i style="--i:${i++}">${esc(c)}</i>`).join('');
        return `<div class="scn-title">
          <div class="stg-idx">THE PROMISE</div>
          <div class="stg-chars">${chars}</div>
          <div class="t-sub2">时间替她告白</div>
          <div class="t-motto">时间，把守约写成最浪漫的告白</div>
        </div>`;
      },
    },

    /* ---------- 3. 一条动态（打字机） ---------- */
    quote: {
      label: '一条动态',
      desc: '取当月最长的一条，正文逐行显出',
      // 取「当月写得最长的那条」而不是固定的某一条：
      // 这条素材的意义是「她的笔迹」，越长越能体现。
      build() {
        const p = pickLongest();
        if (!p) return `<div class="scn-quote"><div class="q-text">（无数据）</div></div>`;
        const txt = String(p.text || '').replace(/\s+/g, ' ').trim();
        const body = txt.length > 190 ? txt.slice(0, 190) + '…' : txt;
        return `<div class="scn-quote">
          <div class="q-mark">“</div>
          <div class="q-text"><span class="ink">${esc(body)}</span></div>
          <div class="q-foot">
            <img class="q-fl" src="assets/images/camellia/c5.png" alt="">
            <span>${p.y}.${pad(p.m)}.${pad(p.d)}</span>
            <span>${pad(p.hh)}:${pad(p.mm)}</span>
            <span class="q-lk">♥ ${fmtNum(p.like || 0)}</span>
          </div>
        </div>`;
      },
      // 打字机用 background-size 收放，时长要跟着字数走，
      // 否则长文会在能看清之前就"打完"，短文又拖得太久。
      after(el) {
        const t = el.querySelector('.q-text .ink');
        if (!t) return;
        const n = t.textContent.length;
        const sec = Math.min(5.2, Math.max(1.8, n / 42));
        t.style.setProperty('--type-dur', sec.toFixed(2) + 's');
      },
    },

    /* ---------- 4. 词云绽放 ---------- */
    cloud: {
      label: '词云绽放',
      desc: '64 个高频词由中心向外依次点亮',
      build() {
        const size = 1000;
        const words = (META.top_words || []).slice(0, 64);
        if (!words.length) return '<div class="scn-cloud"></div>';

        // 布局在 1000×1000 的正圆里算，再整体映射成 cqw。
        // 关键约束来自**画幅高度**而不是宽度：16:9 时高只有宽度的 56.25%，
        // 圆若按宽度铺满，上下必然被切。
        // 竖向预算（16:9，画幅高 56.25cqw）：
        //   .scn-cloud 的 padding 上下各 6cqw = 12
        //   圆直径 dia
        //   最外圈文字的字身约 ±2cqw → 水平多占 4
        // 取 dia = 38cqw：38 + 12 = 50 < 56.25，还留 6cqw 余量。
        const dia = 38;
        const scale = dia / size;
        // 字号直接用 cqw 定，再除回布局坐标：
        //   「直播」要大得出画面感 → 4.4cqw；尾部要有存在感 → 0.62cqw。
        // 4.4/0.038 = 115.8（布局 px），不能写成 dia*0.115 这种「占直径比例」，
        // 那算出来只有 4.37 布局 px，映射到 cqw 后只有 0.166cqw（2.3px），
        // 整张云会变成一片看不清的小点。
        const sizeMin = 0.62 / scale;
        const sizeMax = 4.4 / scale;

        // 复用主站的圆形布局算法（cloud.js 全局函数 layoutCircle）：
        // 同一套确定性算法保证词云在舞台和统计页里是同一个形状，
        // 观众不会觉得"这是两个不同的东西"。
        const laid = layoutCircle(words, size, {
          minSize: sizeMin,
          maxSize: sizeMax,
          gamma: 2.0,
          fontFamily: '"Shippori Mincho","Noto Serif SC",serif',
        });
        // 布局坐标 ±500 → 圆的百分比（0~100%），配合 .c-word 的
        // translate(-50%,-50%) 就是「文字中心落在该点」。
        //
        // 这里刻意用 % 而不是 cqw：元素相对自己所在的 .c-wrap 定位，
        // 用 % 天然跟住这个 38cqw 的方块；而 cqw 的参照物是「最近的尺寸容器」，
        // 即 .stg-inner（画幅宽），不是 .c-wrap。两者混用会让
        // left:50cqw 跑到画幅中心、而不是圆中心。
        const pct = x => (50 + x * (100 / size)).toFixed(3) + '%';
        // 字号仍需 cqw：字号不跟随元素盒子，跟的是尺寸容器，
        // 与别的场景同一基准，画幅一变就同比缩放。
        const fsCqw = s => (s * scale).toFixed(3) + 'cqw';

        const spans = laid.map((o, i) => {
          const k = o.k ?? o.t;
          const col = k >= 0.50 ? 'var(--hiiro-l)'
                    : k >= 0.16 ? 'var(--paper)'
                    : 'var(--paper-3)';
          // 透明度只由这个 --o 决定，animation 的终点也读它（opacity:var(--o)）。
          // 不要再在 after() 里回写 getComputedStyle 的 opacity：
          //   入场动画的 from 是 opacity:0，after 执行时动画刚起步，
          //   读到的计算值就是 0，回写给 --o 等于把整张云永久清零。
          //   元素本身没有静态 opacity 声明时，静态值默认是 1，也不需要回写。
          const op = (0.42 + k * 0.58).toFixed(2);
          return `<span class="c-word" style="
            left:${pct(o.x)};top:${pct(o.y)};
            font-size:${fsCqw(o.size)};
            color:${col};--i:${i};--o:${op}">${esc(o.w)}</span>`;
        }).join('');

        return `<div class="scn-cloud">
          <div class="c-wrap">
            <div class="c-ring"></div>
            <div class="c-core"></div>
            ${spans}
          </div>
        </div>`;
      },
    },

    /* ---------- 5. 动态环 ---------- */
    ring: {
      label: '动态环',
      desc: '69 个月份牌沿圆周排开并缓慢旋转',
      build() {
        const months = META.months || [];
        if (!months.length) return '<div class="scn-ring"></div>';
        const n = months.length;
        const R = 20;   // cqw；与 stage.css 里 .r-wrap 的 46cqw 配套
        const step = 360 / n;
        const maxN = Math.max(...months.map(m => m.n));

        const cards = months.map((m, i) => {
          const ang = i * step;
          const mv = Math.max(0, Math.min(1, m.mood01 ?? 0.5));
          const petal = Math.min(5, Math.max(1, Math.floor(mv * 4.999) + 1));
          // --mc-rgb：橙红(194,65,15) ↔ 灰红(107,74,68)
          const c = [
            Math.round(107 + (194 - 107) * mv),
            Math.round(74 + (65 - 74) * mv),
            Math.round(68 + (15 - 68) * mv),
          ].join(',');
          return `<div class="r-mcard" style="
            transform:rotate(${ang}deg) translateY(-${R}cqw) rotate(${-ang}deg);
            --i:${i};--mv:${mv.toFixed(3)};--mc-rgb:${c}">
            <img class="r-fl" src="assets/images/camellia/c${petal}.png" alt="">
            <b>${pad(+m.m)}</b>
            <span>${m.n}</span>
          </div>`;
        }).join('');

        // 中心的读数用「最忙的那一个月」，那是最有说服力的一个数字
        const top = months.reduce((a, b) => (b.n > a.n ? b : a), months[0]);
        return `<div class="scn-ring">
          <div class="r-wrap">
            <div class="r-orbit">${cards}</div>
            <div class="r-core">
              <div class="r-ym">${top.y}.${pad(top.m)}</div>
              <div class="r-n">${top.n}</div>
              <div class="r-l">条动态</div>
            </div>
          </div>
          <div class="r-cap">${n} 个月 · ${META.total} 条 · 无一月空缺</div>
        </div>`;
      },
    },

    /* ---------- 6. 心情绽放 ---------- */
    mood: {
      label: '心情绽放',
      desc: '五档椿花由凋败到盛开',
      build() {
        const cells = [
          [1, '阴郁'],
          [2, '低落'],
          [3, '平常'],
          [4, '轻快'],
          [5, '盛放'],
        ].map(([lv, name], i) => {
          const mv = i / 4;   // 0 ~ 1
          const sat = (0.2 + mv * 1.1).toFixed(2);
          const bri = (0.58 + mv * 0.7).toFixed(2);
          const glow = (mv * 1.4).toFixed(2);
          const op = (0.30 + mv * 0.70).toFixed(2);
          return `<div class="m-cell" style="--i:${i}">
            <img src="assets/images/camellia/c${lv}.png" alt=""
                 style="--sat:${sat};--bri:${bri};--glow:${glow};--o:${op}">
            <b>${name}</b>
          </div>`;
        }).join('');

        // 真实分布：把「她最常处在哪一档」标出来，避免这段只是装饰
        const months = META.months || [];
        const avg = months.length
          ? months.reduce((s, m) => s + (m.mood01 ?? 0.5), 0) / months.length
          : 0.5;
        return `<div class="scn-mood">
          <div class="stg-idx">MOOD</div>
          <div class="m-row">${cells}</div>
          <div class="m-bar"><i style="--w:${(13 + avg * 87).toFixed(1)}%"></i></div>
          <div class="stg-mono">69 个月的平均心情 · ${(avg * 100).toFixed(1)}</div>
        </div>`;
      },
    },

    /* ---------- 7. 数字滚动 ---------- */
    count: {
      label: '数字滚动',
      desc: '总字数从 0 滚到实际值',
      build() {
        return `<div class="scn-count">
          <div class="n-xl" data-to="${META.total_chars}">0</div>
          <div class="n-lb">字正文</div>
          <div class="n-line"></div>
          <div class="n-note">${META.total} 条动态 · 平均每条 ${META.avg_chars} 字</div>
        </div>`;
      },
      after(el, scn) {
        const n = Number(scn.querySelector('.n-xl').dataset.to) || 0;
        countTo(scn.querySelector('.n-xl'), n, 2200);
      },
    },

    /* ---------- 8. 每月动态 ---------- */
    bars: {
      label: '每月动态',
      desc: '69 根月柱按时间顺序长起来',
      build() {
        const months = META.months || [];
        if (!months.length) return '<div class="scn-bars"></div>';
        const maxN = Math.max(...months.map(m => m.n));
        const slots = months.map((m, i) => `<div class="b-slot${m.m === 1 ? ' yr' : ''}"
          style="--i:${i}"><i style="--h:${Math.max((m.n / maxN) * 100, 1.5).toFixed(2)}%"></i></div>`
        ).join('');
        const axis = META.years.map(y => {
          const i = months.findIndex(m => m.y === y.y && m.m === 1);
          const pct = (Math.max(i, 0) / Math.max(months.length - 1, 1)) * 100;
          // 年份标签以 left:X% 居中，首尾两个会被切掉半截，
          // 用 0/100 两端各收 1.2% 让它们留在画幅内。
          const p = Math.min(98.8, Math.max(1.2, pct));
          return `<span style="left:${p.toFixed(2)}%">${y.y}</span>`;
        }).join('');
        const peak = months.reduce((a, b) => (b.n > a.n ? b : a), months[0]);
        return `<div class="scn-bars">
          <div class="b-head">
            <b>每月动态</b>
            <span>峰值 ${peak.ym} · ${peak.n} 条</span>
          </div>
          <div class="b-chart">${slots}</div>
          <div class="b-axis">${axis}</div>
        </div>`;
      },
    },

    /* ---------- 9. 发帖时刻 ---------- */
    hours: {
      label: '发帖时刻',
      desc: '24 小时分布，峰值那根单独点亮',
      build() {
        const hrs = META.hours || [];
        if (!hrs.length) return '<div class="scn-hours"></div>';
        const maxH = Math.max(...hrs);
        const peakH = hrs.indexOf(maxH);
        const slots = hrs.map((v, h) => `<div class="hr-slot${v === maxH ? ' peak' : ''}"
          style="--i:${h}"><i style="--h:${Math.max((v / maxH) * 100, 1.2).toFixed(2)}%"></i></div>`
        ).join('');
        const axis = [0, 6, 12, 18, 23].map(h =>
          `<span style="left:${((h + 0.5) / 24 * 100).toFixed(3)}%">${pad(h)}</span>`).join('');
        return `<div class="scn-hours">
          <div class="b-head">
            <b>发帖时刻</b>
            <span>${pad(peakH)}:00 是她最常出现的时刻</span>
          </div>
          <div class="hr-chart">${slots}</div>
          <div class="hr-axis">${axis}</div>
          <div class="hr-tag">${maxH} 条 · 全部动态里最集中的一小时</div>
        </div>`;
      },
    },

    /* ---------- 10. 高频词条 ---------- */
    words: {
      label: '高频词条',
      desc: '前十高频词逐行流过并展开条形',
      build() {
        const words = (META.top_words || []).slice(0, 10);
        if (!words.length) return '<div class="scn-words"></div>';
        const maxN = words[0].n || 1;
        const rows = words.map((w, i) => {
          const k = (w.n / maxN);
          return `<div class="w-row" style="--i:${i}">
            <span class="w-rk">${pad(i + 1)}</span>
            <span class="w-t" style="--k:${(k * 1).toFixed(3)}">${esc(w.w)}</span>
            <span class="w-bar"><i style="--w:${(k * 100).toFixed(1)}%"></i></span>
            <span class="w-n">${w.n}</span>
          </div>`;
        }).join('');
        return `<div class="scn-words">
          <div class="stg-idx" style="margin-bottom:2.2cqw">TOP WORDS</div>
          <div class="w-cols">${rows}</div>
        </div>`;
      },
    },
  };

  // 素材顺序：按「先建立意象 → 再进入数据」的叙事排，
  // 连播时是一条完整的片子，而不是十段互不相干的动效。
  const ORDER = ['hero', 'title', 'quote', 'cloud', 'ring',
                 'mood', 'count', 'bars', 'hours', 'words'];

  /* ============================================================
     数据挑选
     ============================================================ */
  function pickLongest() {
    // 在「正文足够长、又不至于长到一屏放不下」的区间里，取最新的那条。
    // 纯粹取最长会挑到 700 字的公告，打字机要打十几秒，录出来很拖。
    const cand = POSTS.filter(p => {
      const n = (p.text || '').trim().length;
      return n >= 90 && n <= 220 && p.text.trim().slice(0, 1) !== '【';
    });
    if (!cand.length) return POSTS[0] || null;
    cand.sort((a, b) => b.ts - a.ts);
    return cand[0];
  }

  /* ============================================================
     数字滚动
     ============================================================ */
  function countTo(el, to, ms) {
    if (!el) return;
    const t0 = performance.now();
    const tick = now => {
      const p = Math.min(1, (now - t0) / ms);
      // easeOutExpo：前段飞快、后段收得慢，观感比线性舒服得多
      const e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      el.textContent = Math.round(to * e).toLocaleString();
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ============================================================
     舞台本体
     ============================================================ */
  function buildStage() {
    const stage = $('#stg-stage');
    $('#stg-list').innerHTML = ORDER.map((key, i) => {
      const s = SCENES[key];
      return `<button class="stg-item" type="button" role="tab"
        data-k="${key}" data-i="${i}" aria-selected="false">
        <span class="si-top">
          <span class="si-dot"></span>
          <span class="si-no">${pad(i + 1)}</span>
          <span>${esc(s.label)}</span>
        </span>
        <span class="si-t">${esc(s.desc)}</span>
        <span class="si-d">${esc(s.dur || '')}</span>
      </button>`;
    }).join('');

    items = ORDER.map(k => ({ key: k, ...SCENES[k] }));

    stage.innerHTML = ORDER.map(k =>
      `<div class="stg-scn" data-scn="${k}"></div>`).join('');

    $('#stg-list').querySelectorAll('.stg-item').forEach(b => {
      b.addEventListener('click', () => {
        // 不再顺手关掉 allMode：它现在是「循环模式」这一播放器设置，
        // 不是「一次性连播」。开着循环时点列表换素材，播完仍应按循环走；
        // 想停续播就按暂停或关掉循环，语义比原来清楚。
        go(+b.dataset.i, true);
      });
    });
  }

  /**
   * 播放某一段。
   * @param {number} i    素材下标
   * @param {boolean} auto 是否自动开始计时（手动点击时为 true，直接开播体验更顺）
   */
  function go(i, auto) {
    if (!items.length) return;
    // 已经在切段了，之前排队的自动跳转一律作废，
    // 否则「手动点第 3 段」之后还会被 340ms 前的续播拖到第 4 段。
    advanceToken++;
    clearTimeout(pendingAdvance);
    cur = Math.max(0, Math.min(items.length - 1, i));
    const it = items[cur];

    // 清空所有场景，再只建当前这一个：
    // 保留十个场景在 DOM 里会让旧场景的 CSS 动画在 display:none 下继续跑，
    // 录屏软件偶尔会把它算进合成层，切段时闪一下。
    renderScene(it);

    // 列表高亮
    $$('#stg-list .stg-item').forEach(b => {
      const on = +b.dataset.i === cur;
      b.classList.toggle('on', on);
      b.classList.toggle('playing', on && playing);
      b.setAttribute('aria-selected', String(on));
    });
    $('#stg-count').textContent = `${cur + 1} / ${items.length}`;
    $('#' + 'stg-time').textContent = '00:00.0';

    if (auto) start();
    else { stopLoop(); syncPlay(); }
  }

  function $$(s, r) { return [...(r || document).querySelectorAll(s)]; }

  function renderScene(it) {
    const host = document.querySelector(`.stg-scn[data-scn="${it.key}"]`);
    if (!host) return;
    $$('.stg-scn').forEach(s => s.classList.toggle('active', s === host));
    host.innerHTML = it.build();

    // 强制 reflow，让刚写进去的动画从第 0 帧开始，
    // 而不是接着上一次的进度（尤其在 0.1s 内连续重播时）
    void host.offsetWidth;

    if (typeof it.after === 'function') it.after(host, host);
  }

  /* ---------- 计时与进度 ---------- */
  function start() {
    playing = true;
    userStopped = false;      // 一旦重新开播，自动续播就重新生效
    syncPlay();
    t0 = performance.now();
    cancelAnimationFrame(raf);

    const tick = now => {
      if (!playing) return;
      const el = now - t0;
      const p = Math.min(1, el / dur);
      if (progOn) $('#stg-prog-i').style.width = (p * 100).toFixed(2) + '%';
      $('#stg-time').textContent = fmtClock(el);
      if (p >= 1) { done(); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function stopLoop() {
    playing = false;
    // 用户按了暂停/停止：作废待执行的自动跳转，并标记不再自动续播，
    // 否则「暂停后又自己跳下一段」会显得失控。
    advanceToken++;
    clearTimeout(pendingAdvance);
    userStopped = true;
    cancelAnimationFrame(raf);
    raf = 0;
    syncPlay();
  }

  /**
   * 一段播完。
   *
   * 【修复】原先只有 allMode（「全部」）才会进下一段；直接点「播放」
   * 播完就停在当前段，用户以为播放器坏了。现在统一走「自动续播」：
   * 播完 → 有下一段就进下一段 → 没有下一段按末尾策略处理。
   *
   * 【末尾策略】选「停止并提示」而不是循环：
   *   这个页面是给录屏用的。若末尾自动循环，录出来的素材会首尾相接、
   *   分不清是从哪一段开始的，也不好判断什么时候该停录。
   *   需要无限循环的场景由「全部」按钮（循环模式）显式开启。
   */
  function done() {
    playing = false;
    cancelAnimationFrame(raf);
    raf = 0;
    if (progOn) $('#stg-prog-i').style.width = '100%';
    $('#stg-time').textContent = fmtClock(dur);
    syncPlay();
    markPlaying();

    const next = cur + 1;

    if (next < items.length) {
      // 留 340ms 黑场间隔，录出来段落感更清楚，
      // 直接衔接会看成一段连续的抖动。
      //
      // 竞态防护：这 340ms 里用户可能已经手动切段或按了停止，
      // 所以用一个自增的 token 作废掉过期的跳转——
      // 只判 playing 不够，因为手动切段后可能又开了播。
      const tk = ++advanceToken;
      pendingAdvance = setTimeout(() => {
        if (tk !== advanceToken) return;   // 已被后续操作作废
        if (!userStopped) go(next, true);
      }, 340);
      return;
    }

    // ---- 已经是最后一段 ----
    if (allMode) {
      // 循环模式：回到第一段继续，方便长时间挂着录
      const tk = ++advanceToken;
      pendingAdvance = setTimeout(() => {
        if (tk !== advanceToken) return;
        if (!userStopped) go(0, true);
      }, 340);
      return;
    }

    // 顺序播放到底：停住并提示
    showEndHint();
  }

  /** 顺序播放到末尾时的一次性提示 */
  function showEndHint() {
    const box = $('#stg-end');
    if (!box) return;
    box.hidden = false;
    box.textContent = `已播完第 ${items.length} 段 · 按 R 重播本段，或点「全部」循环播放`;
    clearTimeout(endHintTimer);
    endHintTimer = setTimeout(() => { box.hidden = true; }, 4200);
  }

  /**
   * 重播本段。
   * 不重置 allMode：连播中途按 R 只想重录这一段，不该把循环模式关掉
   * （原代码写成 `allMode = allMode` 是无操作，等于什么都没做，
   *  行为虽然正确但会误导后人，这里改成注释说明）。
   */
  function replay() {
    advanceToken++;
    clearTimeout(pendingAdvance);
    renderScene(items[cur]);
    if (progOn) $('#stg-prog-i').style.width = '0';
    $('#stg-time').textContent = '00:00.0';
    start();
  }

  function fmtClock(ms) {
    const s = ms / 1000;
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return pad(m) + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
  }

  function syncPlay() {
    const b = $('#stg-play');
    b.dataset.on = playing ? '1' : '0';
    b.setAttribute('aria-label', playing ? '暂停' : '播放');
    const item = $$('#stg-list .stg-item')[cur];
    if (item) item.classList.toggle('playing', playing && item.classList.contains('on'));
  }

  function markPlaying() {
    const item = $$('#stg-list .stg-item')[cur];
    if (item) item.classList.remove('playing');
  }

  function syncAllBtn() {
    const b = $('#stg-all');
    b.setAttribute('aria-pressed', String(allMode));
    b.setAttribute('title', allMode
      ? '循环播放：播完最后一段自动回到第一段（0）· 已开启'
      : '循环播放：播完最后一段自动回到第一段（0）');
  }

  /* ---------- 画幅 ---------- */
  function applyFit(name) {
    const f = FITS[name] || FITS['16:9'];
    fit = name;
    const frame = $('#stg-frame');
    frame.style.setProperty('--fw', f[0]);
    frame.style.setProperty('--fh', f[1]);
    // 竖屏画幅在宽屏上会变得很矮，max-width 必须按高度反算，否则会溢出
    frame.style.setProperty('--fit', f[0] + '/' + f[1]);
    // 词云与动态环依赖方块区域，画幅一变就要重排当前场景
    if (items.length) renderScene(items[cur]);
  }

  /* ---------- 纯净态 ---------- */
  function setClean(on) {
    clean = on;
    document.body.classList.toggle('stg-clean', on);
    if (on) {
      // 进纯净态后把焦点交给画幅，键盘操作才生效
      setTimeout(() => $('#stg-frame').focus(), 60);
    }
  }

  function toggleFull() {
    const f = $('#stg-frame');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (f.requestFullscreen) f.requestFullscreen().catch(() => setClean(true));
    else setClean(true);
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function bind() {
    $('#stg-play').addEventListener('click', () => {
      if (playing) stopLoop(); else start();
    });
    // 上/下一段同样不改动循环模式，只切素材（理由见列表项的注释）
    $('#stg-prev').addEventListener('click', () => go(cur - 1, true));
    $('#stg-next').addEventListener('click', () => go(cur + 1, true));
    $('#stg-replay').addEventListener('click', () => replay());

    $('#stg-all').addEventListener('click', () => {
      allMode = !allMode;
      syncAllBtn();
      if (allMode) go(cur, true);
    });

    $('#stg-fit').addEventListener('change', e => applyFit(e.target.value));
    $('#stg-dur').addEventListener('change', e => {
      dur = +e.target.value * 1000;
      if (playing) replay();
    });

    $('#stg-prog-on').addEventListener('click', e => {
      progOn = !progOn;
      e.currentTarget.setAttribute('aria-pressed', String(progOn));
      $('#stg-root').classList.toggle('no-prog', !progOn);
    });

    $('#stg-clean').addEventListener('click', () => setClean(!clean));
    $('#stg-full').addEventListener('click', toggleFull);

    // 双击画幅 = 纯净态 / 退出
    $('#stg-frame').addEventListener('dblclick', () => {
      clearTimeout(tapTimer);
      setClean(!clean);
    });
    // 单击画幅 = 播放 / 暂停（录屏时最顺手的操作，不用回面板找按钮）。
    // 不能直接监听 click：双击的第二下会先触发两次 click，
    // 结果是「停下→又开始」，看起来像双击失灵。这里用 240ms 的
    // 判定窗把单击延后，期间来了第二下就取消，交给 dblclick。
    let tapTimer = 0;
    $('#stg-frame').addEventListener('click', () => {
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        if (playing) stopLoop(); else start();
      }, 240);
    });

    // 键盘：只在舞台页生效，避免和轮盘页的空格/方向键打架
    window.addEventListener('keydown', e => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const onStage = $('#v-stage').classList.contains('active');
      // 纯净态下即使切走了也要能退出，否则会卡在全屏黑屏里
      if (!onStage && !clean) return;

      // 用 e.code 而不是 e.key：空格在部分键盘布局/输入法下
      // e.key 会是 'Spacebar' 或其它值，code 恒为 'Space'。
      if (e.code === 'Space') {
        // 画幅是 button-like 的可聚焦元素时，空格会顺带触发 click，
        // 而画幅的 click 已经被 240ms 判定窗接管，这里必须阻止默认行为，
        // 否则一次空格会「暂停 → 又播放」。
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(tapTimer);
        if (playing) stopLoop(); else start();
        return;
      }

      switch (e.key) {
        case 'Escape':
          if (clean) { setClean(false); e.preventDefault(); }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          go(cur - 1, true);   // 不改动循环模式，与列表项/按钮保持一致
          break;
        case 'ArrowRight':
          e.preventDefault();
          go(cur + 1, true);
          break;
        case 'r': case 'R':
          e.preventDefault(); replay();
          break;
        case 'f': case 'F':
          e.preventDefault(); toggleFull();
          break;
        case '0':
          e.preventDefault();
          allMode = !allMode; syncAllBtn();
          if (allMode) go(cur, true);
          break;
        default: break;
      }
    });

    // 离开舞台页时停掉计时器，别在后台空转。
    // 不在 window 的 blur 上做——录屏时用户常切到录屏软件，
    // 窗口失焦是常态，一失焦就停反而录不到完整的一段。
    // 真正的判断放在 switchView 里（见 app.js 的 Stage.leave）。
  }

  function leave() {
    if (!inited) return;
    // 离开舞台页要连待执行的自动跳转一起清掉，
    // 否则切走后 340ms 又回来播，声音会莫名其妙响一下。
    advanceToken++;
    clearTimeout(pendingAdvance);
    clearTimeout(endHintTimer);
    if (playing) stopLoop();
  }

  /* ============================================================
     对外入口
     ============================================================ */
  function init(posts, meta) {
    if (inited) return;
    inited = true;
    POSTS = posts;
    META = meta;

    buildStage();
    bind();
    applyFit('16:9');
    // 首屏不自动播放：打开这一页先让人看清画幅与素材列表，
    // 直接开播会显得页面在自己乱动。
    go(0, false);
    $('#stg-prog-i').style.width = '0';
  }

  // 切到舞台页时重排一次：视图隐藏时容器宽高为 0，
  // cqw 会全部算成 0，场景内容会塌成一团。
  //
  // 所有对外入口都要先看 inited：数据加载失败时 app.js 不会调用 init，
  // 但 switchView 仍会在切到 STAGE 页时调 wake，
  // 此时 META 是 null，renderScene 里读 META.months 会直接抛错。
  function wake() {
    if (!inited || !items.length) return;
    renderScene(items[cur]);
    if (!playing) $('#stg-prog-i').style.width = '0';
  }

  window.Stage = { init, wake, leave, go, play: start, pause: stopLoop, replay };
})();
