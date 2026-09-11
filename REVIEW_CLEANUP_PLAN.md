# 全仓代码审查清理方案(Review Cleanup, v1.0.6)

对 dsh-desktop 全仓的四维审查(冗余 / 业务逻辑 / 规范 / 内聚耦合)结论与修复批次。
问题定位均附 file:line;按「优先顺序」分四批实施,每批独立验证。

## 总览

- 业务逻辑:双通道更新状态机 / 退出确认状态机 / 命令注册表 / i18n 全表核对均自洽,无硬伤
- 本批目标:修复 1 个真实行为缺陷(shortcuts 高度契约),清理死代码与真实重复,收敛主进程浮层样板与渲染层 i18n 接线,提升 uitest 的测试真实性
- 明确不做(收益/风险比不足,记录留待后续):downloader 四份 settled 守卫重构(并发逻辑改动面大)、uitest 魔法毫秒时序重构(回归成本高)、trayStatusText/trayMenuStatusLabel 文案重叠(格式语义不同)

## 第一批:P0 行为缺陷与低危重复(高优先)

| # | 问题定位 | 措施 | 预期效果 |
|---|---|---|---|
| 1 | shortcuts.html:16-17 `.panel { position:absolute; inset:0 }` 填满视图,sc:height 回报量到的是窗口自身高度(main.js:1992-1996 回填后又放大视图,每次打开 24px 跳变;内容超估被裁后无法自愈) | `.panel` 改为内容驱动高度(`left/right/top:0; height:auto`),`.rows` 去掉 `flex:1`;回报改量 `.panel.offsetHeight`(此时为真实内容高度) | 高度回报契约与 palette/toast 一致:量真实内容、主进程按实测回填,不再自增,内容变化可自愈 |
| 2 | main.js:2753-2754 `did-finish-load` 注册两遍 | 删重复行 | 消除复制粘贴噪音 |
| 3 | main.js:1068 `showStatusResult` 重复置 `statusQueued = true`(ensureStatusWindow 已置) | 删冗余赋值 | 无行为变化,去冗余 |

## 第二批:死代码清理(零风险)

| # | 问题定位 | 措施 | 预期效果 |
|---|---|---|---|
| 4 | dsh-process.js `nodeUsable` 导出后无外部消费(仅内部用) | 移出 module.exports | 收敛导出面 |
| 5 | downloader.js `singleStreamDownload`、updates.js `comparePre`/`fetchLatestDshVersion`、diagnostics.js `collectDiagnostics`/`renderReport`/`writeReport` 导出无外部消费 | 移出各 module.exports(内部调用保留) | 同上 |
| 6 | ui-kit.js `srOnly` 无消费者(页面用的是 CSS 类 .sr-only);`listNav` 返回值 `rows` 无人使用 | 删 `srOnly`;`listNav` 返回值只留 `{ sync, destroy }` | 收敛共享层 API |
| 7 | ui-icons.js `activity.restart`/`activity.toast` 全仓无 `mode:'restart'/'toast'` 生产方 | 删两个死常量 | 同上 |
| 8 | ui.css 未消费令牌:`--c-selected`/`--c-selected-fg`/`--ctl-icon-lg`/`--density-row-compact`/`--density-gap-compact`/`--z-base`/`--z-popup`/`--z-modal`/`--z-sticky`/`--z-toast`/`--ease-std`/`.num`(逐一 grep 验证后删) | 删除 | 令牌表只含被消费项 |
| 9 | status.html:125 `#bar` 内静态 `#fill` 死 DOM(渲染前被 innerHTML='' 清掉) | 删静态子节点 | 去死 DOM |

## 第三批:真实重复收敛

| # | 问题定位 | 措施 | 预期效果 |
|---|---|---|---|
| 10 | core.js:57-59 与 diagnostics.js:36-38 `redactToken` 逐字重复(uitest 只锁 core 版) | 新建无 electron 依赖的 `redact.js`(纯函数),core.js 与 diagnostics.js 共用;core 保持 re-export(调用点与 uitest 断言不变) | 脱敏规则单一事实源 |
| 11 | main.js:1502 与 1843-1850 内存三档分级(阈值 1500/2200 + 分级文案)两处各写一份 | 抽 `memLevelInfo(total)` 共用 | 改阈值只改一处 |
| 12 | main.js:58-65(uncaughtException)与 1674-1689(showReport)报告上下文 14 字段构造两份 | 抽 `buildReportCtx(phase, error, code, buf)` | 字段增删只改一处 |
| 13 | main.js 四套懒视图生命周期(revealTab/menuPopup/palette/shortcuts 的 ensure/destroy/blur 收起/载荷排队,~150 行同构,destroy* 四函数体完全相同) | 抽 `makeLazyView()` 工厂:统一「懒创建 + 失焦收起 + 载荷排队补发 + 关闭即销毁」样板;四个浮层改为薄包装,对外函数名与 uitest 依赖注入 getter 不变 | main.js 瘦身,新增浮层不再复制第四遍 |
| 14 | updates.js:183-189 与 275-282 两处下载进度载荷格式化近似重复 | 抽 `buildProgressPayload(p, speed)` | 进度格式只写一处 |
| 15 | updates.js:396 看门狗定时器成功路径不清理(常挂 60s) | 成功/失败路径 clearTimeout | 消除常驻定时器 |
| 16 | settings.html:495-496 打开时 onShow + get().then 双路 apply,全表单刷两遍 | onShow 已 apply 时 `.then` 只刷新内存读数(renderMem),不再整表单重刷;`segN` 冗余赋值一并删 | 打开设置窗只渲染一次,内存读数仍强制刷新 |
| 17 | 十个 preload 的 `i18n:table` sendSync + `__i18n.t()` 实现逐字复制(约 10 行 × 10) | 新建共享 `ui-i18n.js`(与 ui-theme.js 同层,head 引用):preload 只暴露 `__i18nTable` 快照,t() 实现收敛进 ui-i18n.js 一份;10 个 preload 各减 7 行 | t() 取值/占位符约定只改一处 |

## 第四批:uitest 测试真实性

| # | 问题定位 | 措施 | 预期效果 |
|---|---|---|---|
| 18 | uitest.js:52-55 SMOKE 模式空操作(16s 后仅 quit),与头注释/README「SMOKE=1 窗口/托盘闭环验证」不符 | SMOKE 与 DEMO 共用同一闭环序列,DEMO 仅在每阶段额外落坐标文件 | SMOKE 模式真正有断言 |
| 19 | uitest.js:36 DEMO 分支 `saveConfig({...closeAction:'tray'})` 静默改写用户配置且不还原 | 开始时记录原 closeAction,序列结束(退出前)还原;UITEST 尾部清理同补 | 测试不再污染用户配置 |
| 20 | uitest.js:617-618 tray-status 断言硬编码 `D:\Work` 与中文文案(换目录/换机必 FAIL) | 期望值改为 i18n.t(tray.running/booting/stopped)拼当前 workspace(loadConfig 读取),不硬编码任何机器/语言 | 回归锁与环境、文案表解耦 |

## 验证方式

1. 全部改动文件 `node --check` 语法校验 ✓
2. 删除项逐一 grep 确认无残留引用 ✓(含 uitest 静态断言同步:uikit-apis / palette-lazy / palette-view / palette-trusted)
3. `DSH_DESKTOP_UITEST=1 npm start` 全量 UI 回归 ✓(见下)
4. `DSH_DESKTOP_SMOKE=1 npm start` 闭环验证 ✓(收托盘→恢复,退出码 0)

### UITEST 回归结果(2026-09-11)

- 全部静态断言组 PASS:unit / uikit / cmdbar / toast / s3 / cmd / menu-tree / list / sizing / settings / report-log / palette(含本次同步的 palette-lazy/palette-view/palette-trusted)/ i18n-a11y 除 landmark 外
- 运行时断言:tray-status(PASS,已改为 i18n+配置驱动)、palette-open/dom、sc-dom(键位卡片=6)、cmdbar-dom、layout-fit、dialog/报告窗/通知宿主主链路全部通过
- **与基线(v1.0.5,git stash 对照)失败的步骤集合完全一致**,本次改动零新增失败:
  theme-1/2 no-item 与 theme-3 崩溃、i18n-a11y 的 a11y-landmark、toast-window/toast-dom、settings-size/settings-resize、welcome-size、tc-narrow —— 均为既有环境性抖动(真实 dsh SPA 首载与弹层首载争抢资源,uitest 注释中已有记载),非本批引入,未列入本批修复

## 版本与提交

- package.json / package-lock.json 版本 1.0.5 → 1.0.6
- 提交信息以 `v1.0.6:` 开头,按批次可分多个 commit

---

# 第二批(Review Cleanup 续,v1.0.7)

承接第一批评审中「留待后续」的项与渲染层中低危项,风险逐一控制。

| # | 问题定位 | 措施 | 预期效果 |
|---|---|---|---|
| 21 | downloader.js 四个网络路径(resolveFinalUrl:27-58 / probe:65-104 / fetchRangeSegment:109-169 / singleStreamDownload:172-249)各写一份「settled 幂等 + clearTimeout + req.abort」三件套 | 抽 `requestGuard(timeoutMs)` 守卫(attach/settle/arm),四路径只留各自的结束动作 | 并发样板只写一份;行为逐行等价(超时语义、shared.failed 广播、背压均不变) |
| 22 | diagnostics.js:200-245 报告模板硬编码中文(与「文案收编」自我声明不符,报告会被用户导出分享) | zh-CN.json 新增 `repfile.*` 键组(文案与现硬编码串逐字相同,产物内容零变化),renderReport 全部走 t() | 报告模板进入文案表,改术语只改表 |
| 23 | toast.html:90-101 手写 keyed-diff,与 ui-kit.keyedList(214-234)重复实现 | toast.html 引入 ui-kit.js,render() 改用 K.keyedList | keyed-diff 行为只剩共享层一份,toast 复用节流/焦点/动画语义 |
| 24 | reveal-tab 复用 titlebar-preload:每次创建白做两次 sendSync(sc:display/i18n:table),且把 17 成员桥暴露给无输入小窗 | 新建极简 reveal-tab-preload.js(仅 showTitlebar/onHandleHint/onHandleFade + __i18nTable);main.js revealTab 实例与 package.json 改指向 | 暴露面与用途匹配,每次收起/展开少两次同步 IPC |
| 25 | main.js:463/698 循环变量 t 遮蔽 i18n.t(被迫走 i18n.t 绕行) | 循环变量改名 task,两处恢复直接 t() | 消除遮蔽气味 |
| 26 | settings.html:292/461 主题键用字符串拼接,titlebar.html:251 用显式映射,两种风格并存 | settings.html 同样引入显式 THEME_KEY 映射 | 键构造一处一种写法,改键名漏改风险消除 |
| 27 | ui-kit.js:33-34「field 待消费方出现」注释已过时(三分区表单已落地) | 更新注释口径(明确不落地原因:页面结构差异大) | 失效注释修正 |
| 28 | uitest.js 阶段编号混乱(⑨ 排 ⑪ 后、⑧ ⑬ 各用两次) | 重排注释序号,与执行顺序一致 | 按编号定位步骤不再错乱 |

明确不做(维持第一批结论):uitest 魔法毫秒时序重构(回归成本高)、trayStatusText/trayMenuStatusLabel 文案重叠(格式语义不同)、menu/palette/dialog 三处键盘导航收编(语义差异大,收益/风险不足)。

验证方式同第一批:node --check、残留引用 grep、UITEST 与基线对照、SMOKE。

### 第二批验证结果(2026-09-11,v1.0.7)

- 全部改动文件 node --check 通过;zh-CN.json JSON 合法性 + repfile 键组 15 键就位
- 报告模板直测(node 跑 buildReport):章节/字段文案全部命中 repfile 键,无裸键残留,产物内容与硬编码版逐字一致
- UITEST 全量回归:静态断言组全部 PASS(toast/s3/palette/downloader 侧);**downloaders 冒烟 dl-* 四步全过**(requestGuard 重构验证)、**toast 运行时全过**(keyedList 收编验证)、**s3 把手演示/淡出全过**(reveal-tab 新 preload 验证)、tray-status/欢迎页/快捷键浮层/任务中心 keydiff 主链路通过
- 失败集合与基线(v1.0.6)对照**完全一致、零新增**(theme-1/2 no-item、i18n-a11y landmark、toast-dom、settings-size/resize、welcome-size、tc-narrow —— 均为既有环境性抖动)
- SMOKE 闭环通过(退出码 0)

版本:package.json / package-lock.json 1.0.6 → 1.0.7,提交信息以 `v1.0.7:` 开头。
