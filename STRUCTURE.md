# 目录说明 — 丝袜纹理 Stocking Texture

> 这份文档是给**下一个接手的人**看的（会话可能已经换了一轮，聊天记录不在了）。
> 它只回答一件事：**哪个文件是干什么的，动它之前必须知道什么。**
>
> 面向使用者的说明在 [`README.md`](README.md)；这份是面向改代码的。

| | |
|---|---|
| 节点位置 | `G:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\custom_nodes\ComfyUI-StockingTexture` |
| 对应备份 | `custom_nodes\_backups.disabled\Stocking Texture 2`（**上一版**，不含 `models/`，也不含本轮四项改动） |
| 上游 | [silvermoong/stocking-texture-tool](https://github.com/silvermoong/stocking-texture-tool)（MIT），本地副本 `G:\siwa` |
| 规模 | 节点自身 Python 约 1.2k 行 + 前端约 1.0k 行；`upstream/` 约 4.9k 行（原版算法）；`panel/` 约 2.9k 行（原版界面，本轮有改动，见 §2.4） |

---

## 0. 一句话架构

```
采样器 ──IMAGE──►  本节点  ──IMAGE──►  保存图像 / 预览 / 下一段采样器
                     │
                     ├─ 节点体内嵌一个 iframe，里面跑【原版桌面工具的整页界面】
                     └─ 界面下方一条【成品】栏：缩略图 + 放大 + 保存
```

节点自己**没有一行纹理逻辑**。算法全部来自 `upstream/`（原版 `stocking/` 包），编辑界面全部来自 `panel/`（原版 `static/`）。
节点只做原版页面做不到的三件事：

| # | 做什么 | 经过 |
|---|---|---|
| 1 | 把 socket 上的图**交给**界面 | `nodes.apply` → `routes.adopt` → `docstore.store.acquire` |
| 2 | 把界面的结果**送回** socket | `docstore.render` → `nodes.apply` 的 IMAGE 输出 |
| 3 | 把成品**显示在节点里**（界面做不到：它是整页布局，没有可放成品的地方） | `web/stocking.js` 的预览条 → `/stocking/api/doc/{id}/result` → `docstore.render` |

编辑动作（点选 / 画笔 / 橡皮 / 切开 / 走向 / 隔开 / 镜像 / 求解 / 渲染）走的是**原版自己的 HTTP 路径**：
页面 → `fetch('/api/...')` → *shim 改写成* `/stocking/api/...` → `routes.py` → `upstream` 的 Document。

> 所以「面板里看到的图」和「socket 上输出的图」是同一张图，**按构造保证**，预览条也是直接问这条路要的同一张图，不是第二份实现。

---

## 1. 目录树

```
ComfyUI-StockingTexture/
├── README.md            面向使用者：装什么、怎么用、按钮干什么
├── STRUCTURE.md         ← 本文件
├── __init__.py          节点入口：注册节点、挂路由、预载模型
├── nodes.py             ★ 节点本体（INPUT_TYPES / apply / 自动选择）
├── routes.py            ★ 面板的 HTTP API（原版路由搬到 aiohttp 上）
├── docstore.py          ★ IMAGE socket ↔ 原版 Document 的桥
├── auto.py              自动找丝袜的预处理（只提议部位，不画走向线）
├── e2e_check.py         无浏览器自检：图 → Document → 求解 → 渲染
├── arrange_check.mjs    ★ 无浏览器自检：节点会不会自己长高（§4.6 / §6），把前端的排布算术抄成最小模型
│
├── web/                 ★ 节点自己的前端扩展（会被 ComfyUI 当扩展加载）
│   ├── stocking.js        挂 iframe、自己 link stocking.css、四个按钮、原图放大、预览条（处理前/成品并排 + 缩略图/放大/保存）、分隔条、右下角拖动把手、全屏、拒收 ComfyUI 自己那份成品图
│   └── stocking.css       节点外壳的样式（页面自己的样式在 panel/style.css）
│
├── panel/               原版页面（**不能**放进 web/，见 §4.1）
│   ├── index.html         原版 index.html，改 title、3 个路径，多引 shim.js，**并多「平滑」滑杆和「锁定图片」按钮**
│   ├── app.js             原版 1885 行 → 2240+ 行，**改了**：画笔平滑（§2.4.1）+ 锁定图片（§2.4.2）+ 走向/隔开线的几何平滑（§5.9）
│   ├── look.js            原版 834 行 + 导出对象上多一个 `reload()`（节点改样式后让界面重读，§5.9）
│   ├── style.css          原版 + 1 条 `#btn-lock` 边距
│   ├── i18n.js            原版，**一字未改**
│   ├── i18n/en.json       原版 + 新词条（平滑 / 它的 tooltip / 锁定图片 / 两条锁提示）
│   ├── icon.ico / icon-256.png  原版
│   └── shim.js            ★ 新写的文件：把请求改道到 /stocking/，并在每次改图后通知节点
│
├── upstream/            原版算法层（stocking/ 包的副本，见 §2.2 的差异清单）
├── models/              权重（453MB，不进备份）
└── __pycache__/         忽略
```

★ = 我们自己写的。其余是原版文件。

---

## 2. 逐文件

### 2.1 根目录 —— 节点本体（全部新写）

| 文件 | 行 | 职责 | 关键点 |
|---|---|---|---|
| `__init__.py` | 28 | 导出 `NODE_CLASS_MAPPINGS`、`WEB_DIRECTORY`；导入时挂路由、预载模型 | `WEB_DIRECTORY = './web'` **只能**放节点自己的扩展，见 §4.1 |
| `nodes.py` | 299 | 节点定义 | `OUTPUT_NODE = True`（否则图到这就断，ComfyUI 会报 `prompt_no_outputs`）；`IS_CHANGED` 恒返回 `nan`（结果依赖面板里的编辑，图上看不出来，必须每次重跑）；`apply()` 里 `_report_text` 的**判断顺序**有意义：先判"没有部位"，再判"有部位但没有走向线"，两者的修法不同；render 前有 `doc.wait_idle(RENDER_WAIT)`，见 §3.4 |
| `routes.py` | 830 | 面板的 HTTP API，48 个路由 | 全是 `upstream` Document 方法的薄壳。公开入口只有 `register()`（挂路由）和 `adopt(rgb)`（把图变成当前文档）。`_current()` 拿"面板正在编辑的那个文档"。`/doc/{id}/result`（预览条的**成品**格）与 `/doc/{id}/art`（**处理前**格）都收 `w=`，`w>0` 时在服务端缩放再编码（见 §3.4）；`/doc/{id}/regions/{rid}/material` 换材质 |
| `docstore.py` | 155 | 在"socket 收到图"与"socket 要答案"之间**持有** Document | 缓存 8 个文档 / 1 小时；`acquire()` 认图靠**尺寸 + 32×32 灰度指纹**——第一次排队时前端 widget 还没序列化进 prompt，节点没有 id，只能靠指纹认出"这张图我见过"；`render()` 无部位时原样返回输入（`empty: True`），这是合法状态 |
| `auto.py` | 546 | 自动找丝袜 | 三条路径按优先级：外部 MASK socket > SAM > 纯颜色。**只提议部位**。它刻意不点"深度最近的物体"——那通常是伸向镜头的手/膝盖/脸，会把一只手分割出来 |
| `e2e_check.py` | 133 | 无浏览器自检 | 命令行跑整条链路，报成品与输入的差异百分比 |

### 2.2 `upstream/` —— 原版算法层

原版 `G:\siwa\stocking\` 的副本。**它并非 100% 逐字一致**，改动清单如下（⚠️ 不要盲目用上游覆盖回来）：

| 文件 | 与上游的关系 |
|---|---|
| `coverage.py` `document.py` `export.py` `guide_fields.py` `i18n.py` `knit.py` `look.py` `oily.py` `presets.py` `settings.py` `split.py` `symmetry.py` `tiles.py` `trace.py` `version.py` `walls.py` | **逐字一致**（16 个） |
| `_loads.py` | **新增**。一个全局锁，见 §4.3 |
| `depth.py` | **改**：模型构造处包了 `_loads.LOCK` |
| `sam.py` | **改**：模型构造处包了 `_loads.LOCK` |
| `psd_io.py` | **改**：`psd-tools` 改成可选依赖（`try/except ImportError` + 新增 `_need_psd()` 守卫，加在 3 个读 PSD 的函数上）。原因：ComfyUI 环境里通常没装 `psd-tools`，不能因为缺它就让整个算法层 import 失败。另：此文件行尾是 CRLF，上游是 LF |
| `__init__.py` | **改**：上游是空文件，这里加了说明性 docstring |
| `static/` | **逐字一致**（含 `index.html`）。`panel/` 里的同名文件就是从这来的，除了 `index.html` 和 `shim.js`，见 §2.4 |

要点：

- `document.py`（1176 行）是核心：拥有 art / regions / strokes / 求解 / 撤销栈 / coverage。
- `look.py`（538 行）拥有样式、密度、强度、亮点；渲染入口 `look.scene_from_doc(doc, disparity=...)`。
- `version.py` / `settings.py` / `presets.py` 很小，但别删——上游代码内部会 import。

### 2.3 `web/` —— 节点自己的前端扩展

**这个目录下的每个 `.js` 都会被 ComfyUI 递归收集并 import 进主页面当扩展。** 所以这里只放节点自己的东西。

| 文件 | 行 | 职责 |
|---|---|---|
| `stocking.js` | 1389 | 用 `addDOMWidget` 把 iframe 塞进节点；自己 link `stocking.css`（`loadStyles`）；顶栏六个按钮（自动选择丝袜 / 取用节点图片 / 原图放大 / 全屏 / **送入下游**（`PUSH_AVAILABLE=false`，置灰保留）/ 状态）；界面下方一条**预览条**（处理前 / 成品**左右并排** + 刷新 / 放大 / **保存** / 收起）；编辑区与预览条之间的**分隔条**；右下角**拖动把手**；拒收 ComfyUI 自己那份成品图（`hideOutputPicture`）；`onExecuted` 里把节点最新的 `sid` 推给面板；widget ↔ 界面 look 的双向同步（`WIDGET_LOOK` / `flushWidgetLook` / `syncWidgets`） |
| `stocking.css` | 266 | 节点外壳样式。`panel/style.css` 管页面内部，这个只管外面那一圈。**ComfyUI 不会自动加载它**，见下面第 7 条 |

`stocking.js` 里的几个设计决定：

1. **用 iframe 而不是重写**。原版页面有自己的全局按键监听、`document.querySelector`、i18n 模块；直接搬进 ComfyUI 主页面会互相打架。iframe 给它一个独立 document。
2. **默认尺寸 960×900**（`DEFAULT_W` / `DEFAULT_H`），因为页面是"侧栏 + 画布"的窗口型布局，litegraph 默认的 ~270px 宽会让工具栏挤成一列。`MIN_H = 560` 以下页面布局会坏。
3. **只有一个面板**（`hostWidget` / `hostNode`）。服务端同一时刻只有一个文档，两个节点各挂一个面板会争同一个文档，所以先挂的当宿主。
4. **预览条是"节点的图"，而"节点的图"就是文档的图**。它请求 `/result` 时**不带**任何样式参数，服务端按 `doc.look`（界面上的设置）渲染；节点自己的 `样式/密度/强度` widget 会先 `PATCH` 进同一份 look，所以栏里的图、socket 上的图、`output/stocking/` 里的图仍然按构造相同。**第六轮之前是相反的做法**（栏里带 widget 的三个值，服务端也只认这三个键），结果是界面换材质后成品不动 —— 详见 §5.9。
5. **预览条出现时会先把节点垫高**（`growForResult`）。页面是按窗口排版的，预览条要是白拿页面的高度，编辑区就被压扁了 —— 所以第一次有东西可显示时，节点长高「预览条的高度」，编辑区保持原样；之后就交给拖动把手去权衡。判断"这个节点是不是已经垫过"用的是 `node.size[1] < DEFAULT_H + 100`。
6. **拖动把手（`wireGrip`）改的就是 `node.setSize`**，和拉节点右下角是同一件事；ComfyUI 自己画的那个把手被 DOM widget 盖住了，够不着，所以在面板右下角重画了一个。全屏时隐藏（那时没有节点可改大小）。
7. **`stocking.css` 必须由 `stocking.js` 自己挂上，不要指望 ComfyUI**。`WEB_DIRECTORY` 只把 `**/*.js` 当扩展喂给前端（`server.py` 的 `/extensions` 路由只 glob `.js`），目录本身取得到，但**没有任何地方 link 这个 css**。没挂上时：作者写的那几条 `display` 全失效 → 处理前/成品**上下堆叠**、条带没有高度上限（两张原尺寸位图把节点撑爆，界面发卡）、`.stocking-grip` 只是个看不见的 18px 空 div（点不到）。所以 `loadStyles()` 用 `import.meta.url` 解析路径去 link，失败就注入 `CSS_FALLBACK`（几何抄了一份：宁可朴素，不能没布局）。**改这个 css 之前先确认这条路还在。**
8. **拒收 ComfyUI 自己那份成品图**（`hideOutputPicture`）。节点有 IMAGE 输出，前端就会在节点里**再画一遍**这张图（占地方、还带 "832 x 1216" 尺寸标注），而它和预览条里的是同一张图。做法是前端自己的逐节点开关 `node.hideOutputImages` —— ComfyUI 自己的 `Painter` / `ImageCropV2` / `ImageCompositor` 就是用这一行关掉的，不是猜出来的 —— 外加把 `imgs` 钉成空：**老画布模式的预览 widget 是前端在每次重绘时按 `imgs` 重建的**（`onDrawBackground` → `unsafeUpdatePreviews` → `showCanvasImagePreview`，没有节流），所以「把那个 widget 删掉」一定会被下一帧加回来（`$$canvas-image-preview` 这个名字就是它找的）。`ui.images` **保持不动**，队列/历史里照样有这张图，`保存到output_save` 也照样写盘。
9. **预览条的高度**：`.stocking-result` 用 `height:clamp(150px,28%,420px)` 限高（不限高就是那张会撑爆节点的全尺寸位图）；用户拖过的高度存 `localStorage`，拖的时候用 inline `height` 盖住 clamp；节点被拉小后 `clampStrip` 把条带收回可用空间（可用 = 节点高 − `chromeHeight()`（**实测**顶栏与分隔条，不用反推） − 编辑区保底 `EDITOR_MIN=220`）；双击分隔条清掉记忆、回到默认。两张 pane 的图都走**服务端缩略图**（`/art?w=` 与 `/result?w=`，`THUMB_W=512`），只有「放大」和「保存」才要原尺寸。

### 2.4 `panel/` —— 原版页面（**不是** ComfyUI 扩展）

`panel/` 是原版 `static/` 的副本，差异见下（⚠️ 现在 **`app.js` / `look.js` 已经不是逐字一致了**，用上游覆盖回来会丢掉画笔平滑、锁定图片和走向线的平滑）：

| 改动 | 原因 |
|---|---|
| `<title>` `丝袜纹理工具` → `丝袜纹理` | 嵌在节点里，标题短一点 |
| 3 个 `/static/...` → `./...`（icon.ico / icon-256.png / style.css） | 页面挂在 `/stocking/panel/` 下，没有 `/static/` |
| `<script type="module" src="/static/app.js">` → `./app.js` | 同上 |
| **新增** `<script src="./shim.js"></script>` | 唯一的实质新增，见下 |
| **新增** 笔刷滑杆下面的「平滑」滑杆（`#brush-smooth`） | 需求 1 的界面部分；`app.js` 里对应的是 §2.4.1 |
| **新增** 顶栏 `100%` 右侧的「锁定图片」按钮（`#btn-lock`） | 需求 2 的界面部分；`app.js` 里对应的是 §2.4.2 |
| **`app.js` 的改动** | 加了画笔平滑（§2.4.1）、锁定图片（§2.4.2）、走向/隔开线的几何平滑（`smoothLine`/`dragPath`，§5.9），以及一个 `message` 监听（`{stocking:"look"}` → `lookUI.reload()`）。其余（工具、命中测试、求解状态、快捷键、导出）原样 |
| **`style.css` 的改动** | 只加了 `#btn-lock { margin-left: 6px; }` 一条 |
| **`i18n/en.json` 的改动** | 平滑 / 它的 tooltip / 锁定图片 / 两条锁提示，共 5 条 |

⚠️ `panel/index.html` 是 **CRLF**，`upstream/static/index.html` 是 **LF**。所以直接 `diff` 会整份标红，别被骗。要看真实差异：

```bash
diff -u <(tr -d '\r' < upstream/static/index.html) <(tr -d '\r' < panel/index.html)
```

`panel/shim.js`（185 行）是整份页面里新写的 JS，它补四件原版默认、但在这里不成立的事：

| # | 补什么 | 怎么做 |
|---|---|---|
| 1 | 路径 | `fetch`、`EventSource` 和 `<img>` 的 `src` setter 都在这里被换掉；`/api/...` → `/stocking/api/...`。`<img>` 那个最容易漏，见 §4.4 |
| 2 | 没有文件对话框 | 隐藏"打开…"，把空状态的按钮改成「取用节点图片」 |
| 3 | 没有事件流 | `EventSource` 换成一个只在下一个 tick 触发一次 `onopen` 的哑对象（`app.js` 的**首次**文档拉取挂在 `onopen` 上，所以不能简单地什么都不做） |
| 4 | 没有人告诉节点"图变了" | 预览条要跟着编辑刷新，而所有编辑都走这里的 `fetch`。每个**改到本文档**的非 GET 请求成功后 `postMessage({stocking:'changed'})` 给父页面；节点自己防抖。GET 和 `/open/...`、`/lang` 不算 |

#### 2.4.1 `app.js` 里新加的画笔平滑（需求 1）

`panel/app.js` 其余部分没动，只多了一块「平滑」（搜索 `平滑` 或 `followStep`）：

| 位置 | 改了什么 |
|---|---|
| `S.smooth` | 新状态，0–100，默认 0 |
| `setSmooth()` / `#brush-smooth` 监听 / 启动时 `setSmooth(S.smooth)` | 滑杆接线，和 `setBrush` 完全对称 |
| `dragLag()` `refreshLag()` `dragStep()` `emitDrag()` `advanceDrag()` | 死区（防抖）本体 |
| `smoothSpeed()` `smoothAlpha()` | 减速（惰性）本体 |
| `followStep()` | 一帧的惰性滤波：把 `d.aim` 向指针拉近一小段，再让 `advanceDrag` 走到那里 |
| `startFollow()` | 改：RAF 循环按帧推进 —— 滤波只在这里步进，与指针采样率解耦 |
| `pointerdown`（画笔/橡皮、走向/切开/隔开） | `S.drag` 多了 `follow`（画点）、`aim`（惰性目标）、`lag`、`minStep` |
| `pointermove` | 每个合并采样点只更新 `d.last`（指针在哪）；**不再自己推进画点**（平滑 > 0 时） |
| `draw()` | 新：平滑 > 0 且绘制中时，画光标与画点之间的虚线引导线（见下） |
| `endDrag` | 松手时 `lag = 0`、`aim = 指针` 再走一遍，把剩下的路收完 |
| `smoothLine()` `dragPath()` `SMOOTH_REACH` | **第六轮加的**：走向 / 隔开线的**几何**平滑（上面那套只改"什么时候动"，不改线的形状）。`endDrag` 提交前过一遍，`draw()` 里的实时线也过同一遍 |

平滑由**两个机制**构成，都是连续的：

**（a）死区 —— 防抖。** 指针在一个小半径内抖动时画点完全不动。半径 = `平滑% × max(笔刷, 6) × 2`。关键是它**会衰减**：`refreshLag()` 在前 180 ms（`LAG_DECAY`）内把半径线性收敛到 0。

- 固定死区的旧做法会让画点**永远**落后一个固定距离 —— 那是"滞后"不是"平滑"，正是"画笔不跟着鼠标走"。
- 衰减后只在起笔瞬间防抖，长笔画全程跟手。
- `平滑 = 0` → 半径 0，画点就在指针上，**行为与改之前逐点一致**。

**（b）惰性 —— 减速。** 画点追一个"惰性目标" `d.aim`，每帧向指针靠拢一个比例（一阶低通）：

```
alpha = 1 - exp(-dt / tau),   tau = 90 ms × (平滑 / 100)      →  0 .. 90 ms
速度 = 1 - 0.3 × (平滑 / 100)                                    →  100% .. 70%（最多减速 30%）
```

`followStep(d, dt)` 每帧把 `d.aim` 拉近，再让 `advanceDrag` 把画点走到 `d.aim`。**滞后量 = 手速 × tau**，所以：

- 手比阈值慢 → 几乎完全跟手（**慢速精修不受影响**）。
- 手比阈值快 → 画点稳定落后一个固定距离，看起来就是笔"拖不动" —— 这就是减速。
- **关键：滞后量有界，不会发散。** 用 `1 - exp(-dt/tau)` 而不是定长 lerp，所以掉帧也能平滑追上，且与刷新率无关。

> ⚠️ **不要再用"每帧限额 + 超出丢弃"实现减速。** 曾经这么做过：`pointermove` 给一个每帧预算，超出的距离直接扔。结果是**瞬移** —— 手快速拖动时画点被卡住不动（超出全被丢），等手一停、80 ms 后走 `Infinity` 一次性收线，画面就是"鼠标拉到位、画笔突然瞬移过去"。减速必须是一个**速率**（连续地慢），不是一个攒起来一次性付清的**欠账**。

松手时（`endDrag`）`lag = 0`、`aim = 指针`，把剩下的路一次走完，所以笔画终点仍落在指针位置。

**（c）PS 式拖拽预览。** `draw()` 末尾：平滑 > 0 且正在画自由笔画时，从画点（`d.follow`）到光标（`S.mouse`）画一条虚线的引导线，画点上一个实心小圆。两点重合时（画点已追上光标）不画线，只留圆点。

三个坑：

1. **必须有个 `FOLLOW_EPS`（1e-6 px）死区。** 没有它，`dist - lag` 会因浮点误差落在 `lag` 上方，画点一步挪百万分之一像素、判定"还没到"、空转 —— 加上死区后同一条抖动路径从 150k 个废点降到 448 个。
2. **`lineTo` 的顺序有讲究**：`emitDrag(d, from, q)` 里 `from` 是**移动前**的 `d.follow`；旧代码在 `paintLocal` 之前就改了 `d.follow`，第一段会画成零长线段。
3. **滤波只在 RAF 里步进，不在 `pointermove` 里。** 指针采样是突发、速率不定的（取决于鼠标硬件），在那里步进会让"拖尾的紧实度"随硬件变化。

浏览器实测（真实 `app.js` 函数，非复刻）与离线仿真一致：

| 指标 | 平滑 0 / 25 / 50 / 100 |
|---|---|
| 慢速 300 px/s 末帧落后 | 0 / 4.6 / 11.2 / 24.7 px（轻微跟随滞后，非硬滞后） |
| 快速 1200 px/s 末帧落后 | 0 / 18.5 / 45 / 98.7 px（随平滑递增，**恒定不发散**） |
| 单帧位移比（画笔/指针） | 1.00 / — / 1.05 / 1.01（**无瞬移**） |
| 3600 px/s 甩动后停手 | 落后 292.6 px → 收敛到 **0** |
| 稳态滞后 vs 速度（平滑 100） | 120→9.9 / 300→24.7 / 600→49.3 / 1200→98.7 / 2400→197.4 / 4800→394.7 px（≈ 速度 × tau） |

要重跑就把 `advanceDrag` / `followStep` / `smoothAlpha` / `refreshLag` / `dragLag` 抄进一个 node 脚本，`S = {brush: 20, smooth: n}` 即可。

#### 2.4.2 `app.js` 里新加的锁定图片（需求 2）

编辑区（画布）会因**空格/中键拖动、方向键、滚轮、适应窗口、100%、+ − F 1** 而移动，画细节时容易误触。顶栏加一个按钮把这套视图变换冻住。

| 位置 | 改了什么 |
|---|---|
| `S.locked` | 新状态，默认 `false` |
| `#btn-lock` / `setLocked()` / `renderLock()` | 按钮接线与文案。**文案按"按下会做什么"写**：未锁显示 `🔓锁定图片`，已锁显示 `🔒解锁图片` |
| `zoomAt()` | 开头 `if (S.locked) return` —— 滚轮、`zoomCentre`、`+ − 1` 全走这里 |
| `fit()` / `fitNow()` | 拆成两个：`fit()` 是用户的「适应窗口」，受锁限制；`fitNow()` 是系统内部（`applyState` 打开新文档时），**无视锁**——新图必须落到适应窗口的位置，否则锁着换图会看到一张没对好的画 |
| `pointerdown` | 中键/空格的 pan 分支加 `if (S.locked) return`；中键在锁定时直接吞掉，不再走后面的工具分支 |
| `pointermove` pan | 补一道 `if (!S.locked)`（锁是拖动中途按下的也要立刻停住） |
| `keydown` | Space 不进入 pan 态；方向键 `return`；`+ − F 1` 各自加锁判断 |
| `wheel` | 仍 `preventDefault()`（否则锁定时 iframe 会横向滚），然后 `if (S.locked) return` |

设计要点：

1. **闸门放在 `zoomAt()` / `fit()` 两个底层函数上，不是散在各个入口。** 审计过：全文件对 `S.view` 的写入只有 5 处 —— `fitNow()`、`zoomAt()`、`pointermove` 的 pan、`keydown` 的方向键。前两个是闸门本身，后两个各自守了一道。这样**新增任何"移动画面"的入口只要走 `zoomAt` 就自动被锁**，不会漏。
2. **锁不拦编辑。** 锁的是视图（平移/缩放），不是数据 —— 画笔画画、点选、求解、导出照常。锁着照样能画，只是画面不动。
3. **锁定时无 pan 光标。** `panning`/`dragging` 两个 class 在锁定时不会被加上（进不去 pan 分支），所以 `cursor` 不会骗人。
4. **按钮在纹理页隐藏**，靠 `edit-only`（`style.css` 第 327 行的 `body[data-mode="look"] .edit-only { display: none !important; }`），不用额外规则。

浏览器实测（无 ComfyUI 后端，静态服务 + 真实 Chromium）：

| 状态 | 按钮文案 | `aria-pressed` | `stage.locked` |
|---|---|---|---|
| 初始 | `🔓锁定图片` | false | false |
| 点一次 | `🔒解锁图片` | true | true |
| 再点一次 | `🔓锁定图片` | false | false |

并且布局正确：按钮在 `100%` 右侧同排（x=922 vs 806，y=8，h=28）。切换时状态栏会 flash「已锁定图片：画面不再随拖动或缩放移动」/「已解锁图片：可以拖动和缩放画面了」。

### 2.5 `models/`

| 文件 | 大小 | 用途 |
|---|---|---|
| `sam_vit_b_01ec64.pth` | 358MB | 点选分割（必需） |
| `Depth-Anything-V2-Small-hf/` | 95MB | 深度（可选；缺了只影响自动方位精度和亮点） |

不进备份。原版工具与本节点共用同一份。

---

## 3. 三条链路

### 3.1 图怎么进来的（"接图后自动进编辑区"）

```
采样器 → nodes.apply(image)
        ├─ _to_rgb(frame)                      float HxWx3 → uint8
        ├─ routes.adopt(rgb)                   ├─ docstore.store.acquire(rgb)   认图：id → 尺寸 → 指纹
        │                                      └─ _doc_holder.d = doc           设成"面板正在编辑的文档"
        └─ ui = {text, stocking:[{sid,ready,w,h}], images:[...]}
                 ↓ 经 onExecuted 到 web/stocking.js
           card.sid ≠ 面板当前的 sid → adoptInto(p) → POST /open/socket → location.reload()
                 ↓ 页面重新加载后
           app.js 从 es.onopen 里 GET /stocking/api/doc，拿到 state，画出来
```

`IS_CHANGED` 返回 `nan` 保证每次排队都重跑，所以"再排一次队，面板里就是新图"。

### 3.2 编辑怎么走的

页面里每一次点击 → `app.js` `request()` → `/stocking/api/doc/{id}/...` → `routes.py` → `upstream` Document 的方法。
**节点不介入**。所以原版的行为（包括 SAM 的三档范围、切开自动贴线、镜像、撤销栈）全部原样可用。

### 3.3 成品怎么出去的

```
doc.wait_idle(60)            等还在求解的部位（见 §3.4 第 2 点）
  ↓
新文档（没有 look）→ 用节点三个 widget 播种一次：doc.set_look(...)   ← 只在没人动过界面时发生
  ↓
routes.take_pushed(doc)       「送入下游」锁定的那张还在、签名没变 → 直接交它，不再渲染
  ↓ 没有
docstore.render(doc, None)   ← 参数 = 文档自己的 look（界面上的设置），见 §3.4 决定 1
  ├─ look.clean_params({**DEFAULTS, **doc.look, **params})     参数清洗
  ├─ 无部位 → doc.art.copy()  原图返回（'empty': True）——这是合法状态，不是错误
  └─ look.scene_from_doc(doc, disparity=lambda: ...).render(q)   ← 原版渲染器
        ↓
  IMAGE / MASK / STRING 三个输出 + 可选写盘 output/stocking/（ui.images）
```

### 3.4 成品怎么又回到节点里的（需求 2 / 4）

```
web/stocking.js 预览条（处理前 | 成品，左右并排）
  ├─ 什么时候刷新：① onExecuted（跑过一次工作流）② iframe 里每次改图（shim postMessage）
  │                 ③ 节点上三个 widget 被改 ④ 手点「刷新」。都过 900ms 防抖，且同一时刻只跑一个
  ├─ 处理前：GET /stocking/api/doc/{id}/art?w=512    ← 只在新文档出现时重新指图（r.artSid）
  ├─ 成品缩略图：GET /stocking/api/doc/{id}/result?w=512      ← 不带 style/density/strength
  ├─ 放大  ：同一个 URL，不带 w  → 原尺寸
  └─ 保存  ：同一个 URL，不带 w  → blob → <a download>（浏览器自己就能存，不需要服务端配合）
        ↓
routes.render_result
  ├─ d.wait_idle(RESULT_WAIT=20)      ← 关键，见下
  ├─ docstore.render(d, None)         和 nodes.apply 走的是同一个函数、同一份参数来源
  └─ 回 PNG + X-Stocking-Empty 头
```

**「送入下游」的另一条路（第七轮起按钮置灰，链路整段保留）：**

```
按钮 → POST /doc/{id}/push → routes.push_doc(d)
        ├─ push_sig(d) = (id, repr(look), repr(render_key()))   渲染前取签名
        ├─ docstore.render(d, None)
        └─ 存进模块级 _pushed
      → app.queuePrompt(0, 1)
        ↓
nodes.apply → routes.take_pushed(d)  签名还对 → 直接交这张（交出后清空）；不对 → 自己重渲
```

**为什么停**：把图放到 socket 上的唯一办法是让图跑一遍，而跑一遍就是重新采样 —— 点一次等于凭空多生成一轮图，代价和按「执行」一样。它要解决的"下游拿到编辑之前的图"确实解决了（`take_pushed` 那段现在还是对的，`nodes_check.py` 也照旧在验），但为一文件多跑一轮采样不划算。前端只加了 `PUSH_AVAILABLE = false`：按钮 `disabled` + 变灰 + title 说明，`pushDownstream` 第一行判它，`finally` 里也是 `push.disabled = !PUSH_AVAILABLE`。**路由、pin、`take_pushed`、`queuePrompt` 一行没删**，开关改回 `true` 就完全恢复。

**ComfyUI 自己那份不画。** 节点有 IMAGE 输出，前端本来会在节点里再画一遍这张图；`hideOutputPicture` 把它关掉（见 §2.3 第 8 条）。**不要**改成删 widget 或加 CSS 去藏 —— 前端在每次重绘时按 `imgs` 重建它，删了会回来；而且 Vue 节点模式（`Comfy.VueNodes.Enabled`）下根本不是一个 widget。

**这条路上的两个关键决定：**

1. **参数来自文档自己的 look（= 界面上的设置），不是节点的三个 widget。** 这是第六轮改过来的，改之前正好相反，结果是：在界面里把材质从「细线」换成「油光」、密度 140、强度 60，`整体` / `细节` 全变了，但**成品条和 socket 一动不动** —— 因为 `docstore.render` 是从 `RENDER_DEFAULTS` 起步的，只有 `style/density/strength` 三个键被 widget 的值覆盖，`tilt` / 亮点 / 强度自动 全是默认值；而 widget 那三个值又恰好是"换材质之前"的那组。于是预览条忠实地显示了"节点按旧设置渲出来的图"，用户看到的就是"改了材质，成品没跟着变"。
   现在只有一处真相：`doc.look`。界面滑杆写它（PUT），节点 widget 也写它（PATCH），`apply` 和 `/result` 都只读它。`apply` 里唯一还碰 widget 的地方是"新文档还没有 look"时**播种**一次，那是纯图上跑（没人开过界面）仍然要能出纹理的兜底。
   ⚠️ 不要再给 `/result` 加上 `style/density/strength` 覆盖参数。加了就等于让预览条重新用另一套参数渲图，§3.4 的整条链又会分成两张图。
2. **`wait_idle` 不是可选项。** 渲染只认**当次**求解结果（`document.fields()` 只取 fresh 的那份），刚改完图就去渲染，拿到的是"刚画的部位没有纹理"的图 —— 正是这条存在的意义所在的那张图错了。所以：
   - `/result` 等最多 20 s（`RESULT_WAIT`），
   - `nodes.apply` 在 render 前也等最多 60 s（`RENDER_WAIT`，`nodes.py`）。
   两边都等，条里的图和 socket 才会是同一张图；都设了上限，卡住的求解不至于把请求挂死。

**两张格子都走缩略图，不是原图。** 原图常有几千像素，而格子只有几百宽；在节点里解码一张全尺寸 PNG（还带 `?t=` 每次都重新取）正是界面发卡的来源。`w=` 在**服务端**用 `cv2.INTER_AREA` 缩完再编成 PNG 发出去，只有「放大」和「保存」要原尺寸。注意通道序：`art` 是 RGB，而 `png()` 直接把数组交给 `cv2.imencode`（要 BGR），所以两条 art 路径都得像 `art_png()` 那样先 `cv2.cvtColor(..., COLOR_RGB2BGR)`。

---

## 4. 改动前必读（四条硬性约束）

### 4.1 原版页面**不能**放进 `WEB_DIRECTORY`

ComfyUI 会把 `WEB_DIRECTORY` 下**所有** `.js`（含子目录）当作 ComfyUI 扩展交给主页面 `import`。
`panel/` 里的 `app.js` / `look.js` / `shim.js` 不是扩展：它们要的是只存在于 iframe 里的 `#view`、`#empty`，还会装全局按键监听。

一旦被主页面加载，**整个前端启动就死在半路**：`/api/object_info` 永远不会被请求，一个节点定义都到不了浏览器，
画布画得出来但界面全空，**任何**节点都加不进去（不只本节点）。

所以页面放在节点根目录的 `panel/`，由 `routes.py` 的 `panel_file` 在 `/stocking/panel/...` 下提供。
**把 `panel/` 挪进 `web/` 会立刻重现这个问题。**

> 诊断法：在浏览器控制台读 `#vue-app.__vue_app__.config.globalProperties.$pinia._s`，
> 看 `nodeDef` store 的 `nodeDefsByName.size`。正常 **1021**；出问题时是 **0**。
> （注意：新版 Vue 前端里 `LiteGraph.registered_node_types` 是空的且不可信，不要用它判断。）

### 4.2 `scene_from_doc` 的 `disparity` 必须传 **callable**

原版 `look.Scene` 把它存下来，在每次渲染时 `self._disparity()` 调用（这样晚到的深度图也能用上）。
传数组会让 Scene 试图调用数组，第一次渲染就崩。

```python
# 对
look.scene_from_doc(doc, disparity=lambda: getattr(doc, 'disparity', None))
# 错
look.scene_from_doc(doc, disparity=doc.disparity)
```

### 4.3 SAM 和深度模型**不能并发构造**

在这个 torch 构建（2.12+cu130）上，两个线程一起 `nn.Module(...).to('cuda')` 会让 SAM 的权重变成半精度，
第一次点选就报 `Input type (struct c10::Half) and bias type (float) should be the same`（或镜像的 `mat1 and mat2 must have the same dtype`）。
`upstream/_loads.py` 里那把锁就是为这个加的，`sam.py` / `depth.py` 都包了它。**不要删。**

锁只包**构造**，不包推理——点击依然能在深度模型加载过程中正常跑。

### 4.4 前端两条坑

- **`img.src` 不走 `fetch`。** 原版页面取图片用的是 `new Image(); img.src = '/api/...'`，不是 `fetch`。
  只覆盖 `window.fetch` 是不够的——**原图、部位掩码、覆盖范围图**这三个都会打到 ComfyUI 自己的 `/api/` 上拿 404。
  症状很骗人：页面看起来是活的（工具列表、部位列表、缩放百分比全都正确，因为这些状态走 fetch），
  **只有画布是空的**，状态栏"等图片…"。`shim.js` 里改了 `HTMLImageElement.prototype.src` 的 setter 才兜住。
- **内联 `style="display:flex"` 会盖掉 `hidden` 属性对应的 `display:none`。**
  所以浮层（原图放大、成品放大、全屏）要**同时**管 `hidden` 和 `style.display`，只设 `hidden` 会让它一直显示在画面上。
- **同样是 `display` 的问题，但反过来了：`web/stocking.css` 里给预览条那几层写了 `display:flex/block`，
  它们会把 `[hidden]` 一起盖掉。** 所以那份 CSS 末尾有显式的一条
  `.stocking-result[hidden], .stocking-result-body[hidden], .stocking-pane[hidden], .stocking-pane-img[hidden],
  .stocking-pane-empty[hidden], .stocking-split[hidden] { display: none; }`。
  再加一个带 `display` 的新子元素时，记得把它的选择器也写进那条规则里，否则它在"隐藏"状态下仍然可见。
  （`CSS_FALLBACK` 里那条也要同步 —— 它是同一份几何的第二份拷贝。）

> 面板内已确认没有别的网络出口：没有 `XMLHttpRequest`、没有 `WebSocket`、没有 `sendBeacon`、CSS 里没有 `url()`。
> 所以"`fetch` + `<img>.src` + `EventSource`"就是全部，覆盖完整。

### 4.5 `web/stocking.css` **不会被 ComfyUI 加载**，必须由 `stocking.js` 自己挂

`WEB_DIRECTORY` 只把 `**/*.js` 当扩展喂给前端（`server.py` 的 `/extensions` 路由只 glob `.js`），
目录本身虽然能取到，但**没有任何地方 link 这个 css**。它没被挂上时，节点是这个样子（2026-10-12 真实踩到）：

| 症状 | 原因 |
|---|---|
| 处理前 / 成品**上下堆叠**，不是左右并排 | `.stocking-result-body` 的 `flex-direction:row` 没生效 |
| 界面**异常卡顿**；节点被两张原尺寸位图撑爆 | `.stocking-result` 没有 `height` 上限，`.stocking-pane-img` 没有 `max-width/max-height` |
| 右下角**拖动把手点不到**、也看不见 | `.stocking-grip` 是个空的 18px `div`，没有背景就没有任何可见内容 |
| 空条带一直占位 | `[hidden]` 规则也在那份 css 里 |

所以 `stocking.js` 的 `loadStyles()` 用 `import.meta.url` 解析出 `/extensions/<folder>/stocking.css` 去 link
（用 `import.meta.url` 而不是写死路径，这样目录改名也不影响）；link 失败（代理、目录被改名）则注入
`CSS_FALLBACK`。**改 css 时，凡是布局依赖的规则（`flex-direction`、`height`、`display`、尺寸上限）
都要在 `CSS_FALLBACK` 里补一份**；纯装饰的不必。

> 诊断法：控制台里 `document.querySelector('link[data-stocking-css]')` 应当拿到元素；
> 或者 `getComputedStyle(document.querySelector('.stocking-result-body')).flexDirection` 应当是 `row`。

> 另一条相关的：**别指望「删掉那个 widget」能关掉 ComfyUI 自己画的成品图。**
> 预览是前端在**每次重绘**时按 `node.imgs` 重建的（`onDrawBackground` → `unsafeUpdatePreviews` →
> `showCanvasImagePreview`，没有节流），删了一定会被加回来；而且开着 `Comfy.VueNodes.Enabled` 时它根本
> 不是一个 widget。用 `node.hideOutputImages`，见 §2.3 第 8 条。

### 4.6 面板 widget **不能**用 `computeSize`，只能用 `computeLayoutSize`

`web/stocking.js` 里给面板 widget 设高度的那一行，是**唯一一个会让节点自己长高的地方**，也是本轮之前线上
"别人的机器上节点变成一条长竖条、怎么拉都拉不回来"的根因。**不要改回去。**

曾经是（**错的**）：

```js
widget.computeSize = (w) => [w, Math.max(MIN_H, (self.size?.[1] ?? DEFAULT_H) - 120)];
```

它把"这个 widget 需要多高"写成了"**节点现在多高**"的函数。而节点的排布本来就是把这些 widget 的高度**加起来**：

```
widget 高度 = node.size[1] - 120
node.size[1] = 各 widget 高度之和 + 槽位 + 8 + 6
              ↑ 于是 node.size[1] 每算一次就比上一次多一截，永远不收敛
```

前端在经典画布模式下的 `_arrangeWidgets()`，结尾那一行（前端产物 `assets/settingStore-*.js`）：

```js
!Z.vueNodesMode && l > t && (this.setSize([this.size[0], l]), this.graph.setDirtyCanvas(!1, !0))
```

`l` = 各 widget 高度之和，`t` = 节点高度。代入上面的 `computeSize`：`l - t ≡ 92px`（常数），于是

- **每帧重绘都 `+92px`**；`setDirtyCanvas(false, true)` 又让下一帧继续重绘 —— 无限长高（`drawNode → node.arrange() → _arrangeWidgets()`，见 §6 的复现脚本）；
- **永远缩不回来**：把节点拉小，下一帧又被 `setSize` 撑回去。用户看到的就是"非常长的长条，无法回收"；
- 尺寸还会被存进工作流，所以打开一次坏一次。

**为什么作者本地看不出来：** 那一行前面有 `!Z.vueNodesMode` —— `Z.vueNodesMode` 就是设置里的
**`Comfy.VueNodes.Enabled`（Modern Node Design / Nodes 2.0）**，而它的 `defaultValue: false`。
作者这台机器手动开着 Nodes 2.0，那条 `setSize` 被挡掉了；别人的 ComfyUI 用默认值（经典画布），于是必然中招。

**正确写法**（现在是这个）：

```js
widget.computeLayoutSize = () => ({ minHeight: MIN_H, minWidth: 0 });
```

- 不给 `maxHeight` ⇒ 前端把"剩下的空间"全给这个 widget（`distributeSpace` 里 `maxSize ?? Infinity`），于是
  `l ≡ t`，条件 `l > t` 不成立，节点高度**恒定**；
- 这也正是前端给 DOM widget 的默认行为、以及 ComfyUI 自己的 `WebcamCapture` / 视频预览 widget 的写法；
- 两种渲染器（经典画布 / Nodes 2.0）从此给出**同一个几何**。

`MIN_H` 作为地板保留。代价：布局允许的最矮节点 = `MIN_H(560) + 六个普通 widget(~144) + 槽位行(~64) ≈ 768`，
所以 `MIN_NODE_H` 从 `640` 提到 `780` —— 否则拖动把手按住 640 拉，下一帧会被布局弹回 768，把手和布局互相打架。

> ⚠️ 不要在节点侧"顺便"再算一次尺寸。`onNodeCreated` 里现有的
> `this.size = [Math.max(this.size[0], DEFAULT_W), Math.max(this.size[1], DEFAULT_H)]` 是**常数**，没问题；
> 有问题的是 `this.setSize(this.computeSize())` 这一类 —— `node.computeSize()` 也会去问每个
> `widget.computeSize`，而 `loadWorkflow` 打开工作流时对每个节点都跑一遍
> `setSize(max(size, computeSize))`（见 §6 复现脚本里的第二条断言），一样会把节点顶高。

---

## 5. 做过的事

前几轮都是**只写代码、没在真机上跑过**（用户在训练 LoRA，不许占显存），"离线已验证"标注的就是真跑不了的。

### 5.1 画笔平滑 ✅

- 界面：`panel/index.html` 笔刷滑杆下面一条「平滑」滑杆，0–100，默认 0。
- 算法：`panel/app.js` 的 `advanceDrag`（死区几何）/ `refreshLag`（死区衰减）/ `followStep` + `smoothAlpha`（惰性滤波）/ `dragLag` / `dragStep` / `emitDrag`，作用于**画笔、橡皮、切开、走向、隔开**（五个都是"手画一条线"）。
- 详见 §2.4.1。**浏览器实测 + 离线仿真双重验证**：跟随（慢速末帧落后 ≤25px）、减速（快速恒定落后不发散）、无瞬移（单帧位移比 ≤1.05）、松手收敛到指针。
- 最可能坏在哪：滑杆没接线（`#brush-smooth` 拼错会静默），或者 `平滑 = 0` 时和以前手感不一样（不该不一样）。
- ⚠️ **历史坑**：第一版用「每帧限额 + 超出丢弃」实现减速，表现为**瞬移**（快速拖动时画笔卡住、手停后突然跳到位），已废弃。减速必须用有界的速率滤波，不能用会发散再一次性付清的欠账。

### 5.2 界面下方显示成品 ✅

- 界面：`web/stocking.js` 的 `buildResult` / `wireResult`；样式在 `web/stocking.css` 的 `.stocking-result`。
- 数据：`routes.py` 新增 `GET /stocking/api/doc/{id}/result`；见 §3.4。
- 首次出现时会把节点垫高（§2.3 第 5 点），所以编辑区不会被压扁。
- 最可能坏在哪：① 预览条一直不出现 → 看 `p.__sid` 有没有值（没跑过工作流、也没点过「取用节点图片」时它是空的）；② 一直显示"正在渲染…" → `/result` 在 `wait_idle`，或者渲染在报错（`note` 会写"渲染失败：…"，服务端日志也会有一行）。

### 5.3 放大与保存 ✅

- 点格子的图或「放大」→ 复用原版图放大那套浮层（`buildViewer`），源是**原尺寸**的渲染（`/result` / `/art` 不带 `w`）。
- **两格的保存从第七轮起不是同一件事**（`buildPane` 的 `toOutput` 选项 + `savePane` 分叉）：
  - **处理前** → 下载。取 `/art` 原尺寸 PNG，走 blob + `<a download>`，文件名 `<文档名>-原图.png`。这张图是节点**收到**的，不是它产出的，落到 `output/` 没有意义。
  - **成品** → 「保存」，走 `saveToOutput`：`POST /api/doc/{id}/export` `{kind:'png', name:<前缀>}`，服务端渲染后写 `output/stocking/<前缀>.png`，状态栏回显 `已保存到 output/stocking/xxx.png`（`outputRel` 把绝对路径截到 `output/` 之后）。**不排队、不重新采样** —— 这是它取代「送入下游」的全部理由。同名覆盖；节点自己执行时写的文件带时间戳，不受影响。
  - 成品放大浮层顶栏那个按钮（`buildViewer('成品（整体）', {save:true})` 的 `onSave`）走的是同一个 `savePane(p,'result')`，所以两个入口行为一致。
- 顺手修掉了上一轮记下的小瑕疵：原来用 `card.sid !== p.viewer.src` 判断浮层是不是在显示旧图，而 `openViewer` 从没设过 `v.src`，所以那个比较永远不成立。现在按文档 id 比（`p.__viewerSid`）。

### 5.4 右下角拖动改变编辑区大小 ✅

- `wireGrip`：面板右下角一个把手，拖动就是 `node.setSize`，和拉节点右下角同一回事；最小 620×640。
- 全屏时把手隐藏（那时没有节点可改大小）。
- 最可能坏在哪：DOM widget 会盖住 ComfyUI 自己画的把手 —— 这正是重画一个的原因；如果拖了没反应，先看 `pointerdown` 有没有被 litegraph 抢走（`e.stopPropagation()` 就是为这个）。

### 5.5 处理前 / 成品**左右并排** + 分隔条 + 不卡了（第四轮）✅ 离线已验证

三个问题一起爆的，根因是同一个：**`web/stocking.css` 从来没被加载过**（§4.5）。

| 用户看到 | 真因 | 改法 |
|---|---|---|
| 两块**上下堆叠** | `.stocking-result-body` 的 `flex-direction:row` 没生效 | `loadStyles()` 把 css link 上 |
| 界面**异常卡顿** | 条带没有 `height` 上限、`img` 没有尺寸上限 → 两张原尺寸位图在节点里被解码/重绘；`?t=` 每次都重新取 | css 到位 + 两张格子改走**服务端缩略图**（`/art?w=`、`/result?w=`，`THUMB_W=512`；见 §3.4） |
| 节点下方那块**没用的图** | ComfyUI 自己画的 IMAGE 输出预览（带尺寸标注），和预览条里是同一张 | `hideOutputPicture`：`node.hideOutputImages = true` + 把 `imgs` 钉成空（§2.3 第 8 条） |
| 想调编辑区/预览的高度 | —— | 新增 `.stocking-split` 分隔条：拖、双击恢复、节点缩小自动收窄（§2.3 第 9 条） |

**离线证据**（无浏览器/无 ComfyUI，都在 `J:\WORK\2026-10-12-12-47-17\.synccheck\`）：

- `layout_harness.html` —— 只含这条预览条的真实 DOM（`buildPanel` / `buildPane` / `buildResult` / `buildSplit` /
  `wireSplit` 逐字复制）+ 真实 `stocking.css`，跑 10 条几何与交互断言，**10/10 全过**：
  两块 pane 并排（`A=[x 12..492]`、`B=[x 492..972]`，同 top 同高）、条带高度 252px（原图 1216px）、
  图片被限制在格子内、手柄 18×18 贴右下角、分隔条在编辑区与预览之间、
  拖分隔条（预览 252→452px、编辑区 608→408px）、编辑区保底 220px、`hidden` 真的隐藏、
  双击恢复 252px、节点缩小后条带 640→260px 且编辑区保住 220px。截图 `layout5.png`。
- `t_thumb.py` —— 用项目自己的 cv2 验缩略图路由：宽度/宽高比/通道序（红蓝不互换）/两处 clamp，
  **14/14 全过**；并确认 `cv2.cvtColor` 与原来的 `art[..., ::-1]` 在这里输出逐字节相同。
- `t_hide_preview.mjs` —— `hideOutputPicture`（**从源文件里抽出来的真实函数**，不是副本）15 条断言全过，
  外加 4 条**前端契约**断言：前端 Vue 预览确实 `if(!t||!e?.images?.length||t.hideOutputImages)` 提前返回、
  且 ComfyUI 自己的 `Painter` / `ImageCropV2` / `ImageCompositor` 确实用同一个标志关预览。
  **前端升级后这个测试会先坏，而不是图悄悄回来。**

**没验证到的**：`hideOutputPicture` 在真机上的效果（需要跑起来 ComfyUI）。契约断言只能证明"前端仍然是这么判的"。

### 5.6 选区材质：丝袜 / 丝质（第三轮）✅ 离线已验证

- 部位 `···` → 「材质」→ 丝袜（默认）/ 丝质。丝质 = 求解域向外扩 `EDGE_PAD=8`，边缘那圈折钩消失。
- 详见 §2.x 与记忆日志；离线证据 `t_material.py`（最外圈 p90 从 50.2° → 9.3°，与内部持平）。
- **坑**：`set_material` 必须 `self._touch()`，否则 `_prepare` 命中缓存不重解。
- 残留：材质**没有写进引导 PSD**，导出再打开会回到丝袜。

### 5.7 修掉「节点每帧长高、变成一条长竖条、拉不回来」 ✅ 已复现并验证

用户反馈：**在作者的机器上正常，在别人的 PC 上节点变成一条极长的竖条，怎么拉都收不回来。**

- 根因、为什么只在别人的机器上出现、正确写法：见 §4.6（一句话：widget 高度写成了节点高度的函数，而节点高度是
  widget 高度之和 ⇒ `_arrangeWidgets` 每帧把节点撑高 92px，且 `!vueNodesMode` 让作者那台开着 Nodes 2.0 的机器
  看不到这个问题）。
- 改动只有两处，都在 `web/stocking.js`：删掉 `widget.computeSize = ...` 换成
  `widget.computeLayoutSize = () => ({ minHeight: MIN_H, minWidth: 0 })`；`MIN_NODE_H` 640 → 780。
- 复现与验证：`arrange_check.mjs`（见 §6），现状 400 帧长到 37700px、修好后 400 帧恒为 900px。
- **真机验证（2026-10-16，本机 ComfyUI 1.53.10）已做**：把 `Comfy.VueNodes.Enabled` 临时置 `false` 并
  重新加载页面（真正的经典模式启动），在临时空白工作流上放真实节点，用真画布连画 121 帧：
  - 修复版：高度恒为 **900**（`panelWidget.computedHeight = 690 = 体高 − 槽位 − 144`，`l ≡ t`）；
  - 现场把 widget 换回旧 `computeSize`：900 → 994 → 2874 → 6634 → **12274**，即 **+94px/帧**（另一次实测 +95.6）；
  - 再换回修复版：**立刻止血**，停在原位不再长（但不会自动缩回——见下）。
  - 截图：`J:\WORK\2026-10-16-13-20-27\stocking-longstrip\真机对照-*.png`（同一 5% 缩放下，正常方块 vs 一条竖线）。
- ⚠️ **真机复现的坑（下次测必须注意）**：`bodyHeight` 是 `max(node.size, contentSize)`，而
  `contentSize` **只由 Nodes 2.0 的 Vue 渲染器上报**（前端 `reportContentSize()`）。所以
  **"先按 Nodes 2.0 启动、再事后把 `vueNodesMode` 改成 false"** 会得到**假阴性**：残留的 contentSize
  把 `l > t` 顶掉，旧代码也不会长高。要复现必须**以经典模式启动**（或节点创建后立刻测）。

### 5.8 还没做 / 已知的坑（下一轮）

- **选区「隔开」之后的 bug（老问题，还没动）**。相关代码：`upstream/split.py` 的 `cut_mask` / `_nearest_fill` /
  `_orient`、`document.split_region`、`panel/app.js` 的 `splitDone` 与 `/regions/{rid}/split`。
  原版就有，不是本轮引入的。**要复现需要**面板「导出」一份引导 PSD（`output/stocking/<名>-丝袜引导.psd`），
  里面有 原图 + 各区域 + 走向 + 亮点 + 隔开线，拿到它才能离线 1:1 复现（环境里没装 `psd_tools`，
  所以 guides 导出当前本来就不可用 —— 要修得先装 `psd-tools`）。
- **面板不知道自己"求解完了"。** 原版靠 SSE 的 `solved` 事件刷新状态文字；这里的 `EventSource` 是哑对象（§2.4 第 3 条），所以求解完成后，区域状态那一行可能要等到下一次操作才更新。横纹本身不受影响（`syncCourses` 每次 `applyState` 都会取）。要修就在 `shim.js` 里补一个轻量轮询。
- **`i18n` 的整页翻译**：`panel/app.js` 第 11 行的 `translatePage()` 在 `LANG==='en'` 时遍历 `document.body`
  的所有文本节点。查过：它**只在模块加载时调一次**，不是逐帧成本，**不是卡顿来源**（本轮排查过）。

### 5.9 第六轮：成品跟着界面走 / 送入下游 / 平滑作用于走向与隔开 ✅ 离线已验证

用户报的三件事，根因是三个不同的地方：

**(1)「改了白色区域的材质后，成品区域不跟着变」** —— 根因在 `docstore.render`：参数是
`clean_params({**RENDER_DEFAULTS, **params})`，而 `params` 只有 `style/density/strength` 三个键。界面的设置存在
`doc.look` 里，**根本没有被读**。所以界面换成油光 140%，成品还是细线 100% / 斜度 32 / 强度自动。修法见 §3.4 决定 1。
`docstore.render` 现在按 `DEFAULTS → doc.look → params` 的顺序合并参数。

**(2)「平滑不作用于走向和隔开」** —— 不是没接线。`pointerdown` 里 `pen/wall/cut` 和 `paint` 一样建了
`follow/aim/lag` 并 `startFollow()`，`pointermove` 也只更新 `d.last`。问题是那个「平滑」是**稳定器**：
它只改画点**什么时候**动，画点最后必然追到每一个指针采样上，所以线的形状一点没变。手慢慢画引导线时
**完全等于没开平滑**。修法：`panel/app.js` 新增 `smoothLine()`，在 `endDrag` 提交前对走向 / 隔开的折线做
**按弧长的盒式平滑**（两遍，端点钉死）；`draw()` 里正在画的那条线用 `dragPath()` 走同一套平滑，所以松手不跳。
几个坑：
  - **窗口按弧长（px）算，不按点数**：点数取决于手速（快手的采样间隔大），按点数会让平滑量随机变化。
  - **必须 O(n)**：这条线是在每一帧重建的，3000 点用三角核要 40 ms/次（掉到 24fps）；前缀和 + 单调双指针后 0.3 ms。
  - **端点钉死**：走向线两端决定横纹方向，隔开线要接到轮廓。`平滑=0` 直接返回原数组，逐点一致。
  - 切开**故意不做**：它会被 `split.py` 重新贴到线稿上，先平滑只是换了它的起点。

**(3)「放个按钮把成品转入下一个节点；现在只能转入编辑之前的图片」** —— 见 §3.3 的「送入下游」。要点：
socket 只有执行时才更新，所以按钮 = 渲染并锁定成品 + 排队；`apply` 用 `take_pushed()` 交锁定的那张。
签名是 `(文档 id, repr(look), repr(render_key()))`，**渲染前**取（渲染中落了新求解 → 签名对不上 → 下次自己重渲）。
交出一次就清空，编辑之后再执行不会被旧图重放。

**(4) 顺带：节点的三个 widget 和界面的三个滑杆变成同一个设置。** widget → 文档走
`PATCH /doc/{id}/look`（不是 PUT —— PUT 是整份，会把界面里调过的斜度 / 亮点冲回默认）；文档 → widget 走
`GET /look` 后直接写 `widget.value`（不触发 callback，`p.__mirroring` 兜底），并 `postMessage({stocking:'look'})`
让界面重读一次（`lookUI.reload()` → 只 GET，不会回声）。

验证脚本（都在节点目录里，和 `e2e_check.py` 并列）：
- `nodes_check.py` —— `apply` 的输出 / 送入下游的锁定与失效 / 新文档的 widget 播种，共 12 条断言；
- `routes_check.py` —— 用真 aiohttp 打 `/push`、`PATCH /look`、`/result`（把 `server.PromptServer` 换成假的 RouteTableDef，不用起 ComfyUI）；
- `smooth_check.mjs` —— 把 `panel/app.js` 里的 `smoothLine` **原文抽出来**跑：抖动 75.8°/点 → 1.2°/点，端点不动，
  3000 点一次重建 0.25 ms（三角核版本是 40 ms，掉到 24fps，所以必须前缀和 + 单调双指针）。

### 5.10 第七轮：「送入下游」收起来，成品改成「保存」 ✅ 离线已验证

**用户反馈**：前两个 BUG 修好了，但优化跑偏了 ——「送往下游变成了开一轮工作流，也就是生成一轮图片」。
于是要的是"点一下把成品存到 output"，而那个按钮留着但先禁用，日后有需要再说。

**(1)「送入下游」置灰，一行没删。** 见 §3.3 的说明。要点：
- 常量 `PUSH_AVAILABLE = false`（`web/stocking.js` 顶部），`push.disabled = !PUSH_AVAILABLE`，内联样式加
  `opacity:.4;cursor:not-allowed`；title 直接写清"暂不可用 + 请用保存到 output + 怎么恢复"。
- `pushDownstream` 第一行 `if (!PUSH_AVAILABLE || p.push.disabled) return;`，`finally` 里 `p.push.disabled = !PUSH_AVAILABLE`
  —— 否则一次成功推送会把按钮重新点亮。
- 后端 `/doc/{id}/push`、`routes.push_doc` / `take_pushed`、`nodes.apply` 里的 `take_pushed` 分支、`queuePrompt`
  全部保留，`nodes_check.py` 里那几条锁定断言也照旧在跑（它们测的是 `apply` 的行为，不是按钮）。

**(2) 成品的保存改走 `output/stocking/`。** 见 §5.3 的分叉。关键是**别再复制一份导出逻辑**：
`POST /api/doc/{id}/export` 本来就是"把成品写进 output"的唯一实现（面板的「导出成品图」用它），
它接受 `{kind:'png', name}`，不传 `params` 就按 `doc.look` 渲染，返回 `{file, folder, notes}`。
`saveToOutput` 只是把这条路由接到按钮上，再把绝对路径截成 `output/stocking/xxx.png` 显示。
它和 `/render/*`、`/result` 走同一个 `docstore.render`，所以状态栏说"已保存"的那张就是预览条上那张。
（**这句话第七轮时其实还不成立**——当时 `/export` 仍自己渲染，两条路会分叉；第八轮才真正并过来，见 §5.11。）

**(3) 为什么成品不再下载、处理前仍然下载。** 成品是节点的**产物**，`output/` 才是它的家（ComfyUI 的历史、
下游节点、用户找文件都看那里）；处理前是节点的**输入**，用户在别处已经有原图，需要副本时才是下载。

**(4) 验证。** `routes_check.py` 加第 4 段：`PATCH` 回 knit（避开 `sparkle_depth` 拉深度模型）→
`POST /export {kind:'png', name:'probe'}` → 断言 200、路径含 `/output/stocking/`、**文件真在盘上**、
尺寸等于原图、文件名是 `probe.png`。`folder_paths` 在测试里被 stub 到一个 `tempfile.mkdtemp()` 下的 `output/`，
所以既验到了真文件，又不会往节点目录里丢测试图。全绿。

### 5.11 第八轮：「保存」写出的必须是预览那张 ✅ 离线已验证

**问题**：点「保存」，`output/stocking/` 里的和预览条上那张不一样；最坏情况存下去的是**没加纹理的原图**。

**根因**：`/export` 是仅剩的一条"自己渲染"的出口 —— 它自己 `_base_look(d)` 解析参数、自己用 `_scene_for(d)`
这个单槽缓存拿 Scene，而预览条（`GET /result`）和 socket（`nodes.apply`）都走 `docstore.render`。
两条路各自缓存、各自解析，**缓存一过期就分叉**。第六轮修的是 `docstore.render` 忽略 `doc.look`，
没管 `/export`，于是同一个病在保存按钮上又活了一轮（症状换成"存出来是原图"）。

**修法**

- `routes.export_doc` 改成 `out_rgb, info = await loop.run_in_executor(None, docstore.render, d, q)`，
  然后 `export.export(d, None, q, path, kind, rgb=out_rgb)` —— 写盘不再自己渲染。
  渲染放 executor 里，事件循环不堵（和 `/push` 同一个理由）。
- `info['empty']` 为真（一个像素都没纹理）时直接 `ValueError`：**拒绝**把原图当成品写下去。
- 像素变化 <1.5% 时往 `notes` 里塞一条提示。这个阈值有实测依据：密度 132 只剩 1% 像素变化（防摩尔纹把
  纹理淡化了），密度 90 是 4%，1.5% 正好卡在"有纹理"和"没有"之间。
- 前端按钮名统一成「保存」（两格同名，靠 title 区分去向），失败文案覆盖"成品就是原图"这一种拒绝。

**约束（别再犯）**：凡是"把成品写到某处"的新代码，一律走 `docstore.render`。
`export.export` 的 `scene` 参数现在只有 guides 和历史调用方还在用，新代码不要传 scene 让它自己渲。
判断"这个文档现在渲染出来是什么"的唯一入口就是 `docstore.render`，任何绕过它的写法都会在缓存过期时给出第二意见。

---

## 6. 怎么跑、怎么验证

### 启动（**必须**用这个 Python）

```bash
G:/Comfy-Desktop/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/Scripts/python.exe \
  G:/Comfy-Desktop/ComfyUI-Installs/ComfyUI/ComfyUI/main.py --port 8199
```

⚠️ 不要用 `standalone-env/python.exe`——它缺 `comfy_aimdo.storage`，起不来。
⚠️ 测试请用 **8199**，不要占用用户平时在跑的实例；**测完必须停掉**（SAM + 深度模型占显存，
用户可能正在跑 LoRA 训练）。

### 不开浏览器的自检

```bash
<venv python> custom_nodes/ComfyUI-StockingTexture/e2e_check.py <输入图.png>
```

跑 图 → Document → 自动选择 → 走向线 → 求解 → 渲染，报告成品与输入的差异百分比，输出 `e2e_out.png`。

### 开浏览器时，判断"画布到底有没有图"

从 iframe 内读 `#view` 采样数**不同颜色数**：

```js
// 1 = 纯色 = 空白；>1 = 有内容。修复 §4.4 那个坑之前是 1，之后是 94
```
```js
// 有没有请求 404
performance.getEntriesByType('resource').filter(e => e.responseStatus >= 400)
```

### 服务端状态

`GET /stocking/api/doc` —— 看当前文档的 id / 尺寸 / 部位数。
`/stocking/api/doc/{id}/regions` —— 每个部位的 `status`（`ok` / `nostroke` / `error`）和 `strokes` 数。

### 最近五轮改动怎么点一遍

1. **处理前 / 成品并排**：跑一次工作流 → 界面下方出现一条预览条，左边「处理前」右边「成品」，**左右并排**（不是上下堆叠），条有高度上限（不会长到页面的几倍），两张图各自缩在自己的格子里、不越界。
2. **ComfyUI 自己那份图没了**：节点里除了这条预览条，**不应该再有第三张图**（带 "832 x 1216" 尺寸标注的那块）。队列 / 历史里那张缩略图**应该还在** —— 那是 `ui.images`，是故意留的。
   直接验服务端也可以：浏览器里开
   `/stocking/api/doc/<sid>/result?style=knit&density=100&strength=100&w=512` 应该回一张 PNG；
   `/stocking/api/doc/<sid>/art?w=512` 也应该回一张 PNG，尺寸约 512 宽。
3. **不再卡**：拿一张 2K 以上的图，开节点面板、来回平移缩放画布、连着画几十笔 —— 应该和关掉这个节点时差不多。最容易看出问题的地方是把节点拉得很小时条带还在画大图（应该已经被 `clampStrip` 收窄）。
4. **分隔条**：编辑区与预览条之间那条横杠，上下拖 → 预览条变高、编辑区变矮（反之亦然）；拖到顶编辑区仍留 220px；**双击**恢复默认高度；把节点拉小 → 条带自己收窄，编辑区不被挤没。
5. **放大 / 保存**：点任一格子的图或「放大」→ 浮层打开（滚轮缩放、拖动平移、双击适应、Esc 关）。
   点保存 → 下载 `<文档名>-原图.png`（处理前）/ `<文档名>-成品.png`（成品），尺寸等于原图。
6. **拖动把手**：面板右下角拖动 → 节点跟着变大变小，页面跟着重排（不是被裁切）。`620 × 640` 是下限。全屏时把手应当消失。
7. **材质**：某个部位的 `···` → 「材质」→ 丝袜 / 丝质。切到「丝质」后**该部位的边缘那圈折钩应当消失**（腿的轮廓内侧不再有向上的短竖线）。切回丝袜应当逐像素还原。
8. **平滑**：选「画笔」，把平滑拉到 60 以上，快速画一笔 —— 线条应明显比 0 时圆顺，松手时画到指针位置。
   拉到 100 画一个直角，拐角应被抹圆。切到「切开」和「走向」，同样生效。
   平滑 = 0 时，手感必须和改动前完全一样。
9. **节点不会自己长高**（§4.6，本轮新增）：把设置里的 **Nodes 2.0（`Comfy.VueNodes.Enabled`）关掉**
   （那才是别人的默认状态），加载一个带本节点的工作流，**盯住节点高度 10 秒** —— 它必须一动不动。
   开节点面板、缩放画布、改样式 / 密度 / 强度、拖右下角把手，高度都不该变（拖把手时只按你拖的改变）。
   旧版本在这里会每帧 +92px，几秒钟就长成一条竖条。
   两种模式（开 / 关 Nodes 2.0）各验一次，布局应当一致：面板正好铺满节点剩余空间，不溢出、不留空。

⚠️ 这台机器开着 **Vue 节点模式**（`user/default/comfy.settings.json` 里 `Comfy.VueNodes.Enabled: true`），节点是 DOM 渲染的。第 2 条在**两种模式下都成立**（`hideOutputPicture` 同时管两条路），但别只在一种模式里验。

**显存**：测完记得停掉服务（SAM + 深度模型一直占着），用户可能正在训练。

---

### 复现「节点每帧长高」（§4.6 / §5.7）

```bash
<任意 node> custom_nodes/ComfyUI-StockingTexture/arrange_check.mjs
```

这份脚本把前端产物里 `_arrangeWidgets` / `distributeSpace` / 与 widget 有关的 `node.computeSize`
**逐字抄**进一份可跑的最小模型（自带节点：1 入 3 出 6 widget + 1 面板 widget），然后各跑 400 帧：

| | 第 1 帧 | 第 60 帧 | 第 400 帧 |
|---|---|---|---|
| 现状（`widget.computeSize`） | 992 | 6420 | 37700（每帧 +92） |
| 修好后（`computeLayoutSize`） | 900 | 900 | 900（恒定） |

两条断言：现状 400 帧必定长高 > 1000px；修好后 400 帧高度增量必须是 0。
**前端升级后这个脚本本身不会坏**（它抄的是算术，不是前端），但它证明的东西会失效 —— 前端如果改了
`_arrangeWidgets` 的结尾那行，要重新去产物里核对一次（当初的定位方法：在
`.venv/Lib/site-packages/comfyui_frontend_package/static/assets/*.js` 里搜 `_arrangeWidgets` 与
`vueNodesMode`）。

---

## 7. 备份

| 名字 | 内容 |
|---|---|
| `N:\丝袜节点\V0.55` | **并排 + 分隔条 + 缩略图那一版**（处理前/成品已左右并排、分隔条可拖、两张格子走 `w=` 缩略图）。与当前目录的差别只有两处：`web/stocking.js`（当时还是在猜 `$$canvas-image-preview` 删 widget，现改为 `hideOutputPicture`）和 `routes.py`（当时用 `art[..., ::-1]` 换通道，现改为 `cv2.cvtColor`）。数据文件、`panel/`、`upstream/`、`nodes.py`、`web/stocking.css` 全部逐字节相同 |
| `N:\丝袜节点\ComfyUI-StockingTexture-2026-10-12_2020` | **材质开关那一版**（只有 `upstream/` + `panel/` 的材质改动，还没有并排 / 分隔条 / 缩略图） |
| `custom_nodes\_backups.disabled\Stocking Texture 2` | 更早的一版（第一轮四项改动之前）。`diff -r` 会看到一批文件有差异，那是后来的改动，不是备份坏了 |
| `G:\siwa` | 上游原版工具的完整本地副本（含 `stocking/`、`tests/`、`docs/`），用于比对与回拷 |
| `J:\WORK\2026-10-16-13-20-27\stocking-longstrip\` | **修「节点长高」之前**的 `web/stocking.js` 与 `web/stocking.css` 原件（`*.orig.bak`），加本轮那份复现脚本与用户反馈的截图。只用于对照，不要拿去覆盖 |

⚠️ 本轮之后**不要再拿 `G:\siwa` 的 `static/app.js` 覆盖 `panel/app.js`** —— 那会把画笔平滑丢掉。要看 `app.js` 相对上游到底改了什么：

```bash
diff -u upstream/static/app.js panel/app.js
```

**为什么备份目录带 `.disabled`：**
ComfyUI 的 `init_external_custom_nodes()` 会把 `custom_nodes` 下**每一个顶层条目**都丢给 `load_custom_node()`
——`os.listdir` 不递归、也不跳过下划线开头的名字。
`_backups` 里没有 `__init__.py`，里面的副本不会被当成节点加载（不会产生重复节点），但会在启动日志里留一条刺眼的
`IMPORT FAILED`。加上 `.disabled` 后缀后 ComfyUI 会直接 `continue` 跳过它，日志干净。

**同理：不要把带 `__init__.py` 的备份直接放在 `custom_nodes` 顶层**——它会被当第二个节点加载，
两个同名 `StockingTexture` 注册进 `NODE_CLASS_MAPPINGS` 会互相覆盖。
