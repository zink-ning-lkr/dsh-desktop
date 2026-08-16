# DSH Desktop

**DeepSeek Harness(dsh)的 Windows 桌面壳** —— 把 `dsh web` 装进一个原生桌面应用:自绘标题栏、系统托盘、鲸鱼图标,而文件、会话、设置与本体 dsh 完全共享,不产生第二份数据。

## 它是怎么工作的

```
┌─ DSH Desktop (Electron) ─────────────────┐
│  ┌─ 自绘标题栏(可收起/全屏自动隐藏) ──┐    │
│  ├─ dsh 页面(WebContentsView) ──────┤    │
│  └─ 托盘常驻(关闭窗口默认收进后台) ──┘    │
└─────────────────┬────────────────────────┘
                  │ 子进程
        node @deepseek-ai/dsh web --host 127.0.0.1 --port 0
                  │ cwd = 你选的工作目录
        会话/设置/插件 ←→ ~/.dsh(与本体完全共享)
```

- 启动时后台拉起本体 `dsh web`(随机空闲端口,与手动开的 dsh 互不冲突),从输出解析地址后加载进窗口
- **文件**:dsh 直接操作工作目录里的真实文件
- **会话/设置/插件**:都在 `~/.dsh`;同一工作目录下,桌面壳和命令行 dsh 看到的是同一份会话
- 关闭窗口默认**最小化到托盘**,dsh 后台继续跑;可在菜单中一键切换为"关闭即退出"

## 功能

| 操作 | 说明 |
|---|---|
| 首次启动 | 选择工作目录(会话与文件归属于它),之后记住 |
| 标题栏 ▴ / Ctrl+Shift+B | 收起/放下标题栏(收起后鼠标靠近顶部中央浮现下拉把手) |
| F11 | 全屏(标题栏自动收起,退出自动恢复) |
| ☰ 菜单 → 打开工作目录… (Ctrl+O) | 切换目录(自动重启 dsh 服务) |
| ☰ / 托盘 → 关闭时最小化到托盘 | 设置项:✕ 收进托盘(默认)或直接退出 |
| 托盘鲸鱼图标 | 左键恢复窗口;右键深色菜单:显示 / 工作目录 / 设置 / 退出 |

## 安装与使用

**方式一:下载安装包**(推荐)

到 [Releases](../../releases) 下载 `DSH Desktop Setup x.x.x.exe`(标准安装:开始菜单/桌面快捷方式、可卸载)或便携版单文件 exe。

**方式二:从源码运行**

```bash
npm install          # 国内网络若下载 Electron 报证书错误,见下方"常见问题"
npm start
```

前置要求:已全局安装 dsh(`npm install -g @deepseek-ai/dsh`)和 Node.js。

## 项目结构

```
dsh-desktop/
├── main.js               # 主进程:窗口/视图编排、dsh 进程管理、托盘、菜单、设置
├── titlebar.html         # 自绘标题栏(拖拽、窗口按钮、收起开关)
├── titlebar-preload.js   # 标题栏 IPC 桥
├── menu.html             # 自绘菜单弹层(主菜单与托盘菜单共用渲染器)
├── menu-preload.js       # 菜单 IPC 桥
├── reveal-tab.html       # 标题栏收起后的下拉把手
├── loading.html          # dsh 启动期间的加载页
├── assets/               # 图标(DeepSeek 官方鲸鱼,@lobehub/icons)
└── tools/                # 开发工具:图标生成管线
```

## 开发

```bash
npm start        # 开发运行
npm run icon     # 重新生成全套图标(改颜色/换源后执行)
npm run dist     # 打包安装版 + 便携版 exe(输出在 dist/)
```

## 常见问题

- **启动失败/白屏**:看日志 `%APPDATA%\DSH Desktop\dsh-web.log`(菜单"帮助"可直达),内含 dsh 完整输出
- **dsh 意外退出**:弹窗可选"重启 dsh"或"退出"
- **国内网络装依赖报证书错误**:`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`
- **SmartScreen 提示**:个人自建应用无代码签名证书,首次运行"更多信息 → 仍要运行"即可

## License

[MIT](LICENSE) © zink-ning ·

