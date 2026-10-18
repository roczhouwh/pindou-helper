import { PERLER_PALETTE, colorDistance } from '../../color-palette.js';
import { AUTO_MERGE_DIST_SQ, state } from '../core/state.js';

// ============================================================
// js/pipeline/simplify.js — 颜色简化（含常开近似色合并）
// ============================================================
// 导出：applySimplify / rebuildColorCounts / getStaticMergeMap。
//
// ⚠️ 两条硬约束（不要改回去）：
//   ① 决胜规则是「**色板序号较小者优先**」，**不是频率** ——
//      按频率决胜会让同一张图换网格尺寸后色号漂移（实测 29×29 得 E16、52×52 得 H12）。
//   ② 合并表必须是「**静态色板级**」（只看色板，与图上出现哪些色无关），
//      否则上述漂移会重新出现。判据要用**纯 H12 图**（图上没有 E16 才区分得出来）。
//
// ⚠️ `AUTO_MERGE_DIST_SQ` **不**在本文件里 —— 它在 `js/core/state.js` 的常量区
//    （与 `MAX_EXPORT_*` 放一起），本文件通过上面的 import 取用。
//
// 本文件是原生 ES module：依赖由上方 import 显式声明，
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
 * 基于 rawGridData 重新计算简化后的 gridData 和 colorCounts。
 *
 * 合并分**两层**，（勿合并回单一层）：
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

  // 合并阈值：层 ① 常开；层 ② 仅在用户拖动滑块时叠加。
  // 取两者的较大值 —— 滑块调到小档位（如 1% → 平方 50）不应把层 ① 反而关掉。
  const sliderDistSq = threshold > 0 ? (threshold / 100) * 5000 : 0;
  const maxDistSq = Math.max(AUTO_MERGE_DIST_SQ, sliderDistSq);
  if (maxDistSq <= 0) {
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

  // 图上出现了哪些色号 —— **滑块层**的选择范围（见 `getStaticMergeMap` 的说明）
  const presentNames = presentNamesOf(raw);
  const mergeMap = buildMergeMap(maxDistSq, presentNames);

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

/**
 * 「阈值 + 图上出现的色」→ 合并表的缓存。
 *
 * ⚠️ **缓存键必须带上"图上有哪些色"**：同一阈值在不同图片上
 * 选出的目标可以不同，只拿 distSq 当键会让第二张图复用第一张图的表 ——
 * 症状是新色号又回来了，且**换张图/改个尺寸就变**，极难排查。
 *
 * 必要性：滑块 `input` 会随拖动连续触发，而每次算表都要做 221²/2 ≈ 24,310 次
 * 距离比较。滑块取值有限（0-100 共 101 档，外加常开层 1 档），缓存后
 * 每个阈值只算一次。
 *
 * ⚠️ 必须声明在 `getStaticMergeMap()` **之前**：`const` 有暂时性死区（TDZ），
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
 * 合并表：`source hex → target hex`。
 *
 * ⚠️ **两层必须用两种规则，不要"统一"成一种**（选型结论：同一张图 29/52 两档的目标色号确实不同）：
 * ┌ ① **常开层仍是静态色板级**（与 `presentNames` 无关）——
 * │   它是对"色板自身缺陷"的数据修正，不是用户的强度选择。若改成"只从图上有的色里选"，
 * │   **纯 H12 图会输出 H12 而不是 E16**，色号重新随图像内容漂移
 * │   （有一条专门区分这两种规则的用例守着）。
 * │
 * └ ② **滑块层限定在"图上已出现的色"内**——
 *    用户反馈：「简化过程不应该出现新的颜色，而是用现有区域内的颜色做简化」。
 *    实测：静态规则在 30% 档就凭空造出 D4、D13、C8 等图上没有的色号。
 *
 * ⚠️ **为什么不用更简单的候选方案 A / C** —— 两者都被选型硬判据淘汰：
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
 * 决胜规则不变：**色板序号较小者优先**（不按频率）。链式解析由
 * "每个来源直接落到最终目标"自然满足，不再需要逐级解析，也没有环。
 *
 * @param {number} distSq 平方距离阈值（`colorDistance()` 的量纲）
 * @param {Set<string>|null} [presentNames] 图上出现的色号名；
 *   **不传 / 传 null ⇒ 纯静态规则**（常开层的调用形态，向后兼容）
 * @returns {Map<string, string>} 源色号 hex → 目标色号 hex
 */
export function getStaticMergeMap(distSq, presentNames) {
  const present = presentNames || null;
  const key = present ? `${distSq}|${[...present].sort().join(',')}` : String(distSq);
  const cached = staticMergeCache.get(key);
  if (cached) return cached;

  const resolved = new Map();
  for (let i = 0; i < PERLER_PALETTE.length; i++) {
    const p = PERLER_PALETTE[i];
    // 候选：**序号比它小**且距离 ≤ 阈值者，按距离升序（等距时序号小者优先）
    const cands = [];
    for (let j = 0; j < i; j++) {
      const d = colorDistance(p, PERLER_PALETTE[j]);
      if (d <= distSq) cands.push({ j, d });
    }
    if (!cands.length) continue;
    cands.sort((a, b) => a.d - b.d || a.j - b.j);

    // ① 静态目标：距离最近者（即"序号小者胜出"）
    let target = cands[0].j;
    // ② 传了 presentNames ⇒ 滑块层：只在图上出现过的色里选
    if (present) {
      const onImage = cands.find(({ j }) => present.has(PERLER_PALETTE[j].name));
      // 图内无可选 ⇒ **不合并**：宁可少省一个色号，也不凭空造出新色号
      if (!onImage) continue;
      target = onImage.j;
    }
    resolved.set(p.hex, PERLER_PALETTE[target].hex);
  }

  staticMergeCache.set(key, resolved);
  return resolved;
}

/**
 * 按两层规则取最终合并表 —— `applySimplify()` 的唯一取表入口。
 *
 * · `maxDistSq <= AUTO_MERGE_DIST_SQ`（滑块没超过常开层）⇒ **只用静态表**。
 *   此时阈值完全由常开层决定，用户的"强度选择"还没生效，
 *   不该按图像内容裁决色号。
 * · 否则 ⇒ 用 `presentNames` 限定后的表。滑块层是用户主动要求压缩，
 *   且其阈值已覆盖静态表的全部合并动作，故此处用图内色表不会让常开层的
 *   契约（纯 H12 图 → E16）在 `simplify=0` 时失效。
 *
 * @param {number} maxDistSq
 * @param {Set<string>} presentNames
 * @returns {Map<string, string>}
 */
function buildMergeMap(maxDistSq, presentNames) {
  if (maxDistSq <= AUTO_MERGE_DIST_SQ) return getStaticMergeMap(maxDistSq);
  return getStaticMergeMap(maxDistSq, presentNames);
}
