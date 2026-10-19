// ⚠️ **import 一律写成单行具名形式**：便于静态检查工具解析依赖。
import { PERLER_PALETTE } from '../../color-palette.js';
import { paletteBtn, paletteBody, paletteCloseBtn, paletteCount, paletteFilter, paletteOverlay, palettePanel } from '../core/dom.js';
import { state } from '../core/state.js';
import { showToast } from '../input/upload.js';
import { pickTextColor } from '../pipeline/render.js';
import { announce } from './a11y.js';
import { chooseEditColor } from './edit-ui.js';

// ============================================================
// js/ui/palette-picker.js — 全色板选择器（方案 A）
// ============================================================
// 用途：让用户从 MARD 221 色标准色板里挑一个色号当画笔色，
//       而不只是"涂成图上已有的颜色"。
// 范围：**只做方案 A**（在色板内选）。自由 RGB **不做** ——
//       用户买不到 221 色之外的颜色，没有意义。
//
// 本模块是**纯 UI 增量**，不是数据模型变更：
//   · 复用 `state.editColor`（形状不变），**不新增任何 state 字段**；
//   · 选的都是色板内的色 ⇒ 色号名必然能查回色板 ⇒ 存档格式零改动；
//   · 下游五条出口（预览 / 导出 / 打印 / 统计 / 存档）只消费格子的字段值，
//     本来就不回查色板 ⇒ **一行不改**。
//
// ⚠️ **六条硬约束**：
//
// 1. **选色语义与统计表逐字一致** —— 一律调 `edit-ui.js` 的 `chooseEditColor()`，
//    **不要**在这里自己写 `state.editColor = ...`（会绕过拷贝防线，复活三重别名），
//    也不要写成"总是切画笔"（擦除态挑色备用会变成"擦着擦着变成涂色"）。
//
// 2. **可见文字只有色号** —— 不要出现 hex、色名、小字标注。
//    `G18`/`H12`/`H17`/`H21` 这 4 个"自动生成产不出"的色号与其余 217 色
//    **渲染路径完全相同，不得特判**（用户口径："加小字会造成混乱"）。
//
// 3. **构建一次、筛选切 `hidden`** —— 不要在每次输入时重建 221 个节点
//    （会丢焦点，也会拖慢输入）。
//
// 4. **关闭必须把焦点还给 `#paletteBtn`**（可访问性硬要求）：
//    不还原时焦点掉到 `<body>`，键盘用户立刻失去落点
//    （焦点漂移会带出浏览器的 `scrollIntoView`，页面随之跳动）。
//
// 5. **`scrollIntoView` 必须做能力检测**：部分测试环境里 `Element.prototype.scrollIntoView`
//    是 `undefined`，不检测会直接 `TypeError`。
//    `block:'nearest'` 也是刻意的：只让面板内滚动最小幅度，**不滚动整个页面**。
//
// 6. **roving tabindex**：只有"当前格"是 `tabindex="0"`，其余全部 `-1`。
//    让 221 个按钮都进 Tab 序列的话，键盘用户要按 200 多次才能出去。
//
// 本文件是原生 ES module：依赖由上方 import 显式声明。
// ============================================================

/** 分组名（顺序即 `PERLER_PALETTE` 的排列顺序，**不要重排**） */
const GROUP_LABELS = {
  A: '黄橙系',
  B: '绿系',
  C: '蓝青系',
  D: '紫系',
  E: '粉系',
  F: '红系',
  G: '棕系',
  H: '灰白黑系',
  M: '混色系',
};

/** 首次打开时才构建（见硬约束 3）；之后的筛选只切 `hidden` */
let built = false;
/**
 * 当前"roving"焦点所在的那个色块（只它 `tabindex="0"`，其余 `-1`）。
 * ⚠️ 是**元素引用**而不是下标：筛选后可见集变了，下标会指错格。
 */
let rovingEl = null;
/** 遮罩打开前的焦点，用于关闭时还原（正常情况下就是 `#paletteBtn`） */
let lastActive = null;

/** 全部色块按钮（构建后一次性缓存，不从 DOM 反复查 221 个节点） */
let cells = [];

/** 每次打开都是整份 221 色；计数文案与之对应 */
const TOTAL_TEXT = `共 ${PERLER_PALETTE.length} 个色号`;

/**
 * 当前可见（未被筛选掉）的色块。
 * ⚠️ 判据是**自身**没有 `hidden` —— 分组容器隐藏时自身仍为 false，
 *    故还要看分组是否可见（见 `isVisible`）。
 */
function isVisible(el) {
  if (el.hidden) return false;
  let p = el.parentElement;
  while (p && p !== paletteBody) {
    if (p.hidden) return false;
    p = p.parentElement;
  }
  return true;
}

function visibleCells() {
  return cells.filter(isVisible);
}

/**
 * 找出"当前格正下方 / 正上方那一行里、水平位置最接近的格子"（↑/↓ 用）。
 *
 * ⚠️ **为什么按几何找，而不是算 `idx ± 每行格数`**：
 *   ① 每行格数**不是常量** —— `grid-template-columns: repeat(auto-fill, minmax(44px,1fr))`
 *      随面板宽度变（实测桌面 13 格/行、375px 手机 6 格/行）；
 *   ② 色块按**分组**排列且每组占整行 ⇒ 跨组时"上一行"是断的，下标算术会算错；
 *   ③ 筛选之后节点**不重建**、只切 `hidden`，若按"当前可见列表的下标"步进，
 *      在筛选态下会跳错位置。
 *   按真实 `getBoundingClientRect()` 找，上面三种情况都不需要特判。
 *
 * ⚠️ 若元素 rect 全是 0（布局尚未生效 / 元素不可见）⇒ 本函数返回 `null`（**不移动**）。
 *    这是刻意接受的：没有布局就无从判断"行"，宁可不动，也不要退化成
 *    "按下标 ±1"—— 那正是"↓ 表现得和 → 一样"这个缺陷的成因。
 *
 * @param {HTMLElement} cur 当前格
 * @param {HTMLElement[]} list 当前可见格（与 cur 同源）
 * @param {boolean} down true=向下找，false=向上找
 * @returns {HTMLElement|null}
 */
function neighborInLine(cur, list, down) {
  const cr = cur.getBoundingClientRect();
  // 布局不可用（rect 全为 0 / 元素不可见）⇒ 不移动，而不是猜一个位置
  if (!cr.width && !cr.height) return null;
  const cy = cr.top + cr.height / 2;
  const cx = cr.left + cr.width / 2;

  // 先找出"在当前行之下/之上"的候选（留 1px 容差，避免亚像素抖动判错行）
  const candidates = [];
  for (const el of list) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const ry = r.top + r.height / 2;
    if (down ? ry > cy + 1 : ry < cy - 1) candidates.push({ el, r, ry });
  }
  if (!candidates.length) return null;

  // 取**最近的一行**（不是"最近的那个格子" —— 否则会斜着跳）
  let bestRowY = down ? Infinity : -Infinity;
  for (const c of candidates) {
    if (down ? c.ry < bestRowY : c.ry > bestRowY) bestRowY = c.ry;
  }
  const sameRow = candidates.filter((c) => Math.abs(c.ry - bestRowY) < 2);
  if (!sameRow.length) return null;

  // 在该行里取**水平中心最接近**的格子
  let best = null;
  let bestDx = Infinity;
  for (const c of sameRow) {
    const dx = Math.abs((c.r.left + c.r.width / 2) - cx);
    if (dx < bestDx) { bestDx = dx; best = c.el; }
  }
  return best;
}

/**
 * 把 roving 焦点挪到 `el`（**不**移动真实焦点，除非 `focus` 参数为真）。
 * 硬约束 6：始终保证"只有一个 tabindex=0"。
 */
function setRoving(el, focus) {
  if (!el) return;
  if (rovingEl && rovingEl !== el) rovingEl.setAttribute('tabindex', '-1');
  rovingEl = el;
  el.setAttribute('tabindex', '0');
  if (focus) {
    el.focus();
    // 硬约束 5：部分环境没有 scrollIntoView，必须检测
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }
}

/** 更新 `aria-selected`（当前画笔色）与计数文案 */
function syncSelectionState() {
  const current = state.editColor ? state.editColor.name : null;
  for (const el of cells) {
    el.setAttribute('aria-selected', el.dataset.name === current ? 'true' : 'false');
  }
  const shown = visibleCells().length;
  paletteCount.textContent = (paletteFilter.value || '').trim()
    ? `匹配 ${shown} 个色号`
    : TOTAL_TEXT;
  // 空结果提示：没有它，用户会以为筛选坏了（本仓库一贯要求：静默失效不可接受）
  const empty = paletteBody.querySelector('.palette-empty');
  if (shown === 0) {
    if (!empty) {
      const p = document.createElement('p');
      p.className = 'palette-empty';
      p.textContent = '没有匹配的色号，换个前缀试试（如 A、B10）';
      paletteBody.appendChild(p);
    }
  } else if (empty) {
    empty.remove();
  }
}

/** 首次打开时构建全部色块（分组 + 色块），之后不再重建 */
function build() {
  if (built) return;
  built = true;
  let html = '';
  let currentGroup = null;
  for (const pal of PERLER_PALETTE) {
    const group = pal.name[0];
    if (group !== currentGroup) {
      // 上一组收尾（首组时 currentGroup 为 null，不写）
      if (currentGroup) html += '</div></div>';
      currentGroup = group;
      const label = GROUP_LABELS[group] || `${group} 系`;
      html += `<div class="palette-group" role="group" aria-label="${label}">`
        + `<div class="palette-group-title" aria-hidden="true">${label}</div>`
        + `<div class="palette-cells">`;
    }
    // `data-fg` 由 `pickTextColor()` 决定（**复用** render.js，不抄第二份亮度公式）。
    // 它返回 `'#000000'` / `'#FFFFFF'`，这里折算成 CSS 用的类别名。
    const fg = pickTextColor(pal) === '#000000' ? 'dark' : 'light';
    // ⚠️ 可见文字**只有色号**（硬约束 2）；`background` 是内联样式，不是文本
    html += `<button type="button" class="palette-cell" role="option" data-name="${pal.name}"`
      + ` tabindex="-1" aria-selected="false" data-fg="${fg}"`
      + ` style="background:${pal.hex};">`
      + `<span class="palette-cell-name">${pal.name}</span></button>`;
  }
  // 收掉最后一组
  if (currentGroup) html += '</div></div>';
  paletteBody.innerHTML = html;
  cells = Array.from(paletteBody.querySelectorAll('.palette-cell'));
}

/**
 * 筛选：**色号前缀**、大小写不敏感（`a` → A1…A26；`b1` → B1, B10…B19）。
 * ⚠️ 只切 `hidden`，**不重建节点**（硬约束 3）。
 */
function applyFilter() {
  const q = (paletteFilter.value || '').trim().toUpperCase();
  for (const el of cells) {
    el.hidden = !!q && !el.dataset.name.toUpperCase().startsWith(q);
  }
  for (const group of paletteBody.querySelectorAll('.palette-group')) {
    const any = Array.from(group.querySelectorAll('.palette-cell')).some((el) => !el.hidden);
    group.hidden = !any;
  }
  // 筛选后把 roving 重置到第一个匹配项（键盘用户按 Tab 之后能接着往下走）
  const first = visibleCells()[0];
  if (first) setRoving(first, false);
  syncSelectionState();
}

/** 打开色板 */
export function openPalette() {
  // ⚠️ "无图纸"守卫：真实界面上 #previewSection 隐藏时按钮点不到，
  //    这道守卫是为**脚本与自动化**留的（本仓库对"看起来灰了其实还能触发"有专门记录）
  if (!state.gridData) {
    // 与 edit-ui.js 的 toggleTool() 同一句，避免两处文案漂移
    showToastNoGrid();
    return;
  }
  build();
  lastActive = document.activeElement;
  paletteOverlay.hidden = false;
  paletteBtn.setAttribute('aria-expanded', 'true');
  document.documentElement.classList.add('palette-open');
  paletteFilter.value = '';
  applyFilter();
  // D3：焦点落在**第一个色块**（不是筛选框）
  const first = cells[0];
  if (first) setRoving(first, true);
  announce('色板已打开：MARD 221 色，用方向键移动，回车选中');
}

/** 关闭色板（三条路径共用同一收尾：✕ / Escape / 点遮罩） */
export function closePalette() {
  if (paletteOverlay.hidden) return;
  paletteOverlay.hidden = true;
  paletteBtn.setAttribute('aria-expanded', 'false');
  document.documentElement.classList.remove('palette-open');
  // 硬约束 4：焦点还给触发按钮（不是 lastActive —— 用户可能从别处用键盘唤出，
  // 但本面板的**唯一**打开入口就是 #paletteBtn）
  //
  // ⚠️ **必须 preventScroll**（真实 Chrome 实测踩到）：直接 `focus()` 会让浏览器
  //    把按钮滚进视野 —— 用户明明停在预览区（色板是 position:fixed，与滚动位置无关），
  //    关掉面板时页面却横跳数百像素（实测 200 → 943）。
  //    这与 U7 的 `preventScroll` 是**两回事**，不要混：
  //      · U7 是"**不该被抢走**的焦点被抢走，再用 preventScroll 掩盖"——禁止；
  //      · 这里是"焦点**本就该回到**按钮，只是不该附带滚动"——正确用法。
  //    与 `scrollIntoView` 一样做能力检测：老 Safari 不认这个参数时会抛或忽略，
  //    用 try/catch 兜住，退化为普通 focus()（至少焦点是对的）。
  try {
    paletteBtn.focus({ preventScroll: true });
  } catch (e) {
    paletteBtn.focus();
  }
}

/**
 * 无图纸提示。
 * ⚠️ 文案与 `edit-ui.js` 的 `toggleTool()` 同一句（「还没有图纸可编辑…」），
 *    两处要一起改 —— 这是**同一个用户动作**在两条入口上的同一句解释。
 */
function showToastNoGrid() {
  showToast('还没有图纸可编辑，请先上传图片生成图纸或载入一份存档');
}

// ------------------------------------------------------------
// 事件装配
// ------------------------------------------------------------

paletteBtn.addEventListener('click', openPalette);
paletteCloseBtn.addEventListener('click', closePalette);

// 点遮罩关闭；点面板内部**不**关闭（判据 e.target === overlay）
paletteOverlay.addEventListener('click', (e) => {
  if (e.target === paletteOverlay) closePalette();
});

// 点色块 = 选中并关闭（**依赖 <button> 原生行为**，不再手动绑 click 语义）
paletteBody.addEventListener('click', (e) => {
  const btn = e.target.closest ? e.target.closest('.palette-cell') : null;
  if (!btn) return;
  // 与统计表 / 吸管走同一个选色函数（硬约束 1）
  chooseEditColor(btn.dataset.name);
  closePalette();
});

// 筛选输入：焦点**留在筛选框**，roving 重置到第一个匹配项
paletteFilter.addEventListener('input', applyFilter);

// 筛选框里按 ↓：焦点进入第一个匹配色块（与下拉框的通行习惯一致）
paletteFilter.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown') return;
  const first = visibleCells()[0];
  if (!first) return;
  e.preventDefault();
  setRoving(first, true);
});

// 面板内键盘：方向键 / Home / End 移动 roving；Tab 走显式三点焦点陷阱
palettePanel.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
    return;
  }
  const list = visibleCells();
  if (!list.length) return;
  const idx = list.indexOf(document.activeElement);

  // ⚠️ **四个方向键不是同一个动作**（2026-10-19 用户实测报缺陷：↓ 与 → 表现相同）。
  //    色块是**多行网格**（`repeat(auto-fill, minmax(44px,1fr))`，每行格数随面板宽度变），
  //    且按**分组**排列（每组占整行，跨组时行是断开的）。
  //    故 ↓/↑ 必须移到"上一行/下一行"的对应列，不能当成 +1/-1 的线性步进。
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (idx < 0) return;   // 焦点在筛选框里：左右键要能移动光标
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    // 线性跨组移动，两端不环绕（221 项下线性最直观）
    const next = list[Math.min(Math.max(idx + step, 0), list.length - 1)];
    setRoving(next, true);
    return;
  }

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (idx < 0) return;
    e.preventDefault();
    const cur = list[idx];
    const down = e.key === 'ArrowDown';
    const target = neighborInLine(cur, list, down);
    // 找不到同列的下/上一行 ⇒ 保持不动（比跳到别处更符合直觉）
    if (target) setRoving(target, true);
    return;
  }

  if (e.key === 'Home' || e.key === 'End') {
    if (idx < 0) return;
    e.preventDefault();
    setRoving(e.key === 'Home' ? list[0] : list[list.length - 1], true);
    return;
  }

  if (e.key === 'Tab') {
    // 焦点陷阱：在「✕ → 筛选框 → 当前色块」三点之间循环。
    // ⚠️ 用**显式三点数组**，不要 querySelectorAll 全量扫描（221 个节点 + 未来改动都会让循环失准）
    const trap = [paletteCloseBtn, paletteFilter, rovingEl].filter(Boolean);
    const at = trap.indexOf(document.activeElement);
    e.preventDefault();
    if (at < 0) { trap[0].focus(); return; }
    const nextIdx = e.shiftKey
      ? (at - 1 + trap.length) % trap.length
      : (at + 1) % trap.length;
    trap[nextIdx].focus();
  }
});

// 图纸/编辑态变化后，色板的"当前选中色"要跟着变（aria-selected）。
// ⚠️ 方向是 UI 监听模型（与 edit-ui.js 的 setEditStateListener 同构），
//    不在这里反向调用编辑模型。
//    未打开时不做事 —— 打开时 openPalette() 已同步过一次。
document.addEventListener('pointerdown', () => {
  if (!paletteOverlay.hidden) syncSelectionState();
}, true);

// Escape 的兜底：焦点在面板外（例如脚本派发到 document）时也能关
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (paletteOverlay.hidden) return;
  // 面板内的 Escape 已由上面的监听处理（并 preventDefault）
  if (e.defaultPrevented) return;
  closePalette();
});

// ⚠️ 供 `state.editColor` 变化时同步 aria-selected（chooseEditColor → setEditStateListener
//    只通知 edit-ui；色板若已打开需要自己的同步）。
//    用 edit.js 的监听器是"UI 监听模型"的正确方向，不会新增反向依赖。
export function syncPaletteSelection() {
  if (!built || paletteOverlay.hidden) return;
  syncSelectionState();
}

// 导出给测试/其它 UI 叶子按需使用（不参与模块装配，避免成为"第二入口"）
export const PALETTE_TOTAL = PERLER_PALETTE.length;
