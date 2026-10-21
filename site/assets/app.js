/* 信 · 火羽ひのめ  —— 交互逻辑 */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const IMG = 'assets/images/media/';
  const WD = ['一', '二', '三', '四', '五', '六', '日'];

  let POSTS = [], META = null;
  let byMonth = new Map();      // '2024-03' -> [posts]
  let monthKeys = [];           // 有序月份

  /**
   * 舰长数据（assets/data/guards.json）。
   *
   * 刻意做成**独立于 posts/meta 的第三份数据**，且加载失败不影响整站：
   *   它是后来补的，来源站点（VTBs）也随时可能停摆。若把它并进
   *   `Promise.all([posts, meta, guards])`，一旦 guards.json 缺失，
   *   整个 boot() 就走 catch，用户连动态都看不了——代价完全不对等。
   *   所以单独 try/catch，缺了就只在对应卡片显示「暂未载入」。
   */
  let GUARDS = null;
  let guardsOK = false;
  // 成员轨道两端的同步器（遮罩 + 进度条）。由 bindGuardDrag 注入：
  // 视图隐藏时量不到宽度，切回 STATS 后需要外部再触发一次。
  let guardSync = null;
  /**
   * 大航海图表的显示窗口：[a, b] 是 GUARDS.daily 的下标区间（含两端）。
   *
   * 等价于 laplace 大航海图里 ECharts dataZoom 的
   * `startValue = len-30, endValue = len`——默认只显示最后 30 天，
   * 底部拖动块负责改这个区间。全量 2086 天的序列同时画在拖动块轨道上
   * 当缩略图（对应 dataZoom 的 dataBackground），窗口只是它的一个选区。
   */
  let guardRange = null;
  // 窗口最小天数。拖成一个点的话，主图就没有任何信息量了。
  const GUARD_MIN_WIN = 7;
  // 范围拖动块是否已绑定（resize 只重绘，不重复绑事件）。
  let guardRangeBound = false;
  // 拖动块的重排器（缩略图 + 窗口位置）。由 bindGuardRange 注入，
  // 与 guardSync 同一位移：视图隐藏时量不到宽度，切回 STATS 后要重排。
  let guardRangeRelayout = null;
  /**
   * 数据是否真的加载成功。
   *
   * 这个开关必须存在：boot() 失败时会走 bindNavOnly()，导航仍然可点，
   * 于是 switchView 会被调到，而它里面每个分支（buildDial / renderCloud /
   * Stage.wake）都直接读 META.*。META 是 null → 抛 TypeError，
   * 异常从 requestAnimationFrame 回调里冒出去，中断掉这一帧剩下的工作，
   * 表现就是「点了没反应」甚至「页面半卡住」。
   * 所有依赖数据的切页回调都必须先看这个开关。
   */
  let dataOK = false;
  let curIdx = 0;               // 当前月份下标
  let curArr = [];              // 当月动态数组（语言徽章 / 整月切换用）

  /* ---------------------------------------- 工具 */
  const pad = n => String(n).padStart(2, '0');
  const fmtDate = p => `${p.y}.${pad(p.m)}.${pad(p.d)}`;
  const fmtTime = p => `${pad(p.hh)}:${pad(p.mm)}`;
  const fmtNum = n => n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);

  // 心情 → 牌面底色：橙红(#c2410f) ↔ 灰红(#6b4a44) 线性插值。
  // 灰红端刻意压暗压灰，低落月不会亮得刺眼，也不会和暗红底糊成一片。
  const C_WARM = [194, 65, 15];
  const C_GREY = [107, 74, 68];
  function moodColor(v) {
    const t = Math.max(0, Math.min(1, v));
    const c = C_GREY.map((g, i) => Math.round(g + (C_WARM[i] - g) * t));
    return c.join(',');
  }

  // 心情分档：五档对应五朵椿花，从凋败到盛开
  const MOOD_LV = [
    [0.00, '低落'], [0.20, '沉静'], [0.36, '平和'],
    [0.52, '舒展'], [0.68, '愉快'], [0.84, '欢喜'],
  ];
  function moodLabel(v) {
    let lab = '平和';
    for (const [th, name] of MOOD_LV) if (v >= th) lab = name;
    return lab;
  }
  // 0~1 → 花朵编号 1~5。用 floor 均分五段，
  // 保证每档都有月份落进来，不会出现「最凋败那朵永远用不上」。
  const petalOf = v => Math.min(5, Math.max(1, Math.floor(v * 4.999) + 1));
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 排行条目截断：长信原文可达 700 字，塞进两行的卡里既撑高度又读不出重点。
  // 按「字符」截而不是按行截，这样中日文混排的视觉高度也大致一致；
  // 换行先压成单空格，否则首行被前文的空行吃掉，条目看起来是空白的。
  // 完整正文点击条目即可跳到轮盘页原地展开。
  const clip = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  /* ---------------------------------------- 加载 */
  /**
   * 双击 index.html 直接打开时，浏览器会以 file:// 协议运行，
   * fetch 本地 JSON 会被 CORS 直接拦掉（连响应都拿不到）。
   * 这不是代码 bug，是浏览器的安全策略，只能引导用户起一个本地服务。
   *
   * 关键是提示必须「跟人走」：原来挂在 #hero 上，#hero 只在 RING 页可见，
   * 用户切到 FILM 就只剩一片空白，看起来像页面崩了。
   * 现在做成固定定位的横幅 + 每个页面的空态说明，切到哪一页都看得见。
   */
  function showLoadError(e) {
    const isFile = location.protocol === 'file:';

    const div = document.createElement('div');
    div.className = 'load-err';
    div.setAttribute('role', 'alert');
    div.innerHTML = isFile
      ? `<b>需要用本地服务器打开</b>
         <p>浏览器禁止 <code>file://</code> 页面读取本地数据文件，这不是页面出错。</p>
         <div class="le-go" id="le-go" hidden>
           <a id="le-go-link" href="#">检测到本地服务器，点此进入站点 →</a>
         </div>
         <p>在 <code>site</code> 目录里（就是 index.html 所在的那层）执行下面任意一条命令，
            然后访问
            <a class="le-link" href="http://localhost:8000/">http://localhost:8000</a>：</p>
         <pre>python -m http.server 8000</pre>
         <pre>npx serve .</pre>
         <p class="le-hint">① 起服务后那个黑窗口要一直开着，关掉服务就停了；
            ② 开好后要在浏览器地址栏输入 http://localhost:8000/ 访问——
            还停在 E:/ 开头的旧标签页上，开多少个服务器它都不会变好；
            ③ 换了端口就把地址里的 8000 换成你的端口。</p>`
      : `<b>数据加载失败</b>
         <p>${esc(e && e.message ? e.message : String(e))}</p>
         <p>请确认 <code>assets/data/</code> 下的 JSON 文件存在且完整。</p>`;

    // 插在 #hero 前面、进入正常文档流，而不是 fixed 浮层。
    //   1. fixed 会跟 sticky 顶栏抢层叠位置（实测切到长页面滚动后
    //      sticky 顶栏被顶到 144px，导航悬在半空），而且浮层会盖住内容。
    //   2. 必须插在 hero 之前而不是 main 之前：hero 是 100vh 的首屏，
    //      插在 main 前会被整块首屏挡在 985px 处，用户打开页面根本看不到。
    // 放进流里最省事：内容自然下推，顶栏照常吸顶，不遮任何东西。
    const heroEl = document.querySelector('#hero');
    const anchor = heroEl || document.querySelector('main');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(div, anchor);
    else document.body.appendChild(div);

    const sub = document.querySelector('#hero-sub');
    if (sub) sub.textContent = '数据未能载入';

    // file:// 场景下启动端口探测：用户多半是「服务器开了，浏览器还盯着
    // file:// 旧标签页」，横幅里给一个能点的进入按钮，把人带过去。
    if (isFile) probeLocalServer(div);

    // 各页给一句就地说明，避免切换到该页时看到「纯空白」以为坏了
    // 注意 film-grid 与 film-empty 二者只有一个可见，
    // 两处都写会同时看到两句「数据未载入」，重复且显得凌乱。
    const grid = document.getElementById('film-grid');
    if (grid) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = '数据未载入，影像列表暂不可用。请按上方提示用本地服务器打开本站。';
      grid.appendChild(p);
    }
    const empty = document.querySelector('#film-empty');
    if (empty) {
      // 交给 grid 里的那句就够了，这里保持隐藏，避免重复
      empty.hidden = true;
    }
    const stgList = document.getElementById('stg-list');
    if (stgList) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = '数据未载入，录制素材暂不可用。请按上方提示用本地服务器打开本站。';
      stgList.appendChild(p);
    }
    document.body.classList.add('data-failed');
  }

  /**
   * file:// 降级横幅的本地服务器端口探测。
   *
   * 两个常见卡点，横幅都得能自动兜住：
   *   1) 服务器开了，浏览器还停在 file:// 旧标签页——给一个能点的
   *      「进入站点」按钮，一步跳过去；
   *   2) 服务器起在了上层目录（E:\Projects\huoyu 而不是 site）——
   *      这时站点挂在 /site/ 路径下，链接要带前缀才进得去。
   *
   * 为什么用 Image 而不是 fetch：Chrome 禁止 file:// 页面发起 fetch/XHR，
   * 无论目标是什么，一律「Failed to fetch」（实测 2026-10-20）。
   * 图片标签不受这层限制；而且只有真的返回了本站的图才算数——
   * 别的服务 404 照样过不了，不会把无关的本地服务误认成本站。
   * 每 2 秒一轮，最多 45 轮；探测不出来也不碍事，横幅里的手动地址始终可点。
   */
  function probeLocalServer(banner) {
    const PORTS = [8000, 8080, 8888, 3000, 5173, 8880, 4173, 5000];
    // base 为空 = 服务器根目录就是 site；'/site/' = 起在了上层目录
    const BASES = ['', 'site/'];
    const PROBE = 'assets/images/camellia/c3.png';   // 站内一定存在的图
    const box = banner.querySelector('#le-go');
    const link = banner.querySelector('#le-go-link');
    if (!box || !link) return;
    let rounds = 0;
    const tryOne = (p, base) => new Promise(resolve => {
      const img = new Image();
      let done = false;
      const fin = ok => {
        if (!done) { done = true; img.onload = img.onerror = null; resolve(ok); }
      };
      img.onload = () => fin(true);
      img.onerror = () => fin(false);
      img.src = `http://localhost:${p}/${base}${PROBE}?t=${Date.now()}`;
      setTimeout(() => fin(false), 1500);
    });
    const tick = async () => {
      for (const p of PORTS) {
        for (const base of BASES) {
          if (await tryOne(p, base)) {
            if (!document.contains(banner)) return;   // 页面已正常，横幅没了
            link.href = `http://localhost:${p}/${base}`;
            link.textContent =
              `检测到本地服务器（端口 ${p}${base ? '，站点在 /' + base.replace('/', '') + ' 路径下' : ''}），点此进入站点 →`;
            box.hidden = false;
            return;
          }
        }
      }
      if (++rounds < 45) setTimeout(tick, 2000);
    };
    tick();
  }

  async function boot() {
    try {
      const [p, m] = await Promise.all([
        fetch('assets/data/posts.json').then(r => r.json()),
        fetch('assets/data/meta.json').then(r => r.json()),
      ]);
      POSTS = p; META = m;
      dataOK = true;
    } catch (e) {
      console.error('数据加载失败', e);
      showLoadError(e);
      // 即使数据挂了，导航也要能切：否则用户卡在 RING 页，
      // 只能看到一块提示，其它页永远进不去，体感就是「点了没反应」。
      bindNavOnly();
      // 舞台不初始化：它的 10 个场景全靠 META 的数字与数组，
      // 传空壳会在 build 里抛错，渲染出一堆 NaN / 空白画幅，
      // 反而比一句「数据未载入」更让人困惑。
      return;
    }

    // 舰长数据单独加载：缺了只影响那一张卡，不能拖垮整站
    try {
      const g = await fetch('assets/data/guards.json').then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
      GUARDS = g;
      // 判据取 daily：日度序列是走势图与范围拖动块的唯一数据源。
      // （months 逐月存量已随月度图表一并下线，不再作为加载判据。）
      guardsOK = !!(g && Array.isArray(g.daily) && g.daily.length);
    } catch (e) {
      console.warn('舰长数据未载入（不影响其它页面）', e);
      GUARDS = null;
      guardsOK = false;
    }

    POSTS.forEach(x => {
      const k = x.y + '-' + pad(x.m);
      if (!byMonth.has(k)) byMonth.set(k, []);
      byMonth.get(k).push(x);
    });
    monthKeys = [...byMonth.keys()].sort();

    renderHero();
    renderHeader();
    buildDial();
    loadDcRun();
    selectMonth(monthKeys.length - 1, false);
    buildStats();
    renderGuard();
    renderSources();
    buildArchive();
    buildFilm();
    buildGallery();
    if (window.Stage) Stage.init(POSTS, META);
    bindTabs();
    bindKeys();
    bindTrans();
    startHeroBubbles();
    window.addEventListener('resize', debounce(() => {
      buildDial(true); renderCloud();
      // 日度图的 viewBox 是按容器实际像素取的，视口一变就得重画，
      // 否则窄屏下网格会互相重叠。
      if (guardsOK) buildGuardDaily();
    }, 260));

    // 首屏滚出后收起 hero 视差
    const hero = $('#hero');
    const io = new IntersectionObserver(
      ([e]) => { hero.style.setProperty('--hero-out', e.isIntersecting ? '0' : '1'); },
      { rootMargin: '-40% 0px' }
    );
    io.observe(hero);
  }

  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  /* ---------------------------------------- HERO */
  function renderHero() {
    $('#hero-sub').textContent = `${META.span_days} 天，${META.total} 条动态`;
    $('#hero-dates').textContent =
      `${META.first_str.replace(/-/g, '.')} — ${META.last_str.replace(/-/g, '.')}`;

    const items = [
      [META.total, '条动态'],
      [META.total_chars.toLocaleString(), '字正文'],
      [META.total_images, '张配图'],
      [META.videos, '条视频投稿'],
    ];
    $('#hero-stats').innerHTML = items
      .map(([v, k]) => `<div class="hs"><b>${v}</b><span>${k}</span></div>`)
      .join('');
  }

  function renderHeader() {
    $('#hd-ro').textContent = `${META.total} 条 · ${META.years.length} 年 · ${META.months.length} 个月`;
    $('#ft-gen').textContent = '数据更新 ' + META.generated_at.slice(0, 10);
    bindAvatar();
  }

  /* ---------------------------------------- 首屏氛围气泡 */
  /**
   * 左右两侧随机浮现的中文短句，纯装饰（容器 pointer-events:none）。
   * 文案不取动态原文，避免「看起来像真数据」的误导——
   * 全部是与她直播/日常语汇同主题的原创短句。
   *
   * 节流三件套：
   *   1. hero 滚出视口 / 页签隐藏时跳过生成（IntersectionObserver 探测）；
   *   2. 同屏气泡数上限，防止 setInterval 链越积越多；
   *   3. prefers-reduced-motion 用户直接不启动。
   * 动画只用 transform/opacity（合成器属性），16 个气泡也不掉帧。
   */
  const HB_TEXTS = [
    '今晚也在直播哟', '宝可梦对战开始', 'FF14 副本集合', '新视频做好了',
    '杂谈回开始啦', '恐怖游戏之夜', '周末愉快', '记得按时喝水',
    '天气转凉添衣', '弹幕热闹起来', '宝可梦大师之路', '旅行计划中',
    '卡比毛茸茸', '剪视频到深夜', '第一次来的人举手', '游戏时间到',
    '期待下一次更新', '冬天想窝被窝', '观众朋友们晚上好', '联动活动进行中',
    '闲聊到很晚', '感谢一路陪伴', '天气不错想出门', '攻略进度百分之八十',
  ];
  // 文案去重（v022）：洗牌后逐条出队，一轮之内 24 条各出现一次、
  // 绝不重复；全部用完再重新洗牌开始下一轮循环。
  let hbPool = [];
  function nextHbText() {
    if (!hbPool.length) {
      hbPool = HB_TEXTS.slice();
      // Fisher-Yates 洗牌：每条出现概率均等，顺序又每次不同
      for (let i = hbPool.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [hbPool[i], hbPool[j]] = [hbPool[j], hbPool[i]];
      }
    }
    return hbPool.pop();
  }

  function startHeroBubbles() {
    const zone = $('#hero-bubbles');
    if (!zone) return;
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // 只在 hero 可见时生成；rootMargin 放宽一点，滚出前就停
    let visible = true;
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; },
      { rootMargin: '12% 0px' }).observe(zone);

    const MAX_ALIVE = 14;                 // 同屏上限
    const SIDE_LO = 2, SIDE_HI = 30;      // 左带 2%~30%
    const SIDE_RL = 70, SIDE_RH = 98;     // 右带 70%~98%

    function spawn() {
      if (visible && !document.hidden) {
        const live = zone.querySelectorAll('.hb').length;
        if (live < MAX_ALIVE) {
          const s = document.createElement('span');
          s.className = 'hb';
          s.textContent = nextHbText();
          // 左右交替起步，再在带内随机：避免长时间偏向一侧
          const left = Math.random() < 0.5;
          const x = left ? SIDE_LO + Math.random() * (SIDE_HI - SIDE_LO)
                         : SIDE_RL + Math.random() * (SIDE_RH - SIDE_RL);
          const dur = 9 + Math.random() * 7;          // 9~16s 走完全程
          const dx = (Math.random() * 2 - 1) * 46;    // 横向漂移 ±46px
          const rot = (Math.random() * 2 - 1) * 3;    // 轻微倾角 ±3deg
          const o = 0.26 + Math.random() * 0.36;      // 峰值透明度 ≤0.62，压不过主体
          s.style.left = x.toFixed(1) + '%';
          s.style.top = (32 + Math.random() * 54).toFixed(1) + '%';
          // v022 字号整体调大一档（12~17px，原 11~16px）：侧带与
          // 中央区有安全间距，词又是 nowrap 绝对定位、zone overflow:hidden，
          // 放大一号不会引起任何布局溢出
          s.style.fontSize = (12 + Math.random() * 5).toFixed(1) + 'px';
          // 约 1/5 的气泡用主题橙，其余用米白，与站点配色呼应
          s.style.color = Math.random() < 0.2 ? 'var(--hiiro-l)' : 'var(--paper)';
          s.style.setProperty('--hb-d', dur.toFixed(1) + 's');
          s.style.setProperty('--hb-delay', (Math.random() * 1.2).toFixed(1) + 's');
          s.style.setProperty('--hb-dx', dx.toFixed(0) + 'px');
          s.style.setProperty('--hb-dy', (-(90 + Math.random() * 70)).toFixed(0) + 'px');
          s.style.setProperty('--hb-rot', rot.toFixed(1) + 'deg');
          s.style.setProperty('--hb-o', o.toFixed(2));
          s.addEventListener('animationend', () => s.remove());
          zone.appendChild(s);
        }
      }
      // 生成节奏 0.7~1.6s 一颗：配合 9~16s 的生命期，
      // 稳态同屏约 10~14 颗，疏密有呼吸感
      setTimeout(spawn, 700 + Math.random() * 900);
    }
    spawn();
  }

  /**
   * 头像兜底：B站图床有防盗链，且本地图可能被误删。
   * 失败时把 .seal 切到 is-broken，露出下面压着的「火羽」印章字，
   * 而不是显示浏览器的破图图标。
   */
  function bindAvatar() {
    const img = $('#brand-avatar');
    if (!img) return;
    const seal = img.closest('.seal');
    const fail = () => { if (seal) seal.classList.add('is-broken'); };

    // 已经加载完但失败（宽高为 0 或 naturalWidth 为 0）——发生在脚本晚于图片加载时
    if (img.complete && img.naturalWidth === 0) { fail(); return; }
    img.addEventListener('error', fail, { once: true });
    // 兜底：srcset 里 2x 失败时部分浏览器不派发 error（直接回退 1x），
    // 用 decode 再确认一次
    if (img.decode) img.decode().catch(fail);
  }

  /* ---------------------------------------- 轮盘 */
  const dial = { R: 0, step: 0, els: [] };

  function buildDial(keepSel) {
    const wrap = $('#dial');
    const core = $('#dial-core');
    const n = monthKeys.length;
    const W = wrap.clientWidth || 620;
    // 69 个月牌要挤在一个圆周上，周长 ≈ 2πR 必须能容纳牌面宽度。
    // 窄屏时牌面缩到 42px，但仍需更大的半径占比，否则相邻牌会互相压叠。
    const ratio = W < 520 ? 0.44 : W < 760 ? 0.40 : 0.365;
    const R = Math.max(W * ratio, 118);

    dial.R = R;
    dial.step = 360 / n;

    const maxN = Math.max(...[...byMonth.values()].map(a => a.length));
    // 心情查表：{ 'YYYY-MM': {mood, mood01} }
    const moodOf = {};
    (META.months || []).forEach(m => { moodOf[m.ym] = m; });

    let html = '';
    monthKeys.forEach((k, i) => {
      const arr = byMonth.get(k);
      const [y, m] = k.split('-');
      const ang = i * dial.step;
      const hot = arr.length >= maxN * 0.72;
      const mr = moodOf[k] || {};
      // mood01 是 0~1 的展布值，决定花朵鲜活度与牌面底色
      const mv = Math.max(0, Math.min(1, mr.mood01 ?? 0.5));
      // 五档花朵：越开心越鲜活（c5 最饱满，c1 最凋败）
      const petal = petalOf(mv);
      const mc = moodColor(mv);
      // 每年 1 月插一根刻度
      if (m === '01') {
        html += `<div class="ysep" style="transform:rotate(${ang}deg) translateY(-${R + 44}px)"></div>`;
      }
      html += `<button class="mcard${hot ? ' hot' : ''}" role="option"
        data-i="${i}" data-mood="${mv.toFixed(3)}"
        title="${y} 年 ${+m} 月 · ${arr.length} 条 · 心情${moodLabel(mv)}"
        style="transform:rotate(${ang}deg) translateY(-${R}px) rotate(${-ang}deg);
               --mv:${mv.toFixed(3)};--mc-rgb:${mc}">
        <span class="beam" aria-hidden="true"></span>
        <img class="mflower" src="assets/images/camellia/c${petal}.png" alt=""
             loading="lazy" draggable="false">
        <span class="my">${y.slice(2)}</span>
        <span class="mm">${pad(+m)}</span>
        <span class="mn">${arr.length}</span>
      </button>`;
    });
    core.innerHTML = html;
    dial.els = $$('.mcard', core);

    dial.els.forEach(el => {
      el.addEventListener('click', e => {
        // 卡片上浮层里的按钮（翻译、展开全文）不应触发月份切换
        if (e.target.closest('.tr,.arc-more,a,button:not(.mcard)')) return;
        selectMonth(+el.dataset.i, true);
        playing = false; syncPlayBtn();
      });
      el.addEventListener('mouseenter', () => showTip(el));
      el.addEventListener('mouseleave', hideTip);
    });

    if (keepSel) rotateTo(curIdx, false);
  }

  // 让当前选中的月份转到正上方
  function rotateTo(idx, animate) {
    const core = $('#dial-core');
    core.style.transition = animate === false ? 'none' : '';
    core.style.transform = `rotate(${-idx * dial.step}deg)`;
    if (animate === false) requestAnimationFrame(() => { core.style.transition = ''; });
    // 椿花只替换内圈装饰环（静态），不跟着月牌转——转的是外圈月牌本身。
  }

  /**
   * 拖拽拨转：按住圆环左右拖动 → 跟手旋转 → 松手吸附到最近月份。
   * 「手机也能转」靠这个实现。要点：
   *   1. touch-action:pan-y（见 CSS）：竖向滚动仍归页面，只有横向手势归圆环；
   *   2. 不 setPointerCapture：否则 pointerup 后 click 的 target 会被
   *      改写到 dial 上，月份牌就点不中了；
   *   3. 位移 ≤5px 视为点击，走 mcard 原有的 click 选月逻辑；
   *   4. 拖拽中用 .dragging 关掉 transition 跟手，松手吸附时恢复。
   */
  function bindDialDrag() {
    // 注意：局部变量叫 dialEl——模块级还有个布局对象 dial（R/step/els），
    // 早年在这里直接用 const dial = $('#dial') 把布局对象遮蔽掉，
    // dial.step 取到 undefined → base=NaN → 旋转赋值静默失败 + 吸附抛错。
    const dialEl = $('#dial'), core = $('#dial-core');
    if (!dialEl || !core) return;
    let drag = null;

    dialEl.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      drag = {
        x: e.clientX, y: e.clientY,
        base: -curIdx * dial.step,
        t: performance.now(),
        moved: 0,
      };
      dialEl.classList.add('is-grab');
    });

    window.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > drag.moved) drag.moved = Math.abs(dx);
      if (drag.moved > 5) core.classList.add('dragging');
      // 弧长换算：整圈 2πR ↔ 360°，再乘 1.8 增益，
      // 短拖动也能得到跟手的转速（不然拖半屏才转一格）。
      const R = dial.R || 240;
      const ang = drag.base + (dx / (2 * Math.PI * R)) * 360 * 1.8;
      core.style.transform = `rotate(${ang}deg)`;
    });

    const endDrag = () => {
      if (!drag) return;
      const m = core.style.transform.match(/-?[\d.]+/);
      const ang = m ? parseFloat(m[0]) : 0;
      // 吸附：取与当前角度最近的月份格
      let idx = Math.round(-ang / dial.step);
      idx = Math.max(0, Math.min(monthKeys.length - 1, idx));
      const clickLike = drag.moved <= 5 && performance.now() - drag.t < 600;
      drag = null;
      core.classList.remove('dragging');
      dialEl.classList.remove('is-grab');
      if (clickLike) return;                 // 当作点击，交给 mcard 的 click
      if (idx !== curIdx) {
        selectMonth(idx, true);
        playing = false; syncPlayBtn();
      } else {
        rotateTo(curIdx, true);              // 没跨格就原地回正
      }
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    // 指针移出窗口时 pointerup 可能收不到，补一个兜底
    window.addEventListener('blur', endDrag);
  }

  /**
   * v028：枢纽里的跑步 GIF。
   *   prefers-reduced-motion → 直接换静态帧（CSS 的全局 reduce 规则
   *     只杀 animation/transition，管不了 GIF 自播，只能在这里换 src）；
   *   GIF 加载失败 → 静态帧兜底 → 再失败才隐藏（枢纽辉光与胶囊不受影响）。
   */
  function loadDcRun() {
    const img = $('#dc-run');
    if (!img) return;
    const still = 'assets/images/hinome-run-still.png';
    const gif = 'assets/images/hinome-run.gif';
    let settled = false;
    img.addEventListener('load', () => { settled = true; });
    img.addEventListener('error', () => {
      if (settled) return;
      if (img.getAttribute('src') !== still) img.src = still;
      else { settled = true; img.style.display = 'none'; }
    });
    img.src = matchMedia('(prefers-reduced-motion: reduce)').matches ? still : gif;
  }

  function selectMonth(idx, animate) {
    idx = Math.max(0, Math.min(monthKeys.length - 1, idx));
    curIdx = idx;
    const k = monthKeys[idx];
    const arr = byMonth.get(k);
    curArr = arr || [];   // 供「日/中」整月徽章与自动轮播读取
    const [y, m] = k.split('-');

    dial.els.forEach((el, i) => el.classList.toggle('sel', i === idx));
    rotateTo(idx, animate);

    $('#dc-ym').textContent = `${y}.${m}`;
    $('#dc-n').textContent = arr.length;

    // 滑轨（轨道左右各留 7px，与 .scrub 的 padding 对齐，避免手柄被裁掉）
    const pct = monthKeys.length > 1 ? (idx / (monthKeys.length - 1)) * 100 : 0;
    $('#scrub-fill').style.width = pct + '%';
    $('#scrub-cur').style.left = `calc(7px + (100% - 14px) * ${pct / 100})`;
    $('#scrub').setAttribute('aria-valuenow', Math.round(pct));

    renderLetter(k, arr);
  }

  function renderLetter(k, arr) {
    // 先把上一个月读到的位置存下来，再重建内容
    const oldLB = $('#letter-body');
    if (letterScrollKey && oldLB) {
      letterScroll.set(letterScrollKey, oldLB.scrollTop);
    }
    letterScrollKey = k;

    const [y, m] = k.split('-');
    const chars = arr.reduce((s, p) => s + p.text.length, 0);
    const imgs = arr.reduce((s, p) => s + p.imgs.length, 0);
    const vids = arr.filter(p => p.video).length;
    const likes = arr.reduce((s, p) => s + p.like, 0);

    $('#lv-ym').textContent = `${y} 年 ${+m} 月`;
    $('#lv-meta').innerHTML =
      `${arr.length} 条 · ${chars.toLocaleString()} 字`
      + (imgs ? ` · ${imgs} 图` : '')
      + (vids ? ` · ${vids} 视频` : '')
      + (likes ? ` · 赞 ${fmtNum(likes)}` : '');

    // 当月心情：一朵小花 + 档位名 + 分位条
    const mr = (META.months || []).find(x => x.ym === k) || {};
    const mvm = Math.max(0, Math.min(1, mr.mood01 ?? 0.5));
    const petal = petalOf(mvm);
    const el = $('#lv-mood');
    if (el) {
      el.innerHTML = `<img class="lm-flower" src="assets/images/camellia/c${petal}.png" alt=""
          style="--mv:${mvm.toFixed(3)}">
        <span class="lm-t">${moodLabel(mvm)}</span>
        <span class="lm-bar"><i style="width:${(13 + mvm * 87).toFixed(1)}%;
          background:linear-gradient(90deg,#6b4a44,rgba(${moodColor(mvm)},1))"></i></span>`;
    }

    // 按日分组。先按 ts 倒序排：信笺本质是「最新动态」列表，
    // 最新的日子排最上面，同一天内也是最新的帖子在最上面。
    // （数据侧 build_site_data.py 按 ts 升序存，这里渲染时再翻过来。）
    const sorted = [...arr].sort((a, b) => b.ts - a.ts);
    const days = new Map();
    sorted.forEach(p => {
      const dk = pad(p.d);
      if (!days.has(dk)) days.set(dk, []);
      days.get(dk).push(p);
    });

    let html = '';
    // 信笺逐条入场：只给每月前 10 个元素排错峰，长月（上百条）
    // 不参与，避免自动轮播每 2.6s 换月时整页都在飘。
    let li = 0;
    const LI_MAX = 10;
    const liCls = () => li < LI_MAX ? ' li-in' : '';
    const liStyle = () => li < LI_MAX ? ` style="--i:${li++}"` : '';
    days.forEach((ps, d) => {
      html += `<div class="day-sep${liCls()}${liStyle()}">${+m}月${+d}日 · 周${WD[ps[0].wd]}</div>`;
      ps.forEach(p => {
        const hasText = p.text.trim().length > 0;
        const on = zhOn.has(p.id);
        html += `<div class="pitem${hasText ? '' : ' blank'}${liCls()}${liStyle()}">`;
        html += `<div class="pt"><span>${fmtTime(p)}</span>`;
        if (p.video) html += `<span class="vt">视频</span>`;
        if (p.like) html += `<span class="lk">♥ ${fmtNum(p.like)}</span>`;
        if (!hasText) html += `<span style="color:var(--paper-4)">（仅图片）</span>`;
        // 翻译按钮在条目右上角
        html += `<span class="pt-r">${tbtn(p)}</span>`;
        html += `</div>`;
        if (hasText) {
          html += `<p class="${on ? 'zh' : ''}" data-body="${p.id}">${esc(bodyText(p))}</p>`;
        }
        if (p.imgs.length) {
          html += `<div class="pimgs">${p.imgs.slice(0, 6)
            .map(f => `<img src="${IMG}${f[0]}" alt="" loading="lazy" data-lb="${IMG}${f[1]}">`)
            .join('')}</div>`;
        }
        if (p.video) {
          html += `<a class="pvid" href="${esc(p.video.url)}" target="_blank" rel="noopener">
            ▶ ${esc(p.video.title || '视频稿件')}
            <span class="bvp">${esc(p.video.bvid)}</span></a>`;
        }
        html += `</div>`;
      });
    });

    $('#letter-body').innerHTML = html;
    // 切月会重建内容，滚动位置随之归零。回到同一个月时恢复上次读到的位置，
    // 免得每切一次月长文都要从头翻。
    const keepY = letterScroll.get(k);
    const LB = $('#letter-body');
    LB.scrollTop = keepY ? Math.min(keepY, LB.scrollHeight) : 0;
    bindLightbox(LB);
    syncLangBadge(arr);
  }

  function trim(s, n) { return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s; }

  /* ---------------------------------------- 播放 */
  let playing = true, speed = 1, timer = null;
  // 指针落在信笺上时自动轮播必须让路，否则读长文时正文会被定时换掉，
  // 滚动位置也跟着丢。只跳过这一拍、不停止计时，移出后自动续上。
  let hoverLetter = false;

  function startPlay() {
    stopPlay();
    const tick = () => {
      if (!playing) return;
      if (hoverLetter) {
        timer = setTimeout(tick, 700);
        return;
      }
      const next = curIdx + 1;
      selectMonth(next >= monthKeys.length ? 0 : next, true);
      timer = setTimeout(tick, 2600 / speed);
    };
    timer = setTimeout(tick, 2600 / speed);
  }
  function stopPlay() { clearTimeout(timer); timer = null; }
  function syncPlayBtn() {
    const b = $('#btn-play');
    b.textContent = playing ? '暂停' : '播放';
    b.setAttribute('aria-pressed', String(playing));
    playing ? startPlay() : stopPlay();
  }

  /* ---------------------------------------- 椭圆词云 */
  /**
   * 为什么要在 JS 里算坐标、而不是靠 CSS flex 排：
   *   需求是「占比越大越靠近中心 + 密集填满椭圆」，这本质是一个
   *   带碰撞的径向布局问题，flex / grid 排不出来。
   *   layoutEllipse（cloud.js）用螺线 + 矩形碰撞做确定性布局，
   *   这里只负责量尺寸、挑颜色、写 DOM。
   */
  // 参考稿风格的多彩横排词。v021 起词云底色去掉、直接落在页面暗底上，
  // 色板从「白底中明度」提亮一档为「暗底高明度」，保持同一组色相。
  // 颜色由词名哈希决定——同一个词永远同一个颜色，且相邻词天然错开，
  // 不会出现按排名渐变的「彩虹条」。
  const CLOUD_COLORS = [
    '#ff6f5e', // 珊瑚红
    '#64a6f2', // 天蓝
    '#57c785', // 草绿
    '#b48cf2', // 亮紫
    '#ffab5c', // 杏橙
    '#f272ab', // 桃粉
    '#43c6c6', // 湖青
  ];
  function cloudColor(w) {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    return CLOUD_COLORS[h % CLOUD_COLORS.length];
  }

  // 字体后到问题：canvas 量宽发生在渲染那一刻，若 Shippori Mincho 还在
  // 下载（display=swap 先用回退 serif 排版），字体换上后字会变宽，
  // 碰撞盒失配 → 词溢出椭圆边界。首排时字体未就绪就排完补排一次。
  let cloudFontRearmed = false;
  function renderCloud() {
    const box = $('#cloud');
    if (!box || !META.top_words || !META.top_words.length) return;

    // 隐藏视图里 offsetWidth 为 0。此时绝不能退回「假定的默认宽度」去排，
    // 否则会把一个按大宽度排好的词云塞进小容器，撑破页面。
    // 直接跳过，等 switchView('stats') 里再补排一次。
    const w = box.offsetWidth;
    if (!w) return;
    const size = Math.min(w, 640);

    // 140 个词 + 收紧间距 + 偏平的 gamma（中尾词更大）才能填满椭圆。
    // 放不下的词会被布局器跳过，宁可少画也不叠字。
    const words = META.top_words.slice(0, 140);
    const laid = layoutEllipse(words, size, {
      ratio: 1.42,
      minSize: size > 420 ? 12 : 10,
      maxSize: size > 420 ? 58 : 40,
      gamma: 1.7,
      fontFamily: '"Shippori Mincho", "Noto Serif SC", serif',
    });

    box.innerHTML = laid.map(o => {
      const k = o.k ?? o.t;
      const col = cloudColor(o.w);
      const cx = (size / 2 + o.x).toFixed(1);
      const cy = (size / (2 * 1.42) + o.y).toFixed(1);
      // 头部词全实色，尾部小词略淡一层，拉开主次但不做径向渐隐
      const op = k >= 0.30 ? 1 : 0.82;
      return `<span class="cw" style="left:${cx}px;top:${cy}px;`
           + `font-size:${o.size}px;color:${col};`
           + `--cw-o:${op}" `
           + `title="${esc(o.w)} · ${o.n} 次">${esc(o.w)}</span>`;
    }).join('');

    if (!cloudFontRearmed && document.fonts && document.fonts.status !== 'loaded') {
      cloudFontRearmed = true;
      document.fonts.ready.then(renderCloud);
    }
  }

  /* ---------------------------------------- 统计 */
  function buildStats() {
    // 月柱
    const bars = $('#bars-month');
    const maxN = Math.max(...META.months.map(m => m.n));
    bars.innerHTML = META.months.map((m, i) => {
      const isJan = m.m === 1;
      return `<div class="bslot${isJan ? ' yr' : ''}" data-i="${i}" title="${m.ym} · ${m.n} 条">
        <i style="height:${Math.max((m.n / maxN) * 100, 1.5)}%"></i></div>`;
    }).join('');
    $('#bar-axis').innerHTML = META.years.map(y => {
      // 定位到该年 1 月在整条轴上的百分比位置
      const i = META.months.findIndex(m => m.y === y.y && m.m === 1);
      const pct = (Math.max(i, 0) / Math.max(META.months.length - 1, 1)) * 100;
      return `<span style="left:${pct}%">${y.y}</span>`;
    }).join('');

    $$('.bslot', bars).forEach(el => {
      el.addEventListener('mouseenter', e => {
        const m = META.months[+el.dataset.i];
        showTipAt(e, `${m.ym} · ${m.n} 条 · ${m.chars} 字`);
      });
      el.addEventListener('mousemove', e => moveTip(e));
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('click', () => {
        const i = monthKeys.indexOf(META.months[+el.dataset.i].ym);
        if (i >= 0) { switchView('ring'); selectMonth(i, true); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      });
    });

    // 年份
    const maxY = Math.max(...META.years.map(y => y.n));
    $('#year-rows').innerHTML = META.years.map(y => `
      <div class="yrow">
        <span class="yy">${y.y}</span>
        <span class="yb"><i style="width:${(y.n / maxY) * 100}%"></i></span>
        <span class="yn">${y.n}</span>
      </div>`).join('');

    // 小时
    const maxH = Math.max(...META.hours);
    $('#hours').innerHTML = META.hours.map((v, h) => `
      <div class="hcol${v === maxH ? ' peak' : ''}" data-h="${h}">
        <i style="height:${Math.max((v / maxH) * 100, 1.5)}%"></i></div>`).join('');
    $('#hour-axis').innerHTML = [0, 6, 12, 18, 23].map(h =>
      `<span style="left:${((h + 0.5) / 24 * 100).toFixed(3)}%">${pad(h)}</span>`
    ).join('');
    $$('.hcol').forEach(el => {
      el.addEventListener('mouseenter', e => {
        const h = +el.dataset.h;
        showTipAt(e, `${pad(h)}:00–${pad(h)}:59 · ${META.hours[h]} 条`);
      });
      el.addEventListener('mousemove', e => moveTip(e));
      el.addEventListener('mouseleave', hideTip);
    });

    // 星期
    const maxW = Math.max(...META.weekdays);
    $('#wds').innerHTML = META.weekdays.map((v, i) => `
      <div class="wd${v === maxW ? ' hi' : ''}"><b>${v}</b><span>周${WD[i]}</span></div>`).join('');

    renderCloud();

    // 排行
    $('#rank-like').innerHTML = META.top_like.map((p, i) => `
      <div class="rk" data-id="${p.id}">
        <span class="rki">${pad(i + 1)}</span>
        <span class="rkt">${esc(clip(p.text, 60) || '（无正文）')}</span>
        <span class="rkn">♥ ${fmtNum(p.like)}</span>
      </div>`).join('');

    $('#rank-long').innerHTML = META.longest.map((p, i) => `
      <div class="rk" data-id="${p.id}">
        <span class="rki">${pad(i + 1)}</span>
        <span class="rkt">${esc(clip(p.text, 60) || '（无正文）')}</span>
        <span class="rkn">${p.chars} 字</span>
      </div>`).join('');

    $$('.rk').forEach(el => {
      el.addEventListener('click', () => jumpToPost(el.dataset.id));
    });
  }

  /* ---------------------------------------- 数据来源标注 */
  /**
   * 站内所有「统计数字」的出处登记表。
   *
   * 新增统计项时先在这里登记、再去渲染处挂徽章——反过来做一定会漏一处。
   * 徽章类名用 .src-chip 而不是 .chip：后者已被 ARCHIVE 的筛选胶囊占用。
   */
  const SOURCES = {
    bili: {
      label: 'B站动态',
      url: 'https://space.bilibili.com/2094031249',
      how: 'UP 主公开发布的动态，自建脚本全量抓取（正文 / 配图 / 视频文案与链接）',
    },
    guardHist: {
      label: 'VTBs',
      url: 'https://vtbs.moe/detail/2094031249',
      how: 'socket.io 事件 bulkGuardCompressed，逐月舰长存量历史序列（2879 条实测观测）',
    },
    guardNow: {
      label: 'B站官方',
      url: 'https://live.bilibili.com/22748536',
      how: '官方公开接口 guardTab/topList 的 data.info.num，免登录',
    },
  };

  function srcChip(key) {
    const s = SOURCES[key];
    if (!s) return '';
    return `<a class="src-chip" href="${esc(s.url)}" target="_blank" rel="noopener"` +
           ` title="${esc(s.how)}">${esc(s.label)}</a>`;
  }

  /** 给各统计卡挂上来源徽章 */
  function renderSources() {
    const set = (id, keys) => {
      const el = $('#' + id);
      if (el) el.innerHTML = keys.map(srcChip).join('');
    };
    // 这几张卡的口径完全一致：都是同一批抓取到的动态算出来的，
    // 所以统一挂「B站动态」一个来源，不必重复标。
    set('src-month', ['bili']);
    set('src-year',  ['bili']);
    set('src-hour',  ['bili']);
    set('src-wd',    ['bili']);
    set('src-cloud', ['bili']);
    set('src-like',  ['bili']);
    set('src-long',  ['bili']);

    // 首屏那几个大数字同样来自抓取的动态，
    // 在数字下面补一行说明，避免截图外传后只剩孤零零的数字。
    const hs = $('#hero-src');
    if (hs && META) {
      hs.innerHTML =
        `统计口径：${META.total} 条公开动态 · ` +
        `覆盖 ${META.first_str} 至 ${META.last_str} · 来源 ` +
        `<a href="https://space.bilibili.com/2094031249" target="_blank" rel="noopener">B站 UP 主个人空间</a>`;
    }

    // 影像页 / 全文页的统计同样要能追到出处
    const fs = $('#film-src');
    if (fs) {
      fs.innerHTML = `影像统计口径：B站投稿中带视频的动态 · 来源 ${srcChip('bili')}`;
    }
    const as = $('#arc-src');
    if (as) {
      as.innerHTML = `全文检索范围：${META ? META.total : '全部'} 条动态正文及中文译文 · 来源 ${srcChip('bili')}`;
    }
    const gs = $('#gal-src');
    if (gs) {
      // 张数交给 #gal-meta（主行），这里只说口径与出处，避免同一数字写两遍
      gs.innerHTML = `图片取自动态附图 · 点开缩略图看原图 · 来源 ${srcChip('bili')}`;
    }
  }

  /* ---------------------------------------- 动态图集（GALLERY） */
  /**
   * 按发布时间倒序，一条动态一组：日期 + 正文摘录 + 该条全部附图。
   * 只渲染 480w 缩略图（lazy loading），点开走全站共用灯箱换 1080w；
   * 年份筛选 chips 用事件委托绑一次，innerHTML 重建不影响。
   * 「看原文」复用 jumpToPost 跳回 RING 页并高亮那条动态。
   */
  let galYear = 'all';
  let galBound = false;
  function buildGallery() {
    const list = $('#gal-list');
    if (!list || !dataOK) return;

    const posts = POSTS.filter(p => p.imgs && p.imgs.length)
                       .sort((a, b) => b.ts - a.ts);
    if (!posts.length) {
      list.innerHTML = '<div class="gal-empty">动态里还没有图片</div>';
      return;
    }

    // 年份筛选：chips 每次重建（保持 active 态正确），
    // 点击监听用委托绑在容器上，只绑一次
    const chips = $('#gal-years');
    const years = [...new Set(posts.map(p => p.y))];
    chips.innerHTML = ['all', ...years].map(y =>
      `<button type="button" class="chip${(String(y) === String(galYear)) ? ' active' : ''}" data-y="${y}">${
        y === 'all' ? '全部' : y + ' 年'}</button>`).join('');

    const shown = galYear === 'all' ? posts : posts.filter(p => p.y === galYear);
    const nImgs = shown.reduce((s, p) => s + p.imgs.length, 0);
    $('#gal-meta').textContent =
      `共 ${nImgs} 张图片 · 来自 ${shown.length} 条动态` +
      (galYear === 'all' ? '' : ` · ${galYear} 年`);

    list.innerHTML = shown.map(p => {
      const raw = (p.zh || p.text || '').replace(/\s+/g, ' ').trim();
      const excerpt = raw.length > 48 ? raw.slice(0, 48) + '…' : raw;
      return `
      <article class="gal-group">
        <header class="gal-cap">
          <time>${p.y}.${pad(p.m)}.${pad(p.d)}</time>
          <span class="gal-cap-txt">${esc(excerpt)}</span>
          <button class="gal-go" type="button" data-id="${p.id}">看原文</button>
        </header>
        <div class="gal-imgs">
          ${p.imgs.map(([th, full]) =>
            `<img loading="lazy" decoding="async"
                  src="assets/images/media/${esc(th)}"
                  data-lb="assets/images/media/${esc(full)}"
                  alt="动态配图 ${p.y}.${pad(p.m)}.${pad(p.d)}">`).join('')}
        </div>
      </article>`;
    }).join('');
    bindLightbox(list);

    if (!galBound) {
      galBound = true;
      chips.addEventListener('click', e => {
        const b = e.target.closest('.chip[data-y]');
        if (!b) return;
        galYear = b.dataset.y === 'all' ? 'all' : +b.dataset.y;
        buildGallery();
      });
      list.addEventListener('click', e => {
        const b = e.target.closest('.gal-go');
        if (b) jumpToPost(b.dataset.id);
      });
    }
  }


  /* ---------------------------------------- 大航海：汇总 + 日度图 + 成员轨道 */
  const nf = n => Number(n).toLocaleString('zh-CN');

  function renderGuard() {
    // guards.json 缺失/解析失败时，整块大航海主题区不能静默空白——
    // 显式说明缺什么、去哪查，而不是留一块莫名的坑。
    const top = $('#gh-top');
    if (!guardsOK || !GUARDS.summary) {
      if (top) top.classList.add('is-empty');
      // 成员轨道同样别留空白舞台：给一句提示，和旧卡片的
      // 「暂未载入」保持同一套说法。
      const track = $('#gd-track');
      if (track && !track.innerHTML.trim()) {
        track.innerHTML = '<div class="gd-empty">成员名单未载入</div>';
      }
      const meta = $('#gd-meta');
      if (meta && !meta.textContent) meta.textContent = '数据缺失';
      return;
    }
    if (top) top.classList.remove('is-empty');
    const s = GUARDS.summary;

    // ---- 汇总数字 ----
    const cls = v => (v > 0 ? 'up' : v < 0 ? 'dn' : '');
    const signed = v => (v > 0 ? '+' : '') + nf(v);
    const items = [
      { v: nf(s.total),               l: '在舰总数', c: '' },
      { v: signed(s.d1 ?? 0),         l: '1 日净增', c: cls(s.d1) },
      { v: signed(s.d7 ?? 0),         l: '7 日净增', c: cls(s.d7) },
      { v: signed(s.d30 ?? 0),        l: '30 日净增', c: cls(s.d30) },
      { v: nf(s.avgMonth ?? 0),       l: '月均存量', c: 'dim' },
    ];
    const nums = $('#gh-nums');
    if (nums) nums.innerHTML = items.map(i =>
      `<div class="gh-n"><b class="${i.c}">${i.v}</b><span>${i.l}</span></div>`).join('');

    // ---- 成员轨道 ----
    renderGuardMembers();

    // ---- 日度走势（窗口由下方拖动块控制）----
    buildGuardDaily();
    bindGuardRange();          // 只绑一次；内部有 guardRangeBound 去重
    updateGuardNote();
  }

  function renderGuardMembers() {
    const track = $('#gd-track');
    if (!track) return;
    const ms = GUARDS.members || [];
    if (!ms.length) {
      track.innerHTML = '<div class="gd-empty">成员名单未载入</div>';
      return;
    }

    // 三张一列：列高被 flex 拉满容器，卡片用 flex:1 均分，
    // 这样无论下方区域多高都排得整齐，不用去算每列该放几张。
    // 顺序即排行榜：数据侧 build_guards_data.py 已按
    // 「陪伴天数降序 → 军衔（总督>提督>舰长）→ uid」排好，
    // 与 data/guards_contribution_rank.csv 同一套键，前端不再重排。
    // 卡片左上角的 #N 是榜上序号；r 是 B站官方返回的序列号（按军衔分段），
    // 与陪伴天数口径不同，只放进 tooltip 作补充。
    const PER_COL = 3;
    const face = m => m.f
      ? `https://i2.hdslb.com/bfs/face/${m.f}`
      : '';
    let html = '';
    for (let i = 0; i < ms.length; i += PER_COL) {
      html += '<div class="gd-col">' +
        ms.slice(i, i + PER_COL).map((m, j) => {
          const no = i + j + 1;
          return `
          <div class="gcard g${m.g}${no <= 3 ? ' top' : ''}"
               title="${esc(m.u)} · 陪伴 ${m.a} 天 · 大航海序列 #${m.r}">
            <img class="gc-face" src="${face(m)}" alt="" loading="lazy"
                 referrerpolicy="no-referrer">
            <div class="gc-body">
              <div class="gc-name"><i class="gc-no">#${no}</i>${esc(m.u)}</div>
              <div class="gc-medal"><i class="gc-lv">${m.l}</i>${esc(m.m)}</div>
              <div class="gc-day">陪伴 ${m.a} 天</div>
            </div>
          </div>`;
        }).join('') +
        '</div>';
    }
    track.innerHTML = html;

    // B站图床有防盗链，referrerpolicy 已经兜了一层；
    // 仍失败时把 img 藏掉，让圆形的底色顶替，别露破图图标。
    track.addEventListener('error', e => {
      const t = e.target;
      if (t && t.tagName === 'IMG') t.style.visibility = 'hidden';
    }, true);

    const meta = $('#gd-meta');
    if (meta) meta.textContent =
      `陪伴天数 TOP ${ms.length} · 共 ${GUARDS.summary.total} 名在舰`;

    bindGuardDrag();
  }

  /**
   * 走势图：柱 = 每日净增（右轴），线 = 在舰总数（左轴）。
   * 显示范围由底部拖动块（guardRange）控制，默认最后 30 天。
   *
   * 为什么非得双轴：总量在 1 → 6913 之间，每日净增在 -50 → +3000 之间。
   * 共用一根轴的话，柱子要么全部贴地看不见，要么把总量线压成一条直线。
   * 两个轴的量纲不同，各自归一化才都看得清。
   */
  function buildGuardDaily() {
    const svg = $('#gh-svg');
    const plot = $('#gh-plot');
    const tip = $('#gh-tip');
    if (!svg || !plot) return;

    const daily = GUARDS.daily || [];
    if (daily.length < 2) { svg.innerHTML = ''; return; }
    const r = ensureGuardRange();
    if (!r) { svg.innerHTML = ''; return; }

    // 窗口切片。首日的净增要跟窗口外的前一天比——
    // 否则每次拖动边界，第一根柱子都会莫名消失或变形。
    const view = daily.slice(r.a, r.b + 1);
    const prevVal = i => (i === 0
      ? (r.a > 0 ? daily[r.a - 1][1] : view[0][1])
      : view[i - 1][1]);
    const deltas = view.map((d, i) => d[1] - prevVal(i));

    // 容器高度是弹性的（跟着 100dvh 走），所以 viewBox 必须按实际像素取，
    // 用固定比例会在大屏上被拉成一张糊掉的图。
    const W = Math.round(plot.clientWidth);
    const H = Math.round(plot.clientHeight);
    if (W < 80 || H < 60) return;

    const padL = 44, padR = 44, padT = 10, padB = 22;
    const pw = W - padL - padR;
    const ph = H - padT - padB;
    const n = view.length;
    const step = pw / n;

    const maxT = Math.max(...view.map(d => d[1]));
    const topT = Math.max(1000, Math.ceil(maxT / 1000) * 1000);
    const minD = Math.min(0, ...deltas);
    const maxD = Math.max(1, ...deltas);

    const yT = v => padT + ph * (1 - v / topT);
    const yD = v => padT + ph * (1 - (v - minD) / (maxD - minD));
    const x = i => padL + (i + 0.5) * step;

    // 左轴网格
    let grid = '';
    for (let k = 0; k <= 4; k++) {
      const v = (topT / 4) * k;
      const y = yT(v);
      grid += `<line class="h-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`;
      grid += `<text class="h-lab" x="${padL - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end">${nf(v)}</text>`;
    }

    // 增量零线（右轴基准）
    const zy = yD(0);
    grid += `<line class="h-zero" x1="${padL}" y1="${zy.toFixed(1)}" x2="${W - padR}" y2="${zy.toFixed(1)}"/>`;
    grid += `<text class="h-lab" x="${W - padR + 8}" y="${(yD(maxD) + 3).toFixed(1)}">+${nf(maxD)}</text>`;
    grid += `<text class="h-lab" x="${W - padR + 8}" y="${(zy + 3).toFixed(1)}">0</text>`;

    // 每日净增柱。高度为 0 的那天不画，否则会铺出一条贴底的脏线
    const bw = Math.max(1, step * 0.62);
    let bars = '';
    deltas.forEach((d, i) => {
      if (!d) return;
      const y1 = yD(d);
      const top = Math.min(zy, y1);
      const h = Math.abs(y1 - zy);
      bars += `<rect class="h-bar${d < 0 ? ' neg' : ''}" x="${(x(i) - bw / 2).toFixed(1)}" ` +
              `y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 0.7).toFixed(1)}"/>`;
    });

    // 总量折线 + 面积
    const line = 'M' + view.map((d, i) => `${x(i).toFixed(1)} ${yT(d[1]).toFixed(1)}`).join('L');
    const base = (padT + ph).toFixed(1);
    const area = `${line}L${x(n - 1).toFixed(1)} ${base}L${x(0).toFixed(1)} ${base}Z`;

    // 里程碑标记：千舰 / 破五千。窗口外的不画。
    // （2000、3000 与 5000 同在 2026-10 那一周，标出来只会糊成一团，故只取首末两个量级）
    let marks = '';
    const want = Math.max(2, Math.floor(pw / 92));
    const every = Math.max(1, Math.round(n / want));
    for (const ms of (GUARDS.summary && GUARDS.summary.milestones) || []) {
      if (ms.target !== 1000 && ms.target !== 5000) continue;
      const gi = daily.findIndex(d => d[0] === ms.date);
      if (gi < r.a || gi > r.b) continue;
      const i = gi - r.a;
      marks += `<circle class="h-mark" cx="${x(i).toFixed(1)}" cy="${yT(view[i][1]).toFixed(1)}" r="3"/>` +
               `<text class="h-mk-t" x="${x(i).toFixed(1)}" y="${(yT(view[i][1]) - 8).toFixed(1)}" ` +
               `text-anchor="${i < n * 0.15 ? 'start' : i > n * 0.85 ? 'end' : 'middle'}">` +
               `${ms.target >= 1000 ? ms.target / 1000 + 'k' : ms.target}</text>`;
    }

    // X 轴标签：按可用宽度决定打几个，避免挤成一团。
    // 首末两个改用左/右对齐——居中的话，边缘标签会有一半探出绘图区被切掉。
    // 跨度超过一年就打「年/月」，否则打「月/日」。
    const fmtX = n > 400
      ? d => d.slice(0, 4) + '/' + d.slice(5, 7)
      : d => d.slice(5).replace('-', '/');
    let xlab = '';
    for (let i = 0; i < n; i += every) {
      const xx = x(i);
      const anchor = i === 0 ? 'start' : xx > W - padR - 30 ? 'end' : 'middle';
      xlab += `<text class="h-lab h-xlab" x="${xx.toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">` +
              `${fmtX(view[i][0])}</text>`;
    }

    // 热区。首尾两块向外扩到画布边缘、纵向撑满画布：
    // 否则最左/最右那 44px（轴间距）是死的，指针明明停在图区却没有反应；
    // 图上方那片空白同理，跟随指针的提示不该挑地方才出现。
    let hits = '';
    for (let i = 0; i < n; i++) {
      const hx = i === 0 ? 0 : padL + i * step;
      const hw = i === 0 ? padL + step
                : i === n - 1 ? W - (padL + i * step)
                : step;
      hits += `<rect class="h-hit" x="${hx.toFixed(1)}" y="0" ` +
              `width="${hw.toFixed(1)}" height="${H}" data-i="${i}"/>`;
    }

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML =
      grid +
      `<path class="h-area" d="${area}"/>` +
      bars +
      `<path class="h-line" d="${line}"/>` +
      marks +
      `<line class="h-cursor" x1="0" y1="${padT}" x2="0" y2="${padT + ph}" opacity="0"/>` +
      `<circle class="h-dot" cx="0" cy="0" r="3.4" opacity="0"/>` +
      xlab + hits;

    const cursor = $('.h-cursor', svg);
    const dot = $('.h-dot', svg);
    const box = () => plot.getBoundingClientRect();

    $$('.h-hit', svg).forEach(el => {
      const i = +el.dataset.i;
      const d = daily[r.a + i];      // 全局下标——tooltip 要显示真实日期
      const dv = deltas[i];

      el.addEventListener('mouseenter', e => {
        const r = box();
        const px = x(i);
        cursor.setAttribute('x1', px.toFixed(1));
        cursor.setAttribute('x2', px.toFixed(1));
        cursor.setAttribute('opacity', '1');
        dot.setAttribute('cx', px.toFixed(1));
        dot.setAttribute('cy', yT(d[1]).toFixed(1));
        dot.setAttribute('opacity', '1');

        const wk = '日一二三四五六'[new Date(d[0] + 'T00:00:00').getDay()];
        tip.innerHTML =
          `${d[0]} 周${wk}<br>` +
          `在舰 <b>${nf(d[1])}</b><br>` +
          `净增 <span class="${dv > 0 ? 't-up' : dv < 0 ? 't-dn' : ''}">` +
          `${dv > 0 ? '+' : ''}${nf(dv)}</span>`;
        tip.hidden = false;

        // 贴着指针放，但推到容器内——否则最左/最右那几天提示会被切掉
        const tw = tip.offsetWidth;
        let lx = e.clientX - r.left;
        lx = Math.min(Math.max(lx, tw / 2 + 4), r.width - tw / 2 - 4);
        tip.style.left = lx + 'px';
        tip.style.top = (e.clientY - r.top) + 'px';
      });
      el.addEventListener('mousemove', e => {
        const r = box();
        const tw = tip.offsetWidth;
        let lx = e.clientX - r.left;
        lx = Math.min(Math.max(lx, tw / 2 + 4), r.width - tw / 2 - 4);
        tip.style.left = lx + 'px';
        tip.style.top = (e.clientY - r.top) + 'px';
      });
      el.addEventListener('mouseleave', () => {
        tip.hidden = true;
        cursor.setAttribute('opacity', '0');
        dot.setAttribute('opacity', '0');
      });
    });
  }

  /* ---------------------------------------- 大航海：范围拖动块 */
  /**
   * 对应 laplace 大航海图里 ECharts dataZoom 的两个实例：
   *   - `type:"inside"`（图内直接拖）→ 这里做成主图区按住左右拖 = 平移窗口
   *   - slider（图下方拖动块）→ 这里就是 #gr-track：双手柄 + 可平移中段
   * 默认窗口与 laplace 一致：`startValue = len-30, endValue = len`。
   *
   * 与成员轨道共用的两条铁律：
   *  1) 纵向滚轮/手势绝不劫持——滑块上 `touch-action:pan-y`，
   *     竖着拖仍然滚页面，横着拖才归滑块。
   *  2) 边界硬 clamp，不做橡皮筋。范围是个离散区间，
   *     拉过头只会让用户以为还能更远（laplace 的 dataZoom 同样 clamp）。
   */
  function ensureGuardRange() {
    const n = (GUARDS && GUARDS.daily || []).length;
    if (n < 2) return null;
    if (!guardRange || guardRange.b > n - 1) {
      const b = n - 1;
      guardRange = { a: Math.max(0, b - 29), b };   // 默认最后 30 天
    }
    return guardRange;
  }

  function setGuardRange(a, b, fromDrag) {
    const n = (GUARDS && GUARDS.daily || []).length;
    if (n < 2) return;
    a = Math.max(0, Math.min(a, n - 1));
    b = Math.max(0, Math.min(b, n - 1));
    if (b < a) { const t = a; a = b; b = t; }
    if (b - a + 1 < GUARD_MIN_WIN) {
      if (fromDrag) return;               // 拖动中到边界直接忽略这一帧
      b = Math.min(n - 1, a + GUARD_MIN_WIN - 1);
    }
    guardRange = { a, b };
    buildGuardDaily();
    layoutGuardRange();
    updateGuardNote();
  }

  /** 刷新拖动块：窗口位置、读数、预设高亮。纯布局，不重新绑事件。 */
  function layoutGuardRange() {
    const track = $('#gr-track');
    const win = $('#gr-win');
    const read = $('#gr-read');
    if (!track || !win) return;
    const daily = GUARDS.daily || [];
    const n = daily.length;
    const r = ensureGuardRange();
    if (!r) return;

    const w = track.clientWidth;
    const lx = (r.a / (n - 1)) * w;
    const rw = Math.max(((r.b - r.a) / (n - 1)) * w, 8);
    win.style.left = lx.toFixed(1) + 'px';
    win.style.width = rw.toFixed(1) + 'px';

    const short = d => d.slice(2).replace('-', '/');
    if (read) {
      read.textContent =
        `${short(daily[r.a][0])} → ${short(daily[r.b][0])} · ${r.b - r.a + 1} 天`;
    }
    track.setAttribute('aria-valuenow', String(Math.round((r.a / (n - 1)) * 100)));
    track.setAttribute('aria-valuetext',
      `${daily[r.a][0]} 至 ${daily[r.b][0]}，共 ${r.b - r.a + 1} 天`);

    $$('#gr-presets button').forEach(btn => {
      const d = +btn.dataset.d;
      const want = d === 0 ? n - 1 : d - 1;
      btn.classList.toggle('on', (r.b - r.a) === want);
    });
  }

  /** 底部说明行：把当前窗口也讲清楚，免得用户以为图还是全量。 */
  function updateGuardNote() {
    const note = $('#gh-note');
    const s = GUARDS && GUARDS.summary;
    if (!note || !s) return;
    const r = ensureGuardRange();
    const daily = GUARDS.daily || [];
    note.textContent =
      `全量 ${s.first} 至 ${s.last} · ${s.spanDays} 天（${s.obsDays} 天有观测）` +
      (r ? ` · 当前显示 ${daily[r.a][0]} 起 ${r.b - r.a + 1} 天` : '') +
      ` · 总督 ${s.governor ?? '—'} / 提督 ${s.colonel ?? '—'} / 舰长 ${s.captain ?? '—'}` +
      ` · 净增柱仅出现在有观测的日子`;
  }

  /**
   * 绑定范围拖动块。整个 STATS 生命周期只绑一次——
   * resize 时只调 layoutGuardRange() 重排，绝不重新 addEventListener。
   */
  function bindGuardRange() {
    const track = $('#gr-track');
    const svg = $('#gr-svg');
    const win = $('#gr-win');
    const hl = $('#gr-hl');
    const hr = $('#gr-hr');
    const mid = $('#gr-mid');
    if (!track || !svg || !win || guardRangeBound) return;

    const daily = GUARDS.daily || [];
    const n = daily.length;
    if (n < 2) return;
    guardRangeBound = true;

    /* ---- 缩略图：全量序列的面积 + 线（laplace dataBackground 等价物） ---- */
    function paintOverview() {
      const W = Math.round(track.clientWidth);
      const H = 34;
      if (W < 40) return;
      const maxV = Math.max(...daily.map(d => d[1]));
      const x = i => (i / (n - 1)) * W;
      const y = v => H - 3 - (v / maxV) * (H - 9);
      const line = 'M' + daily.map((d, i) => `${x(i).toFixed(1)} ${y(d[1]).toFixed(1)}`).join('L');
      const area = `${line}L${x(n - 1).toFixed(1)} ${H}L0 ${H}Z`;
      // 年份刻度：1 月 1 日各一道
      let ticks = '';
      for (let i = 0; i < n; i++) {
        if (daily[i][0].slice(5) === '01-01' || i === 0) {
          const xx = x(i).toFixed(1);
          ticks += `<line class="gr-tick" x1="${xx}" y1="0" x2="${xx}" y2="${H}"/>` +
                   `<text class="gr-tick-t" x="${(+xx + 3).toFixed(1)}" y="9">${daily[i][0].slice(0, 4)}</text>`;
        }
      }
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML =
        `<path class="gr-area" d="${area}"/><path class="gr-line" d="${line}"/>` + ticks;
    }
    paintOverview();
    layoutGuardRange();

    /* ---- 指针交互：手柄 / 中段 / 轨道点击 ---- */
    let mode = null;      // 'l' | 'mid' | 'r'
    let pid = null;
    let startX = 0, startA = 0, startB = 0;

    const idxFromX = clientX => {
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      const t = (clientX - rect.left) / rect.width;
      return Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))));
    };

    function begin(e, m) {
      if (e.button !== undefined && e.button !== 0) return;
      const r = ensureGuardRange();
      mode = m; pid = e.pointerId;
      startX = e.clientX; startA = r.a; startB = r.b;
      win.classList.add('drag');
      try { e.currentTarget.setPointerCapture(pid); } catch (_) {}
    }

    function move(e) {
      if (!mode || e.pointerId !== pid) return;
      const per = track.clientWidth / (n - 1);   // 一个下标 = 多少像素
      if (per <= 0) return;
      const di = Math.round((e.clientX - startX) / per);
      if (mode === 'mid') {
        const span = startB - startA;
        const a = Math.min(Math.max(0, startA + di), n - 1 - span);
        if (a !== guardRange.a) setGuardRange(a, a + span, true);
      } else if (mode === 'l') {
        const a = Math.max(0, Math.min(startA + di, startB - GUARD_MIN_WIN));
        if (a !== guardRange.a) setGuardRange(a, guardRange.b, true);
      } else {
        const b = Math.min(n - 1, Math.max(startB + di, startA + GUARD_MIN_WIN));
        if (b !== guardRange.b) setGuardRange(guardRange.a, b, true);
      }
    }

    function end(e) {
      if (!mode) return;
      if (e && e.pointerId !== undefined && e.pointerId !== pid) return;
      try {
        if (pid !== null && e && e.currentTarget &&
            e.currentTarget.releasePointerCapture) {
          e.currentTarget.releasePointerCapture(pid);
        }
      } catch (_) {}
      mode = null; pid = null;
      win.classList.remove('drag');
    }

    hl.addEventListener('pointerdown', e => begin(e, 'l'));
    hr.addEventListener('pointerdown', e => begin(e, 'r'));
    mid.addEventListener('pointerdown', e => begin(e, 'mid'));
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', () => { if (mode) end({}); });

    // 点轨道空白处：把窗口中心挪到点击处，并允许按住继续拖
    track.addEventListener('pointerdown', e => {
      if (e.target === hl || e.target === hr || e.target === mid) return;
      const i = idxFromX(e.clientX);
      const r = ensureGuardRange();
      const half = Math.floor((r.b - r.a) / 2);
      setGuardRange(i - half, i - half + (r.b - r.a));
      begin(e, 'mid');
    });

    /* ---- 预设 ---- */
    $$('#gr-presets button').forEach(btn => {
      btn.addEventListener('click', () => {
        const d = +btn.dataset.d;
        // 「30天」= 30 个点，故 b-a = d-1；「全部」= 全量 n 个点。
        const span = d === 0 ? n - 1 : d - 1;
        setGuardRange(n - 1 - span, n - 1);
      });
    });

    /* ---- 键盘 ---- */
    track.addEventListener('keydown', e => {
      const r = ensureGuardRange();
      const span = r.b - r.a;
      const step = e.shiftKey ? 7 : 1;
      let a = r.a, b = r.b, hit = true;
      if (e.key === 'ArrowLeft') { a -= step; b -= step; }
      else if (e.key === 'ArrowRight') { a += step; b += step; }
      else if (e.key === 'Home') { a = 0; b = span; }
      else if (e.key === 'End') { b = n - 1; a = n - 1 - span; }
      else if (e.key === '+' || e.key === '=') { b = Math.min(n - 1, b + step); a = Math.max(0, a - step); }
      else if (e.key === '-' || e.key === '_') { b = Math.max(a + GUARD_MIN_WIN - 1, b - step); a = Math.min(b - GUARD_MIN_WIN + 1, a + step); }
      else hit = false;
      if (hit) { e.preventDefault(); setGuardRange(a, b); }
    });

    /* ---- 主图区内按住左右拖 = 平移窗口（inside zoom 的拖拽等价物） ---- */
    const plot = $('#gh-plot');
    if (plot) {
      let pPid = null, pX = 0, pA = 0, pB = 0, pMoved = 0;
      plot.addEventListener('pointerdown', e => {
        if (e.pointerType === 'touch') return;   // 触摸留给 tooltip / 页面
        if (e.button !== 0) return;
        const r = ensureGuardRange();
        pPid = e.pointerId; pX = e.clientX; pA = r.a; pB = r.b; pMoved = 0;
        plot.classList.add('panning');
        try { plot.setPointerCapture(pPid); } catch (_) {}
      });
      plot.addEventListener('pointermove', e => {
        if (pPid === null || e.pointerId !== pPid) return;
        const dx = e.clientX - pX;
        if (Math.abs(dx) > pMoved) pMoved = Math.abs(dx);
        if (pMoved < 4) return;
        const tip = $('#gh-tip');
        if (tip) tip.hidden = true;
        const stepPx = plot.clientWidth / Math.max(1, pB - pA);
        const di = -Math.round(dx / stepPx);
        if (!di) return;
        const span = pB - pA;
        const a = Math.min(Math.max(0, pA + di), n - 1 - span);
        if (a !== guardRange.a) setGuardRange(a, a + span, true);
      });
      const pEnd = e => {
        if (pPid === null) return;
        if (e && e.pointerId !== undefined && e.pointerId !== pPid) return;
        try { plot.releasePointerCapture(pPid); } catch (_) {}
        pPid = null;
        plot.classList.remove('panning');
      };
      plot.addEventListener('pointerup', pEnd);
      plot.addEventListener('pointercancel', pEnd);
    }

    /* ---- resize 只重排，不重绑 ---- */
    const relayout = () => { paintOverview(); layoutGuardRange(); };
    guardRangeRelayout = relayout;
    window.addEventListener('resize', debounce(relayout, 200));
  }

  /**
   * 成员轨道的拖动。
   *
   * 三条原则：
   *  1) **只接管鼠标/笔，触摸交给浏览器**。触摸走原生 overflow 滚动才有惯性、
   *     才有正确的方向判定；自己拿 JS 模拟触摸平移，手感一定比原生差。
   *  2) **越界用 transform 做橡皮筋**，而不是硬改 scrollLeft——scrollLeft
   *     没有负值，到头就是不动，用户得不到"已经到底了"的反馈。
   *  3) **滚轮不接管**。横向容器如果吃掉纵向滚轮，用户在卡片区就滚不动页面，
   *     这是这类组件最常见、也最招人烦的坏味道。
   */
  function bindGuardDrag() {
    const view = $('#gd-view');
    const stage = $('.gd-stage');
    const track = $('#gd-track');
    const prog = $('#gd-prog');
    if (!view || !track) return;

    let dragging = false, pid = null;
    let startX = 0, startScroll = 0, moved = 0, suppressClick = false;

    const maxScroll = () => Math.max(0, view.scrollWidth - view.clientWidth);

    function syncEdges() {
      const max = maxScroll();
      const x = view.scrollLeft;
      stage.classList.toggle('at-start', x <= 1);
      stage.classList.toggle('at-end', x >= max - 1);
      if (prog) prog.style.width = max > 0 ? ((x / max) * 100).toFixed(2) + '%' : '100%';
    }

    view.addEventListener('scroll', syncEdges, { passive: true });
    window.addEventListener('resize', debounce(syncEdges, 200));
    guardSync = syncEdges;

    view.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') return;   // 触摸留给原生滚动
      if (e.button !== 0) return;
      dragging = true; moved = 0;
      startX = e.clientX;
      startScroll = view.scrollLeft;
      pid = e.pointerId;
      view.classList.add('is-drag');
      track.classList.remove('snap');          // 拖拽中不能有过渡，否则发飘

      // 【关键】鼠标拖拽期间把 touch-action 关掉。
      // CSS 里写的是 pan-x pan-y（为了触摸时浏览器能判方向）。
      // 但 Chromium 对鼠标同样会拿它做手势判定：按住拖动一晃，
      // 就认为这是"平移"，立刻派发 pointercancel —— 拖动链断掉，
      // 表现为按住能拖一两下然后突然失灵。
      // 在 pointerdown 这一帧内改掉还来得及，手势尚未锁定。
      view.style.touchAction = 'none';
      // 同时压掉默认行为：否则长按拖动会顺手选中卡片上的名字
      e.preventDefault();
      try { view.setPointerCapture(pid); } catch (_) {}
    });

    view.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > moved) moved = Math.abs(dx);

      const max = maxScroll();
      const want = startScroll - dx;

      if (want < 0) {
        view.scrollLeft = 0;
        track.style.transform = `translateX(${(-want * 0.34).toFixed(1)}px)`;
      } else if (want > max) {
        view.scrollLeft = max;
        track.style.transform = `translateX(${((want - max) * 0.34).toFixed(1)}px)`;
      } else {
        view.scrollLeft = want;
        track.style.transform = '';
      }
    });

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      view.classList.remove('is-drag');
      // 松手立刻把 touch-action 还回去。否则这个区域以后再也收不到
      // 触摸滚动手势——手机用户会完全滑不动。
      view.style.touchAction = '';
      if (pid !== null) { try { view.releasePointerCapture(pid); } catch (_) {} pid = null; }

      // 先把 transition 打开再清 transform，同一帧内浏览器才会从
      // 当前位移过渡回原位；顺序反了就是直接跳回去，没有回弹感。
      track.classList.add('snap');
      track.style.transform = '';
      setTimeout(() => track.classList.remove('snap'), 400);

      if (moved > 6) {
        suppressClick = true;
        const gd = $('#gd');
        if (gd) gd.classList.add('used');
      }
      syncEdges();
    }

    view.addEventListener('pointerup', endDrag);
    view.addEventListener('pointercancel', endDrag);
    // 鼠标移出窗口时 pointerup 可能收不到，补一个兜底
    window.addEventListener('pointerup', () => { if (dragging) endDrag(); });
    window.addEventListener('blur', () => { if (dragging) endDrag(); });

    // 拖完抑制那一次 click，避免"想拖动结果点开了卡片"
    view.addEventListener('click', e => {
      if (suppressClick) {
        e.preventDefault(); e.stopPropagation();
        suppressClick = false;
      }
    }, true);

    // 键盘可达：方向键 / Home / End
    view.addEventListener('keydown', e => {
      const s = view.clientWidth * 0.85;
      if (e.key === 'ArrowRight') { view.scrollBy({ left: s, behavior: 'smooth' }); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { view.scrollBy({ left: -s, behavior: 'smooth' }); e.preventDefault(); }
      else if (e.key === 'Home') { view.scrollTo({ left: 0, behavior: 'smooth' }); e.preventDefault(); }
      else if (e.key === 'End') { view.scrollTo({ left: maxScroll(), behavior: 'smooth' }); e.preventDefault(); }
    });

    syncEdges();
  }

  function jumpToPost(id) {
    const p = POSTS.find(x => x.id === id);
    if (!p) return;
    switchView('ring');
    const i = monthKeys.indexOf(p.y + '-' + pad(p.m));
    selectMonth(i, true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // 定位到信笺里对应的条目
    setTimeout(() => {
      const items = $$('#letter-body .pitem');
      const target = items.find(el => el.querySelector('.pt') &&
        el.querySelector('.pt span').textContent === fmtTime(p) &&
        el.textContent.includes(p.text.slice(0, 12)));
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.style.transition = 'background .4s';
        target.style.background = 'rgba(216,65,44,.14)';
        setTimeout(() => { target.style.background = ''; }, 1600);
      }
    }, 620);
  }

  /* ---------------------------------------- 影像（视频页） */
  /**
   * 页面定位：不只是「列出视频」，而是能看、能留档。
   *   看——点卡片就地展开 B 站官方 iframe；不跳站，不打断浏览节奏。
   *   留——「录制」把卡片渲染成 PNG（canvas 手绘封面 + 标题 + 日期）。
   *
   * 为什么录制要走 canvas 手绘而不是 html2canvas：
   *   项目不引第三方库（首屏体积被字体坑过一次），而且 html2canvas
   *   对外部字体和 backdrop-filter 的还原很差。手绘虽然朴素，
   *   但版式完全可控、零依赖，且能稳定输出 1080 宽的图。
   */
  let films = [];
  let filmYear = 'all';
  let filmSort = 'new';
  let filmOn = null;   // 当前展开的视频 id
  // 「重试」按下后跳过网络预检直接注入 iframe（见 showFilmFallback）
  let filmSkipPrecheck = false;

  function buildFilm() {
    // 只留有内容的视频。顺序由排序决定，编号按「最新在前」固定，
    // 与排序解耦，避免用户切排序后编号乱跳。
    films = POSTS
      .filter(p => p.video && p.video.bvid)
      .sort((a, b) => b.ts - a.ts)
      .map((p, i) => ({
        no: i + 1,
        id: p.id,
        ts: p.ts,
        title: p.video.title || '（无标题）',
        bvid: p.video.bvid,
        cover: p.video.cover,
        duration: p.video.duration || '',
        like: p.like || 0,
        cmt: p.cmt || 0,
        y: p.y,
        m: p.m,
        d: p.d,
        text: p.text || '',
      }));

    // 顶部统计
    const years = [...new Set(films.map(v => v.y))].sort();
    const totalLike = films.reduce((s, v) => s + v.like, 0);
    $('#film-stat').innerHTML = `
      <div><b class="fs-n">${films.length}</b><span class="fs-l">影像</span></div>
      <div><b class="fs-n">${years.length}</b><span class="fs-l">年份</span></div>
      <div><b class="fs-n">${fmtNum(totalLike)}</b><span class="fs-l">总点赞</span></div>`;

    // 年份筛选
    const cnt = y => films.filter(v => v.y === y).length;
    $('#film-years').innerHTML =
      `<button class="fy active" data-y="all">全部<i>${films.length}</i></button>` +
      years.map(y => `<button class="fy" data-y="${y}">${y}<i>${cnt(y)}</i></button>`).join('');

    $$('#film-years .fy').forEach(b => b.addEventListener('click', () => {
      $$('#film-years .fy').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      filmYear = b.dataset.y;
      renderFilmGrid();
    }));

    // 排序
    $$('.seg-b').forEach(b => b.addEventListener('click', () => {
      $$('.seg-b').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      filmSort = b.dataset.sort;
      renderFilmGrid();
    }));

    bindFilmStage();
    renderFilmGrid();
  }

  function filmVisible() {
    const list = filmYear === 'all' ? films.slice() : films.filter(v => v.y === +filmYear);
    if (filmSort === 'hot') list.sort((a, b) => b.like - a.like);
    else if (filmSort === 'old') list.sort((a, b) => a.ts - b.ts);
    else list.sort((a, b) => b.ts - a.ts);
    return list;
  }

  function renderFilmGrid() {
    const list = filmVisible();
    const grid = $('#film-grid');
    $('#film-empty').hidden = list.length > 0;

    grid.innerHTML = list.map(v => `
      <button class="fcell${filmOn === v.id ? ' on' : ''}" type="button"
              data-id="${v.id}" data-no="${v.no}"
              aria-label="播放：${esc(v.title)}">
        <span class="fc-thumb">
          <img src="assets/images/media/${esc(v.cover)}" alt=""
               decoding="async" fetchpriority="low"
               onerror="this.style.opacity=0">
          <span class="fc-no">${pad(v.no)}</span>
          ${v.duration ? `<span class="fc-time">${esc(v.duration)}</span>` : ''}
          <span class="fc-play" aria-hidden="true">
            <i><svg viewBox="0 0 12 14" width="11" height="12" aria-hidden="true">
              <path d="M1 1.4v11.2L11 7z" fill="#1a0b07"/></svg></i>
          </span>
        </span>
        <span class="fc-body">
          <span class="fc-title">${esc(v.title)}</span>
          <span class="fc-foot">
            <span class="fc-date">${v.y}.${pad(v.m)}.${pad(v.d)}</span>
            <span class="fc-like">♥ ${fmtNum(v.like)}</span>
          </span>
        </span>
        <span class="fc-rec" role="button" tabindex="0"
              data-rec="${v.id}" aria-label="录制这一格" title="录制为图片">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="5.2" stroke="currentColor" stroke-width="1.6"/>
            <circle cx="8" cy="8" r="2.1" fill="currentColor"/>
          </svg>
        </span>
      </button>`).join('');

    grid.querySelectorAll('.fcell').forEach(el => {
      el.addEventListener('click', e => {
        // 录制按钮在卡片内部，点它时不能顺带触发播放
        if (e.target.closest('[data-rec]')) return;
        openFilm(el.dataset.id);
      });
    });

    grid.querySelectorAll('[data-rec]').forEach(b => {
      const run = e => {
        e.preventDefault(); e.stopPropagation();
        const id = b.dataset.rec;
        const v = films.find(x => x.id === id);
        if (v) recordOne(v);
      };
      b.addEventListener('click', run);
      b.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') run(e);
      });
    });
  }

  function bindFilmStage() {
    $('#fs-close').addEventListener('click', closeFilm);
    $('#fs-shot').addEventListener('click', () => {
      const v = films.find(x => x.id === filmOn);
      if (v) recordOne(v);
    });
    $('#film-rec-all').addEventListener('click', () => {
      recordList(filmVisible());
    });
  }

  function openFilm(id) {
    const v = films.find(x => x.id === id);
    if (!v) return;
    filmOn = id;

    const stage = $('#film-stage');
    $('#fs-title').textContent = v.title;
    $('#fs-meta').textContent =
      `${v.y}.${pad(v.m)}.${pad(v.d)} · ${v.duration || '—'} · ♥ ${fmtNum(v.like)} · ${v.bvid}`;
    $('#fs-open').href = `https://www.bilibili.com/video/${v.bvid}`;
    // 底部常驻出口同步指向同一支（iframe 被屏蔽时用户唯一的退路）
    const noteGo = $('#fs-note-open');
    if (noteGo) noteGo.href = `https://www.bilibili.com/video/${v.bvid}`;

    // 站内跳转时用 iframe 内嵌；参考 B 站官方分享的 player 页，
    // 不带 autoplay，避免用户没准备好就被声音撞到。
    //
    // 实测（2026-10-20，Chromium 有头/无头均验证）：
    //  - player.bilibili.com **不返回** X-Frame-Options / frame-ancestors，
    //    官方允许嵌入；带 bvid 的地址能自己解析 cid 并拉到 playurl。
    //  - 但在真实浏览器里仍可能整片空白。三种宿主环境原因：
    //      a) 隐私类扩展（uBlock / AdGuard / Privacy Badger）屏蔽了
    //         player.bilibili.com 或其 API 子请求；
    //      b) 浏览器拦截第三方 Cookie / 存储（Chrome 第三方 Cookie 淘汰、
    //         Safari 防跨站追踪、Edge 跟踪防护）→ 播放器拿不到票据；
    //      c) 网络策略屏蔽了 bilibili CDN 域名。
    //    代码修不了环境，但要把「静默白屏」变成「明说的出口卡」。
    //
    // 关键坑（2026-10-20 补测证实）：请求被屏蔽时，iframe 的 **load 事件
    // 照样触发**——浏览器把错误页渲染进 iframe 框里。所以「N 秒没 load
    // 就换卡」的兜底在硬屏蔽场景下**完全失效**，用户看到的就是一片白。
    // 对策：注入 iframe 之前先发一次 no-cors 预检（precheckBili），
    // 网络层不通就直接换卡，不喂空白 iframe。
    //
    // 另有一个纯代码坑：协议相对地址 `//player.bilibili.com` 在 file:// 下
    // 会解析成 file://player.bilibili.com/...，永远加载失败 → 画框纯白。
    // 所以显式写明 https:（B 站只走 https）。
    const fileProto = location.protocol === 'file:';
    if (fileProto) {
      // file:// 下 iframe 一定不通（跨协议 + 无 referer），
      // 直接不给空 iframe，改成一张明确的出口卡，别让用户对着白屏等。
      showFilmFallback(v, '当前以本地文件方式打开，内嵌播放器不可用：浏览器会拦截跨协议的嵌入请求。');
    } else {
      const frame = $('#fs-frame');
      const playerUrl =
        `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(v.bvid)}` +
        `&page=1&danmaku=0&autoplay=0`;

      const inject = () => {
        frame.innerHTML =
          `<iframe src="${playerUrl}"`
          + ` allowfullscreen="true" scrolling="no" frameborder="0"` +
          // sandbox 只放**合法**标志位。注意 allow-fullscreen 并不在 HTML 规范的
          // sandbox token 表里——Chrome 会直接报
          // 「Error while parsing the 'sandbox' attribute」。
          // 全屏由上面的 allowfullscreen 属性管（规范里它已重定义为
          // permissions policy 的 fullscreen），不占 sandbox 的位。
          // allow-storage-access-by-user-activation：第三方 Cookie 被禁的环境里，
          // 播放器要靠它在用户点击后申请存储访问，否则直接摆烂。
          ` sandbox="allow-scripts allow-same-origin allow-popups allow-presentation ` +
          `allow-storage-access-by-user-activation"` +
          ` referrerpolicy="no-referrer-when-downgrade"` +
          ` title="${esc(v.title)}"></iframe>`;

        // 加载超时兜底：load 一直不触发 = 网络黑洞（请求既没成功也没失败）。
        // iframe 的 error 事件在这些场景下不可靠（多数时候静默），
        // 所以用「N 秒内没 load 就换卡」这个笨但确定能兜住的判据。
        const ifr = frame.querySelector('iframe');
        if (ifr) {
          const timer = setTimeout(() => {
            if (!ifr.dataset.loaded) {
              showFilmFallback(v, '播放器加载超时。可能是隐私扩展屏蔽了 B 站播放器，或网络无法访问 bilibili.com。');
            }
          }, 8000);
          ifr.addEventListener('load', () => {
            ifr.dataset.loaded = '1';
            clearTimeout(timer);
          });
        }
      };

      // 预检通过 / 用户点「重试」跳过预检 → 注入
      if (filmSkipPrecheck) {
        filmSkipPrecheck = false;
        frame.innerHTML = '<div class="fs-loading">播放器加载中…</div>';
        inject();
      } else {
        frame.innerHTML = '<div class="fs-loading">播放器加载中…</div>';
        precheckBili(playerUrl).then(reachable => {
          // 预检期间用户可能已切换/关闭了别的片，别往旧舞台上写
          if (filmOn !== id) return;
          if (reachable) {
            inject();
          } else {
            showFilmFallback(v,
              '无法访问 player.bilibili.com。可能是隐私扩展屏蔽了 B 站，' +
              '或当前网络到不了 bilibili.com。可点「重试」再试，或直接去 B 站看。');
          }
        });
      }
    }

    stage.hidden = false;
    // 高亮当前格
    $$('#film-grid .fcell').forEach(el =>
      el.classList.toggle('on', el.dataset.id === id));

    // 播放器在页面下方时，滚到它，避免用户以为没反应
    const hd = document.querySelector('.hd');
    const top = stage.getBoundingClientRect().top + window.scrollY
      - (hd ? hd.offsetHeight : 0) - 12;
    window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
  }

  /** 播放器的出口卡：iframe 不可用 / 预检失败 / 加载超时时替换画框内容。 */
  function showFilmFallback(v, reason) {
    $('#fs-frame').innerHTML = `
      <div class="fs-fallback">
        <b>内嵌播放器不可用</b>
        <p>${esc(reason)}</p>
        <div class="fs-fb-btns">
          <button class="film-btn" type="button" id="fs-retry">重试内嵌播放</button>
          <a class="film-btn ghost" href="https://www.bilibili.com/video/${encodeURIComponent(v.bvid)}"
             target="_blank" rel="noopener">在新窗口打开这一支 →</a>
        </div>
      </div>`;
    // 重试 = 跳过预检直接注入。预检说不通、用户仍想试试的场合
    // （比如扩展拦了 fetch 但没拦 iframe），不能让预检把路堵死。
    const retry = $('#fs-retry');
    if (retry) retry.addEventListener('click', () => {
      filmSkipPrecheck = true;
      openFilm(v.id);
    });
  }

  /**
   * 注入 iframe 前的网络预检。
   *
   * 为什么需要：请求被屏蔽时 iframe 的 load 事件**照样触发**（浏览器把
   * 错误页渲染进框里），靠 load/超时判定会漏掉整类硬屏蔽，用户看到白屏。
   * no-cors  fetch 只探「网络层通不通」：通 → resolve（opaque 响应），
   * 不通（DNS / 连接失败 / 扩展拦截）→ reject。拿不到内容也不需要——
   * 内容对不对由播放器自己负责，我们只保证不喂空白框。
   */
  function precheckBili(url, ms = 6000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    return fetch(url, { mode: 'no-cors', credentials: 'omit', signal: ac.signal })
      .then(() => true)
      .catch(() => false)
      .finally(() => clearTimeout(timer));
  }

  function closeFilm() {
    filmOn = null;
    filmSkipPrecheck = false;
    $('#film-stage').hidden = true;
    // 必须清空 iframe：只 hidden 的话视频还在后台播
    $('#fs-frame').innerHTML = '';
    $$('#film-grid .fcell').forEach(el => el.classList.remove('on'));
  }

  /* ---- 录制：把一格渲染成 PNG ---- */

  // 圆角矩形路径
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // canvas 不会自动换行，中文需要按宽度逐字断行
  function wrapCJK(ctx, text, maxW, maxLines) {
    const lines = [];
    let cur = '';
    for (const ch of text) {
      const t = cur + ch;
      if (ctx.measureText(t).width > maxW && cur) {
        lines.push(cur);
        cur = ch;
        if (lines.length === maxLines) break;
      } else cur = t;
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    // 截断时补省略号
    if (lines.length === maxLines) {
      const last = lines[maxLines - 1];
      if (ctx.measureText(last).width > maxW - ctx.measureText('…').width) {
        let l = last;
        while (l && ctx.measureText(l + '…').width > maxW) l = l.slice(0, -1);
        lines[maxLines - 1] = l + '…';
      }
    }
    return lines;
  }

  const SER = '"Yu Mincho","Hiragino Mincho ProN","Songti SC","STSong",serif';
  const MON = '"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace';

  /**
   * 画一张 1080 宽的「胶片格」。
   * 封面图若加载失败（file:// 或图被删）就退化成纯色块 + 标题，
   * 不让整个录制失败。
   */
  async function drawCell(v, opts = {}) {
    const W = opts.width || 1080;
    const H = Math.round(W * 9 / 16);
    // 尺寸全按 W 等比算；但缩略图不能等比压到看不清，
    // 用 K 做一个有下限的补偿（最小 0.62，即 480 宽时按 0.62 的比例算字号）
    const K = Math.max(0.62, W / 1080);
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');

    // 底：暗红褐
    ctx.fillStyle = '#100806';
    ctx.fillRect(0, 0, W, H);

    // 封面铺满并裁切
    let img = null;
    try {
      img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('cover'));
        im.src = `assets/images/media/${v.cover}`;
      });
    } catch (_) { /* 无封面也能画 */ }

    if (img) {
      const s = Math.max(W / img.width, H / img.height);
      const dw = img.width * s, dh = img.height * s;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      // 压暗：底部必须够深，否则标题压在浅色画面上读不清。
      // 上限到 .97 是因为最坏情况是白底封面，只有够深才能保证对比度。
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(16,8,6,.34)');
      g.addColorStop(.34, 'rgba(16,8,6,.06)');
      g.addColorStop(.58, 'rgba(16,8,6,.42)');
      g.addColorStop(.82, 'rgba(16,8,6,.86)');
      g.addColorStop(1, 'rgba(16,8,6,.98)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    const PAD = W * 0.052;

    // 左上编号
    ctx.font = `500 ${W * 0.019 * K}px ${MON}`;
    const no = pad(v.no);
    const noW = ctx.measureText(no).width + W * 0.026 * K;
    const noH = W * 0.036 * K;
    ctx.fillStyle = 'rgba(255,90,46,.94)';
    rr(ctx, PAD, PAD, noW, noH, W * 0.004);
    ctx.fill();
    ctx.fillStyle = '#1a0b07';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(no, PAD + noW / 2, PAD + noH / 2 + 1);

    // 右上时长
    if (v.duration) {
      ctx.font = `500 ${W * 0.019 * K}px ${MON}`;
      const dw2 = ctx.measureText(v.duration).width + W * 0.026 * K;
      ctx.fillStyle = 'rgba(16,8,6,.78)';
      rr(ctx, W - PAD - dw2, PAD, dw2, noH, W * 0.004);
      ctx.fill();
      ctx.fillStyle = '#f7ece4';
      ctx.fillText(v.duration, W - PAD - dw2 / 2, PAD + noH / 2 + 1);
    }

    // 右下文字块
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // 日期行
    ctx.font = `500 ${W * 0.019 * K}px ${MON}`;
    ctx.fillStyle = 'rgba(201,179,168,.92)';
    const dateStr = `${v.y}.${pad(v.m)}.${pad(v.d)}`;
    ctx.fillText(dateStr, PAD, H - PAD - W * 0.108 * K);

    // 标题（最多两行）
    const maxW = W - PAD * 2 - W * 0.02;
    ctx.font = `600 ${W * 0.036 * K}px ${SER}`;
    ctx.fillStyle = '#fff8f4';
    // 投影兜底：即使封面是纯白（有这种封面），标题也压得住
    ctx.shadowColor = 'rgba(10,5,4,.92)';
    ctx.shadowBlur = W * 0.018 * K;
    ctx.shadowOffsetY = W * 0.002 * K;
    const lines = wrapCJK(ctx, v.title, maxW, 2);
    lines.forEach((ln, i) => {
      ctx.fillText(ln, PAD, H - PAD - W * 0.070 * K + i * W * 0.046 * K);
    });
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // 底部：来源 + BV 号 + 点赞
    // BV 号本身就是可回溯的出处，前面再点明「B站」，截图外传时才不会被当成自造数据
    ctx.font = `500 ${W * 0.017 * K}px ${MON}`;
    ctx.fillStyle = 'rgba(155,129,117,.95)';
    ctx.fillText(`B站 · ${v.bvid}`, PAD, H - PAD + W * 0.004 * K);

    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,138,92,.95)';
    ctx.fillText(`♥ ${fmtNum(v.like)}`, W - PAD, H - PAD + W * 0.004 * K);

    // 右下角水印
    ctx.textAlign = 'right';
    ctx.font = `500 ${W * 0.015 * K}px ${MON}`;
    ctx.fillStyle = 'rgba(247,236,228,.34)';
    ctx.fillText('火羽ひのめ · 影像录', W - PAD, PAD + noH + W * 0.030 * K);

    return cv;
  }

  function downloadCanvas(cv, name) {
    cv.toBlob(b => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = name;
      a.click();
      // 立刻 revoke 会让部分浏览器来不及下载，延后释放
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  }

  async function recordOne(v) {
    const cell = $(`#film-grid .fcell[data-id="${v.id}"]`);
    if (cell) {
      cell.classList.add('flash');
      setTimeout(() => cell.classList.remove('flash'), 520);
    }
    try {
      const cv = await drawCell(v);
      downloadCanvas(cv, `火羽_影像_${pad(v.no)}_${v.bvid}.png`);
    } catch (e) {
      console.error('录制失败', e);
    }
  }

  /**
   * 整页清单：把当前筛选结果拼成一张长图（每行 3 格）。
   * 条目多时图会很高，浏览器 canvas 上限约 32k px，
   * 这里限制在 60 格（20 行 = 5400px），并提示已截断。
   */
  async function recordList(list) {
    if (!list.length) return;
    const MAX = 60;
    const use = list.slice(0, MAX);
    const COLS = 3, GAP = 18, PAD = 40;
    const CW = 480, CH = Math.round(CW * 9 / 16);
    const CAP = 96;                      // 标题区高度
    const rows = Math.ceil(use.length / COLS);
    const W = PAD * 2 + CW * COLS + GAP * (COLS - 1);
    // 页眉占 138（含 100 处细线），每行 CH+CAP，行间 GAP，末尾留页脚 46
    const H = PAD * 2 + 138 + rows * (CH + CAP) + (rows - 1) * GAP + 46;

    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');

    ctx.fillStyle = '#0d0605';
    ctx.fillRect(0, 0, W, H);

    // 页眉
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.font = `700 40px ${SER}`;
    ctx.fillStyle = '#ff5a2e';
    ctx.fillText('影像录', PAD, PAD + 40);
    ctx.font = `500 17px ${MON}`;
    ctx.fillStyle = 'rgba(201,179,168,.9)';
    const scope = filmYear === 'all' ? '全部年份' : `${filmYear} 年`;
    const sortTxt = { new: '最新在前', hot: '按点赞', old: '最早在前' }[filmSort];
    ctx.fillText(`火羽ひのめ · ${scope} · ${sortTxt} · ${list.length} 段影像`
      + (list.length > MAX ? `（图为前 ${MAX} 段）` : ''), PAD, PAD + 74);

    // 页眉下的一条细线，把标题区和内容分开（否则第一行封面会贴上副标题）
    ctx.strokeStyle = 'rgba(140,31,24,.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, PAD + 100);
    ctx.lineTo(W - PAD, PAD + 100);
    ctx.stroke();

    // 逐格绘制（封面 + 标题）
    for (let i = 0; i < use.length; i++) {
      const v = use[i];
      const c = i % COLS, r = Math.floor(i / COLS);
      const x = PAD + c * (CW + GAP);
      const y = PAD + 138 + r * (CH + CAP + GAP);

      // 关键：按小尺寸画（CW 宽），不要先画 1080 再缩——
      // 60 格各画一张 1080 宽的临时画布会吃掉几百 MB 内存，直奔崩溃。
      const sub = await drawCell(v, { width: CW });
      ctx.drawImage(sub, x, y, CW, CH);

      // 边框
      ctx.strokeStyle = 'rgba(140,31,24,.5)';
      ctx.lineWidth = 1;
      rr(ctx, x + .5, y + .5, CW - 1, CH - 1, 6);
      ctx.stroke();

      // 标题
      ctx.font = `600 17px ${SER}`;
      ctx.fillStyle = '#f7ece4';
      const lines = wrapCJK(ctx, v.title, CW - 6, 2);
      lines.forEach((ln, k) => ctx.fillText(ln, x + 2, y + CH + 26 + k * 24));

      ctx.font = `500 12.5px ${MON}`;
      ctx.fillStyle = 'rgba(155,129,117,.95)';
      ctx.fillText(`${pad(v.no)} · ${v.y}.${pad(v.m)}.${pad(v.d)}`, x + 2, y + CH + 78);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,138,92,.9)';
      ctx.fillText(`♥ ${fmtNum(v.like)}`, x + CW - 2, y + CH + 78);
      ctx.textAlign = 'left';
    }

    // 页脚
    ctx.font = `500 13px ${MON}`;
    ctx.fillStyle = 'rgba(110,87,77,.9)';
    ctx.textAlign = 'center';
    ctx.fillText(
      '数据来源：B站公开投稿 space.bilibili.com/2094031249 · 仅收录标题与链接，不含视频本体',
      W / 2, H - PAD + 6
    );

    downloadCanvas(cv, `火羽_影像清单_${scope}_${list.length}段.png`);
  }

  /* ---------------------------------------- ARCHIVE */
  const PAGE = 40;
  let filtered = [], shown = 0, filter = 'all', query = '';
  // 搜索防抖定时器。必须提到模块作用域：
  // resetSearch 定义在 buildArchive 外面，看不到 buildArchive 里的局部变量，
  // 放里面会 ReferenceError，清空后过滤不会重跑。
  let qTimer = 0;

  function buildArchive() {
    applyFilter();

    $('#q').addEventListener('input', e => {
      const v = e.target.value;
      query = v.trim();
      // 清空按钮跟随输入内容显隐
      $('#q-clear').classList.toggle('on', v.length > 0);
      // 只剩 90ms 防抖：既要即时跟上输入，又不能每敲一个字母都重排整页
      clearTimeout(qTimer);
      qTimer = setTimeout(applyFilter, 90);
    });
    // Esc 快速清空（type=search 自带的行为在部分浏览器里不触发 input，显式处理）
    $('#q').addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); resetSearch(); }
    });
    $('#q-clear').addEventListener('click', resetSearch);

    $$('#chips .chip').forEach(c => {
      c.addEventListener('click', () => {
        $$('#chips .chip').forEach(x => x.classList.remove('active'));
        c.classList.add('active');
        filter = c.dataset.f;
        applyFilter();
      });
    });

    $('#more').addEventListener('click', () => { renderPage(); });
  }

  // 一键清空：不仅要清掉关键词，还要把分页、滚动和焦点状态一起复位，
  // 否则会停在「搜到一半」的列表位置，用户会觉得没清干净。
  function resetSearch() {
    const inp = $('#q');
    inp.value = '';
    query = '';
    $('#q-clear').classList.remove('on');
    clearTimeout(qTimer);
    applyFilter();
    // 回到列表起点
    const list = $('#arc-list');
    if (list) {
      const hd = document.querySelector('.hd');
      const top = list.getBoundingClientRect().top + window.scrollY
        - (hd ? hd.offsetHeight : 0) - 8;
      if (window.scrollY > top) window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
    }
    inp.focus({ preventScroll: true });
  }

  function applyFilter() {
    const q = query.toLowerCase();
    filtered = POSTS.filter(p => {
      if (filter === 'img' && !p.imgs.length) return false;
      if (filter === 'video' && !p.video) return false;
      if (filter === 'like' && p.like <= 100) return false;
      // 中日两种文本都参与搜索：用户看到中文译文后自然会用中文查
      if (q) {
        const hitJa = p.text.toLowerCase().includes(q);
        const hitZh = !!(p.zh && p.zh.toLowerCase().includes(q));
        const hitVideo = !!(p.video && p.video.title.toLowerCase().includes(q));
        if (!(hitJa || hitZh || hitVideo)) return false;
        // 只有中文命中时，自动切到中文，否则高亮会在日文正文里落空
        if (hitZh && !hitJa) zhOn.add(p.id);
      }
      return true;
    }).sort((a, b) => b.ts - a.ts);

    shown = 0;
    $('#arc-list').innerHTML = '';
    $('#arc-end').hidden = true;

    const chars = filtered.reduce((s, p) => s + p.text.length, 0);
    $('#arc-meta').textContent = q
      ? `「${query}」 · ${filtered.length} 条结果`
      : `${filtered.length} 条 · ${chars.toLocaleString()} 字`;

    if (!filtered.length) {
      $('#arc-list').innerHTML = `<div class="empty">没有找到匹配的动态</div>`;
      $('#more').style.display = 'none';
      return;
    }
    $('#more').style.display = '';
    renderPage();
  }

  function renderPage() {
    const slice = filtered.slice(shown, shown + PAGE);
    const html = slice.map(p => postHTML(p)).join('');
    $('#arc-list').insertAdjacentHTML('beforeend', html);
    shown += slice.length;

    const more = $('#more');
    if (shown >= filtered.length) {
      more.style.display = 'none';
      $('#arc-end').hidden = false;
    } else {
      more.style.display = '';
      more.textContent = `加载更多（还有 ${filtered.length - shown} 条）`;
    }
    bindLightbox($('#arc-list'));
    bindExpand();
  }

  function HL(s) {
    // 不再截断：折叠交给 CSS 的 .clamp，这样「展开全文」才能显示完整内容
    if (!query) return esc(s);
    const i = s.toLowerCase().indexOf(query.toLowerCase());
    if (i < 0) return esc(s);
    return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + query.length)) + '</mark>'
      + esc(s.slice(i + query.length));
  }

  /* ---------------------------------------- 双语（默认日文，可切换中文） */
  // 每条动态右上角一个翻译按钮，点一下切中文，再点还原日文。
  // 切换状态按动态 id 记在内存里，重渲染（翻页/换月/搜索）后仍然保持。
  const zhOn = new Set();

  // 每月信笺的阅读位置：{ 月份键: scrollTop }。
  // 切月会重建 DOM，不记的话长文每次都被打回顶部。
  const letterScroll = new Map();
  let letterScrollKey = null;

  // AI-TRANS｜p.zh 全站都是 AI 机器翻译（Google 引擎 + 术语表），未经人工逐条校对，
  // 含义可能不准确，需人工复核。人工确认过的条目见 translation/fixes.json。
  // 界面上由信笺头的 .lv-ainote 常驻提示，这里只管按开关切换显示哪一层。
  function tbtn(p) {
    if (!p.zh) return '';
    const on = zhOn.has(p.id);
    return `<button class="tr${on ? ' on' : ''}" type="button" data-tr="${p.id}"
      title="${on ? '切回日文' : '译成中文（AI 翻译，仅供参考）'}"
      aria-pressed="${on}"><span class="tr-ic" aria-hidden="true">文</span>A</button>`;
  }

  function bodyText(p) {
    return zhOn.has(p.id) && p.zh ? p.zh : p.text;
  }

  // 把一条动态的「当前语言」写回 DOM：按钮态 + 正文。
  // 单条切换（bindTrans）与整月切换（setMonthLang）共用同一函数，
  // 两条路径的状态与视觉效果必须完全一致。
  function applyLangToDOM(id) {
    const on = zhOn.has(id);
    const p = POSTS.find(x => x.id === id);
    document.querySelectorAll(`.tr[data-tr="${id}"]`).forEach(x => {
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', String(on));
      x.title = on ? '切回日文' : '译成中文';
    });
    document.querySelectorAll(`[data-body="${id}"]`).forEach(el => {
      el.textContent = bodyText(p);
      el.classList.toggle('zh', on);
      // 切语言后长文的折叠状态需要重算
      if (el.classList.contains('arc-t')) {
        const txt = el.textContent;
        el.classList.toggle('clamp', txt.length > 300 && !el.dataset.open);
        const more = el.nextElementSibling;
        if (more && more.classList.contains('arc-more')) {
          more.style.display = txt.length > 300 ? '' : 'none';
          more.textContent = '展开全文';
        }
      }
    });
  }

  // 当月语言一键切换：把当月所有「有译文」的条目统一切中或统切日。
  // 没有译文的条目不动（它只有日文可显示）。
  function setMonthLang(on) {
    curArr.forEach(p => {
      if (!p.zh) return;
      if (on) zhOn.add(p.id); else zhOn.delete(p.id);
      applyLangToDOM(p.id);
    });
    syncLangBadge(curArr);
  }

  // 徽章三态：全中 → 「中文」按下；全无 → 「日文」按下；混合 → 都不按。
  // 当月一条译文都没有时「中文」禁用，并说明原因。
  function syncLangBadge(arr) {
    const box = $('#lv-lang');
    if (!box) return;
    const hasZh = arr.filter(p => p.zh).length;
    const onN = arr.filter(p => zhOn.has(p.id)).length;
    const ja = box.querySelector('[data-l="ja"]');
    const zh = box.querySelector('[data-l="zh"]');
    if (ja) ja.setAttribute('aria-pressed', String(onN === 0));
    if (zh) {
      zh.setAttribute('aria-pressed', String(hasZh > 0 && onN === hasZh));
      zh.disabled = hasZh === 0;
      zh.title = hasZh === 0 ? '当月暂无译文'
        : (onN === hasZh ? '全部切回日文' : '全部译成中文');
    }
  }

  // 事件委托：按钮是动态插入的，不必逐个绑定
  function bindTrans() {
    if (document.__trBound) return;
    document.__trBound = true;
    document.addEventListener('click', e => {
      const b = e.target.closest('.tr');
      if (!b) return;
      const id = b.dataset.tr;
      if (zhOn.has(id)) zhOn.delete(id); else zhOn.add(id);
      // 就地替换，避免整页重渲染打断滚动位置
      applyLangToDOM(id);
      syncLangBadge(curArr);
      e.stopPropagation();
    });
  }

  function postHTML(p) {
    const txt = bodyText(p);
    const long = txt.length > 300;
    let h = `<article class="arc-item" data-id="${p.id}">
      <div class="arc-d">${fmtDate(p)}<span class="at">${fmtTime(p)} · 周${WD[p.wd]}</span></div>
      <div class="arc-c">${tbtn(p)}`;

    if (p.text.trim()) {
      h += `<p class="arc-t${long ? ' clamp' : ''}${zhOn.has(p.id) ? ' zh' : ''}"
        data-body="${p.id}">${HL(txt, p.id)}</p>`;
      if (long) h += `<button class="arc-more" type="button">展开全文</button>`;
    } else {
      h += `<p class="arc-t" style="color:var(--paper-4);font-style:italic">（本条无文字，仅图片）</p>`;
    }

    if (p.imgs.length) {
      h += `<div class="arc-imgs">${p.imgs.map(f =>
        `<img src="${IMG}${f[0]}" alt="" loading="lazy" data-lb="${IMG}${f[1]}">`).join('')}</div>`;
    }

    if (p.video) {
      h += `<a class="arc-vid" href="${esc(p.video.url)}" target="_blank" rel="noopener">
        ${p.video.cover ? `<img src="${IMG}${p.video.cover}" alt="" loading="lazy">` : ''}
        <div><div class="vt">${esc(p.video.title || '视频稿件')}</div>
        <div class="vb">${esc(p.video.bvid)}${p.video.duration ? ' · ' + esc(p.video.duration) : ''}</div></div>
      </a>`;
    }

    h += `<div class="arc-foot"><span class="arc-st">♥ <b>${fmtNum(p.like)}</b></span>
      <span class="arc-st">💬 <b>${fmtNum(p.cmt)}</b></span>
      <span class="arc-st">↻ <b>${fmtNum(p.fwd)}</b></span>
      <a class="arc-st" href="https://www.bilibili.com/opus/${p.id}" target="_blank"
         rel="noopener">原动态 ↗</a></div>
      </div></article>`;
    return h;
  }

  function bindExpand() {
    $$('.arc-more').forEach(b => {
      if (b.dataset.bound) return;
      b.dataset.bound = '1';
      b.addEventListener('click', () => {
        const t = b.previousElementSibling;
        t.classList.toggle('clamp');
        const open = !t.classList.contains('clamp');
        // 记住展开状态，切换语言重算折叠时不会被强行收回
        if (open) t.dataset.open = '1'; else delete t.dataset.open;
        b.textContent = open ? '收起' : '展开全文';
      });
    });
  }

  /* ---------------------------------------- 视图切换 */
  function switchView(v, scroll) {
    // v022：影像 / 录制入口已下线。唯一 UI 入口是导航标签（已 hidden），
    // 这里再兜一层——任何路径切到这两页都回落到动态环。
    // 判据是「对应标签是否可用」：测试脚本可先移除 hidden 走同一套入口；
    // 恢复功能时只需去掉 HTML 里的 hidden，此处逻辑自动放行。
    if (v === 'video' || v === 'stage') {
      const t = $(`.tab[data-v="${v}"]`);
      if (!t || t.hidden) v = 'ring';
    }
    $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.v === v)));
    $$('.view').forEach(s => s.classList.toggle('active', s.id === 'v-' + v));
    // 首屏很高，切视图后若停在原处会看不出任何变化；
    // 但顶栏本身是吸顶的，滚动过量又会遮住内容标题，所以只对齐到内容起点。
    if (scroll) {
      // 数据没起来时别去对齐内容起点：内容区是空的，滚过去反而
      // 把刚插在 main 前面的提示条顶出视野，用户就只看到一片空白。
      if (!dataOK) {
        window.scrollTo({ top: 0, behavior: 'auto' });
      } else {
        const target = $('#v-' + v);
        if (target) {
          const hd = document.querySelector('.hd');
          const top = target.getBoundingClientRect().top + window.scrollY
            - (hd ? hd.offsetHeight : 0) - 12;
          window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
        }
      }
    }
    // 这三个分支全部依赖数据。数据没加载时（file:// 打开最常见）
    // 它们会在 rAF 回调里抛 TypeError 并中断这一帧，
    // 所以统一先看 dataOK——导航依然能切页去看提示条。
    if (!dataOK) return;

    if (v === 'ring') {
      // 视图隐藏时 clientWidth 为 0，轮盘会按兜底尺寸排布；
      // 重新可见后必须重建一次，并按当前月份恢复选中态。
      requestAnimationFrame(() => {
        buildDial(true);
        selectMonth(curIdx, false);
      });
    } else if (v === 'stats') {
      // 同理会话初建时统计页是隐藏的，词云与日度图都量不到宽度。
      // 切成可见后重排一次，否则会一直停在兜底尺寸上把版面撑宽。
      requestAnimationFrame(() => {
        renderCloud();
        // 视图隐藏时 clientWidth/clientHeight 都是 0，日度图会直接放弃绘制；
        // 这里补画一次，并重新同步轨道两端状态（进度条此时才知道真实宽度）。
        if (guardsOK) buildGuardDaily();
        if (guardSync) guardSync();
        // 范围拖动块的缩略图与窗口位置同样依赖真实宽度，
        // 隐藏期间量到 0 会全部塌在左端，切回来必须重画。
        if (guardRangeRelayout) guardRangeRelayout();
      });
    } else if (v === 'stage') {
      // 舞台里所有尺寸都是 cqw，视图隐藏时容器宽高为 0，
      // 全部算成 0 会把场景塌成一团。可见后必须重建一次。
      requestAnimationFrame(() => { if (window.Stage) Stage.wake(); });
    }
    // 离开舞台页停掉计时，别在后台空转
    if (v !== 'stage' && window.Stage) Stage.leave();
    // 离开影像页就把 iframe 卸掉，否则切走后视频还在后台出声。
    // 注意判断条件是「新视图不是 video」，不是「是 video」。
    if (v !== 'video' && filmOn) closeFilm();
  }

  /** 只绑导航，不碰轮盘。数据失败时也要能切页看提示。 */
  function bindNavOnly() {
    $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.v, true)));

    // 首屏这颗按钮交给 switchView 处理，而不是让浏览器去跳锚点：
    //   1. 顶栏是 sticky 的，原生跳转会把内容标题顶到栏下面；
    //      switchView 里已经减掉了 header 高度。
    //   2. RING 视图隐藏时轮盘是按兜底尺寸排的，必须重建一次。
    // 放在 bindNavOnly 里：数据加载失败时按钮也要能用，
    // 点了会滚到顶部去看那条提示。
    const cta = $('#hero-cta');
    if (cta) cta.addEventListener('click', e => {
      e.preventDefault();
      switchView('ring', true);
    });
  }

  function bindTabs() {
    bindNavOnly();

    // 滑轨点击 / 拖动
    const scrub = $('#scrub');
    let dragging = false;
    const seek = e => {
      const r = scrub.getBoundingClientRect();
      const x = (e.clientX ?? e.touches?.[0]?.clientX ?? 0) - r.left;
      const pct = Math.max(0, Math.min(1, x / r.width));
      const i = Math.round(pct * (monthKeys.length - 1));
      if (i !== curIdx) selectMonth(i, true);
    };
    scrub.addEventListener('mousedown', e => { dragging = true; seek(e); });
    window.addEventListener('mousemove', e => { if (dragging) seek(e); });
    window.addEventListener('mouseup', () => { dragging = false; });
    scrub.addEventListener('touchstart', e => { dragging = true; seek(e); }, { passive: true });
    scrub.addEventListener('touchmove', e => { if (dragging) seek(e); }, { passive: true });
    scrub.addEventListener('touchend', () => { dragging = false; });

    // 轮盘滚轮
    // 关键：.ring-wrap 同时包住左侧圆环和右侧信笺，所以滚轮必须按指针位置分流，
    // 否则在信笺里读长文时会被抢去切月份。
    // 判据用 event.target 是否落在信笺内，而不是矩形命中测试——目标元素是
    // 最精确的「指针此刻在哪」，
    // 不受面板绝对定位、浮层、阴影这些几何因素的影响。
    const wrap = $('.ring-wrap');
    const letter = $('#letter');
    const lb = $('#letter-body');

    // 记录鼠标是否真的在信笺上（指针移出时自动失效，不需要手动清状态）
    let overLetter = false;
    const setOver = v => {
      if (overLetter === v) return;
      overLetter = v;
      hoverLetter = v; // 暂停自动轮播，见 startPlay
      wrap.classList.toggle('pool', v); // 给 CSS 一个钩子，视觉上提示滚轮已交给面板
    };
    letter.addEventListener('pointerenter', () => setOver(true));
    letter.addEventListener('pointerleave', () => setOver(false));
    // 触屏没有 hover，落点到信笺上就直接视为「在里面」
    letter.addEventListener('pointerdown', e => setOver(e.pointerType !== 'mouse'));

    const inLetter = e => letter.contains(e.target) || overLetter;

    wrap.addEventListener('wheel', e => {
      if (inLetter(e)) {
        // 交给信笺自己的 overflow 滚动，并挡住冒泡，圆环绝不响应
        e.stopPropagation();
        const dir = e.deltaY > 0 ? 1 : -1;
        const atTop = lb.scrollTop <= 0;
        const atEnd = lb.scrollTop + lb.clientHeight >= lb.scrollHeight - 1;
        // 内容不够长、或已滚到尽头时，浏览器会把这个滚轮事件「链」给页面，
        // 结果既不动面板也不动圆环，观感像卡住。这里撑住它。
        if (atTop && atEnd) {
          e.preventDefault();
        } else if (dir < 0 && atTop) {
          e.preventDefault();
        } else if (dir > 0 && atEnd) {
          e.preventDefault();
        }
        // 实时记住读到哪里，切回这个月时能接上
        if (letterScrollKey) letterScroll.set(letterScrollKey, lb.scrollTop);
        return;
      }
      if (Math.abs(e.deltaY) < 12) return;
      e.preventDefault();
      selectMonth(curIdx + (e.deltaY > 0 ? 1 : -1), true);
      playing = false; syncPlayBtn();
    }, { passive: false });

    $('#dial-prev').addEventListener('click', () => { selectMonth(curIdx - 1, true); playing = false; syncPlayBtn(); });
    $('#dial-next').addEventListener('click', () => { selectMonth(curIdx + 1, true); playing = false; syncPlayBtn(); });

    // 圆环拖拽拨转（手机端的主力交互）
    bindDialDrag();

    // 日/中整月切换徽章：按钮常驻在 letter-head 里，绑一次即可
    const langBox = $('#lv-lang');
    if (langBox) {
      langBox.addEventListener('click', e => {
        const b = e.target.closest('.lgb');
        if (!b || b.disabled) return;
        setMonthLang(b.dataset.l === 'zh');
      });
    }

    $('#btn-play').addEventListener('click', () => { playing = !playing; syncPlayBtn(); });
    $('#btn-speed').addEventListener('click', () => {
      speed = speed === 1 ? 2 : speed === 2 ? 0.5 : 1;
      const b = $('#btn-speed');
      b.textContent = '速度 ' + speed + '×';
      b.setAttribute('aria-pressed', String(speed !== 1));
      if (playing) startPlay();
    });
    $('#btn-latest').addEventListener('click', () => {
      selectMonth(monthKeys.length - 1, true);
      playing = false; syncPlayBtn();
    });

    startPlay();
  }

  function bindKeys() {
    window.addEventListener('keydown', e => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;

      // 全局快捷键只属于轮盘页。
      // 影像页里空格是播放器的播放/暂停，方向键是进度；
      // 录制舞台里空格/方向键/R/F 是舞台自己的走带控制。都不能抢。
      const onRing = $('#v-ring').classList.contains('active');
      if (!onRing) {
        if (e.key === 'Escape' && filmOn) closeFilm();
        return;
      }
      if (e.key === 'ArrowLeft') { selectMonth(curIdx - 1, true); playing = false; syncPlayBtn(); }
      else if (e.key === 'ArrowRight') { selectMonth(curIdx + 1, true); playing = false; syncPlayBtn(); }
      else if (e.code === 'Space') { e.preventDefault(); playing = !playing; syncPlayBtn(); }
      else if (e.key === 'Escape') closeLB();
    });
  }

  /* ---------------------------------------- 浮层 */
  const tip = $('#tip');
  function showTip(el) {
    const r = el.getBoundingClientRect();
    tip.textContent = el.title || '';
    tip.hidden = false;
    tip.style.left = r.left + r.width / 2 + 'px';
    tip.style.top = r.top + 'px';
  }
  function showTipAt(e, txt) {
    tip.textContent = txt;
    tip.hidden = false;
    moveTip(e);
  }
  /**
   * 跟随指针定位，并把提示条**推回视口内**。
   *
   * 原来直接写 clientX，配合 CSS 的 translate(-50%,-130%)，
   * 指针靠近右/上边缘时提示条会有一半跑到屏幕外。
   * 「大航海历程」的长提示（月份+人数+口径+观测数）一贴近右边就被切掉半句，
   * 正好把最关键的「来源/口径」截没。这里按实际尺寸做钳制。
   */
  function moveTip(e) {
    const w = tip.offsetWidth || 0;
    const h = tip.offsetHeight || 0;
    const pad = 10;
    // translate(-50%) → left 必须落在 [w/2, innerWidth - w/2]
    const x = Math.min(Math.max(e.clientX, w / 2 + pad), window.innerWidth - w / 2 - pad);
    // translate(-130%) → top 必须 ≥ 1.3h，否则上沿出屏
    const y = Math.max(e.clientY - 6, h * 1.3 + pad);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hideTip() { tip.hidden = true; }

  const lb = $('#lightbox');
  function bindLightbox(root) {
    $$('img[data-lb]', root).forEach(img => {
      if (img.dataset.bound) return;
      img.dataset.bound = '1';
      img.addEventListener('click', () => {
        $('img', lb).src = img.dataset.lb;
        lb.hidden = false;
      });
    });
  }
  function closeLB() { lb.hidden = true; $('img', lb).src = ''; }
  lb.addEventListener('click', e => { if (e.target !== $('img', lb)) closeLB(); });

  document.addEventListener('DOMContentLoaded', boot);
})();
