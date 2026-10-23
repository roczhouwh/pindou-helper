import { PERLER_PALETTE, colorDistance, deltaE76 } from '../../color-palette.js';
import { AUTO_MERGE_DIST_SQ, state } from '../core/state.js';

// ============================================================
// js/pipeline/simplify.js — 颜色简化（含常开近似色合并）
// ============================================================
// 自早先的单体文件搬迁而来，落位到本文件：
//   applySimplify / rebuildColorCounts / getStaticMergeMap / staticMergeCache
//   此前未按规则 1 落位到本文件。
//
// ⚠️ 两条硬约束（有专门的测试与突变测试守护，不要改回去）：
//   ① 决胜规则是「**色板序号较小者优先**」，**不是频率** ——
//      按频率决胜会让同一张图换网格尺寸后色号漂移（实测 29×29 得 E16、52×52 得 H12）。
//   ② 合并表必须是「**静态色板级**」（只看色板，与图上出现哪些色无关），
//      否则上述漂移会重新出现。判据要用**纯 H12 图**（图上没有 E16 才区分得出来）。
//
// ⚠️ `AUTO_MERGE_DIST_SQ` **不**在本文件里 —— 它在 `js/core/state.js` 的常量区
//    （与 `MAX_EXPORT_*` 放一起），本文件通过上面的 import 取用。
//
// 本文件是原生 ES module（步骤 0 已完成）：依赖由上方 import 显式声明，
// 不再靠"共享全局词法环境"。
// ============================================================
// ============================================================
// 5.5 颜色简化 — 合并映射后的相近颜色
// ============================================================

/**
 * 深拷贝一份网格：行数组与格子对象都不共享。
 * 关键点是格子对象 —— `findNearestColor()` 返回的是 PERLER_PALETTE 里的
 * 对象引用，浅拷贝会让格子仍然指向全局色板。
 */
export function cloneGrid(grid) {
  return grid.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
}

/** 从 gridData 重建 colorCounts */
export function rebuildColorCounts(grid) {
  const map = new Map();
  for (const row of grid) {
    for (const cell of row) {
      if (!cell) continue;
      const key = cell.hex;
      if (!map.has(key)) map.set(key, { ...cell, count: 0 });
      map.get(key).count++;
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

/**
 * 滑块层（层 ②）在 100% 档允许并掉的最大感知色差（CIELAB ΔE76）。
 *
 * 取值依据（全色板实测样张）：
 * 全色板在 `ΔE ≤ 20` 下收敛为 **72 色**（与 RGB cap 50 的 71 色力度相当），
 * 但最差合并只有 **ΔE 20**，而 RGB cap 50 的最差合并可达 **ΔE 38.9**。
 * 用户实测评判确认：`B23↔H6`（ΔE 20.8）已属"明显不合适"，
 * `M6↔M8`（ΔE 26.5）更明显 —— 故上限取 20。
 *
 * ⚠️ 不要为了"再简化一点"把它调高：每 +5 就会把肉眼能分辨的色对并掉。
 */
export const SIMPLIFY_MAX_DE = 20;

/**
 * 滑块档位 → ΔE 上限。
 *
 * 曲线沿用改版前的**形状**（`dist ∝ √档位`）：0% → 0，25% → 10，50% → 14.1，100% → 20。
 * 之所以不改线性：上限 20 时，现状曲线把 ΔE 17→20 铺在 72%~100%（28 个档位），
 * 线性只有 85%~100%（15 个档位）—— 在用户最关心的"接近上限"区段，√ 分辨率更高。
 *
 * ⚠️ 曲线只决定"每个档位对应多大色差"，不改变色数单调性（ΔE 上限随档位单调递增）。
 */
export function sliderDeltaE(threshold) {
  if (!(threshold > 0)) return 0;
  return SIMPLIFY_MAX_DE * Math.sqrt(threshold / 100);
}

/**
 * 基于 rawGridData 重新计算简化后的 gridData 和 colorCounts。
 *
 * 合并分**两层**（勿合并回单一层）：
 *
 * ┌ ① **常开近似色合并** —— 恒定为 `AUTO_MERGE_DIST_SQ`（dist ≤ 4），与滑块无关。
 * │   针对的是**色板自身的缺陷**：221 色里存在几对肉眼无法分辨的近同色
 * │   （最近一对 E16/H12 距离仅 2.83），最近邻匹配会在它们之间抖动，
 * │   凭空多出色号 → 污染统计、抬高采购量、预览出噪点。
 * │   滑块拉回 0 也**仍然生效** —— 这不是用户的强度选择，而是数据修正。
 * │   旧实现在 `threshold <= 0` 时直接早返回、完全跳过合并循环，
 * │   所以默认状态（simplify=0）下这些近同色对**原样存在** —— 这正是本次要修的。
 * │
 * └ ② **滑块合并** —— `simplify > 0` 时的用户主动压缩，在层 ① 之上继续合并。
 *    阈值是 **CIELAB ΔE76**（感知色差），100% 档上限 `SIMPLIFY_MAX_DE = 20`。
 *    ⚠️ 层 ① 仍用 RGB 距离 —— 它修的是"肉眼无法分辨"的色板缺陷，量纲必须原样保留
 *    （实测**不存在**任何 ΔE 阈值能恰好复现它并掉的那 4 对，见 `getMergeMap()` 注释）。
 *
 * ⚠️ **决胜规则：色板序号较小者优先，不按采样频率**。
 * 旧实现按频率决胜（低频并入高频），后果是**同一张图换网格尺寸后色号会漂移** ——
 * 采样网格一变、频率排序就变、主色随之改变。实测证据（改动前基线，可复现）：
 * 同一张近白测试图在 `simplify=30%` 下，**29×29 得 `E16`、52×52 得 `H12`**。
 * 用户按 29×29 的图纸买了 E16，改看 52×52 时色号变成 H12 —— 对按图采购是硬伤。
 * 「色号可复现」是图纸工具的基本要求，故改用固定规则。
 *
 * ⚠️ **合并关系是"静态色板级"，与图上出现了哪些色无关**（见 `getStaticMergeMap`）。
 * 这是上一条能成立的**前提**，不是可选优化：若改成"只在图上出现过的色里选目标"，
 * 则同一张图 29×29 可能只出现 H12（图内无 E16 可并，H12 保留）、
 * 52×52 同时出现两者（H12 并入 E16）—— **漂移依旧存在**，等于白改。
 */
export function applySimplify() {
  const threshold = state.simplify;
  const raw = state.rawGridData;
  if (!raw) return;

  // 层 ② 的阈值：滑块档位 → ΔE 上限（0 档即"不启用滑块层"，只剩层 ①）。
  // ⚠️ 两层用**不同量纲**（层 ① RGB 平方距离、层 ② ΔE），
  //    所以不能再像改版前那样取 `Math.max` —— 由 `getMergeMap()` 做顺序合成。
  const limitDE = sliderDeltaE(threshold);
  if (limitDE <= 0 && AUTO_MERGE_DIST_SQ <= 0) {
    // 当前不可达（AUTO_MERGE_DIST_SQ 恒 > 0），保留以防该常量将来被改成 0。
    // 早返回会让 gridData 停留在旧值、与新的 simplify 不一致 ——
    // 必须补齐 state 同步，而不是留一个静默退出
    state.gridData = cloneGrid(state.rawGridData);
    state.colorCounts = state.rawColorCounts;
    state.mergedColors = [];
    return;
  }

  const rows = raw.length;
  const cols = raw[0].length;

  // 深拷贝一份原始网格（格子对象也要独立，见 cloneGrid 注释）
  const grid = cloneGrid(raw);

  // 图上出现了哪些色号 —— **滑块层**的选择范围（见 applySimplify 的 JSDoc「U3」段）
  const presentNames = presentNamesOf(raw);
  const mergeMap = getMergeMap(limitDE, presentNames);

  // 执行合并
  const paletteMap = new Map(PERLER_PALETTE.map(p => [p.hex, p]));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = grid[r][c];
      if (cell && mergeMap.has(cell.hex)) {
        const tgt = paletteMap.get(mergeMap.get(cell.hex));
        // 拷贝而非直接引用色板对象：直接赋值会让 gridData 里混入全局色板引用，
        // 将来单元格编辑会就地改坏色板
        if (tgt) grid[r][c] = { ...tgt };
      }
    }
  }

  // 记录被丢弃的**色号名**，供 renderPreview 如实告知用户。
  // 只记图上**确实出现过**且被并掉的 —— 不夸大影响：
  // 色板级合并在阈值 4 时会并掉 4 个色号，但一张图通常只涉及其中一两个。
  const mergedColors = [];
  const seenHex = new Set();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = raw[r][c];
      if (!cell || seenHex.has(cell.hex)) continue;
      seenHex.add(cell.hex);
      if (!mergeMap.has(cell.hex)) continue;
      const src = paletteMap.get(cell.hex);
      const dst = paletteMap.get(mergeMap.get(cell.hex));
      if (src && dst) mergedColors.push({ from: src.name, to: dst.name });
    }
  }

  state.gridData = grid;
  state.colorCounts = rebuildColorCounts(grid);
  // 按源色号名排序，保证提示文案稳定（不随扫描顺序变化）
  state.mergedColors = mergedColors.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/** 色板的两张反查表（hex / 色号名 → 色板条目）。模块级常量，避免每次取表重建。 */
const paletteByHex = new Map(PERLER_PALETTE.map((p) => [p.hex, p]));
const paletteByName = new Map(PERLER_PALETTE.map((p) => [p.name, p]));

/**
 * 「度量 + 阈值 + 图上出现的色」→ 合并表的缓存。
 *
 * ⚠️ **缓存键必须带上"图上有哪些色"**：同一阈值在不同图片上
 * 选出的目标可以不同，只拿阈值当键会让第二张图复用第一张图的表 ——
 * 症状是新色号又回来了，且**换张图/改个尺寸就变**，极难排查。
 * ⚠️ **还必须带上度量标识**（`rgb` / `de` / `compose`）：同一数值阈值在
 * RGB 与 ΔE 下含义完全不同，混用会让层 ① 与层 ② 互相污染。
 *
 * 必要性：滑块 `input` 会随拖动连续触发，而每次算表都要做 221²/2 ≈ 24,310 次
 * 距离比较。滑块取值有限（0-100 共 101 档，外加常开层 1 档），缓存后
 * 每个阈值只算一次。
 *
 * ⚠️ 必须声明在取表函数**之前**：`const` 有暂时性死区（TDZ），
 * 声明在使用之后虽然当前调用时序不会踩到，但一旦将来有代码在脚本加载完成前
 * 触发合并，就会抛 ReferenceError。顺序即契约，不要调换。
 */
const staticMergeCache = new Map();

/** 收集网格里**出现过**的色号名集合（空格跳过）。滑块层的候选范围。 */
function presentNamesOf(grid) {
  const s = new Set();
  for (const row of grid) for (const cell of row) if (cell) s.add(cell.name);
  return s;
}

/**
 * 合并表：`source hex → target hex`（**RGB 平方距离**度量）。
 *
 * 这是**层 ①（常开层）**的取表函数，也仍被测试当作"静态色板级规则"的判据入口。
 * 层 ② 的 ΔE 度量走 `getDeltaEMergeMap()`，两层合成走 `getMergeMap()`。
 * 三者共用 `buildMapWithMetric()` + `clusterByCompleteLinkage()`。
 *
 * ⚠️ **两层必须用两种规则，不要"统一"成一种**（选型结论，实测数据见下）：
 *
 * ┌ ① **常开层仍是静态色板级**（与 `presentNames` 无关）——
 * │   它是对"色板自身缺陷"的数据修正，不是用户的强度选择。若改成"只从图上有的色里选"，
 * │   **纯 H12 图会输出 H12 而不是 E16**，色号重新随图像内容漂移
 * │   （测试 有一条专门区分这两种规则的用例守着）。
 * │
 * └ ② **滑块层限定在"图上已出现的色"内**（产品决策）——
 *    用户反馈：「简化过程不应该出现新的颜色，而是用现有区域内的颜色做简化」。
 *    实测：静态规则在 30% 档就凭空造出 D4、D13、C8 等图上没有的色号。
 *
 * ⚠️ **为什么不直接用早先评估过的另外两种候选** —— 两者都被选型硬判据淘汰：
 * 同一张红色渐变图，29 档与 52 档的**同一个来源色映射到了不同目标**
 * （A：`E13` 29档→D21 / 52档→D14；C 另有 `D21`、`F15`、`F8` 同类漂移）。
 * 再叠加一道"跨尺寸统一决胜"也补不回来：色板级的统一目标**本就是静态规则本身**，
 * 既然拒绝它，"哪些图内色可当目标"仍取决于图像 ⇒ 剩下的裁决依据只有频率，
 * 而频率决胜正是已修的旧缺陷。**两条约束在本架构下不可兼得。**
 *
 * ⚠️ **本方案（D）的已知边界，如实记录**：
 * · **只有滑块层**能保证"不引入新色号"。常开层是自动的、用户没主动要求，
 *   它的静态规则优先于"不引入新色"。实测反例：纯 H12 近白图在 `simplify=0`
 *   时仍输出 E16（这是既有契约，不要为此"顺手"改常开层）。
 * · **滑块层仍有**跨尺寸漂移的残余风险：某色在 29 档有图内近邻可选、
 *   在 52 档没有，两档目标就会不同。取舍是「**不引入新色号**」优先于
 *   「**跨尺寸绝对不漂移**」，理由是不引入新色是用户明说的话，
 *   而漂移只在换了尺寸时才有感知。**这是产品取舍，不是实现疏漏。**
 *
 * 决胜规则不变：**色板序号较小者优先**（不按频率）。
 *
 * ⚠️⚠️ **聚类规则是「完全链接」（complete linkage），不是"逐色找最近邻"** ——
 *    这条是本仓库 2026-10 实测修正的**结构性缺陷**，改之前务必读完本段。
 *
 *    【旧实现的问题】逐色贪心：每个色在自己的候选里挑最近的较小序号色，一遍替换即完事。
 *    当出现 p→q、q→r 这样的**链**时，一遍替换只会把 p 变成 q，而 q 自己又要变成 r ——
 *    **q 就留在了最终图纸上**。实测（全色板 221 色铺一格，`simplify=100%`）：
 *    映射表有 211 条，单遍替换后**仍有 115 个色号"本应消失却还在"**。
 *    可感知的后果有两个：
 *      ① **滑块往上拖，颜色反而变多**：红→蓝渐变 29×29 实测 96% 档 4 色、
 *         97% 档变 5 色（多出来的正是链的中间色）——与用户"简化=变少"的直觉相反；
 *      ② `#previewInfo` 的「已合并近似色」与实际不符（文案说并掉了，图上还在）。
 *
 *    【为什么不是"把链解析到不动点"】那样做色数确实单调了，但**会越出用户选的阈值**：
 *    p→q 与 q→r 各在阈值内，p→r 却可以到两倍阈值。改版前（RGB 时代）实测该形态
 *    最大跳色 **146**，而当时候阈值只有 **70.7** —— 等于偷偷抹平了用户没同意的色差。
 *    （现在度量换成 ΔE、上限 20，链式解析同样能让实际跳色翻倍，理由不变。）
 *
 *    【完全链接的做法】按阈值增量地做**层次聚类**：只有"簇内**任意两色**距离都 ≤ 阈值"
 *    才允许并成一簇（簇间距离取成员对的**最大**值）。代表色取簇内**最小色板序号**。
 *    三条性质由构造保证，无需额外断言兜底：
 *      ① **单调**：阈值只增不减、合并只并不可分 ⇒ 色数不随滑块上升而增加；
 *      ② **无泄漏**：每个非代表色直接映射到**最终代表**⇒ 不存在"既是目标又是源"的色号；
 *      ③ **不越阈**：簇内任意两色 ≤ 阈值 ⇒ 任何一格的实际跳色都不超用户所选阈值。
 *
 *    【为什么用"最小序号"当代表，而不是簇中心/高频色】§3.1 硬约束 1 已定：
 *    决胜必须与图像内容无关（按频率决胜会让色号随网格尺寸漂移）。
 *    最小序号是**纯色板规则**，与图上出现哪些色、出现多少次全都无关。
 *
 *    ✅ **常开层（阈值 4）行为与改造前逐条相同**（实测 4 条映射完全一致）：
 *    该阈值下不存在链（最近一对距离 2.83，链要求 p→q 且 q→r 两端都在 4 内），
 *    故完全链接与贪心结果等价。`纯 H12 图 → E16` 的契约不受影响。
 *
 * @param {number} distSq 平方距离阈值（`colorDistance()` 的量纲）
 * @param {Set<string>|null} [presentNames] 图上出现的色号名；
 *   **不传 / 传 null ⇒ 纯静态规则**（常开层的调用形态，向后兼容）
 * @returns {Map<string, string>} 源色号 hex → 目标色号 hex
 */
export function getStaticMergeMap(distSq, presentNames) {
  return buildMapWithMetric('rgb', distSq, presentNames, colorDistance);
}

/**
 * 层 ② 的合并表：**CIELAB ΔE76** 度量下的完全链接聚类。
 *
 * 与 `getStaticMergeMap()` 的唯一差别就是度量函数 —— 聚类规则、代表色规则、
 * 缓存策略全部共用 `buildMapWithMetric()`。分开导出是为了让两层**各用各的量纲**，
 * 又不必复制一份 O(k³) 的实现。
 *
 * @param {number} limitDE ΔE76 上限（`deltaE76()` 的量纲）
 * @param {Set<string>|null} [presentNames] 图上出现的色号名（不传 ⇒ 纯静态）
 * @returns {Map<string, string>}
 */
export function getDeltaEMergeMap(limitDE, presentNames) {
  return buildMapWithMetric('de', limitDE, presentNames, deltaE76);
}

/**
 * 单层合并表的统一实现（按度量参数化）。
 *
 * @param {'rgb'|'de'} tag 度量标识，参与缓存键
 * @param {number} limit 阈值（`rgb` 为平方距离，`de` 为 ΔE76）
 * @param {Set<string>|null|undefined} presentNames 图上出现的色号名
 * @param {(a: object, b: object) => number} dist 度量函数
 * @returns {Map<string, string>}
 */
function buildMapWithMetric(tag, limit, presentNames, dist) {
  const present = presentNames || null;
  const key = present
    ? `${tag}:${limit}|${[...present].sort().join(',')}`
    : `${tag}:${limit}`;
  const cached = staticMergeCache.get(key);
  if (cached) return cached;

  // 参与聚类的色：滑块层限定"图上已出现的色"，常开层是整块色板。
  // 保持**色板原序**（下标升序）—— 代表色的"序号最小"判据依赖它。
  const pool = [];
  for (let i = 0; i < PERLER_PALETTE.length; i++) {
    if (!present || present.has(PERLER_PALETTE[i].name)) pool.push(i);
  }

  const resolved = clusterByCompleteLinkage(pool, limit, dist);

  staticMergeCache.set(key, resolved);
  return resolved;
}

/**
 * 完全链接层次聚类：把 `pool`（色板下标数组，须升序）在阈值 `limit` 下并成若干簇，
 * 返回 `源 hex → 簇代表 hex`（代表 = 簇内**最小色板下标**）。
 *
 * 实现是朴素的 O(k³)（k = 池大小，≤ 221）：实测 k=221 建树 **11ms**，
 * 且结果按「度量 + 阈值 + 图上色集」缓存（见 `staticMergeCache`），滑块连续拖动**不会重算**。
 * 不要为了"看起来更聪明"换成近似算法 —— 单调性/不越阈是由**精确的簇间最大距离**
 * 保证的，近似后那三条性质就不再可证了。
 *
 * ⚠️ **度量由调用方传入**（`dist`），本函数不假设量纲：
 * 层 ① 传 `colorDistance`（平方距离，阈值 16）、层 ② 传 `deltaE76`（ΔE，阈值 20）。
 * 三条性质只依赖"`dist` 是度量 + 簇间取最大"，与具体量纲无关。
 *
 * @param {number[]} pool 参与聚类的色板下标（升序）
 * @param {number} limit 阈值（与 `dist` 同量纲）
 * @param {(a: object, b: object) => number} dist 度量函数
 * @returns {Map<string, string>}
 */
function clusterByCompleteLinkage(pool, limit, dist) {
  const k = pool.length;
  const resolved = new Map();
  if (k < 2) return resolved;

  // 簇间距离 = 成员对的**最大**距离。初始时每个色自成一簇。
  const cd = [];
  for (let i = 0; i < k; i++) {
    const row = new Array(k).fill(0);
    for (let j = i + 1; j < k; j++) {
      const d = dist(PERLER_PALETTE[pool[i]], PERLER_PALETTE[pool[j]]);
      row[j] = d;
    }
    cd.push(row);
    for (let j = 0; j < i; j++) cd[i][j] = cd[j][i];
  }

  const alive = new Array(k).fill(true);
  /** 每个簇的成员（局部下标），合并只并到保留下来的那一簇 */
  const members = pool.map((_, i) => [i]);
  /** 合并记录：`{ height, keep, drop }`，按 height 递增生成 */
  const merges = [];

  for (let step = 0; step < k - 1; step++) {
    // 找当前**簇间最大距离最小**的一对
    let bi = -1;
    let bj = -1;
    let bd = Infinity;
    for (let i = 0; i < k; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < k; j++) {
        if (!alive[j]) continue;
        if (cd[i][j] < bd) { bd = cd[i][j]; bi = i; bj = j; }
      }
    }
    // 剩下的簇两两距离都超阈值 ⇒ 再并就会越阈，**到此为止**
    // （提前退出是"不越阈"的实现点：后面的合并一定更大，不可能回到阈值内）
    if (bi < 0 || bd > limit) break;

    // 代表取**序号更小**的那一族 —— 保住"色板序号较小者优先"（§3.1 硬约束 1）
    const repA = Math.min(...members[bi].map((x) => pool[x]));
    const repB = Math.min(...members[bj].map((x) => pool[x]));
    const keep = repA <= repB ? bi : bj;
    const drop = keep === bi ? bj : bi;

    merges.push({ height: bd, keep, drop });

    // 合并簇：新簇到其它簇的距离 = 两侧**最大值**（完全链接的定义）
    for (let t = 0; t < k; t++) {
      if (!alive[t] || t === keep || t === drop) continue;
      const m = Math.max(cd[keep][t], cd[drop][t]);
      cd[keep][t] = m;
      cd[t][keep] = m;
    }
    for (const x of members[drop]) members[keep].push(x);
    alive[drop] = false;
  }

  // 并查集：把"被合并掉的簇"指向最终代表。
  // ⚠️ 必须走**合并记录**（而不是"每个色自己找最近邻"）——
  //    后者会重新引入链（p→q、q→r 时 q 仍留在图上），正是本次要修的缺陷。
  const parent = new Map();
  const findRoot = (x) => {
    let r = x;
    while (parent.has(r)) r = parent.get(r);
    return r;
  };
  for (const m of merges) {
    const a = findRoot(m.keep);
    const b = findRoot(m.drop);
    if (a !== b) parent.set(b, a);
  }

  const rootRep = new Map();   // 根 → 代表色板下标
  for (let i = 0; i < k; i++) {
    const r = findRoot(i);
    const idx = pool[i];
    if (!rootRep.has(r) || idx < rootRep.get(r)) rootRep.set(r, idx);
  }
  for (let i = 0; i < k; i++) {
    const rep = rootRep.get(findRoot(i));
    if (rep !== pool[i]) resolved.set(PERLER_PALETTE[pool[i]].hex, PERLER_PALETTE[rep].hex);
  }
  return resolved;
}

/**
 * 两层合成后的最终合并表 —— `applySimplify()` 的**唯一取表入口**。
 *
 * 顺序是 **先层 ①（RGB 静态）再层 ②（ΔE）**：
 *
 *     hex --层①--> 代表色 --层②--> 最终代表
 *
 * · `limitDE <= 0`（0% 档）⇒ 只有层 ①，与改版前逐条相同。
 * · `limitDE > 0` ⇒ 先把图上每个色过一遍层 ①，得到"修好的色板"里实际参与
 *   层 ② 的色集，再在这个色集上做 ΔE 完全链接聚类。
 *
 * ⚠️ **为什么是"合成"而不是"把层 ① 也换成 ΔE"**：
 * 层 ① 并掉的那 4 对色号（`E16/H12`、`G1/G18`、`G15/H21`、`H9/H17`）
 * ΔE 实测分别为 0.91 / 2.17 / 0.97 / 1.45 —— 跨度 0.91~2.17，**不存在**
 * 任何单一 ΔE 阈值能恰好复现这 4 对：
 *   · ΔE ≤1.5 ⇒ 只并到 5 对，但**多并** `F16/G2`、**漏掉** `G1/G18`；
 *   · ΔE ≤2.5 ⇒ 并到 9 对（多出 `H10/H17`、`H11/H22`、`G4/G9`、`H9/H10`）。
 * 层 ① 是对"色板自身缺陷"的数据修正，动它就会改变 `纯 H12 图 → E16`
 * 和「4 个色号永久不可达」两条既有契约 —— 用户没要求改这些。
 * ⇒ **层 ① 的量纲保持 RGB 不变，层 ② 单独换 ΔE。**
 *
 * ⚠️ 三条性质在合成下依然成立：
 *   ① 单调：层 ① 恒定、层 ② 的 ΔE 上限随档位单调增 ⇒ 色数只减不增；
 *   ② 无泄漏：每个图上色都走完整条链 ⇒ 图上不会留下"本该被并走"的色号；
 *   ③ 不越阈：层 ② 的跳色 ≤ `limitDE`；层 ① 的跳色 ≤ ΔE 2.17（肉眼无法分辨）。
 *
 * @param {number} limitDE 滑块层的 ΔE 上限（0 ⇒ 只走常开层）
 * @param {Set<string>} presentNames 图上出现的色号名
 * @returns {Map<string, string>} 源色号 hex → 目标色号 hex
 */
export function getMergeMap(limitDE, presentNames) {
  const present = presentNames || null;
  const key = present
    ? `compose:${limitDE}|${[...present].sort().join(',')}`
    : `compose:${limitDE}`;
  const cached = staticMergeCache.get(key);
  if (cached) return cached;

  // 层 ① 恒定（静态色板级，与图上出现哪些色无关）
  const staticMap = getStaticMergeMap(AUTO_MERGE_DIST_SQ);
  const resolved = new Map();

  if (limitDE > 0 && present) {
    // 图上每个色先过层 ①，得到"修好的色板"里实际参与层 ② 的色
    const repOf = new Map();   // 原色号名 → 层 ① 代表色板条目
    const repNames = new Set();
    for (const name of present) {
      const p = paletteByName.get(name);
      if (!p) continue;
      const rep = paletteByHex.get(staticMap.get(p.hex) || p.hex);
      if (!rep) continue;
      repOf.set(name, rep);
      repNames.add(rep.name);
    }
    const deMap = getDeltaEMergeMap(limitDE, repNames);
    for (const name of present) {
      const p = paletteByName.get(name);
      const rep = repOf.get(name);
      if (!p || !rep) continue;
      const finalHex = deMap.get(rep.hex) || rep.hex;
      if (finalHex !== p.hex) resolved.set(p.hex, finalHex);
    }
  } else {
    // 没有滑块层（0 档 / 未传候选集）⇒ 只有层 ①
    for (const [from, to] of staticMap) resolved.set(from, to);
  }

  staticMergeCache.set(key, resolved);
  return resolved;
}
