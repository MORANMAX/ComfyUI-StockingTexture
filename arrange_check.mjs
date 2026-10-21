// 离线复刻 ComfyUI 前端（1.53.10）的节点 widget 排布，验证“节点每帧长高”的失控循环。
//
// 下面的 distributeSpace / _arrangeWidgets 是从机器上装的前端产物里逐字抄出来的
// （.venv/Lib/site-packages/comfyui_frontend_package/static/assets/settingStore-CbkuaYBI.js）：
//
//   distributeSpace  @220966
//   _arrangeWidgets  @262459   （结尾那行是罪魁：!vueNodesMode && l > t && setSize(...)）
//   node.computeSize @239000 附近（loadWorkflow / expandToFitContent 走的那条）
//
// 只把渲染无关的部分（canvas 绘制）省掉了；尺寸算术一个字没改。

const Z = {
  NODE_TITLE_HEIGHT: 30,
  NODE_WIDGET_HEIGHT: 20,
  NODE_SLOT_HEIGHT: 20,
};

// ---- verbatim port ----------------------------------------------------------
function distributeSpace(space, items) {
  if (items.length === 0) return [];
  const sumMin = items.reduce((a, b) => a + b.minSize, 0);
  if (space < sumMin) return items.map((e) => e.minSize);
  let list = items.map((e) => ({
    computedSize: e.minSize,
    maxSize: e.maxSize ?? Infinity,
    remaining: (e.maxSize ?? Infinity) - e.minSize,
  }));
  let avail = space - sumMin;
  while (avail > 0 && list.some((e) => e.remaining > 0)) {
    const n = list.filter((e) => e.remaining > 0).length;
    if (n === 0) break;
    const each = avail / n;
    let used = 0;
    list = list.map((e) => {
      if (e.remaining <= 0) return e;
      const r = Math.min(each, e.remaining);
      used += r;
      return { ...e, computedSize: e.computedSize + r, remaining: e.remaining - r };
    });
    avail -= used;
    if (used === 0) break;
  }
  return list.map(({ computedSize }) => computedSize);
}

function arrangeWidgets(node, widgetStartY) {
  if (!node.widgets || !node.widgets.length) return;
  const t = node.size[1];                                   // bodyHeight == size[1]（litegraph 的 size 不含标题）
  const n = node.widgets_start_y ?? ((node.widgets_up ? 0 : widgetStartY) + 2);
  let r = t - n;
  let i = 0;
  const flex = [];                                          // 走 computeLayoutSize 的 widget（可伸缩）
  for (const w of node.widgets) {
    if (w.computeSize) {
      const h = w.computeSize()[1] + 4;
      w.computedHeight = h;
      i += h;
    } else if (w.computeLayoutSize) {
      const { minHeight, maxHeight } = w.computeLayoutSize(node);
      flex.push({ minHeight, prefHeight: maxHeight, w });
    } else {
      const h = Z.NODE_WIDGET_HEIGHT + 4;
      w.computedHeight = h;
      i += h;
    }
  }
  r -= i;
  node.freeWidgetSpace = r;
  const sizes = distributeSpace(Math.max(0, r), flex.map((e) => ({ minSize: e.minHeight, maxSize: e.prefHeight })));
  flex.forEach((e, k) => { e.w.computedHeight = sizes[k]; });

  let l = n;
  for (const w of node.widgets) l += w.computedHeight ?? 0;

  // ★ 就是这一行：经典画布模式下，只要 widget 摞起来比节点高，就把节点撑到那么高。
  //   它在节点每次重绘时都会跑一遍（drawNode → node.arrange() → _arrangeWidgets）。
  const vueNodesMode = node.__vueNodesMode === true;
  if (!vueNodesMode && l > t) {
    node.setSize([node.size[0], l]);
    node.__dirtied = true;                                  // 对应 graph.setDirtyCanvas(false, true)
  }
}

// node.computeSize() 里与 widget 有关的那几行（loadWorkflow / expandToFitContent 会用）
function nodeComputeSize(node) {
  const outs = Math.max(node.inputs, node.outputs);
  let y = 0;
  for (const w of node.widgets) {
    let h = 0;
    if (w.computeSize) h = w.computeSize()[1];
    else if (w.computeLayoutSize) h = w.computeLayoutSize(node).minHeight;
    else h = Z.NODE_WIDGET_HEIGHT;
    y += h + 4;
  }
  y += 8;
  return [/*width 与本题无关*/ 960, outs * Z.NODE_SLOT_HEIGHT + y + 6];
}

// ---- the node under test ----------------------------------------------------
// ComfyUI-StockingTexture：1 个输入、3 个输出、6 个普通 widget，外加 1 个 DOM widget。
// DOM widget 的高度，就是 web/stocking.js 第 1083 行那一句。
function makeNode({ fixed }) {
  const node = {
    size: [960, 900],                 // onNodeCreated: size = [max(960), max(900)]
    inputs: 3,
    outputs: 3,
    widgets_start_y: null,
    widgets_up: false,
    __vueNodesMode: false,            // 别人的机器：Comfy.VueNodes.Enabled 默认 false
    setSize(s) { this.size = s; },
    widgets: [],
  };
  for (const name of ['样式', '密度', '强度', '自动选择', '保存到output', '文件名前缀']) {
    node.widgets.push({ name });      // 普通 widget：前端按 NODE_WIDGET_HEIGHT 固定 20
  }
  const dom = { name: 'stocking_panel' };
  if (fixed) {
    // 修好的写法：让 widget 去“吃掉剩余空间”，高度不再反过来取决于节点高度
    dom.computeLayoutSize = () => ({ minHeight: 0, minWidth: 0, maxHeight: undefined });
  } else {
    // 现在的写法：widget 高度 = f(节点高度)
    dom.computeSize = () => [960, Math.max(560, node.size[1] - 120)];
  }
  node.widgets.push(dom);
  return node;
}

// ---- run --------------------------------------------------------------------
function run(label, { fixed }) {
  const node = makeNode({ fixed });
  const seq = [node.size[1]];
  for (let frame = 1; frame <= 400; frame++) {
    arrangeWidgets(node, 62);         // 3 个输出槽之后 widget 从这里开始；每帧重绘都会跑
    seq.push(node.size[1]);
  }
  const grew = seq[seq.length - 1] - seq[0];
  console.log(`\n=== ${label} ===`);
  console.log(`节点高度：第 0 帧 ${seq[0]} → 第 1 帧 ${seq[1]} → 第 2 帧 ${seq[2]} → 第 3 帧 ${seq[3]}`);
  console.log(`第 60 帧 ${seq[60]} ，第 400 帧 ${seq[400]}（400 帧 ≈ 7 秒 @60fps）`);
  console.log(`每帧增量 ${seq[1] - seq[0]} px ／ setDirtyCanvas(false,true) 自触发：${node.__dirtied ? '是（会无限循环）' : '否'}`);
  console.log(`结论：${grew > 1000 ? '失控——每帧都在长高，且永远不会回落' : '稳定——节点高度保持不变'}`);
  return { seq, grew };
}

const bad = run('现状（web/stocking.js 现在的写法）', { fixed: false });
const good = run('修好后（widget 改为可伸缩）', { fixed: true });

// 顺带验证第三方那条路（loadWorkflow / expandToFitContent 用 node.computeSize）
const n1 = makeNode({ fixed: false });
const n2 = makeNode({ fixed: true });
console.log('\n=== 另一条会撑高的路：node.computeSize()（打开工作流时执行一次）===');
console.log(`现状：computeSize 返回高度 ${nodeComputeSize(n1)[1]} → setSize(max(900, 它)) = ${Math.max(900, nodeComputeSize(n1)[1])}`);
console.log(`修好：computeSize 返回高度 ${nodeComputeSize(n2)[1]} → setSize(max(900, 它)) = ${Math.max(900, nodeComputeSize(n2)[1])}`);

console.log('\n=== 断言 ===');
console.log(`现状每 400 帧长高 ${bad.grew}px（应为失控）: ${bad.grew > 1000 ? 'PASS' : 'FAIL'}`);
console.log(`修好后 400 帧高度不变（${good.grew}px）: ${good.grew === 0 ? 'PASS' : 'FAIL'}`);
