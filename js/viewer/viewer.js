import { controlsSection, downloadBtn, isTouchDevice, previewSection, printBtn, saveArchiveBtn, selectionBox, statsSection, uploadSection, viewerCanvas, viewerHint, viewerHint2, viewerHint3, viewerHint4, viewerSection, viewerWrapper } from '../core/dom.js';
import { state, viewerCtx } from '../core/state.js';
import { updateSelectionBox } from './selection.js';

// ⚠️ 本文件**不反向 import 上位领域**。两条跨领域动作各自留一个 hook，
//    由编排层 `js/main.js` 注入：
//      · `setViewerReadyHandler`  —— 图片渲染完、可以生成图纸时（通常是 generateGrid）
//      · `setExitArchiveHandler`  —— 载入新图时退出「存档模式」（通常是 exitArchiveMode）
//    未注册时**只 warn 不抛错**：抛错会让一次普通上传白屏，
//    比"少一次自动生成 / 横幅残留"严重得多。
let viewerReadyHandler = null;

/** 由 `js/main.js` 注入：查看器就绪后要执行的跨领域动作（通常是 generateGrid）。 */
export function setViewerReadyHandler(fn) {
  viewerReadyHandler = typeof fn === 'function' ? fn : null;
}

let exitArchiveHandler = null;

/** 由 `js/main.js` 注入：进入查看器时要执行的跨领域动作（通常是 exitArchiveMode）。 */
export function setExitArchiveHandler(fn) {
  exitArchiveHandler = typeof fn === 'function' ? fn : null;
}

// ============================================================
// js/viewer/viewer.js — 图片查看器（画布渲染与坐标换算）
// ============================================================

// 含 computeImageRect / showViewer / resizeViewerCanvas / renderViewer /
//    getImageCoords / scheduleViewerRedraw。
//
// ⚠️ `computeImageRect(w, h)` **必须保留 w/h 参数**，不要在函数里自取尺寸：
//    三个调用方的宽度来源本就不同（viewerCanvas.width vs getBoundingClientRect().width），
//    在 iOS 的 0 尺寸时序窗口内不相等。让它自己取会**改回已修的 iOS 缺陷**。
//
// ⚠️ `resizeViewerCanvas()` 的零尺寸 rAF 重试不要删：
//    iOS 14 在 hidden→visible 切换后 getBoundingClientRect 可能返回 0。
//
// 本文件是原生 ES module：依赖由上方 import 显式声明，
// 不再靠"共享全局词法环境"。
// ============================================================
// ============================================================
// 2. 图片查看器
// ============================================================

/**
 * 计算图片在画布中的**实际绘制矩形**（contain 适配 + zoom/pan 变换）。
 *
 * 这是整个 viewer 的坐标换算基准，此前在 `renderViewer` / `getImageCoords` /
 * `updateSelectionBox` 里**重复了三份**。抽取后
 * 三处共用同一份数学，避免"改了一处、漏了另两处"。
 *
 * @param {number} w 画布宽（**调用方决定来源**，见下方 ⚠️）
 * @param {number} h 画布高
 * @returns {{imgX:number, imgY:number, scaledW:number, scaledH:number}}
 *          图片左上角坐标与缩放后的宽高（client 像素）
 *
 * ⚠️ **为什么把 w/h 做成参数、而不在函数内自己取**：
 * 三个调用方的宽度来源**本来就不同**，且这个差异**必须保留**：
 *   - `renderViewer`        → `viewerCanvas.width`（canvas 位图尺寸）
 *   - `getImageCoords`      → `getBoundingClientRect().width`
 *   - `updateSelectionBox`  → `getBoundingClientRect().width`
 * `resizeViewerCanvas()` 之后二者应相等，但在 **iOS 的 0 尺寸时序窗口内不相等**
 * （`resizeViewerCanvas` 的零尺寸 rAF 重试正为此存在）。
 * 若在此"顺手统一"成单一来源，就会把已修复的 iOS 缺陷改回来。
 *
 * ⚠️ 另：本函数**不读** `state.image`，也不做 `state.imageW/imageH` 的有效性检查，
 * 调用方须自行保证（`renderViewer` 已在入口判空）。
 */
export function computeImageRect(w, h) {
  // contain 适配：图片按原比例完整放入画布
  const imgAspect = state.imageW / state.imageH;
  const canvasAspect = w / h;
  let drawW, drawH;
  if (imgAspect > canvasAspect) {
    drawW = w;
    drawH = w / imgAspect;
  } else {
    drawH = h;
    drawW = h * imgAspect;
  }

  // 应用 zoom 和 pan（以画布中心为基准）
  const cx = w / 2 + state.panX;
  const cy = h / 2 + state.panY;
  const scaledW = drawW * state.zoom;
  const scaledH = drawH * state.zoom;

  return { imgX: cx - scaledW / 2, imgY: cy - scaledH / 2, scaledW, scaledH };
}

export function showViewer() {
  uploadSection.hidden = true;
  viewerSection.hidden = false;
  controlsSection.hidden = false;
  previewSection.hidden = true;
  statsSection.hidden = true;
  downloadBtn.disabled = true;
  // 打印出口与 PNG 导出同启用时机：新图尚未生成图纸，两者都必须禁用
  printBtn.disabled = true;
  // 存档模式在此退出：showViewer 是**任何**载入原图路径的
  // 唯一必经之处（handleFile 只在这里收尾），收在这里才不会漏掉某条分支。
  // ⚠️ 漏了它的表现是"上传了新图，但网格尺寸按钮与简化滑块仍是灰的、
  //    横幅还挂着上一份存档的说明"——只有用户能撞见。
  if (exitArchiveHandler) exitArchiveHandler();
  else {
    console.warn('[viewer] 未注册 exitArchiveHandler —— 上传新图后可能残留「已载入存档」横幅，'
      + '且网格尺寸/简化滑块仍是灰的。请在 js/main.js 里调用 setExitArchiveHandler(exitArchiveMode)。');
  }
  viewerHint.hidden = false;
  viewerHint2.hidden = isTouchDevice;
  viewerHint3.hidden = !isTouchDevice;
  // 键盘提示与触摸提示同源同判据：触摸设备没有物理键盘，显示它只是噪音
  viewerHint4.hidden = isTouchDevice;
  selectionBox.classList.add('visible');

  // iOS Safari: hidden→visible 切换后强制同步布局计算
  // 1. 先强制 reflow 确保 getBoundingClientRect 返回有效值
  // 2. 再用 rAF 调度到下一帧，确保渲染管线已提交
  void viewerWrapper.offsetHeight;
  requestAnimationFrame(() => {
    // 再次强制 reflow，防止 iOS Safari 在 rAF 回调中仍未完成布局
    void viewerWrapper.offsetHeight;
    resizeViewerCanvas();
    renderViewer();
    updateSelectionBox();
    if (viewerReadyHandler) viewerReadyHandler();
    else {
      console.warn('[viewer] 未注册 viewerReadyHandler —— 上传后不会自动生成图纸。'
        + '请在 js/main.js 里调用 setViewerReadyHandler(generateGrid)。');
    }
  });
}

/**
 * 把界面**退回上传阶段**（与 `showViewer()` 对称）。
 *
 * ⚠️ 这里只做界面（画布 / 选框 / 区块显隐 / 按钮禁用）。
 *    **数据复位是另一件事** —— 由 `core/state.js` 的 `resetDocumentState()` 负责。
 *    两者分开的理由：界面与数据各自可单独测试，也不会出现"清了一半"的中间态。
 *
 * ⚠️ 新增"仅查看阶段可见"的元素时，**必须同步补进本函数与 `showViewer()`**，
 *    否则会出现"退回上传页了，某个区块还浮在上面"。
 */
export function showUploadStage() {
  viewerCtx.clearRect(0, 0, viewerCanvas.width, viewerCanvas.height);
  selectionBox.classList.remove('visible');
  uploadSection.hidden = false;
  viewerSection.hidden = true;
  controlsSection.hidden = true;
  previewSection.hidden = true;
  statsSection.hidden = true;
  // 三个出口在没图纸时都不可用（否则点了会没反应或报错）
  downloadBtn.disabled = true;
  printBtn.disabled = true;
  saveArchiveBtn.disabled = true;
}

export function resizeViewerCanvas() {
  const rect = viewerWrapper.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    // iOS Safari 布局未就绪，重试
    requestAnimationFrame(resizeViewerCanvas);
    return;
  }
  viewerCanvas.width = rect.width;
  viewerCanvas.height = rect.height;
  viewerCanvas.style.width = rect.width + 'px';
  viewerCanvas.style.height = rect.height + 'px';
}

export function renderViewer() {
  if (!state.image) return;
  // ⚠️ 宽高来源是 viewerCanvas（不是 getBoundingClientRect）—— 见 computeImageRect 的说明
  const w = viewerCanvas.width;
  const h = viewerCanvas.height;
  const ctx = viewerCtx;
  ctx.clearRect(0, 0, w, h);

  const { imgX, imgY, scaledW, scaledH } = computeImageRect(w, h);

  ctx.drawImage(state.image, imgX, imgY, scaledW, scaledH);

  // 在 canvas 上绘制选框轮廓（双保险，兼容 iOS 14.4 等旧设备 DOM 渲染问题）
  const sel = state.selection;
  if (sel && sel.w > 0 && sel.h > 0) {
    const sx = imgX + sel.x * scaledW;
    const sy = imgY + sel.y * scaledH;
    const sw = sel.w * scaledW;
    const sh = sel.h * scaledH;
    ctx.strokeStyle = '#6366F1';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(sx, sy, sw, sh);
    ctx.setLineDash([]);
    // 半透明填充
    ctx.fillStyle = 'rgba(99, 102, 241, 0.08)';
    ctx.fillRect(sx, sy, sw, sh);
  }
}

export function getImageCoords(clientX, clientY) {
  const rect = viewerWrapper.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;

  // ⚠️ 这里必须用 getBoundingClientRect 的宽高（不是 viewerCanvas.width），
  // 与 renderViewer 的差异是**刻意保留**的，详见 computeImageRect 的说明
  const { imgX, imgY, scaledW, scaledH } = computeImageRect(rect.width, rect.height);

  // 图片坐标 (0-1 归一化)
  const ix = (mx - imgX) / scaledW;
  const iy = (my - imgY) / scaledH;
  return { ix, iy, inImage: ix >= 0 && ix <= 1 && iy >= 0 && iy <= 1 };
}

/**
 * 合并同一帧内的视图重绘。
 *
 * 背景：pointermove 一个回调并联了
 * isDragging / isResizing / isPanning 三套逻辑，每套都各调一次
 * updateSelectionBox() + renderViewer()，**无节流、无 rAF 合并** ——
 * 移动端每次指针移动可能触发 2 次全画布重绘。
 *
 * 这里把重绘收敛成"每帧至多一次"。安全性依据：
 * state.selection / panX / panY 在监听器里**已同步更新**，
 * 重绘只读 state，因此延迟到下一帧画的必然是最新状态，不会画丢中间态。
 * 若已有排队的重绘则直接复用，不再重复排队。
 */
let viewerRedrawPending = false;
export function scheduleViewerRedraw() {
  if (viewerRedrawPending) return;
  viewerRedrawPending = true;
  requestAnimationFrame(() => {
    viewerRedrawPending = false;
    renderViewer();
    updateSelectionBox();
  });
}
