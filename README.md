# DSH Desktop

**DeepSeek Harness(dsh)的 Windows 桌面壳** —— 把 `dsh web` 装进一个原生桌面应用:自绘标题栏、系统托盘、鲸鱼图标,而文件、会话、设置与本体 dsh 完全共享,不产生第二份数据。

## 它是怎么工作的

```
┌─ DSH Desktop (Electron) ─────────────────┐
│  ┌─ 自绘标题栏(可收起/全屏自动隐藏) ──┐    │
│  ├─ dsh 页面(WebContentsView) ─────────┤    │
│  └─ 托盘常驻(关闭窗口默认收进后台) ────┘    │
│  辅助窗口:任务中心 / 对话框 / 错误报告 /  │
│           下载加速设置 / 首启欢迎页        │
│          (自绘,跟随深浅主题,Win11 系统材质)
└─────────────────┬────────────────────────┘
                  │ 子进程
        node @deepseek-ai/dsh web --host 127.0.0.1 --port <配置或随机>
                  │ cwd = 你选的工作目录
        会话/设置/插件 ←→ ~/.dsh(与本体完全共享)
```

- 启动时后台拉起本体 `dsh web`(端口默认随机空闲,可在 `%APPDATA%\DSH Desktop\config.json` 加 `"port": 13372` 固定,与手动开的 dsh 互不冲突),从输出解析地址后加载进窗口
- **文件**:dsh 直接操作工作目录里的真实文件
- **会话/设置/插件**:都在 `~/.dsh`;同一工作目录下,桌面壳和命令行 dsh 看到的是同一份会话
- 关闭窗口默认**最小化到托盘**,dsh 后台继续跑;首次收托盘会有一条系统通知说明,可在菜单中一键切换为"关闭即退出"(标题栏关闭按钮的提示文字会随之变化)

## 功能

| 操作 | 说明 |
|---|---|
| 首次启动 | 欢迎页引导选择工作目录(会话与文件归属于它),并预告「关闭=收托盘」行为,之后记住 |
| ☰ 菜单 → 键盘快捷键… | 快捷键速查浮层(与菜单/应用菜单同一数据源,不手写第二份) |
| ☰ 菜单 → 外观 | 跟随系统 / 深色 / 浅色 三态循环;全部自绘窗口即时换肤(Win11 下辅助窗为 Mica/Acrylic 系统材质) |
| 任务中心 | 检查更新/下载/安装多任务并存列表:进度互不顶掉、行级取消、完成项折叠历史;「后台」挂后台完成时桌面通知 |
| 标题栏 ▴ / Ctrl+Shift+B | 收起/放下标题栏(收起后鼠标靠近顶部中央浮现下拉把手) |
| F11 | 全屏(标题栏自动收起,退出自动恢复进入前的状态) |
| ☰ 菜单 → 打开工作目录… (Ctrl+O) | 切换目录(自动重启 dsh 服务) |
| ☰ 菜单 → 在浏览器中打开 | 用系统默认浏览器打开当前 dsh 页面 |
| ☰ 菜单 → 自动打开浏览器 | 设置项:启动 dsh 时是否随带打开系统浏览器(dsh 0.1.0-rc.8 起默认会,桌面壳默认关闭并传 `--no-open`) |
| ☰ 菜单 → 下载加速设置… | 可视化表单:多线程分段数(2-16 滑杆,即时保存)、镜像源(可选)、npm 国内镜像指引 |
| ☰ 菜单 → 检查更新… | 桌面壳自身更新(对接 GitHub Releases):多线程分段加速下载 + sha512 校验,失败自动回退官方单连接 |
| ☰ 菜单 → 检查 dsh 本体更新… | dsh 本体更新(对接 npm registry):安装期间自动暂停/恢复 dsh 服务,完成后自动重启生效 |
| ☰ / 托盘 → 关闭时最小化到托盘 | 设置项:✕ 收进托盘(默认)或直接退出 |
| 托盘鲸鱼图标 | 左键恢复窗口;右键菜单:状态行(版本/运行状态/时长)、显示 / 工作目录 / 检查更新… / 退出 |

**更新机制细节**

- 两条更新通道相互独立:**桌面壳**(GitHub Releases 检查 → 通知/弹窗 → 加速下载 → 重启安装)与 **dsh 本体**(npm registry 检查 → 全局安装 → 自动重启服务);两流在「任务中心」并存展示互不顶掉,行级取消互不误伤
- 启动 6 秒后自动静默检查桌面壳更新、12 秒后检查 dsh 本体更新,**自动检查只发桌面通知**(点击才弹窗),不打断操作
- 手动检查带超时(桌面 15s / dsh 12s),超时后结果在宽限期内仍会送达,不会误报「超时」
- dsh 本体只在**已验证兼容的 0.1.x 区间**内自动推送(已验证 0.1.0-rc.8 / 0.1.1-rc.2 / 0.1.2-alpha.2);0.2+ 会提示手动升级确认,避免破坏性升级
- dsh 0.1.2-alpha.2 起,`dsh web` 打印的服务地址会带一次性 `?token=` 鉴权参数(浏览器首次访问用它换取会话 Cookie),桌面壳按原样解析并加载,无需额外设置
- 升级 dsh 后若启动报「plugin tree failed to load / does not provide an export named」,是**第三方插件与新版不兼容**:在 `~/.dsh/profiles/web/cordis.patch.yml` 禁用或移除报错插件(桌面壳错误报告窗会直接给出定位与命令)
- 「稍后」跳过的已下载安装包会缓存,下次点更新不再重复下载
- 便携版不支持自更新(与安装版的更新形态不同),检查更新会引导手动下载

## 安装与使用

**方式一:下载安装包**(推荐)

到 [Releases](../../releases) 下载 `DSH Desktop Setup x.x.x.exe`(标准安装:开始菜单/桌面快捷方式、可卸载)或便携版单文件 exe。

**方式二:从源码运行**

```bash
npm install          # 国内网络若下载 Electron 报证书错误,见下方"常见问题"
npm start
```

前置要求:已全局安装 dsh(`npm install -g @deepseek-ai/dsh`,已验证兼容 0.1.x)和 Node.js。

## 配置文件

位置:`%APPDATA%\DSH Desktop\config.json`(应用自动生成和维护,各字段均可选)

| 字段 | 说明 |
|---|---|
| `workspace` | 工作目录(首次启动选择后写入) |
| `port` | 固定 dsh 服务端口(不设则随机空闲端口) |
| `openBrowser` | `true` = 启动 dsh 时不传 `--no-open`(随带打开系统浏览器) |
| `closeAction` | `"tray"`(默认,关闭收进托盘)或 `"quit"`(关闭即退出) |
| `theme` | `"auto"`(默认,跟随系统)、`"dark"` 或 `"light"`;由菜单「外观」项循环切换 |
| `downloadSegments` | 桌面端更新下载的分段数(2-16,默认 6;由「下载加速设置」窗管理) |
| `downloadMirror` | 镜像根目录 URL(可选;目录内放置与 GitHub Release 资产同名的安装包,版本检查与完整性校验仍走 GitHub 官方) |
| `winBounds` / `winMaximized` | 窗口位置/大小/最大化状态的记忆(自动维护) |
| `trayHintShown` | 首次收托盘提示是否已展示(自动维护) |

## 项目结构

```
dsh-desktop/
├── main.js                # 主进程:窗口/视图编排、托盘、菜单、辅助窗、应用生命周期
│                          #  (dsh 子进程域、双通道更新、配置/日志见下方拆分模块)
├── core.js                # 主进程基础设施:配置原子读写、日志缓冲与轮转、token 脱敏、限时命令、共享常量
├── dsh-process.js         # dsh 子进程域:定位 node/dsh、启动与地址解析、等待就绪、进程树终止、启动快照
├── updates.js             # 双通道更新编排:桌面端(GitHub Releases 加速下载)+ dsh 本体(npm 全局安装),
│                          #  共享状态集中在 state,UI 能力经 init() 注入,不反向依赖 main.js
├── downloader.js          # 多线程分段下载器(HEAD 重定向解析/Range 探测/并发分片/sha512 校验/背压,失败自动退化单连接)
├── diagnostics.js         # 错误诊断:收集运行时状态 → 归类(缺失 dsh/端口占用/权限等)→ 生成可导出报告(保留最近 10 份)
├── uitest.js              # 自动化冒烟编排(SMOKE/DEMO/UITEST 三种模式,由环境变量触发,不参与生产路径)
├── ui.css                 # 设计令牌与公共组件单一事实源(色板/深浅主题/按钮/头部/关闭按钮/结果圆标)
├── ui-theme.js            # 渲染层主题探针:config.theme → matchMedia 自动换肤 + 鲸鱼 logo 黑白换版
├── ui-icons.js            # 共享 SVG 图标常量(结果四态/进行中五态/菜单 19 枚)
├── shortcuts.js           # 快捷键单一数据源(菜单文案/accelerator/速查浮层三方共用)
├── i18n.js + i18n/        # 文案集中与术语统一:t(key, params) + zh-CN.json(渐进收编中)
├── titlebar.html + titlebar-preload.js    # 自绘标题栏:拖拽、窗口按钮、收起按钮、鲸鱼 logo、工作目录、主题跟随
├── menu.html + menu-preload.js            # 自绘菜单(主菜单/托盘菜单共用):图标/快捷键/勾选/全键盘导航/焦点管理
├── loading.html           # dsh 启动加载页:四阶段进度 + 实时日志尾巴 + 慢启动自助操作行
├── status.html + status-preload.js        # 任务中心:多任务并存列表、行级取消、实测式高度、任务栏进度、挂后台+通知
├── dialog.html + dialog-preload.js        # 通用对话框(队列化、Enter=主按钮/Esc=取消、聚焦主按钮)
├── accel.html + accel-preload.js          # 下载加速设置窗:分段数滑杆/镜像源校验/即时保存
├── report.html + report-preload.js        # 错误报告窗:归类结论/建议/日志预览/一键导出与复制
├── welcome.html + welcome-preload.js      # 首启欢迎页:品牌引导选择工作目录 + 托盘行为事前告知
├── reveal-tab.html        # 标题栏收起后顶部中央的下拉把手(鼠标靠近浮现,带迟滞防闪烁)
├── assets/                # 应用图标与鲸鱼 logo(见下)
├── tools/                 # 图标管线:离屏渲染母版 → 尺寸重采样 → 手工编码 ICO/PNG
├── package.json           # 项目清单、npm 脚本、electron-builder 打包配置(NSIS + 便携版)
└── dist/                  # 打包产物输出(Setup/Portable exe、latest.yml、blockmap;被 .gitignore 忽略)
```

说明:界面层以外的 dsh 页面本体加载自 `dsh web` 服务,不在本仓库内。全部渲染窗口均为 sandbox + contextBridge 最小 IPC 面;dsh 页面中的外链/异源跳转一律交给系统浏览器打开。

## 开发

```bash
npm start         # 开发运行
npm run icon      # 重新生成全套图标(改颜色/换源后执行)
npm run dist      # 打包安装版 + 便携版 exe(输出在 dist/)
```

自动化冒烟(均会自动退出,用于回归验证):

```bash
DSH_DESKTOP_SMOKE=1 npm start   # 启动完成+窗口/托盘闭环验证(16s 自动退出)
DSH_DESKTOP_DEMO=1  npm start   # SMOKE + 分阶段输出窗口屏幕坐标(供外部截屏)
DSH_DESKTOP_UITEST=1 npm start  # 全量 UI 冒烟:任务中心/对话框(队列)/报告窗/菜单/主题/欢迎页/
                                # 标题栏动画/假 npm 安装成功与超时路径/多线程下载器 sha512 断言
```

版本发布约定:每次改动先提升版本号(`package.json` 与 `package-lock.json` 同步,提交信息以 `vX.Y.Z` 开头);修复补丁提 patch 位、新功能提 minor 位、破坏性变更提 major 位。

## 常见问题

- **升级 dsh 后启动失败,报告提示「第三方插件不兼容」**:dsh 升级可能移除/变更插件 ABI(如 0.1.2-alpha.2 移除了 `@deepseek-ai/dsh-settings` 的 `settingsNamespace` 导出),未跟进的社区插件会崩掉整个插件树。按错误报告窗的建议,在 `~/.dsh/profiles/web/cordis.patch.yml` 给报错插件加 `disabled: true`,或 `dsh plugin --profile web add <插件名>@latest` 更新到兼容版本后重启桌面壳。
- **启动失败/白屏**:看日志 `%APPDATA%\DSH Desktop\dsh-web.log`(☰ 菜单 → 打开日志文件 可直达),内含 dsh 完整输出;启动失败时会自动弹出错误报告窗(含归类结论与建议,可一键导出)
- **dsh 意外退出**:报告窗可选"重启 dsh"或"退出";退出时会清理整个 dsh 进程树
- **dsh 未安装**:启动失败报告会引导执行 `npm install -g @deepseek-ai/dsh`,装好后重启桌面壳即可
- **国内网络检查/下载慢**:菜单「下载加速设置」→ 配置镜像源与分段数;dsh 本体更新可复制窗口内的 npm 换源命令执行
- **国内网络装依赖报证书错误**:`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`
- **SmartScreen 提示**:个人自建应用无代码签名证书,首次运行"更多信息 → 仍要运行"即可
- **窗口"消失"了?** 默认点 ✕ 是收进托盘(dsh 后台继续跑),点托盘鲸鱼图标恢复;再次启动应用也会恢复窗口。可在菜单里切换为"关闭即退出"

## License

[MIT](LICENSE) © zink-ning-lkr