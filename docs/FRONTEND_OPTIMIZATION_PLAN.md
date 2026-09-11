# DSH Desktop 前端优化方案（第五轮 · v1.0.0 深澜之后）

> 走查基线：v1.0.0（`96ff0b8`，深澜视觉体系整体落地）· 范围：全部 11 个自绘渲染页面 + `ui.css` 设计系统 + 与界面直接相关的主进程编排（窗口/尺寸/IPC/推送路径）
> 与前序的关系：前四轮（全量 UI 优化 → 弹窗专项 → 前端重构阶段 0–3 → 深澜视觉重绘）已把「骨架」建成——五个单一事实源（`ui.css` 令牌 / `ui-icons.js` / `shortcuts.js` / `i18n` / `commands.js`）、L3 复合组件层（`ui-kit.js`）、列表 keyed diff 与 roving tabindex、Win11 系统材质均已落地。
> **本轮不再做视觉推倒重来**，只做三件事：① 修正深澜落地与阶段 3 重构留下的**真实回归**；② 把仍靠「人肉保持同步」的耦合点**收口到单一事实源**；③ 削减**高频帧与开窗路径**上的跨进程/同步 IO 开销。
> 不改变任何用户可见的功能语义与既有几何契约。

---

## 1. 总体评价

工程成熟度在同类 Electron 壳中属上游：注释密度高且解释「为什么」，安全基线扎实（全沙箱渲染层、无 `nodeIntegration`、`trustedEvent` 校验、文本一律 `textContent`），崩溃路径与竞态有专门考虑，`uitest.js` 有 160+ 断言与静态契约锁。

因此本轮的增量收益不在「大改」，而在**长尾的一致性与热路径成本**。本次走查共确认 **4 个真实缺陷/回归**，以及 3 类系统性问题：

| 类别 | 症结 |
|---|---|
| **回归残留** | 深澜换值、阶段 3 改命令 id 时，有两处「改了一半」：报告窗用页面级 `:root` 把设计令牌钉回旧值；菜单图标表与命令注册表键漂移 |
| **耦合靠注释维持** | 菜单行高、面板行高、status 高度等被拆分在「主进程常量 / 估值函数 / 渲染层 CSS」三处，一致性只写在注释里，无机制保障 |
| **热路径未短路** | 下载期间 150ms 一帧的推送路径上，存在**未做同值短路**的原生窗口操作与**同步磁盘读**，以及每帧一次的跨进程 DOM 测量 |

---

## 2. 问题总览

级别：**P0** = 真实缺陷/视觉回归，应立即修；**P1** = 一致性或热路径成本，收益明确；**P2** = 打磨与整洁。

| 编号 | 位置 | 问题 | 级别 |
|---|---|---|---|
| **R-1** | `report.html:84-85` | 页面级 `:root` 覆写 `--c-warn` / `--c-fg3`，后声明同特异性**恒覆盖**深澜令牌，报告窗脱离色板 | P0 |
| **R-2** | `ui-icons.js` ↔ `commands.js` | 5 条命令无图标（菜单项图标槽空白），2 个图标成死代码 | P0 |
| **R-3** | `status.html:183-189` / `243-254` | `fmtPct`、`fillButtons` 各定义两份，函数提升后后者静默覆盖前者 | P1 |
| **R-4** | `status.html:125` + `:231-233` | `role="progressbar"` 静态外壳内又追加一个 `role="progressbar"`，ARIA 非法嵌套 | P1 |
| **T-1** | 4 个页面 | `.win.mica` / `.win.acrylic` 各写一份，未上移 `ui.css` 窗口外壳层 | P1 |
| **T-2** | `settings.html:80`、`loading.html:80` | 硬编码字体栈替代 `var(--font-mono)` | P1 |
| **T-3** | `settings.html:31`、`reveal-tab.html:19,57` | 焦点环宽度/圆角/品牌光晕硬编码，绕过令牌 | P2 |
| **T-4** | `status.html:49` | 任务行卡片用 `--radius-l`(16px 面板档)，与 `--radius-card` 语义不符 | P2 |
| **T-5** | 4 个页面 | `.win-head` 结构 + 关闭按钮 i18n 接线逐页手写；`ui-kit.js:33` 声明延后的 `winShell` 已到落地时机 | P2 |
| **P-1** | `main.js:654-658` | 150ms 进度帧无条件 `setContentSize` + `setTitle` + `send` + `refreshTray` | P1 |
| **P-2** | `main.js:425,476` + `core.js:17` | 150ms 路径上每帧 2 次同步读 `config.json`（短路判断在读盘之后） | P1 |
| **P-3** | `status.html:456` + `main.js:1093` | 列表模式每帧 `S.rendered()` → 每 150ms 一次跨进程 `executeJavaScript` 全列表测量 | P1 |
| **P-4** | `main.js:2660-2661` | 为菜单 label 每 30s 拉起 PowerShell 枚举进程树；启动时那次必然无效 | P2 |
| **P-5** | `palette.html:186` | 每次击键 `list.textContent=''` 全量重建行，未用已有 `keyedList` 构件 | P2 |
| **A-1** | 9 份 `*-preload.js` | `__i18n.t` 实现重复 9 份，各自 `sendSync('i18n:table')`；菜单/面板每次开合都重付一次 | P1 |
| **A-2** | `main.js` 11 处建窗样板 | `createAuxWindow` 未抽；窗口生命周期有 4 套不同策略 | P2 |
| **A-3** | `main.js:1039-1104, 1306, 1431-1448, 1621-1648, 2350-2392` | 高权限入站通道只校验 `file:` 协议，未校验 `e.sender` 身份 | P1 |
| **X-1** | `ui.css:391` | `prefers-reduced-motion` 逐条列举，`--dur-*` 未置零 → 页面级 `transition` 全部仍在跑 | P1 |
| **X-2** | `palette.html:87` | `role="combobox"` 输入框无可访问名（只有 placeholder） | P1 |
| **X-3** | `report.html:124`、`settings.html:236` | 复制/导出/保存的就地反馈写入无 `aria-live` 的 `.inline-feedback`，读屏零播报 | P1 |
| **X-4** | `menu.html:224-228,250-259` | typeahead 的 `typeBuf`/`typeTimer` 跨次开合不重置，可能匹配上一次的陈旧前缀 | P2 |
| **X-5** | `titlebar.html:192,276` | 主题钮首帧起可见，但可访问名要等第一次 IPC 推送才有 | P2 |
| **X-6** | `welcome.html:55` | hero 大图 `alt="DSH"` 与紧邻的 `<h1>` 重复播报（该装饰） | P2 |
| **X-7** | `dialog.html:67`、`status.html:168`、`titlebar.html:291` | `focusTrap`/`listNav` 返回的拆除闭包被丢弃、`MutationObserver` 未 `disconnect` | P2 |
| **H-1** | 仓库根 | `NVIDIA Corporation/` 空目录树、`.prepack-base/`（2.7MB）未入 `.gitignore`，污染 `git status` | P2 |
| **H-2** | `i18n/zh-CN.json` | 6 个确认无引用的死文案键 | P2 |
| **H-3** | `main.js:1752` | 注释「18 条命令」与实际 17 条不符（陈旧注释） | P2 |
| **H-4** | `report.html`、`settings.html`、`status.html`、`titlebar.html` | 手写 `<button>` 缺 `type="button"`（`ui-kit.buttonRow` 生成的已带） | P2 |

---

## 3. P0 真实缺陷

### R-1【令牌覆盖】报告窗的「兜底」实际是无条件覆盖

- **问题定位**：`report.html:84-85`

  ```css
  /* 颜色变量缺失时(浅色主题个别子集)走兜底,避免无声白屏 */
  :root { --c-warn: #f59e0b; --c-fg3: #909296; }
  [data-theme="light"] { --c-warn: #b45309; --c-fg3: #6b7280; }
  ```

  这两行的意图是「令牌缺失时兜底」，但 CSS 自定义属性的层叠与普通声明一致：`ui.css` 的 `:root`（特异性 0,1,0）与本块特异性相同，而本块所在的 `<style>` 在 `<link rel="stylesheet">` **之后**，因此**永远胜出**。`[data-theme="light"]` 同理压制 ui.css 的浅色覆写。

- **后果**：报告窗的 `--c-warn` 恒为 GitHub 时代的 `#f59e0b`（深澜为珊瑚金 `#fbbf24`），`--c-fg3` 恒为中性灰 `#909296`（深澜为带蓝的深波 `#5f6884`）。受影响处包括 `.cls.exit` 状态横幅（进程退出场景底色与该窗唯一的告警色）、`.log .line.warn`（警告行）、以及日志行号 `.lnum` 的颜色。**报告窗是用户遇到故障时唯一看到的界面，它却不在深澜色板内**——这是 v1.0.0 的视觉回归，且因「报告窗只在出错时出现」，日常走查极易漏掉。

- **优化目标**：恢复令牌单一来源；「兜底」语义若确有需要，不得用同特异性的页面级 `:root` 实现。

- **改进措施**：删除 `report.html:83-85` 两行。ui.css 的 `:root` 已在同文件顶部无条件定义这两个令牌，二者永不为空，「缺失」这一前提不成立。若仍希望保留极端兜底，正确写法是在引用处写 `var(--c-warn, #f59e0b)`，而非重定义令牌。

- **预期效果**：报告窗告警色/次级文字色回归深澜色板；`grep ":root {"` 在全部页面中归零，`ui.css` 重回唯一令牌源。

### R-2【键漂移】菜单图标表与命令注册表已漂移

- **问题定位**：`menu.html:190` 与 `palette.html:213` 均按条目 `id` 取图标 `ICONS[it.id] || ''`，条目 id 来自 `commands.js` 注册表（+ 少量主进程合成项）。实测比对：

  | 有命令、无图标（菜单项图标槽恒空） | 有图标、无命令（死代码） |
  |---|---|
  | `copy-workspace`、`open-tasks`、`settings-download`、`settings-appearance`、`settings-advanced` | `auto-open-browser`、`download-accel` |

- **成因**：v0.8.1 阶段 3 第二批把「下载加速设置」改为「更新与下载设置」深链（`download-accel` → `settings-download`），并新增两条 `settings-*` 深链，只改了 `commands.js` 的 id，未同步 `ui-icons.js` 的键。`auto-open-browser` 同理（该勾选项已收进设置窗）。`copy-workspace` / `open-tasks` 是阶段 2 新增的 `menu:false` 条目，本来就没配图标——但它们在**命令面板**里可见，同样显示为空。

- **后果**：菜单「更新与下载设置 / 外观与行为设置 / 高级设置」三项的图标槽是 16px 空白，夹在两侧都有图标的条目之间，视觉上像「图标没加载出来」；命令面板搜索结果里这 5 条同样无图标。同时 2 个死图标随包发布。

- **优化目标**：图标键与命令 id 一一对应，且该对应关系可被断言拦截。

- **改进措施**：
  1. 在 `ui-icons.js` 的 `menu` 域补 5 个图标（`settings-download` 可复用原 `download-accel` 的船形/下载语义，`settings-appearance` 用 `cycle-theme` 的半月语义、`settings-advanced` 用 `memory-info` 的芯片语义，`copy-workspace` 用复制/路径语义，`open-tasks` 复用 `cmdbar.tasks` 的清单语义），删除 `auto-open-browser`、`download-accel`。
  2. 在 `uitest.js` 加一条静态断言 `icon-keys-sync`：解析 `commands.js` 的 id 集合与 `ui-icons.js` 的菜单键集合，要求「每个进菜单/面板的 id 都有图标」，无对应命令的键数为 0。这条断言正是防止下一次改 id 时重演。

- **预期效果**：菜单与命令面板图标齐全一致；键漂移由测试拦截，不再依赖人工比对。

### R-4【ARIA 非法嵌套】进度条套进度条

- **问题定位**：`status.html:125` 的静态外壳本身就带角色与范围：

  ```html
  <div class="bar" id="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="fill indet" id="fill"></div></div>
  ```

  而 `render()`（`status.html:231-233`）在活动态下 `barWrap.innerHTML = ''` 后，把 `K.progressBar(...)` 的返回值（`ui-kit.js:115-133` 构造的**另一个** `role="progressbar"` 节点）追加进去。结果是 `#bar[role=progressbar] > div.bar[role=progressbar]` —— 进度条包含进度条，违反 ARIA 的容器角色约束；外层还挂着一个由 `status.html:158` 设置的 `aria-label`，读屏可能播报两层。

- **优化目标**：`#bar` 只作为布局槽，角色唯一。

- **改进措施**：把 `status.html:125` 静态外壳的角色/范围属性移除（只留 `class="bar" id="bar"` 作为插入点），由 `K.progressBar` 生成的节点独占 `role="progressbar"`；`status.html:158` 的 `aria-label` 随之删除（构件已按 `status.html:233` 传入的 `p.title` 设置 `aria-label`）。同时可顺带把手写的进度更新（`status.html:343-358` 自行处理 clamp/width/`aria-valuenow`）也交给构件，消除两处对同一契约的实现。

- **预期效果**：无障碍树中每帧只有一个进度条节点；进度条契约只有 `ui-kit` 一份实现。

---

## 4. 一致性：令牌与样式漂移

### T-1【样式重复】窗口材质块上移 `ui.css`

- **问题定位**：`.win.mica` 在 `settings.html:117`、`report.html:17-20` 各一份；`.win.acrylic` 在 `status.html:109`、`dialog.html:40` 各一份。四份内容一致（mica 62% 底、acrylic 55% 底，均去自绘大阴影）。

- **优化目标**：材质是「窗口外壳」的公共属性，应与 `.win` 同处 `ui.css §5`。

- **改进措施**：在 `ui.css` 的 `.win` 规则后新增

  ```css
  .win.mica    { --win-bg: color-mix(in srgb, var(--c-win-bg) 62%, transparent); --win-shadow: none; }
  .win.acrylic { --win-bg: color-mix(in srgb, var(--c-win-bg) 55%, transparent); --win-shadow: none; }
  ```

  删除四页的本地副本。渲染层仍按既有载荷（`mica` / `acrylic` 字段、`st:env`）加类名，行为零变化。

  同一批可顺带收编「透明窗根规则」——`html, body { height:100%; overflow:hidden; background:transparent; user-select:none }` 在 `dialog/status/report/settings/welcome` 五页逐字重复（`menu.html`、`palette.html` 为变体）。可提为 `ui.css` 的一个 `.win-page` 工具类，各页 `<body class="win-page">`。此项**会改变选择器特异性**，需逐页确认无本地覆盖依赖，故列为可选。

- **预期效果**：未来新增辅助窗只需加类名，不必再复制两行；材质半透明度只有一个数字来源。

### T-2【令牌绕过】硬编码字体栈

- **问题定位**：`settings.html:80` 与 `loading.html:80` 写死 `"Cascadia Mono", Consolas, "Microsoft YaHei", monospace`，而 `ui.css:140` 已定义 `--font-mono`；同文件的 `.path code`（`settings.html:107`）、`report.html:71` 都已正确走令牌。

- **改进措施**：两处改为 `font-family: var(--font-mono)`。

- **预期效果**：等宽字栈一处可改；`grep "Cascadia Mono" *.html` 归零。

### T-3【令牌绕过】焦点环/圆角/光晕硬编码

- **问题定位**：`settings.html:31` `.tab:focus-visible { outline: 2px solid … }` 未用 `var(--focus-ring-w)`；`reveal-tab.html:19` 硬编码 `border-radius: 0 0 14px 14px`、`:57` 硬编码 `rgba(77, 107, 254, .5)` 品牌光晕（该值恰是深澜品牌蓝的手写 rgb，主题换色后不会跟随）；`settings.html:37` 的 `999px` 可用 `var(--radius-pill)`。

- **改进措施**：逐处换为令牌（`--focus-ring-w`、`--radius-panel`/新增下拉把手专用值、`color-mix(in srgb, var(--c-brand) 50%, transparent)`、`--radius-pill`）。

- **预期效果**：深澜改色时下拉把手光晕同步；全仓「令牌级距外的游离数值」清零。

### T-4【语义误用】卡片圆角用了面板档

- **问题定位**：`status.html:49` 的 `.trow`（任务行，是卡片）用 `border-radius: var(--radius-l)`（= `--radius-panel` 16px），而 ui.css 的语义命名是 `--radius-card: 12px`（注释明写「卡片 / 任务行 / 面板内块」）。

- **改进措施**：改为 `var(--radius-card)`。

- **预期效果**：圆角语义与命名一致；任务行与列表内其他卡片同档。

### T-5【结构重复】窗口头部三件套仍逐页手写

- **问题定位**：`.win-head` 的结构（图标槽 `.ico` + 标题 `.t` + `.win-close` 按钮）在 `status.html:115-122`、`report.html:101-105`、`settings.html:126-130`、`welcome.html:49-52` 重复四份；且每页都要再手写一遍「填 `title` + `aria-label` + 绑关闭回调」的接线（`status.html:155-157`、`report.html:152-155`、`settings.html:307-309`、`titlebar.html:215-224`——其中 `titlebar` 的 `setTip` 已被抽成局部函数，说明这个重复本身是可感知的）。`ui-kit.js:33` 明确记录 `winShell` 复合件「属阶段 3（窗口模型归一），届时四窗一并改造」——阶段 3 已收尾，但该构件未落地，成了悬空的计划。

- **优化目标**：窗口外壳（头部 + 关闭按钮 + i18n 接线）只有一个实现。

- **改进措施**：在 `ui-kit.js` 落地 `winShell(win, { iconId, titleKey, onClose })`，四页改用它。注意 `status.html` 的头部多一个「后台」按钮（`.hmbtn`），需支持「关闭按钮之前的额外插槽」参数——但这是参数化，不是分支。

- **预期效果**：新增辅助窗的外壳从「复制 8 行 HTML + 6 行 JS」变为一次调用；关闭按钮的可访问名不可能再漏配。

---

## 5. 性能：热路径短路与同步 IO

> 共同背景：下载/安装期间，`pushTasks`（`main.js:649`）由 progress 回调以 **150ms** 一帧驱动，约 7 帧/秒，整个下载期持续。

### P-1【原生窗口操作未短路】150ms 帧上的 `setContentSize` / `setTitle`

- **问题定位**：`main.js:654-658`

  ```js
  statusWin.setContentSize(410, statusHeight());
  statusWin.setTitle(statusWinTitle(tasks));
  statusWin.webContents.send('st:tasks', tasks);
  applyStatusProgress();
  refreshTray();
  ```

  这五项**每帧无条件执行**。其中 `setContentSize` 与 `setTitle` 是原生窗口调用（`setContentSize` 会触发一次原生 resize + 渲染层重排），`setProgressBar` 被调用两次（任务栏 + 主窗）。而 `statusHeight()` 在单任务期间恒为 186 或 250，`statusWinTitle()` 在标题不变时也恒定。同文件对托盘与命令栏状态簇已做过同值短路（`main.js:431-448`、`463-483`，注释明确写了「进度帧不产生 IPC」），**唯独最重的窗口尺寸/标题漏了**。

- **优化目标**：数值未变时不触碰原生 API。

- **改进措施**：加缓存短路，与 `trayLastTip` 同模式：

  ```js
  const h = statusHeight();
  if (h !== statusLastH) { statusLastH = h; statusWin.setContentSize(410, h); }
  const wt = statusWinTitle(tasks);
  if (wt !== statusLastTitle) { statusLastTitle = wt; statusWin.setTitle(wt); }
  ```

  缓存需在窗口重建（`ensureStatusWindow`）与 `close` 时复位。同时把散落的字面量 `410` 提为 `STATUS_W` 常量（`main.js:654` 与 `669` 已是第二个副本）。

- **预期效果**：下载期每秒 ~7 次原生 resize/setTitle 归零，只在任务增删导致行数档位变化时触发；状态窗在下载期间的原生层抖动消失。

### P-2【热路径同步磁盘读】每帧 2 次 `loadConfig()`

- **问题定位**：`core.js:17-19` 的 `loadConfig()` 无缓存，每次都是 `fs.readFileSync + JSON.parse`。而 `refreshTray()`（`main.js:433`）里的两条调用链每帧都会命中它：

  - `main.js:438` → `trayStatusText()` → `main.js:425` `loadConfig().workspace`
  - `main.js:436` → `pushTitlebarStatus()` → `main.js:476` `loadConfig().theme`

  **关键点**：`pushTitlebarStatus` 的同值短路（`main.js:478-479`）发生在 `payload` **构造之后**——为了比较而构造的 `svcText` 已经把盘读了。因此短路缓存拦不住 IO：下载期约 **14 次/秒同步读盘**，全部阻塞主进程事件循环。

- **优化目标**：配置在内存中只有一份；同值短路真正短路。

- **改进措施**：给 `core.js` 加带失效的缓存：

  ```js
  let cfgCache = null;
  function loadConfig() {
    if (cfgCache) return cfgCache;
    try { cfgCache = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { cfgCache = {}; }
    return cfgCache;
  }
  function saveConfig(cfg) { …成功后 cfgCache = cfg; … }
  ```

  注意：需保证 `saveConfig` 成功路径更新缓存、失败路径不更新（写入被拒时磁盘仍是旧值）。若担心外部进程改 `config.json`，可在 `saveConfig` 之外提供 `invalidateConfig()`，由「打开设置窗」「切换工作目录」等低频入口调用即可——不必为此牺牲热路径。

- **预期效果**：热路径同步 IO 归零；`loadConfig` 的 7 个调用点（`applyTheme` / `trayStatusText` / `pushTitlebarStatus` / `settingsPayload` / `commandCtx` / `sendCloseTip` / close 钩子）自动共享一份内存值。

### P-3【每帧跨进程测量】列表模式的 `S.rendered()`

- **问题定位**：`status.html:456` 在**每一帧**列表渲染后调用 `S.rendered()`；主进程 `main.js:1093-1104` 收到后执行 `fitWindowToContent`，其实现是一次 `webContents.executeJavaScript(...)`（`main.js:1097-1102`）注入一段遍历整个列表、逐行 `getBoundingClientRect` 的测量脚本。即：下载期每秒 ~7 次「IPC → 主进程注入脚本 → 渲染进程同步布局测量 → 回传 → 可能 setContentSize」。

  而 `fitWindowToContent` 的用途（`main.js:1091` 注释）是「修正 `statusHeight()` 行数估算的漂移」——这是一个**只在任务增删时才会变**的量，与进度百分比无关。

- **优化目标**：按「行集合变化」而非「帧」回报。

- **改进措施**：渲染层缓存上一次回报的行数指纹（进行中行数 + 完成行数 + 历史折叠态），仅在指纹变化时调 `S.rendered()`；主进程侧再补一道同值短路（测量结果与当前内容高度差 <1px 时不调 `setContentSize`）。二者独立成立，可只做其一。

- **预期效果**：进度帧不再触发跨进程 DOM 测量；下载期状态窗 CPU 占用显著下降。

### P-4【常驻 PowerShell】为菜单 label 每 30s 枚举进程树

- **问题定位**：`main.js:2660-2661` 在 `startMain` 中立即 `refreshTotalMemory()` 并 `setInterval` 每 30s 一次；其实现在 `main.js:1692` 起一个 PowerShell（`-EncodedCommand` + CIM 查询）枚举 dsh 进程树，单次数百 ms CPU/IO 尖峰。该值只喂给菜单里的「内存」label（`main.js:1700` 注释）。

  启动时那次几乎必然无效：`dshChild` 尚未建立，`dshTreeMemMB` 直接 resolve 0（`main.js:1681-1682`）——却仍然起了一个常驻定时器。

- **优化目标**：按需刷新，常驻成本归零。

- **改进措施**：删除启动时的立即调用与 `setInterval`；改为在 `showMenuPopup()`（菜单本身已是懒创建）与设置窗「高级」分区的 `acc:get` 路径上按需刷新，并保留一个「距上次刷新 > N 秒才真跑」的节流。菜单里的内存值从「后台常驻采样」变为「打开菜单时的新鲜值」，用户观感反而更好。

- **预期效果**：无常驻 PowerShell 进程；菜单/设置窗打开时最多一次查询，且带节流。

### P-5【每次击键全量重建】命令面板结果行

- **问题定位**：`palette.html:186` `renderRows()` 以 `list.textContent = ''` 开头，随后对 ≤8 行逐个 `createElement` 并 `addEventListener`。每次 `input` 事件都如此。

- **优化目标**：复用项目已有构件，与 `status.html` 的做法一致。

- **改进措施**：`status.html` 已用 `K.keyedList` 解决同类问题（`ui-kit.js:206-234` 的存在理由正是「全量重建会冲掉滚动位置、CSS 动画、未提交输入与焦点」）。命令面板把 `view` 映射为带 `k: it.id` 的 specs，`create`/`update` 分别建行与就地改 `sel`/`aria-selected` 即可。收益在 ≤8 行时不大（这也是当初未做的原因），但它消除了同一代码库里两种对立做法，属一致性收益。

- **预期效果**：击键时节点身份稳定；`ui-kit.keyedList` 的消费方从 1 处变 2 处，构件不再是「只用在一处的基础设施」。

---

## 6. 架构：preload、窗口与 IPC

### A-1【重复实现】9 份 `__i18n.t` 与 9 次 `sendSync('i18n:table')`

- **问题定位**：`dsh/menu/palette/report/settings/status/titlebar/toast/welcome` 九个 preload 各自复制了同一段（以 `menu-preload.js:7-23` 为例）：

  ```js
  let i18nTable = {};
  try { i18nTable = ipcRenderer.sendSync('i18n:table') || {}; } catch {}
  contextBridge.exposeInMainWorld('__i18n', { t: (key, params) => { … } });
  ```

  取值/占位符/回退逻辑完全相同，改动要同步 9 处。且 `menu` / `palette` / `reveal-tab` 的视图是**每次交互销毁重建**（`main.js:1814-1843`、`2015-2045`、`255-281`），因此每次开合菜单/面板都要重付一次 `sendSync`——主进程被同步阻塞在渲染进程的 preload 阶段。`revealTabView` 用的是 `titlebar-preload.js`，收起标题栏时一次要付 `sc:display` + `i18n:table` **两次** `sendSync`。

- **优化目标**：文案表一份实现、一次拉取。

- **改进措施**：新增 `preload-i18n.js`（导出 `installI18n()`，内部完成 `sendSync` 一次 + `exposeInMainWorld('__i18n')`），九个 preload 改为 `require('./preload-i18n').install()`。进一步（可选）把 `sendSync` 换成主进程在窗口 `did-finish-load` 时 `send('i18n:table', snapshot)`、渲染层首个 `t()` 前 await 的模式，彻底去掉同步阻塞；因 `t()` 在渲染层是同步 API，这一步需要一个「表到达前的 key 回退」窗口，风险可控但改动面较大，可作为第二批。

- **预期效果**：preload 里 `sendSync` 从 9 处收敛到 1 处；文案逻辑单点维护。

### A-2【样板与策略】窗口创建与生命周期不统一

- **问题定位**：`main.js` 中 7 处 `new BrowserWindow`（566/669/784/1274/1407/1597/2544）与 4 处 `new WebContentsView`（260/1817/2018/2193）重复同一套样板：`frame:false` / `show:false` / `webPreferences:{sandbox:true, spellcheck:false, preload}` → `setMenuBarVisibility(false)` → `loadFile(...).catch(()=>{})` → `did-finish-load` 补发 → `closed` 清引用。安全默认值（`sandbox`、`spellcheck:false`）靠人工复制，漏一处即静默降级。

  生命周期策略同时存在四套：隐藏复用 + 闲置 60s 销毁（dialog/settings）、关闭即销毁（status/report）、每次交互全新创建（trayMenu/menu/palette/reveal）、按需建队列空即销毁（toast）。

- **优化目标**：安全默认值不可漏；策略差异显式化。

- **改进措施**：抽 `createAuxWindow({ file, preload, width, height, props })` 与 `createAuxView({ file, preload })`，把安全默认值收进函数体；`AUX_IDLE_DESTROY_MS` 等策略参数由调用方传入并在调用点写明为何选这套策略。**这一项是纯重构，不修 bug**，建议作为独立提交，不与本方案其他项混提。

- **预期效果**：新增辅助窗从 15+ 行变 1 行；`sandbox:false` 这种降级不可能被无意引入。

### A-3【纵深防御】入站通道缺发送方身份校验

- **问题定位**：`main.js:1019-1025` 的 `trustedEvent` 只校验 `file:` 协议。实际做了 `e.sender` 身份校验的只有少数（`nt:*`、`pt:*`、`st:rendered`、`dl:rendered`、`boot:action`）。以下高权限通道**只查协议**：

  - `st:bg/close/action/dismiss/cancel/cancel-one/cancel-all/clear-done`（`main.js:1039-1092`）
  - `dl:choose`（`1306`）
  - `acc:close/copy/get/set`（`1431-1448`）
  - `rp:export/copy/open-log/action`（`1621-1648`）——其中 `rp:export` 会弹出原生保存框并写文件
  - 绝大多数 `tb:*`（`2350-2392`）与 `m:action`/`m:close`（`1939-1954`）

  这意味着：任何一个 `file:` 页面被注入（例如 dsh 侧错误信息含恶意构造内容且某页渲染不当）即可调用其他窗口的高权限动作。当前各页文本均走 `textContent`，实际触发路径很窄，但这是纵深防御的实际缺口，不是理论问题。

- **优化目标**：每个入站通道只接受「它该来自的那个窗口」。

- **改进措施**：把 `trustedEvent` 升级为 `trustedEvent(e, expectedView)` 形式（或在各 `ipcMain.on` 首行补 `e.sender !== statusWin?.webContents` 判定后 return），逐个通道标注期望发送方。这是机械但需细致的改动，建议单独提交并复跑 UITEST。

- **预期效果**：越窗调用不可能；新增通道时也会被迫显式声明来源。

---

## 7. 可达性与动效

### X-1【动效降级】`prefers-reduced-motion` 未从令牌层收口

- **问题定位**：`ui.css:391-395` 的降级块只逐条列举了 `.win` / `.big` / `.fill` / `.titem.enter` 的动画，并额外保留 `status`/`settings`/`report`/`toast` 四页各自的本地降级。问题在于：全仓大量交互反馈走的是 `transition`（`.btn`、`.item`、`.tab`、`.prow`、滑杆 thumb、`reveal-tab` body 等），而 `--dur-*` 令牌（`ui.css:129-136`）**没有被置零**——降级块覆盖不到这些 `transition`。开启动效降敏的用户，仍会看到所有悬停/切换过渡。

- **优化目标**：一处令牌级收口，覆盖全部过渡与动画。

- **改进措施**：在 `ui.css` 的 reduced-motion 块内加

  ```css
  @media (prefers-reduced-motion: reduce) {
    :root { --dur-fast: 0s; --dur-mid: 0s; --dur-slow: 0s; --dur-win: 0s; }
  }
  ```

  保留既有逐条 `animation: none`（关键帧动画不受时长令牌控制）。同时清理各页本地降级块中已被令牌覆盖的重复项。注意 `--dur-win: 0s` 会让 `.win` 入场动画瞬间完成，与既有 `animation:none` 等效。

- **预期效果**：所有过渡与动画在同一开关下归零；新增组件只要用令牌就自动遵从，无需记得加媒体查询。

### X-2【可访问名】命令面板输入框只有 placeholder

- **问题定位**：`palette.html:87`

  ```html
  <input id="q" type="text" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="plist" spellcheck="false" autocomplete="off">
  ```

  有 `role="combobox"` 与控制关系，但**没有可访问名**。placeholder（`palette.html:112` 经 `T('palette.placeholder')` 设置）按规范**不能**作为可访问名（它只是提示，且输入后消失）。读屏用户聚焦该框时只会听到「组合框，可编辑文本」，听不到这是「命令搜索」。

- **优化目标**：输入框有稳定的可访问名。

- **改进措施**：加 `aria-label`，取值复用已存在的 `palette.region`（“命令面板”）或新增 `palette.searchLabel`，在 `palette.html:110-113` 的初始化块内一并设置。同理复核 `settings.html` 的 `#seg` 已有 `aria-label`（`283`）与 `aria-valuetext`（`399`）——此处是正例。

- **预期效果**：读屏进入面板即播报用途；与其余控件的标注水准一致。

### X-3【反馈不可播报】就地反馈缺 live region

- **问题定位**：`.inline-feedback`（`ui.css:329-334`）是纯视觉的透明→显示过渡，无 `role`/`aria-live`。而两处把「操作结果」写进去：

  - `report.html:124` `#flash` ← 复制成功（`257`）、导出成功（`258`），经 `K.feedback`（`247-250`）
  - `settings.html:236` `#toast` ← 分段数保存、镜像保存/重置、档位切换（`318-323` 及 `407,417,427,434,454,460-461`）

  对比 `settings.html:160` 的 `#mirrorErr` 已正确标注 `aria-live="polite"`——说明标注纪律存在，只是漏在了「成功反馈」这一侧。

- **优化目标**：成功/失败反馈与错误提示同样可播报。

- **改进措施**：在 `ui.css` 的 `.inline-feedback` 规则处补 `aria-live` **无意义**（CSS 不能加 ARIA），需在 HTML 上加：给 `report.html:124` 与 `settings.html:236` 两个节点加 `role="status"`（成功/中性）——因两处也会承载失败信息，统一用 `aria-live="polite"` 更稳。构件 `K.feedback` 只改 `className`/`textContent`，加属性零冲突。

- **预期效果**：读屏用户在复制/保存后能听到结果；两窗标注水准对齐。

### X-4【状态泄漏】菜单 typeahead 未跨次开合复位

- **问题定位**：`menu.html:224-228` 的 `typeBuf` / `typeTimer` 是模块级变量，`onShow`（`250-259`）只重建列表、复位 `sel`，**没有清空 `typeBuf` 与 `typeTimer`**。若上一次菜单在 500ms 缓冲窗口内被关闭，重新打开后继续输入会与陈旧前缀拼接，跳转到非预期条目；`typeTimer` 也可能在菜单已隐藏后触发（无害但无意义）。

- **改进措施**：在 `onShow` 内 `clearTimeout(typeTimer); typeBuf = '';`（或直接调用一个 `resetTypeahead()`）。

- **预期效果**：每次打开菜单的 typeahead 都从干净状态开始。

### X-5【首帧无名】标题栏主题钮在首次推送前无可访问名

- **问题定位**：`titlebar.html:192` 的 `#themeBtn` 从首帧起就可见（不像 `#taskBtn`/`#updBtn` 默认 `hidden`），但它的 `aria-label` 只在 `t.onStatus` 回调里写（`titlebar.html:276`）。主进程第一次 `tb:status` 到达前（`main.js:464` 的推送依赖窗口就绪），它是 Tab 序里一个没有名字的按钮。

- **改进措施**：在 `titlebar.html:220-224` 的 `setTip` 初始化块里给 `themeBtn` 一个与 `auto` 模式一致的初始名（复用 `menu.appearanceAuto`），后续推送再覆盖。

- **预期效果**：首帧即有可读名；与其余四个按钮的初始化方式一致。

### X-6【装饰图误标】欢迎页 hero 大图 alt 冗余

- **问题定位**：`welcome.html:55` `<img src="assets/deepseek-whale-color.svg" alt="DSH">` 紧邻 `<h1>`（`56`）。头部小图标已正确用 `alt=""`（`50`），hero 大图却给了文本 alt，读屏会先念「DSH」再念标题，属噪声。

- **改进措施**：改为 `alt=""`。

### X-7【清理路径缺失】返回的拆除闭包被丢弃、观察者未断开

- **问题定位**：

  - `ui-kit.js` 的 `focusTrap` 返回解除函数（`203`），`dialog.html:67` 未接收；`listNav` 返回 `{ destroy }`（`308`），`status.html:168` 未接收。
  - `titlebar.html:291-292` 的 `MutationObserver` 无 `disconnect()`。
  - 全部 11 页均无 `beforeunload`/`unload` 清理，preload 的 `ipcRenderer.on` 也无 `removeListener`。

  这些页面当前是「加载一次、长期复用」或被销毁重建，因此**暂无实际泄漏路径**；记在这里是为了在 A-2（窗口生命周期归一）之后，页面可能被 reload 时不再有隐患。

- **改进措施**：与 A-2 同批处理——生命周期的统一入口应负责拆除。单独做收益很低，不建议现在动。

### 已知取舍（本轮不视为缺陷，仅记录）

- **通知条目的按钮键盘不可达**：`toast.html` 所在窗口是 `focusable:false`（`toast.html:4-7` 说明了理由：绝不抢焦点、绝不挡点击），因此 `.tact` / `.tclose` 没有键盘路径。这是「通知不打扰」与「完全可达」之间的**自觉取舍**，且相同动作在任务中心都有键盘可达入口。建议保持，但若将来有仅存在于通知里的动作，必须为此另设入口。
- **命令面板输入框焦点环走 `.pin:focus-within` 的整行光晕**：`palette.html:36` 的 `#q { all: unset }` 以 ID 特异性盖过了 ui.css 的公共焦点环（`ui.css:209`），焦点反馈改由输入行整体高亮承担。视觉上成立且更明显，仅与其余页面「控件级焦点环」的做法不同。保留。
- **`i18n` 收编已完整**：对 11 个页面做中日韩字符扫描，中文字面量**只出现在注释里**，引号内与属性值内均无——`i18n.js:4-8` 的声明属实。本方案不再列 i18n 相关项。

---

## 8. 整洁度

### H-1【仓库污染】未跟踪的遗留目录

- **问题定位**：仓库根存在 `NVIDIA Corporation/`（仅空目录树，实测无文件）与 `.prepack-base/`（`win-unpacked` 暂存，2.7MB）。两者均未被 `.gitignore` 覆盖，因此 `git status` 长期显示为 `??`。前者疑为 Chromium GPU 缓存在错误 cwd 下创建。

- **改进措施**：删除两目录；`.gitignore` 增加 `.prepack-base/` 与 `NVIDIA Corporation/` 兜底。（另：`CODE_REVIEW.md` 与 `UI_POPUP_POLISH_PLAN.md` 当前处于已删除未提交状态，按仓库「方案文档本地留存」的既有约定，应提交这两笔删除或确认它们已转本地。）

### H-2【死文案】确认无引用的 i18n 键

- **问题定位**：对全仓 `t('…')` / `T('…')` / `set(id, '…')` 字面量做静态收集后，以下 6 键零引用（已排除 `menu.appearance*`、`cmd.group*`、`palette.on/off` 等动态拼接的误报）：

  `menu.downloadAccel`、`menu.autoOpenBrowser`、`status.clearDoneTip`、`toast.viewDetail`、`report.logFilteredHint`、`report.logLines`

  成因与本轮 R-2 同源：v0.8.1 阶段 3 的深链改造移除了对应菜单项，文案表未同步清理。

- **改进措施**：删除这 6 键（329 → 323 键）；其余 `terms.*` 属术语表，可能为文档用途，保留并加注释说明用途即可。

### H-3【陈旧注释】菜单条目数

- **问题定位**：`main.js:1752` 注释写「菜单是"常用入口"(18 条命令)」，实际 `commands.list` 共 22 条、`menu:false` 滤掉 5 条后入菜单 17 条（+1 合成项「所有命令…」）。

- **改进措施**：改为 17，或去掉具体数字（注释里写死的计数必然会再次过期）。

### H-4【小一致性】手写按钮缺 `type="button"`

- **问题定位**：`ui-kit.buttonRow` 生成的按钮都带 `type="button"`（`ui-kit.js:100`），但手写的 `<button>` 多数没带：`report.html:104,128,129,130`、`settings.html:129,158,159,171`、`status.html:118,121`、`titlebar.html:195-205`。当前这些窗口内都没有 `<form>`，因此**没有实际提交行为**，但一旦将来某个头部被放进表单语境，缺省 `type="submit"` 会引发意外提交。

- **改进措施**：补齐（机械改动）。T-5 的 `winShell` 落地后，头部那几个会自动带上。

---

## 9. 实施批次与验收

按「先修可见回归、再收口、后重构」排序，每批独立提交、独立可验证、互不阻塞。

| 批次 | 内容 | 风险 | 验证 |
|---|---|---|---|
| **第一批｜修回归** | R-1、R-2（含 `icon-keys-sync` 断言）、R-3、R-4、H-2、H-3、H-4 | 极低（纯删改 + 补图标 + 去一层角色） | 浅色/深色下截图报告窗与菜单；`DSH_DESKTOP_UITEST=1 npm start` 全量断言（`tc-h`/`h-activity`/`h-result` 必须不变） |
| **第二批｜收口令牌与动效** | T-1~T-5、X-1 | 低（视觉零变化，`reduced-motion` 为增强） | 九窗逐页截图比对；开启系统「减少动态效果」后复核过渡；`grep ":root {"` / `grep "Cascadia Mono"` 归零 |
| **第三批｜热路径性能** | P-1、P-2、P-3、P-4 | 中（触及推送路径与缓存失效） | 虚构长下载，观察主进程 CPU 与原生 resize 次数；几何锁定断言不变 |
| **第四批｜preload 与可达性** | A-1、A-3、X-2~X-6 | 中（安全面与语义面改动） | 全量 UITEST；逐通道手工越窗调用应被拒；读屏走查命令面板/菜单/设置窗反馈 |
| **第五批｜纯重构（独立提交）** | A-2、P-5、H-1、X-7 | 中（无行为变更，X-7 依赖 A-2 的拆除入口） | 全量 UITEST；`git diff --stat` 复核无副作用面 |

**回归边界（不可动契约，改动前必读）**：

- 几何锁定：`status` 单视图 **186 / 250**（结果 250 锁定，`uitest.js:695,701`）、`TITLEBAR_H=30`、把手 `96×26`、`TOAST_W=360`/最多 3 条/2200ms、`PALETTE_W=560`+`MARGIN 12`/`ROW_H 36`/`MAX_ROWS 8`/`INPUT_H 56`、菜单 `MENU_ITEM_H=32`/`SEC_H=24`/`SEP_H=9`/`MENU_W=288`（`PAD_Y=20`）。
- 静态契约断言：`uitest.js:294`(palette 常量)、`354`(菜单高度)、`432`(辅助窗下限)、`546`(toast 常量) 以**源码文本正则**匹配这些常量——改常量必须同改断言。
- `--density-row` 与 `menu.html` 行高、`main.js` 的 `MENU_ITEM_H` 三者强耦合（`ui.css:121-127` 注释）。
- `main.js` 与渲染层的尺寸对应关系（如 `PALETTE_MARGIN` ↔ `palette.html` body padding、`PALETTE_INPUT_H` ↔ `.pin` 高度）逐处有注释，改一侧必须同改另一侧。

---

## 10. 实施记录（2026-09-11）

批次 1–4 与 H-1 已落地，每批独立跑 `DSH_DESKTOP_UITEST=1 npm start` 验证。

| 批次 | 落地项 | 验证 |
|---|---|---|
| 第一批 修回归 | R-1、R-2（含新增 `icon-keys-sync` 断言）、R-3、R-4、H-2、H-3、H-4 | 静态断言全绿；与改动前的基线运行逐条比对，失败集合完全一致（无新增失败） |
| 第二批 令牌与动效 | T-1、T-2、T-3、T-4、X-1 | 同上，失败集合无变化 |
| 第三批 热路径 | P-1、P-2、P-3、P-4 | 几何锁定档 186/250 不变；内存读数由按需刷新正常产出（393MB） |
| 第四批 preload 与可达性 | A-3、X-2、X-3、X-4、X-5、X-6 | 新增 `ipc-identity-all` 回归锁；全部入站通道改用 `fromWin` |
| 第五批 | A-2、T-5、X-7、P-5、H-1 | 全部落地（见下）；命令面板断言不变（rows=8 / ad=po-0 / focus=true） |

### 实施中修正的方案项

**A-1（preload 抽取）经实测不可行 —— 撤回。**
方案原文提议把 9 份 `__i18n.t` 收进 `preload-i18n.js` 由各 preload `require`。实测：沙箱化 preload 的 `require` 是受限 polyfill，**不支持相对路径**（一次性 Electron 用例返回 `module not found: ./helper.js`）。可行路径只剩「放弃 `sandbox: true`」或「引入打包步骤」，两者都比这份重复更糟。而 `sendSync('i18n:table')` 的真实开销是每次开窗一次只读静态快照（毫秒级），A-1 的性能论据不成立。**结论：保留现状，把该重复记为已知取舍。**

**T-5、A-2、X-7 已全部实施（2026-09-11，v1.0.1）。**
- **T-5**：`ui-kit.js` 落地 `winShell(head, { icon, title, close, onClose, beforeClose })`，返回 `{ ico, title, close }` 句柄供高频更新；`status.html`（后台按钮经 `beforeClose` 插槽排在 ✕ 前）、`report.html`（品牌小图带 `data-logo`）、`settings.html`（齿轮图标经 `icon` 参数）、`welcome.html`（`close:false`，无 ✕）四页改用它。四页的头部结构、初始可访问名接线、关闭回调三处重复收成一份；`H-4` 的手写 `<button>` 缺 `type` 问题在头部随之清零（`ui-kit.buttonRow` 生成的按钮本来就带）。`report.html` 的本地 `.win-head .logo` 尺寸规则随之删除（ui.css 公共 `.win-head .ico img` 已给 18px）。
- **A-2**：`main.js` 新增 `createAuxWindow({ file, preload, x, y, width, height, props })` 与 `createAuxView({ file, preload, props })`，安全默认值（`frame:false` / `show:false` / `sandbox:true` / `spellcheck:false` / `setMenuBarVisibility(false)` / `loadFile().catch`）收进函数体，`webPreferences` 在函数内与默认值合并——调用点只能追加、不能移除安全默认。7 处 BrowserWindow（托盘菜单/状态窗/通知宿主/对话框/设置窗/报告窗/欢迎页）与 4 处 View（下拉把手/菜单弹层/命令面板/dsh 内容视图）全部改走统一函数，每处调用点以注释写明生命周期策略。两处行为细节：①托盘菜单的 `loadFile().then(发载荷+展示)` 改为 `did-finish-load` 事件（时序等价，窗口早关保护保留）；②dsh 视图随统一默认补上 `spellcheck:false`（自绘壳不展示拼写 UI，与其余全部视图对齐）。
- **X-7**：`dialog.html` 接收 `focusTrap` 返回的解除闭包、`status.html` 保存 `listNav` 返回的 `destroy`、`titlebar.html` 的 `MutationObserver` 保存句柄并 `disconnect`，三者统一挂在 `beforeunload` 上释放。preload 的 `ipcRenderer.on` 未做 `removeListener`（页面销毁时监听随渲染进程一并回收，无实际泄漏路径，与 A-1 同类保留）。

**UITEST 断言随结构同步（与 T-5/A-2 同批）。** 两处结构变化打破既有断言，本轮一并修正（不是测试放水，是断言跟随新结构）：① `palette-view` 静态契约从 `paletteView = new WebContentsView(` 改为 `paletteView = createAuxView(`；② 8 处依赖 `id="xBtn"` / `id="title"` 的页面内执行脚本（result-x / cancel-click / tc-close / cancel-all-click / theme-report-close / install-title / tc-list）改按 winShell 产出的公共类定位（`.win-head .win-close` / `.win-head .t`）——关闭按钮与头部标题从此不再有稳定 id，测试以「行为」而非「实现」为准。

### 实施中发现的两个真缺陷（方案未列）

**R-5【真缺陷】命令栏工作目录芯片整轮会话不出现。**
`tb:workspace` 只在 `bootDsh` 里 `send` 一次，而标题栏页面此时多半尚未注册好监听——芯片初始是 `hidden` 的，漏收的后果是**正常启动下它永远不出现**，只有「切换工作目录」才会点亮。同处 `did-finish-load` 已修过同类问题（注释写着「loadFile 前 send 会丢」），只是漏了这一条。`uitest` 的 `cmdbar-dom` 一直在报它（`FAIL 工作目录标签=`），被当成环境性失败忽略至今。修复：抽出 `pushWorkspace()`，启动与 `did-finish-load` 两处调用。

**R-6【实施引入并修复】`fromWin` 对 `WebContentsView` 抛错。**
A-3 的守卫助手最初写成 `!win.isDestroyed()`，但目标既可能是 `BrowserWindow` 也可能是 `WebContentsView`，后者没有该方法 → `pt:close`/`pt:height` 每次调用抛 `TypeError`。而 ipcMain 回调里的异常被 `uncaughtException` 处理器吞掉，表现为**通道静默失效**（面板 Esc 关窗、高度回报都不生效）——这正是本方案开篇批评的那类「不报错、只是没反应」。已改为先探类型、以 `webContents` 为最终判据。记录在此：**新增守卫助手时必须以两种载具实测**。

### 关于既有测试基线

`DSH_DESKTOP_UITEST` 在本机有 **9 条间歇性失败的断言**（`cmdbar-dom` 除外，它是稳定失败，即 R-5，已修）：`tc-narrow`、`toast-dom`、`toast-window`、`theme-1`、`theme-2`、`settings-size`、`settings-resize`、`welcome-size`。已用「暂存全部改动跑基线」的方式确认它们**在改动前同样失败**，与本次工作无关。两条成因线索：

- `settings-size` / `settings-resize`：本机工作区高度使窗口被 `maxContentHeight()` 钳到 907，而断言要求「窗口高 ≈ 内容高」——内容 1102 > 907 时该断言**永远无法成立**，属断言未考虑钳制分支。
- `theme-1` / `theme-2`：`clickThemeItem` 用 `pollFor` 重试点击菜单项，但 `.catch` 挂在 `executeJavaScript` 之后，视图已在途销毁时 `win.webContents` 为 `undefined` 会**同步抛出**，导致 unhandled rejection（日志中可见 `uitest.js:935`）。这是测试自身的健壮性缺口，建议一并修。

---

## 11. 一句话结论

深澜把「好看」做完了，前四轮把「结构」做完了。**这一轮该把「改一处会不会漏另一处」这件事，从注释里的纪律变成机制上的保障**——R-1/R-2 正是这条纪律失守的两个实例，而 P-1/P-2/P-3 则是热路径上尚未兑现的同值短路。两者都不改变任何用户可见的功能语义，却决定了这个代码库在下一次改版时是「再走查一遍」还是「跑一遍测试」。
