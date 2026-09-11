# DSH Desktop 交互质感与弹窗升级方案(第七轮 · v1.0.4)

> 走查基线:v1.0.3(`682b6e0`)· 用户反馈 6 项 + 同类走查。范围:滚动条形态、下拉把手动画链路、主题切换时序、菜单条目收敛、按钮质感、快捷键速查弹窗。
> 约束:不改变功能语义与既有几何契约;UITEST 几何断言(菜单 288/行高 32、把手 96×26、状态窗 186/250)一律不动。

---

## 1. 问题总览

| 编号 | 位置 | 问题 | 级别 |
|---|---|---|---|
| **R-1** | `ui.css:203-207` + `menu.html:40-44` | 滚动条虽已降噪(6px 半透明),但矮屏下 thumb 仍是一整条长竖条(内容 665px / 视口 ~540px → thumb ≈440px),用户仍嫌「太长」 | P1 |
| **H-1** | `main.js` 把手链路 + `reveal-tab.html` | 把手动画不够流畅:出现依赖 dropIn 的 180ms 位移动画,与 80ms 轮询延迟叠加;视图 0 尺寸期间渲染被后台节流(无 `backgroundThrottling:false`),恢复尺寸首帧可能慢半拍 | P1 |
| **T-1** | `main.js:1612` `applyThemeChange` / `2293` `nativeTheme.on('updated')` | 切主题时标题栏慢主界面一步:辅助窗走 matchMedia 即时换肤,标题栏底色要等 dsh 页面采样链(页面钩子 150ms 去抖 → executeJavaScript 往返)才更新 | P1 |
| **M-1** | `commands.js:73` | 菜单里的「高级设置」深链没有必要:高级分区(路径/内存)是低频诊断入口,应只在命令面板可达 | P2 |
| **B-1** | `ui.css:266-286` `.btn` | 次级按钮质感平:纯色底 + 1px 边框,无受光/分层/按压反馈;「大部分按钮质感不好」 | P1 |
| **D-1** | `main.js:1908-1916` `showShortcutsDialog` | 快捷键速查用通用 dialog 承载,只有一段文字列表,「弹窗太过简陋」;同理走查:其余 dialog 场景(退出确认/下载失败/便携版提示)均有图标+标题+正文+按钮结构,不算简陋,仅此一处 | P1 |

---

## 2. 滚动条:自动隐藏(终极降噪)

### R-1【滚动条仍是长竖条】

- **成因**:滚动条 thumb 长度 = 视口/内容比例,矮屏钳制下内容 665px 对视口 ~540px,thumb 必然 ≈440px——降噪只能改「色」,改不了「长」。要「短」只有两条路:①内容变少(破坏几何,不做);②**静止时不存在**。
- **改进措施**:
  1. `menu.html`:滚动条 thumb 默认透明,**滚动时显现、静止 1.2s 淡出**(JS 加 `.sb-visible` 类,scroll/mouseenter 点亮,mouseleave 立即隐藏),CSS 过渡走 `--dur-fast`。
  2. `ui.css` 全局滚动条 6px → **4px**(全部页面受益,thumb 更细)。
- **预期效果**:菜单打开时右侧没有任何滚动条;滚动过程才出现一条 4px 淡色细条,静止即隐。菜单内容宽度完整。

---

## 3. 下拉把手:动画链路最流畅化

### H-1【出现依赖位移动画 + 首帧可能被节流】

- **成因**:
  - 出现路径:轮询(0-80ms 延迟)→ setBounds 0→96 → dropIn 180ms(含 translateY 位移)。总感知延迟可达 ~260ms。
  - `ensureRevealTab` 的视图无 `backgroundThrottling:false`:收起态把手视图是 0 尺寸,渲染进程被 Chromium 后台节流;setBounds 恢复 96×26 时,渲染层可能以低帧率跑首帧过渡——「出现那一下卡」。
- **改进措施**:
  1. **出现/消失统一走渲染层 opacity 过渡**(`--dur-fast` = 140ms):出现 = setBounds 恢复 + 移除 `.fade` → 140ms 淡入;消失 = 加 `.fade` → 170ms 后归零(既有协议)。删除 dropIn 的 opacity 段,位移保留为极短 `dropIn var(--dur-fast)`(落下感仍在,但不参与淡入时序)。
  2. `ensureRevealTab` 的 `createAuxView` 调用加 `props.webPreferences.backgroundThrottling:false`——把手视图常驻渲染层,恢复尺寸首帧不被节流拖慢。
  3. 轮询 80ms 保持(读取鼠标的唯一手段),但出现路径在 `cancelHandleFade()` 后立即 setBounds(不再等动画,过渡由渲染层负责)。
- **预期效果**:出现 ~140ms 淡入、消失 170ms 淡出,全程 GPU 合成(opacity/transform),无尺寸跳变感、无节流首帧。

---

## 4. 主题切换:标题栏不再慢一步

### T-1【标题栏底色采样链延迟】

- **成因**:标题栏底色跟随 dsh 页面采样色(`syncTitleBarTheme`),触发源是页面主题钩子(150ms 去抖)+ 3s 周期采样。切主题时 dsh 页面即时换色,标题栏要等整条链走完,「慢一步」。
- **改进措施**:两个主题切换入口各补一次「延迟采样」——主题切换是低频动作,多一次采样零成本:
  - `applyThemeChange`(菜单/命令栏/设置窗切主题):`applyChromeBg()` 后加 `setTimeout(() => syncTitleBarTheme(), 250)`(250ms 等 dsh 页面自身换色完成;`titlebarThemeInFlight` 互斥已有,幂等)。
  - `nativeTheme.on('updated')`(系统主题变化,auto 模式):同样补延迟采样。
  - 页面钩子链保留(覆盖 dsh 页面内自换主题的场景),与主动采样双保险。
- **预期效果**:切主题后标题栏底色 ~250ms 内跟上,与主界面几乎同步。

---

## 5. 菜单收敛与按钮质感

### M-1【菜单去掉「高级设置」】

- **改进措施**:`commands.js:73` 的 `settings-advanced` 加 `menu:false`(命令面板仍可达)。菜单保留「更新与下载」「外观与行为」两个常用深链。图标 `settings-advanced` 保留(面板还要用),`icon-keys-sync` 断言不受影响。
- **预期效果**:菜单条目 17 → 16,「常用入口」更纯粹。

### B-1【次级按钮质感】

- **改进措施**:`ui.css` `.btn` 次级档升级:
  - 底:纯 `--c-bg2` → **微渐变**(顶 `--c-bg1` 55% 混入 → 底 `--c-bg2`)+ **顶部内高光**(`inset 0 1px 0` 7% 前景色,模拟受光)+ `--c-elev-1` 投影分层;
  - hover:渐变至 `--c-border` 系 + **上浮 1px**(`translateY(-1px)`)+ 品牌光晕(30% 25% 投影);
  - active:回落 + `scale(.97)` + **内阴影下沉**(按压感);
  - primary/success/danger:保留渐变/光晕,hover `brightness(1.1)` 不变,active 统一按压下沉。
  - 全部由令牌 `color-mix` 派生,浅色主题自动成立;行内小按钮(`.lbtns`)transform 不占布局,不破坏行高契约。
- **预期效果**:次级按钮有「受光-悬浮-按压」三层反馈,五档语义不变。

---

## 6. 快捷键速查:从文字列表升级为键位卡片浮层

### D-1【专用速查浮层】

- **成因**:`showShortcutsDialog` 用通用对话框承载纯文本列表(6 行 `说明 · Ctrl+X`),信息密度低、无键帽视觉、无图标,「简陋」。
- **改进措施**:新增专用浮层(与命令面板同构:懒创建 WebContentsView + blur/Esc 关闭):
  - `shortcuts.html` + `shortcuts-preload.js`:深澜键位卡片——每行「键帽(kbd 胶囊)+ 功能名 + 图标」,标题行 + 发丝线,行 hover 高亮;载荷来自 `shortcuts.js`(单一数据源不变,不手写第二份)。
  - `main.js`:`showShortcutsDialog` 改为懒创建浮层视图(水平居中于内容区、垂直贴命令栏下沿,与面板同定位策略),`did-finish-load` 补发载荷;关闭即销毁(P0-2 同款内存策略)。
  - 键盘:Esc 关闭;焦点给浮层容器(与菜单同款 focus 语义)。
- **预期效果**:快捷键速查是带键帽的视觉化卡片,不再是「一段文字」;数据源仍是 `shortcuts.js`。

---

## 7. 实施批次与验收

| 批次 | 内容 | 风险 | 验证 |
|---|---|---|---|
| **第一批 滚动与质感** | R-1、B-1 | 低(纯 CSS + menu 一段 JS) | 菜单滚动 1.2s 静止后 thumb 消失;按钮 hover/按压反馈;UITEST 几何断言不变 |
| **第二批 把手与主题** | H-1、T-1 | 中(轮询/采样时序) | UITEST s3-hint-* 仍 PASS;切主题后标题栏底色 250ms 内跟随(日志验证采样触发) |
| **第三批 菜单与速查浮层** | M-1、D-1 | 中(新页面 + 断言适配) | UITEST sc-* 断言改查新浮层;cmd 断言(条目数/图标同步)全绿 |

**回归边界**:菜单高度断言(`uitest.js:354` 附近,动态计算不受条目数影响,但 `a11y-menu-tree` 的 `grpN` 是分组数=6,去条目不减组,安全);`sc-dom` 断言将整体重写为新浮层 DOM;`s3-hint-*` 时间点不动。

---

## 8. 实施记录(2026-09-11)

全部落地(v1.0.4),`DSH_DESKTOP_UITEST=1` 全量验证:失败集合 8 条全部落在本机基线间歇失败内,无新增;sc-* 新断言(键位卡片=6 / Esc 关闭 / 关闭即销毁)全绿。

| 项 | 落地内容 |
|---|---|
| R-1 | 全局滚动条 6px→4px;`menu.html` 滚动条改为「滚动/悬停点亮,静止 1.2s 熄灭」(`.sb-visible` 类 + scroll/mouseenter/mouseleave 监听) |
| B-1 | `.btn` 次级档:微渐变底(`--c-bg1` 55% 混入)+ 顶部内高光 + `--c-elev-1` 分层;hover 上浮 1px + 品牌光晕;active 内阴影下沉;primary/success/danger 按压统一内阴影+亮度 |
| H-1 | `reveal-tab.html` 淡入淡出统一由 opacity 过渡承担(dropIn 只留首帧位移,动画时长走 `--dur-fast`);淡出完成后**保留** `.fade`(opacity:0),出现路径经 `cancelHandleFade` 移除触发淡入;`ensureRevealTab` 加 `backgroundThrottling:false`(0 尺寸期不被节流,恢复首帧不掉帧);`beginHandleHint` 补 `cancelHandleFade` 清残留 |
| T-1 | `applyThemeChange` 与 `nativeTheme.on('updated')` 各补一次 250ms 延迟 `syncTitleBarTheme()`(等 dsh 页面换色完成;in-flight 互斥已有,幂等) |
| M-1 | `commands.js` 的 `settings-advanced` 加 `menu:false`(命令面板仍可达);菜单条目 17→16,图标/断言不受影响 |
| D-1 | 新增 `shortcuts.html` + `shortcuts-preload.js`:键位卡片浮层(键帽 kbd 胶囊 + 触发键澜光高亮 + 功能名 + Esc 提示),`main.js` 的 `showShortcutsDialog` 从通用对话框改为懒创建视图(与命令面板同构:blur/Esc 关闭、关闭即销毁、`sc:height` 高度回报);`package.json` build.files 补两文件;`dlg.escHint` i18n 键新增;`uitest.js` sc-* 断言改查新浮层 |

**细节**:菜单滚动条自动隐藏的监听是模块级(菜单视图每次开合销毁重建,无残留);速查浮层与菜单弹层互斥(`showShortcutsDialog` 先 `closeMenuPopup`,反之菜单打开时速查视图 blur 自动关闭)。
