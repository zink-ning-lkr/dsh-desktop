# DSH Desktop 交互手感专项优化方案(第六轮 · v1.0.3)

> 走查基线:v1.0.2(`c8b619a`,README 同步后)· 范围:菜单弹层滚动体验、标题栏下拉把手动效,以及同类「滚动条突兀 / 动效截断 / 抖振」问题
> 与前序的关系:第五轮把结构收口(winShell / createAuxWindow / 五个单一事实源),本轮不新增结构,**只修手感**——用户报告的两个具体问题(菜单右侧滚动条太长、下拉把手切换不流畅) + 走查发现的同类项。
> 约束:不改变任何用户可见的功能语义与既有几何契约(菜单宽 288、把手 96×26、行高 32 等 UITEST 锁定常量一律不动)。

---

## 1. 问题总览

| 编号 | 位置 | 问题 | 级别 |
|---|---|---|---|
| **S-1** | `ui.css:203-205` + `menu.html:36-38` | 矮屏菜单被钳制后内部滚动,8px 常驻深色滚动条把 288px 菜单挤窄且整条竖轨突兀 | P1 |
| **S-2** | `ui.css:203-205` | 全局滚动条无 hover 增强/透明度控制:命令面板、设置窗、报告日志、状态列表同样观感 | P1 |
| **H-1** | `main.js` `startHandlePolling` / `endHandleHint` | 下拉把手出现有 dropIn 动画、**消失瞬时归零**(setBounds 0),「啪」地截断 | P1 |
| **H-2** | `main.js:283-311` | 轮询判定无最小驻留、无连续帧确认:鼠标快速划过顶部边缘时把手闪断抖振 | P1 |
| **H-3** | `menu.html:56-58` | 菜单条目入场动画 8ms×17 级联 ≈136ms,打开瞬间底部项仍在浮现,与 hover 反馈叠加显「慢半拍」 | P2 |

---

## 2. 滚动条:降噪与按需显现

### S-1【菜单滚动条太突兀】+ S-2【全局滚动条降噪】

- **问题定位**:
  - `menu.html:36-38` `.panel` 的 `max-height: calc(100% - 24px)` + `overflow-y: auto`:菜单自然高度 665px(17 项×32 + 6 组小标题×24 + 分隔线),矮屏(1366×768 及缩放下)主进程把视图钳到工作区剩余高度(`main.js` `showMenuPopup` 的 `Math.min(mh, wa.height - currentBarH - MENU_MARGIN*2)`),滚动由这里承接——**右侧出现一条几乎与菜单等长的滚动条,且常驻占位**。
  - `ui.css:203-205` 全局滚动条:`width: 8px`、thumb 实色 `--c-border`、无透明度/悬停控制。8px 常驻把菜单内容挤窄 8px;深色整轨在浅色主题下反差更大。
- **成因**:滚动条样式是「全局一份、永远可见」,而菜单是鼠标为主的浮层——滚动条只在「内容超高」时才存在,却以最高存在感的形态出现。
- **优化目标**:滚动条只在需要时「打扰」;可见度随悬停/滚动提升。
- **改进措施**:
  1. `ui.css` 全局滚动条降噪(所有页面自动受益,这是唯一一处):
     ```css
     ::-webkit-scrollbar { width: 6px; }
     ::-webkit-scrollbar-thumb {
       background: color-mix(in srgb, var(--c-border) 55%, transparent);
       border-radius: 3px;
       transition: background var(--dur-fast);
     }
     ::-webkit-scrollbar-thumb:hover { background: var(--c-border-hover); }
     ```
     宽度 8→6(省 2px,视觉更轻),thumb 半透明化(淡色,不抢内容),hover 加深。
  2. `menu.html` 菜单滚动条「悬停显现」——默认接近隐形,鼠标在菜单内时显现:
     ```css
     .panel::-webkit-scrollbar-thumb { background: transparent; }
     .panel:hover::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--c-border) 55%, transparent); }
     .panel:hover::-webkit-scrollbar-thumb:hover { background: var(--c-border-hover); }
     ```
     (菜单是纯鼠标交互,「悬停菜单时滚动条才可见」不损失任何可发现性;`.panel` 有 `overflow-x: hidden`,纵向 thumb 悬停态不影响)
  3. 命令面板/设置窗/报告日志/状态列表**不逐页加规则**——全局 6px 半透明已统一降噪;其中命令面板结果列表(`palette.html` `#plist`)最高 8 行、实际很少滚动,全局规则已够。
- **预期效果**:矮屏菜单右侧不再是一条深色长竖轨;滚动条退为「淡色细线,悬停才清晰」;内容宽度让回 2px。

---

## 3. 下拉把手:退场淡出与防抖

### H-1【消失瞬时截断】

- **问题定位**:`reveal-tab.html:24-27` 入场有 `dropIn` 动画(.18s),但退场路径(`main.js` `startHandlePolling` 的 `handleShown=false` 分支与 `endHandleHint`)都是直接 `revealTabView.setBounds({x:0,y:0,width:0,height:0})`——**视图整块消失,无任何过渡**。一进一出形成「淡入-骤隐」的不对称。
- **优化目标**:退场与入场对称,均有 ~150ms 平滑过渡。
- **改进措施**:主进程新增「淡出归零」协议,出现/消失共用一条路径:
  - `reveal-tab.html`:`body` 过渡加 `opacity var(--dur-fast)`;新增 `.fade { opacity: 0 }`(reduced-motion 下时长令牌自动归零,见 `ui.css:398-406`)。
  - `main.js`:新增 `beginHandleFade()`(send `tb:handle-fade` → `HANDLE_FADE_MS=170` 后 `setBounds` 归零并清类)与 `cancelHandleFade()`(淡出未决期间重新出现:清定时器、恢复不透明)。两条消失路径(`endHandleHint` 演示到期 / 轮询移出)统一走 `beginHandleFade`;定时器回调内做 `handleShown` 与视图存活双重检查,竞态安全。
- **预期效果**:把手浮现/收走都有平滑过渡,不再「骤隐」。

### H-2【边缘快速划过抖振】

- **问题定位**:`main.js:289-311` 轮询每 80ms 判定一次,迟滞区(1.5×)只决定判定阈值,不约束时序——鼠标在顶部边缘快速来回时,单帧抖动即可翻转 `handleShown`,把手闪断。
- **优化目标**:短暂抖动不触发状态翻转。
- **改进措施**:
  1. **最小驻留**:`handleShownAt` 记录出现时刻,移出判定在出现后 `HANDLE_MIN_DWELL_MS=250` 内不生效(出现即移出的「划过」不再闪断)。
  2. **连续帧确认**:移出需连续 `HANDLE_OUT_FRAMES=2` 帧(160ms)区外才消失;任何一帧回到区内即清零计数。
- **预期效果**:快速划过顶部时把手稳定浮现,不会闪烁。

### H-3【菜单条目级联动画拖尾】

- **问题定位**:`menu.html:56-58` `.item` 的 `itemIn` 动画 `animation-delay: calc(var(--i, 0) * 8ms)`——17 个条目级联 136ms,打开瞬间最后几项还在「从左侧滑入」的半透明状态,此时鼠标悬停反馈与动画叠加,观感拖沓。
- **改进措施**:级联步长 8ms→5ms,并封顶 100ms(17 项时实际 85ms)。视觉仍是「自上而下逐项落位」的深澜签名,但打开即用。
- **预期效果**:菜单打开响应更跟手;动画风格不变。

---

## 4. 实施批次与验收

| 批次 | 内容 | 风险 | 验证 |
|---|---|---|---|
| **第一批 滚动条** | S-1、S-2 | 低(纯 CSS,几何不变) | 矮屏下打开菜单滚动区域:滚动条淡色细条、悬停显现;`grep "::-webkit-scrollbar" ui.css` 单一来源 |
| **第二批 把手与菜单动效** | H-1、H-2、H-3 | 中(触及轮询与 IPC 时序) | UITEST 全量:失败集合与基线一致(s3-hint-* 时间点顺延后必须 PASS);手动:收起标题栏后划过顶部边缘不再闪烁 |

**回归边界(不可动契约)**:

- 菜单几何:288 宽 / 行高 32 / 分组 24 / 分隔 9 / 上下边距 20(`uitest.js:354` 源码断言),改动画不碰几何。
- 把手几何:`HANDLE_W=96` / `HANDLE_H=26`(`uitest.js:753,761` 断言 `w===HANDLE_W` / `w===0`)——淡出期间 `w` 仍为 96×26,UITEST 检查点需覆盖淡出窗口。
- `s3-hint-off` 时序:演示 3s 到期(12760ms)+ 淡出 170ms = 12930ms,原检查点 12900ms 会撞窗 → 顺延至 13070ms(与现状同样留 140ms 余量);`s3-restore`/`s3-flag-restore` 随之顺延。

---

## 5. 实施记录(2026-09-11)

全部落地(v1.0.3),`DSH_DESKTOP_UITEST=1` 全量验证:失败集合 8 条全部落在本机基线间歇失败内,无新增。

| 项 | 落地内容 |
|---|---|
| S-1/S-2 | `ui.css` 全局滚动条 8px 实色 → 6px 半透明(`color-mix` 55%)+ 悬停加深 + 时长令牌过渡;`menu.html` `.panel` 滚动条「悬停显现」(默认透明 thumb) |
| H-1 | `main.js` 新增 `beginHandleFade`/`cancelHandleFade`(`HANDLE_FADE_MS=170`,send `tb:handle-fade` → 渲染层 `.fade` 过渡 → 归零 bounds,双检查防竞态);`endHandleHint` 与轮询消失路径统一走淡出;`reveal-tab.html` 加 `body.fade`、过渡改走 `--dur-fast` 令牌;`titlebar-preload.js` 暴露 `onHandleFade` |
| H-2 | 轮询消失判定加最小驻留(`HANDLE_MIN_DWELL_MS=250`)+ 连续帧确认(`HANDLE_OUT_FRAMES=2`),出现路径取消未决淡出 |
| H-3 | `menu.html` 条目级联动画 8ms/项 → `min(var(--i),20) * 5ms`(封顶 100ms) |

**UITEST 时序适配(两处撞窗,已修)**:

- s3 段顺延 +170ms(淡出占时),但 `s3-restore`(13090)越过 `menu-open`(13000)——`toggleTitlebar` 里的 `closeMenuPopup` 会把刚打开的菜单关掉,menu-* 三条全挂。menu 段整体 +200ms 修正。
- menu 段平移后 `menu-reopen-verify`(14350)越过 `accel-dialog`(14300)——模态对话框先弹出抢焦点,菜单 blur 关闭。accel 段整体 +150ms 修正。
- 教训:UITEST 时间点顺延必须复核**与后续步骤的先后关系**,不只是自身检查点。

**实施中发现的原问题确认**:s3 演示到期路径原本「3s 呼吸结束后瞬间归零」,现为 170ms 淡出;轮询路径「出现-消失」对称平滑;快速划过顶部由最小驻留 + 连续帧确认吸收。
