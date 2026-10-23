// ============================================================
// js/main.js — 编排层
// ============================================================
// 本文件是**页面加载的最后一环**，取代了原来的单体 app.js。
//
// 各特性域全部落位到 js/ 下：
//     core/     dom.js        —— $ / $$ / DOM 引用 / isTouchDevice
//               state.js      —— 常量 / state / viewerCtx / 主题同步
//               serialize.js  —— 图纸序列化/版本化地基（纯函数，不写 state）
//               storage.js    —— 图纸存档存储层（localStorage 多份管理，不碰 DOM）
//     input/    upload.js     —— handleFile / showError / showToast / 上传区监听
//               camera.js     —— openCamera / capturePhoto / closeCamera
//     viewer/   viewer.js     —— computeImageRect / renderViewer / resizeViewerCanvas …
//               selection.js  —— updateSelectionBox / 选框拖拽
//               panzoom.js    —— 右键平移 / 滚轮 / 双指 / 窗口尺寸
//     pipeline/ render.js     —— drawGrid / drawRuler / pickTextColor / FONT_STACK
//               simplify.js   —— applySimplify / getStaticMergeMap …
//               grid.js       —— generateGrid / generateGridCore / adoptGrid
//               edit.js       —— 单元格编辑模型（纯数据 + 独立撤销栈）
//     output/   preview.js    —— fitPreviewGrid / computePreviewLayout / hitTestCell / renderPreview
//               stats.js      —— renderStats
//               export.js     —— computeDownloadSize / renderDownloadCanvas / downloadPNG …
//     ui/       a11y.js       —— announce / markActiveGridBtn / 键盘通路 / clamp
//               grid-select.js—— 网格预设 / 自定义 / 简化滑块 / 标尺开关
//                                + setSamplingControlsEnabled（6b：无原图时置灰）
//                                + refreshSamplingControls（6c：编辑锁）
//               library.js    —— 图纸存档 UI（保存/载入/删除 + 无原图展示路径）
//               edit-ui.js    —— 单元格编辑界面（指针命中 / 工具栏 / 选色 / 撤销）
//               loading.js    —— showLoading / hideLoading
//               install.js    —— PWA 安装提示
//
// ⚠️ **本文件当前不承载逻辑**，这是**有意为之**，不是遗漏：
//    跨领域编排（showViewer / reset / 事件装配）归 main.js，
//    但它们在步骤 5 中已随各自领域落位（如 showViewer 归 viewer.js）。
//    真正需要收拢的跨领域耦合（pointerup 反向驱动 generateGrid、
//    #resetBtn 横跨 5 个领域、pointermove 三合一回调）是**尚未执行的收尾工作**
//    的范围，尚未执行。
//
// ⚠️ 因此**不要**往本文件里堆新功能（防复发规则 1）：按特性域归位到 js/ 下。
//    本文件存在的意义是：步骤 6 收拢跨领域调用时有一个明确的落点，
//
// ⚠️⚠️ **下面这组 import 是页面能否工作的关键，不是装饰**。
//
//   ESM 的模块图是**从入口的 import 语句出发**解析的 —— 没有被 import 到的
//   文件**根本不会被浏览器请求**。本文件原先只有注释、一条 import 都没有，
//   于是 index.html 虽然写着 `<script type="module" src="js/main.js">`，
//   浏览器却只取到 main.js 一个文件，**其余 18 个模块全都没加载** ——
//   页面表现为"完全没反应"（而 jsdom 脚手架用的是真实 `import()` 整图，
//   所以**测试全绿也发现不了**，必须靠真实浏览器验证）。
//
//   实测证据：改成单入口后，Chrome 网络层只看到
//   `index.html / style.css / js/main.js / manifest.json / icon-*.png`，
//   一个 js/ 模块都没有。
//
//   **新增模块时必须在这里补一条 import**（若它不被其它模块引用），
//   否则那个文件永远不会被加载。
//
// 顺序说明：ESM 由解析器做拓扑排序，**这里的书写顺序不影响正确性**；
// 下面按领域层次排列，纯粹为了可读性。
// ============================================================

// 入口的副作用就是"把整张模块图拉起来"。
// 每个模块在被求值时都会完成自己的装配（DOM 引用、事件监听、状态初始化），
// 所以这里**不需要**再写任何编排代码 —— 见上方「本文件当前不承载逻辑」。
import { $, fileInput } from './core/dom.js';
import { resetDocumentState } from './core/state.js';
// 序列化地基：纯函数层，被 6b 的 storage.js 引用，
// 因此即使不写这一条它也是可达的 —— 但**保留显式一条**（与下面的 storage.js 同理）：
// 入口的 import 列表是"页面会加载哪些文件"的真源，让人一眼看全比省一行重要。
import './core/serialize.js';
// 图纸存档存储层（js/core/storage.js）：
// 它被 js/ui/library.js 引用，故可达；此处仍显式列一条，理由同上。
import './core/storage.js';
import './input/camera.js';
import { setFileLoadedHandler } from './input/upload.js';
import './pipeline/render.js';
import './pipeline/simplify.js';
import { generateGrid } from './pipeline/grid.js';
// 单元格编辑模型层（js/pipeline/edit.js）：
// 它被 edit-ui.js 与 grid-select.js 引用，故可达；此处仍显式列一条，
// 理由同 storage.js —— 入口的 import 列表是"页面会加载哪些文件"的真源。
import { resetEditState } from './pipeline/edit.js';
import { setExitArchiveHandler, setViewerReadyHandler, showUploadStage, showViewer } from './viewer/viewer.js';
import { setSelectionChangeHandler } from './viewer/selection.js';
import './viewer/panzoom.js';
import './output/preview.js';
import './output/stats.js';
import './output/export.js';
import './output/print.js';
import { markActiveGridBtn } from './ui/a11y.js';
import { resetSimplify } from './ui/grid-select.js';
// 图纸存档界面层（js/ui/library.js）：
// ⚠️ **它是本模块唯一的"装配入口"** —— 没有任何别的模块 import 它
//    （它是 UI 叶子：按钮监听与初始化都在它自己顶层），
//    所以**漏了这一条它永远不会被浏览器请求**，页面表现为"存档功能完全不存在"。
//    
import { exitArchiveMode } from './ui/library.js';
// 单元格编辑界面层（js/ui/edit-ui.js）：
// ⚠️ 与 library.js 同类 —— 它是 **UI 叶子**（指针监听、工具栏、快捷键都在它自己顶层），
//    没有任何别的模块 import 它，**漏了这一条它永远不会被浏览器请求**，
//    页面表现为"编辑工具完全不存在"。
import './ui/edit-ui.js';
// 全色板选择器（js/ui/palette-picker.js）：
// ⚠️ 与 library.js 同类 —— 它是 **UI 叶子**（按钮、筛选、键盘、焦点陷阱都在它自己顶层），
//    没有任何别的模块 import 它，**漏了这一条它永远不会被浏览器请求**，
//    页面表现为"「🎨 全部色板」点了没反应"。
import './ui/palette-picker.js';
import './ui/loading.js';
import './ui/install.js';

// ============================================================
// 跨领域编排
// ============================================================
// 这里是**唯一**允许出现"跨领域调用"的地方：把某个域导出的回调 setter，
// 用另一个域的函数注入进去。方向恒为
//     叶子模块 export setter  →  main.js 调 setter
// 绝不允许被注入方反向 import —— 那正是这些 hook 要拆掉的耦合形状。
//
// ⚠️ **一段编排 = 一条跨域边的消失**。加新段之前先确认它真的属于编排，
//    而不是"某两个域本来就该单向依赖"（后者不需要 hook）。
//
// ⚠️ **未注册 handler 时叶子模块只 console.warn 不抛错**：
//    抛错会让页面白屏，比"少一次自动重算"严重得多。
// ============================================================

// 选框松手 → 重算图纸。
// 改造前 `js/viewer/selection.js` 顶部直接 `import { generateGrid } from '../pipeline/grid.js'`，
// 选框领域反向驱动生成。现在该文件改为导出 `setSelectionChangeHandler(fn)`，由这里注入。
//
// ⚠️ 时序契约不变：`generateGrid()` 返回时 `state.gridData` 仍是上一轮
//    （真实生成推迟到 rAF）。经 hook 调用不影响它。
setSelectionChangeHandler(generateGrid);

// 上传完成后进入查看器。
// 改造前 `js/input/upload.js` 顶部直接 `import { showViewer } from '../viewer/viewer.js'`，
// input 域反向依赖 viewer 域。
setFileLoadedHandler(showViewer);

// showViewer() 的两条反向调用改由这里注入：
//   · 原先 `viewer.js` 在 rAF 里直接调 `generateGrid()`（viewer 域 → pipeline 域）；
//   · 原先 `viewer.js` 在 return 前直接调 `exitArchiveMode()`（viewer 域 → ui 域）。
// 两条都拆掉后，`js/viewer/viewer.js` 的**跨域出边为 0**。
//
// ⚠️ 这里是**两段独立注入**，不是一段：它们的触发时机不同 ——
//    `exitArchiveMode` 在 showViewer() 同步段里跑，`generateGrid` 在下一帧的 rAF 里跑。
setViewerReadyHandler(generateGrid);
setExitArchiveHandler(exitArchiveMode);

// ============================================================
// #resetBtn「重新上传」的 5 域编排
// ============================================================
// 改造前这段逻辑住在 `js/ui/a11y.js` 的点击回调里：
//   一次点击写 9 个 state 字段 + 调 3 个别的域 + 清画布 + 5 个区块显隐 + 3 个按钮禁用。
// 也就是说 a11y 域（播报/键盘）反向牵着 pipeline、ui、viewer 三个域。
// 现在拆成「各域自己的复位动作」，由本文件按次序串起来。
//
// ⚠️ **这里的调用次序与改造前逐句一致，但那只是为了让本次 diff 只体现搬家。**
//    **不要把它读成"必须"** —— 已逐条核算过，这几个调用之间**没有**真实
//    数据依赖（两种次序的终态都正确）：
//      · resetEditState ↔ resetSimplify 谁先都行（两者都走到 refreshSamplingControls，
//        读的是 hasAppliedEdits()，终态一致）；
//      · gridW/gridH = 29 早于 markActiveGridBtn(29) 无必要（后者按参数点亮，不读 state）；
//      · exitArchiveMode ↔ showUploadStage 目标集合不相交（前者管采样控件 disabled，
//        后者管区块显隐与三个按钮）。
//    把这些写成"必须"会让后来的人不敢调整。
$('#resetBtn').addEventListener('click', () => {
  // ① 纯数据复位（住在 core/state.js，不碰 DOM）
  resetDocumentState();
  // ② 各域自己的复位动作（各自的入口，不是本文件造的）
  resetEditState();      // pipeline/edit.js —— 撤销栈、工具、画笔色都不跨图纸保留
  resetSimplify();       // ui/grid-select.js —— 简化强度回到 0
  markActiveGridBtn(29); // ui/a11y.js —— 点亮默认网格尺寸按钮
  // ③ 界面回到上传阶段（画布 / 选框 / 5 个区块 / 3 个按钮）
  showUploadStage();     // viewer/viewer.js
  // ④ 存档模式也要退出：重置是"回到最初"，此时既无原图也无图纸，
  //    留着"已载入存档…"的横幅与置灰控件会与界面对不上
  exitArchiveMode();     // ui/library.js
  // ⑤ 清空 file input，让用户可以重新选同一个文件（否则 change 不触发）
  fileInput.value = '';
});
