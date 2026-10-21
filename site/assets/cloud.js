/**
 * 圆形词云布局。
 *
 * 为什么不用「随机撒点 + 力导向」：
 *   那个方案每次刷新位置都不一样，且收敛不稳定，小屏容易叠字。
 * 这里用确定性算法——按词频从高到低，沿阿基米德螺线从圆心向外找位置，
 * 每次试放到不与已占矩形相交、且不超出圆边界为止。
 * 结果：词频越高越靠近中心（螺线起点在圆心），且永远不重叠。
 *
 * 依赖 canvas 测字宽：DOM 上量太慢（要触发 layout），52 个词会明显卡顿。
 */

let _measureCtx = null;

function measureWord(text, size, fontFamily) {
  if (!_measureCtx) {
    const c = document.createElement('canvas');
    _measureCtx = c.getContext('2d');
  }
  // canvas 的 font 不接受小数像素：`700 0.75px serif` 会因为「无效值」
  // 被整条丢弃，退回默认的 10px sans-serif，于是所有词都按 10px 测宽，
  // 碰撞盒与实际字号完全不匹配（在画幅这种小基准下就是全军覆没）。
  // 这里向上取整到 1px 以上，测完再按同一比例换算回来即可。
  const px = Math.max(1, Math.round(size));
  _measureCtx.font = `700 ${px}px ${fontFamily}`;
  const raw = _measureCtx.measureText(text).width;
  const ratio = px === size ? 1 : size / px;
  // 高度按行高 1.0 估：中文字形几乎撑满 em 框，
  // 用 1.06 会让大字行高虚胖、小字行高虚瘦，反而叠在一起
  return { w: raw * ratio + 2, h: size + 1 };
}

/**
 * @param words [{w,n}] 已按词频降序
 * @param size  圆形画布直径
 * @param opts  {minSize, maxSize, fontFamily, gamma}
 * @returns [{w,n,size,x,y,t}]  x,y 为相对圆心的偏移
 */
function layoutCircle(words, size, opts = {}) {
  const R = size / 2;
  const minSize = opts.minSize ?? 12;
  const maxSize = opts.maxSize ?? 34;
  const ff = opts.fontFamily ?? 'serif';
  // gamma 越大，中低频词被压得越狠，头部词相对越突出
  const gamma = opts.gamma ?? 1.85;

  const n = words.length;
  if (!n) return [];

  // 用 log 而不是 sqrt 做词频归一：
  //   sqrt 下「直播 2335」和「温度 40」只差 7.6 倍，开 1.25 次方后
  //   字号只差约 2.4 倍，看起来仍然「差不多大」。
  //   log 把长尾压平，再配 gamma 指数，才能做出「一眼分三层」的效果。
  const lmax = Math.log(words[0].n + 1);
  const lmin = Math.log(words[n - 1].n + 1);
  const span = Math.max(lmax - lmin, 1e-6);

  const placed = [];
  const out = [];

  /**
   * 分区定环（这是让画面均匀的关键）：
   *   纯螺线「由内向外找第一个空位」会让小词被大词的间隙顶走，
   *   结果词群歪向一侧、外圈大片留白。
   *   改成按词频把词分到三个环带，各自只能在自己带内落位：
   *     头部词 → 内环（占满圆心视觉重心）
   *     中部词 → 中环
   *     尾部词 → 外环（贴边，把圆撑满）
   *   带与带之间留重叠，避免出现明显的同心分层感。
   */
  for (let i = 0; i < n; i++) {
    const item = words[i];
    // t: 1 = 最高频，0 = 最低频
    const t = Math.max(0, Math.min(1, (Math.log(item.n + 1) - lmin) / span));
    const k = Math.pow(t, gamma);
    // 字号走「分段线性」而不是纯幂函数：
    //   纯幂函数（gamma 2.0）下 52 个词里有 30 个都塌到 11~12px，
    //   看起来像一堆一样大的碎片，反而没有层次。
    //   这里前 3 名单独拉一大档，4~12 名一档，其余平滑降到下限，
    //   保证「一眼分三层」且尾部仍有 4 种以上字号。
    //
    // 注意：这里绝不能 Math.round。
    //   主站调用时字号是 13~58 的整数像素，取整没影响；
    //   但录制舞台是先在 1000px 的布局坐标里排、再整体映射成 cqw，
    //   此时字号只有 0.5~4.4 这一量级，一取整就只剩 1 和 4 两档，
    //   整张词云会退化成「全一样大」，同时因为大词被压小、
    //   碰撞盒算错，最终铺出圆外去。
    let fs;
    if (i === 0) fs = maxSize;
    else if (i < 3) fs = minSize + (maxSize - minSize) * (0.58 + k * 0.22);
    else if (i < 12) fs = minSize + (maxSize - minSize) * (0.26 + k * 0.30);
    else fs = minSize + (maxSize - minSize) * Math.pow(t, 1.15) * 0.52;
    fs = Math.max(minSize, fs);
    const box = measureWord(item.w, fs, ff);

    // 环带按「字号占比」划分，而不是按 k：
    // 字号已经改成三段式，若仍用 k 分环，会出现「大字号被塞进外环」的错位。
    const share = (fs - minSize) / Math.max(1, maxSize - minSize);
    let rMin, rMax, outward;
    if (share >= 0.50) {
      // 头部词：从圆心向外找，占住视觉重心
      rMin = R * 0.03; rMax = R * 0.44; outward = true;
    } else if (share >= 0.18) {
      // 中部词：中环，由内向外
      rMin = R * 0.18; rMax = R * 0.80; outward = true;
    } else {
      // 尾部词：由外向内找。
      // 这是把圆撑满的关键——如果小词也从内缘往外找，
      // 它们会挤在 0.4R 一带形成一圈，最外圈永远空着。
      rMin = R * 0.40; rMax = R * 0.995; outward = false;
    }

    // 从环带内缘向外找位；步长取字号的一部分，保证细密但不慢
    const step = Math.max(1.2, fs * 0.07);
    const dTheta = 0.11;
    // 反向绕行按 8 个一组交替：全逆时针会让词一路向右下铺开，
    // 导致整团圆偏向右下（反之偏左上），交替才均匀。
    const ccw = (i % 8) >= 4 ? -1 : 1;
    // 起始角用低差异序列打散，避免大量词都从 0 度（右侧）起步
    const base0 = (i * 0.6180339887 % 1) * Math.PI * 2;
    let ok = null;

    // 间隙不再按字号成比例放大——那会让大词周围空出一圈白。
    // 但也不能一刀切：大字要留 1px 才不糊成一块，小字可以更贴。
    const padX = 1.6, padY = 0.8;

    // 找位：先在环带内绕，放不下再放开到整圆。
    // 注意别加「多个起始角轮着试」——圆是旋转对称的，
    // 整体旋转 rot 得到的落位集合完全一样，纯属白算 5 倍。
    const PASSES = [
      { lo: rMin, hi: rMax, out: outward },
      { lo: 0, hi: R - 1, out: true },
    ];

    for (let pi = 0; pi < PASSES.length && !ok; pi++) {
      const { lo, hi, out } = PASSES[pi];
      // 用统一的「0..N」游标再映射成实际半径，这样既能由内向外，
      // 也能由外向内，而不用写两套循环
      const N = Math.max(1, Math.round((hi - lo) / step));
      for (let s = 0; s <= N && !ok; s++) {
        const r = out ? lo + s * step : hi - s * step;
        if (r < 0) continue;
        for (let kk = 0; kk < 72; kk++) {
          const th = base0 + ccw * kk * dTheta + r * 0.006;
          const x = Math.cos(th) * r;
          const y = Math.sin(th) * r;
          const halfW = box.w / 2;
          const halfH = box.h / 2;

          // 整个矩形必须在圆内（四个角都检查，用外接半径近似）
          const far = Math.hypot(Math.abs(x) + halfW, Math.abs(y) + halfH);
          if (far > R - 2) continue;

          let hit = false;
          for (const p of placed) {
            if (Math.abs(x - p.x) < (halfW + p.hw + padX) &&
                Math.abs(y - p.y) < (halfH + p.hh + padY)) {
              hit = true;
              break;
            }
          }
          if (hit) continue;

          ok = { x, y };
          break;
        }
        if (ok) break;
      }
    }

    // 两轮都放不下就跳过（宁可少画一个词，也不要叠字）
    if (!ok) continue;

    placed.push({ x: ok.x, y: ok.y, hw: box.w / 2, hh: box.h / 2 });
    out.push({
      w: item.w, n: item.n, size: fs,
      x: ok.x, y: ok.y,
      // 离圆心越远越淡，形成径向光晕
      t, k,
    });
  }

  return out;
}

/**
 * 椭圆词云布局（主站统计页「高频词」卡用）。
 *
 * 与 layoutCircle 同一套确定性思路（词频降序 + 阿基米德螺线 + 矩形碰撞），
 * 差别只在三处：
 *   1. 边界从「圆」换成「横椭圆」：整个碰撞盒四角都在
 *      x²/A² + y²/B² ≤ 1 内才落位（该式对 |x|、|y| 单调递增，
 *      所以查最远角 (|x|+hw, |y|+hh) 即覆盖四个角）。
 *   2. 环带按「归一化椭圆半径」ρ = √((x/A)²+(y/B)²) 划分，
 *      螺线也从圆改成同心椭圆：x = ρA·cosθ, y = ρB·sinθ。
 *   3. 间隙更小（椭圆比圆难填满，靠收紧间距提高密度）。
 *
 * 刻意不并进 layoutCircle：录制舞台（stage.js）以 1000px 布局坐标
 * 复用圆形版，词云场景是正圆构图；主站改成椭圆后两边各用各的，
 * 互不影响。字号三段式、log+gamma 归一等逻辑保持一致。
 *
 * @param words [{w,n}] 已按词频降序
 * @param size  布局宽度；高 = size / ratio
 * @param opts  {ratio, minSize, maxSize, fontFamily, gamma}
 * @returns [{w,n,size,x,y,t,k}]  x,y 为相对椭圆中心的偏移
 */
function layoutEllipse(words, size, opts = {}) {
  const ratio = opts.ratio ?? 1.42;
  const A = size / 2;
  const B = size / (2 * ratio);
  const minSize = opts.minSize ?? 12;
  const maxSize = opts.maxSize ?? 34;
  const ff = opts.fontFamily ?? 'serif';
  const gamma = opts.gamma ?? 2.0;

  const n = words.length;
  if (!n) return [];

  const lmax = Math.log(words[0].n + 1);
  const lmin = Math.log(words[n - 1].n + 1);
  const span = Math.max(lmax - lmin, 1e-6);

  const placed = [];
  const out = [];

  for (let i = 0; i < n; i++) {
    const item = words[i];
    const t = Math.max(0, Math.min(1, (Math.log(item.n + 1) - lmin) / span));
    const k = Math.pow(t, gamma);
    // 字号三段式与 layoutCircle 完全一致（同样不能取整，理由见彼处注释）
    let fs;
    if (i === 0) fs = maxSize;
    else if (i < 3) fs = minSize + (maxSize - minSize) * (0.58 + k * 0.22);
    else if (i < 12) fs = minSize + (maxSize - minSize) * (0.26 + k * 0.30);
    else fs = minSize + (maxSize - minSize) * Math.pow(t, 1.15) * 0.60;
    fs = Math.max(minSize, fs);
    const box = measureWord(item.w, fs, ff);

    // 环带按字号占比划分（同 layoutCircle），只是度量换成归一化椭圆半径
    const share = (fs - minSize) / Math.max(1, maxSize - minSize);
    let rMin, rMax, outward;
    if (share >= 0.50) {
      rMin = 0.03; rMax = 0.46; outward = true;    // 头部词：占住椭圆中心
    } else if (share >= 0.18) {
      rMin = 0.15; rMax = 0.78; outward = true;    // 中部词：中环
    } else {
      rMin = 0.42; rMax = 0.995; outward = false;  // 尾部词：由外向内贴边
    }

    // 径向步长用像素定义（换算成 ρ 增量）：B 是短半轴，用它换算最保守
    const stepPx = Math.max(1.0, fs * 0.055);
    const dRho = stepPx / B;
    const dTheta = 0.085;
    const ccw = (i % 8) >= 4 ? -1 : 1;
    const base0 = (i * 0.6180339887 % 1) * Math.PI * 2;
    let ok = null;

    // 椭圆比圆更难填，间隙再收一档；同样不随字号放大
    const padX = 1.0, padY = 0.5;

    const PASSES = [
      { lo: rMin, hi: rMax, out: outward },
      { lo: 0, hi: 0.995, out: true },
    ];

    for (let pi = 0; pi < PASSES.length && !ok; pi++) {
      const { lo, hi, out: outwardPass } = PASSES[pi];
      const N = Math.max(1, Math.round((hi - lo) / dRho));
      for (let s = 0; s <= N && !ok; s++) {
        const rho = outwardPass ? lo + s * dRho : hi - s * dRho;
        if (rho < 0) continue;
        for (let kk = 0; kk < 90; kk++) {
          const th = base0 + ccw * kk * dTheta + rho * 0.9;
          const x = Math.cos(th) * rho * A;
          const y = Math.sin(th) * rho * B;
          const halfW = box.w / 2;
          const halfH = box.h / 2;

          // 整个碰撞盒必须在椭圆内：查最远角（见函数头注释）
          const ex = (Math.abs(x) + halfW) / A;
          const ey = (Math.abs(y) + halfH) / B;
          if (ex * ex + ey * ey > 0.988) continue;   // ≈边界内缩 0.5px

          let hit = false;
          for (const p of placed) {
            if (Math.abs(x - p.x) < (halfW + p.hw + padX) &&
                Math.abs(y - p.y) < (halfH + p.hh + padY)) {
              hit = true;
              break;
            }
          }
          if (hit) continue;

          ok = { x, y };
          break;
        }
        if (ok) break;
      }
    }

    if (!ok) continue;

    placed.push({ x: ok.x, y: ok.y, hw: box.w / 2, hh: box.h / 2 });
    out.push({
      w: item.w, n: item.n, size: fs,
      x: ok.x, y: ok.y,
      t, k,
    });
  }

  return out;
}
