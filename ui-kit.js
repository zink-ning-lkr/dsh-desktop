/* ui-kit.js —— 复合组件层(L3,单一事实源)。第六轮前端重构 阶段 0 落地。
   背景:ui.css 把样式收成了单一事实源,但行为层从未收编——构造按钮行、构造进度条、
   设置结果圆标、就地反馈、聚焦主按钮这五件事在 9 个页面里各写了一份,连反馈时长都不一致
   (accel 2600ms / report 1800ms)。本文件是这些行为的唯一实现。

   用法:置于页面自身脚本之前(与 ui-icons.js 同层),经 window.UI_KIT 取用。
     <script src="ui-kit.js"></script>

   ---- 硬约束(与全仓约定一致) ----
   ① 经典脚本 + IIFE + window 命名空间,不用 ES module:
      页面经 loadFile() 走 file://,Chromium 按 CORS 拒绝 type="module"(origin 为 null)。
      因此不能 import/export,也不能用打包器。
   ② 纯 DOM 构建,不持有任何应用状态:状态仍在各页(视图态)与主进程(真相源),
      本层只接收「数据 + 回调」,不做 IPC、不读 config、不订阅事件。
   ③ 文本一律 textContent;唯一的 innerHTML 入口是 icons(来自 ui-icons.js 的内部白名单),
      与既有纪律一致(label 中拼接的版本号/路径等不经 HTML 解析)。
   ④ 样式一律引 ui.css 令牌:本文件不写死任何颜色/字号/间距字面量。
   ⑤ CSP 无需放宽:script-src 'self' 已允许本文件。

   ---- 已提供 ----
   el          极简 hyperscript(替代 createElement 三连)
   buttonRow   按钮行(替代 status/dialog/report 三份同构实现)
   progressBar 进度条(确定态 / 不定态,含 ARIA 规范处理)
   bigBadge    结果圆标(替代 status/dialog 两份 type+icon 组合)
   feedback    就地反馈(统一 2200ms)
   focusPrimary 打开即聚焦主按钮(替代 status/dialog/report 三份)
   focusTrap   对话框焦点陷阱(阶段 0 修复 X3 用)
   keyedList   按 key 复用节点重建列表(阶段 2 修 C3:150ms 全量重建)
   listNav     列表行 roving tabindex(阶段 2 修 X4:↑↓/Home/End + Enter/Delete)
   winShell    窗口头部三件套(阶段 3 T-5:图标槽 + 标题 + 关闭按钮)

   ---- 明确暂不提供 ----
   field    : 表单行。settings 三分区表单已落地但结构差异大(滑杆/选项组/文本框混排),
             单一构件收益不抵抽象成本,待出现第二个同构表单行再落地。 */
(function () {
  'use strict';

  // 就地反馈默认驻留时长(统一值:此前 accel 2600ms / report 1800ms 两个时长并存)
  const FEEDBACK_MS = 2200;

  // 可聚焦元素选择器(focusTrap 用)
  const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  // ---------- 内部:子节点挂载 ----------
  function appendChildren(node, children) {
    if (children == null || children === false) return;
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
  }

  /* 极简 hyperscript。props 约定:
       class / className → 类名        text  → textContent
       html              → innerHTML(仅限仓库内受控文案,如含 <b>/<br> 的 i18n 值)
       style / dataset   → 逐键赋值对象
       on                → { 事件名: 处理函数 }
       attrs             → 逐键 setAttribute(用于 data- 与 aria- 之外的原生属性)
       其余键            → setAttribute(值为 true 时写空串,便于布尔属性) */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class' || k === 'className') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
        else if (k === 'on' && typeof v === 'object') {
          for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
        } else if (k === 'attrs' && typeof v === 'object') {
          for (const [a, av] of Object.entries(v)) node.setAttribute(a, av);
        } else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    appendChildren(node, children);
    return node;
  }

  /* ---------- 按钮行 ----------
     收编三份同构实现:status.html fillButtons / dialog.html foot / report.html actions。
     container 的 className 由调用方决定(btn-row / lbtns / btns btn-row),本函数只清空子节点,
     因为三处的容器类名语义不同(决策行等宽 vs 行内小按钮不等宽),不强行统一。
     buttons 元素:{ label, id?, primary?, style?: 'primary'|'danger'|'success', disabled?, title? }
     强调样式的两种既有契约都收:①primary: true(status/dialog);②style: 'primary'
     (report 的动作按钮把整类名塞在 style 里)。二者等价,统一归到 primary 类,
     避免调用方为了适配构件去改数据形状。
     onPick(button, index) —— 下标会随按钮排列漂移,语义分发请用 button.id(既有约定)。 */
  function buttonRow(container, buttons, onPick, opts) {
    const o = opts || {};
    container.textContent = '';
    const list = buttons || [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const cls = ['btn'];
      if (b.primary || b.style === 'primary') cls.push('primary');
      if (b.style === 'danger' || b.style === 'success') cls.push(b.style);
      const btn = el('button', { class: cls.join(' '), text: b.label, type: 'button' });
      if (b.id) btn.dataset.id = b.id; // 主进程按 id 分发语义
      if (b.disabled) btn.disabled = true; // 禁用态样式见 ui.css .btn:disabled
      if (b.title) btn.title = b.title;
      btn.addEventListener('click', () => { if (onPick) onPick(b, i); });
      container.appendChild(btn);
    }
    if (o.cls) container.className = o.cls;
    return container;
  }

  /* ---------- 进度条 ----------
     收编 status.html makeBar(单任务视图与列表行共用同一实现)。
     确定态:task.progress 为数字 → 设 width 与 aria-valuenow;
     不定态:无 progress → .indet 流光,且按 ARIA 规范不携带 aria-valuenow。 */
  function progressBar(task, ariaLabel) {
    const t = task || {};
    const bar = el('div', {
      class: 'bar',
      attrs: {
        role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
        'aria-label': ariaLabel || '',
      },
    });
    const has = typeof t.progress === 'number';
    const fill = el('div', { class: 'fill' + (has ? '' : ' indet') });
    if (has) {
      const pct = Math.max(0, Math.min(100, t.progress));
      fill.style.width = pct + '%';
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    }
    bar.appendChild(fill);
    return bar;
  }

  /* ---------- 结果圆标 ----------
     收编 status.html 结果视图与 dialog.html 的同一段:type → 配色类 + 图标。
     配色走 ui.css 公共 .big.<type>(info/success/warning/error 四态);
     icons 传 ui-icons.js 的 result 族(内部白名单,innerHTML 安全)。 */
  function bigBadge(node, type, icons) {
    const kind = type || 'info';
    const set = icons || {};
    node.className = 'big ' + kind;
    node.innerHTML = set[kind] || set.info || '';
    return node;
  }

  // ---------- 就地反馈(每元素一个计时器:连点不叠加、后一条覆盖前一条) ----------
  const feedbackTimers = new WeakMap();
  function feedback(node, msg, opts) {
    const o = opts || {};
    const ok = o.ok !== false; // 默认成功色
    const ms = typeof o.ms === 'number' ? o.ms : FEEDBACK_MS;
    node.textContent = msg == null ? '' : String(msg);
    node.className = 'inline-feedback' + (ok ? '' : ' bad') + ' on';
    clearTimeout(feedbackTimers.get(node));
    feedbackTimers.set(node, window.setTimeout(() => {
      feedbackTimers.delete(node);
      node.className = 'inline-feedback' + (ok ? '' : ' bad');
    }, ms));
  }

  /* ---------- 打开即聚焦主按钮 ----------
     收编三处:status 结果视图(setTimeout 30)/ dialog(setTimeout 0)/ report(rAF)。
     语义:容器内 .primary 优先,否则第一个 button,都没有则回落 fallback(如 ✕)。
       opts.guard   可见性护栏:该元素不可见(offsetParent 为 null)时直接放弃,不抢焦点;
                    status 视图切换后旧容器的按钮不应再被聚焦,由它兜住。
       opts.fallback 兜底焦点元素
       opts.raf     true 用 requestAnimationFrame 等一帧布局稳定(report 的既有做法)
       opts.delay   毫秒,默认 30 */
  function focusPrimary(container, opts) {
    const o = opts || {};
    const run = () => {
      if (o.guard && o.guard.offsetParent === null) return; // 视图已切走
      const main = container && (container.querySelector('.primary') || container.querySelector('button'));
      if (main) { main.focus(); return; }
      if (o.fallback) o.fallback.focus();
    };
    if (o.raf) window.requestAnimationFrame(run);
    else window.setTimeout(run, typeof o.delay === 'number' ? o.delay : 30);
  }

  // ---------- 焦点陷阱(模态对话框:Tab/Shift+Tab 在容器内循环) ----------
  // 返回解除函数。不可见元素(display:none 等导致 offsetWidth 为 0)与 disabled 元素不参与循环。
  function focusTrap(root) {
    function visible(node) {
      return !node.disabled && node.offsetWidth > 0 && node.offsetHeight > 0;
    }
    function onKey(e) {
      if (e.key !== 'Tab') return;
      const items = Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), visible);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = root.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first) { e.preventDefault(); last.focus(); }
      } else if (!inside || active === last) {
        e.preventDefault(); first.focus();
      }
    }
    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
  }

  /* ---------- keyed 列表重建 ----------
     specs 按顺序描述 host 的子节点,每项必须带唯一 spec.k(键)。
       create(spec) → 新节点(本层负责写入 data-k)
       update(node, spec) → 就地更新已有节点
     行为:按 k 认领旧节点,顺序不符时用 insertBefore **移动**而不是重建。这一步是 C3 的根治——
     150ms 一次的全量 innerHTML 重建会同时冲掉滚动位置、CSS 动画、未提交的输入与**焦点**;
     移动节点则四者全部存活。不在 specs 里的节点(含没有 data-k 的残留)在末尾统一摘掉。
     返回 { added, removed, moved } 供断言与调试(不参与渲染决策)。 */
  function keyedList(host, specs, create, update) {
    const alive = new Map();
    for (const node of Array.prototype.slice.call(host.children)) {
      const k = node.dataset.k;
      if (k === undefined) node.remove(); // 无键节点:既无法复用也排不进序
      else if (!alive.has(k)) alive.set(k, node); // 重复键只认第一个,后来者留待末尾清理
    }
    const stat = { added: 0, removed: 0, moved: 0 };
    let anchor = host.firstChild;
    for (const spec of specs) {
      let node = alive.get(spec.k);
      if (node) alive.delete(spec.k);
      else { node = create(spec); node.dataset.k = spec.k; stat.added++; }
      if (node !== anchor) { host.insertBefore(node, anchor); stat.moved++; }
      update(node, spec);
      anchor = node.nextSibling;
    }
    // 认领过的节点都已被拉到 anchor 之前,故 anchor 及其后即为残留(含未被认领的旧键)
    while (anchor) { const next = anchor.nextSibling; anchor.remove(); stat.removed++; anchor = next; }
    return stat;
  }

  /* ---------- 列表行 roving tabindex ----------
     把 root 内每个 rowSelector 行里的可聚焦控件拉成**一组 roving tabindex**:
     整个列表在 Tab 序里只占一格(恰好一个控件 tabindex=0,其余 -1),焦点与 tabindex 一起走。
     调用方须把行内控件建为 tabindex=-1,由本层提升其一(否则 Tab 序里会多出 N 个停靠点)。
       ↑ / ↓  移到上/下一行的同列控件(列数不同则落该行最后一个)
       ← / →  前/后一个控件(可跨行)
       Home / End  当前行的首/末控件
       Enter  不拦截:焦点就在控件上,"主操作"由原生 button 自己完成(拦截反而会与点击重复触发)
       Delete 行级取消/关闭,交给 opts.onDelete(row)(本层不预设语义,由调用方裁决)
     必须与 keyedList 配套:节点被复用才谈得上"焦点不被 150ms 一帧冲掉"。
     返回 { sync, destroy }:列表每次重建后调 sync() 重算行序与 tabindex。
     sync() 以 document.activeElement 为准恢复位置,故不持有任何节点引用,节点被移动也不受影响。 */
  function listNav(root, opts) {
    const o = opts || {};
    const rowSel = o.rowSelector || '[role="listitem"]';
    const itemSel = o.itemSelector || 'button, [href], input, [tabindex]';
    // 只认可见行:折叠进历史(display:none)的行必须跳过,否则焦点会被送到看不见的地方
    const rows = () => Array.prototype.filter.call(root.querySelectorAll(rowSel), (r) => r.offsetParent !== null);
    const items = () => rows().reduce((acc, r) => acc.concat(Array.prototype.slice.call(r.querySelectorAll(itemSel))), []);
    // 只挪 tabindex,绝不主动 focus:sync() 挂在每帧渲染上(150ms 一次),
    // 一旦在这里 focus(),用户把焦点放到列表之外(头部按钮/详情文本)后会被每帧拽回第一行
    function mark(node) {
      const list = items();
      list.forEach((n) => { n.tabIndex = n === node ? 0 : -1; });
    }
    function sync() {
      const list = items();
      if (!list.length) return;
      const at = list.indexOf(document.activeElement);
      mark(list[at >= 0 ? at : 0]);
    }
    function goTo(node) {
      mark(node);
      if (node) node.focus(); // 键盘导航才动焦点
    }
    function onKey(e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const list = items();
      if (!list.length) return;
      const at = list.indexOf(document.activeElement);
      const row = at >= 0 ? list[at].closest(rowSel) : null;
      if (e.key === 'Delete') {
        if (!row || !o.onDelete || o.onDelete(row) !== true) return;
        e.preventDefault();
        return;
      }
      if (at < 0) return; // 焦点不在列表控件上:方向键交回浏览器(滚动/原生行为)
      const cur = list[at];
      const host = cur.closest(rowSel);
      const all = rows();
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const cols = Array.prototype.slice.call(host.querySelectorAll(itemSel));
        goTo(e.key === 'Home' ? cols[0] : cols[cols.length - 1]);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        goTo(list[Math.max(0, Math.min(list.length - 1, at + (e.key === 'ArrowRight' ? 1 : -1)))]);
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const r = host ? all.indexOf(host) : -1;
        const target = all[Math.max(0, Math.min(all.length - 1, (r < 0 ? 0 : r) + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (!target) return;
        const cols = Array.prototype.slice.call(target.querySelectorAll(itemSel));
        const col = Array.prototype.indexOf.call(host ? host.querySelectorAll(itemSel) : [], cur);
        goTo(cols[Math.min(col < 0 ? 0 : col, cols.length - 1)]);
      }
    }
    root.addEventListener('keydown', onKey);
    return { sync, destroy: () => root.removeEventListener('keydown', onKey) };
  }

  /* ---------- 窗口头部三件套(阶段 3 T-5):.win-head 的图标槽 + 标题 + 关闭按钮 ----------
     收编 status/report/settings/welcome 四页手写的同一结构与同一段接线
     (填 title/aria-label + 绑关闭回调)。样式仍走 ui.css 公共 .win-head/.ico/.t/.win-close,
     页面继续用 --head-pad 等令牌微调;返回 { ico, title, close } 句柄供高频更新
     (status 每帧换图标/标题、随模式换关闭按钮可访问名)。
       opts.icon        SVG 字符串(仓库内受控图标,innerHTML 白名单)
                        或 { img: src, logo?: true }(品牌小图;logo=true 时带 data-logo,
                        由 ui-theme.js 按主题换黑白版)
       opts.title       初始标题文本
       opts.close       false = 不建关闭按钮(welcome 页无 ✕)
                         字符串 = 初始可访问名(title 与 aria-label 同步)
       opts.onClose     关闭按钮点击回调(各窗关闭语义不同,由调用方裁决)
       opts.beforeClose 节点数组:追加在关闭按钮之前的额外插槽(status 的「后台」按钮)。
                         传入的节点从原位挪到 close 之前,保证三件套顺序不被页面残留子节点打乱 */
  function winShell(head, opts) {
    const o = opts || {};
    const ico = el('span', { class: 'ico', attrs: { 'aria-hidden': 'true' } });
    if (typeof o.icon === 'string') ico.innerHTML = o.icon;
    else if (o.icon && o.icon.img) {
      const img = el('img', { src: o.icon.img, alt: '' });
      if (o.icon.logo) img.setAttribute('data-logo', '');
      ico.appendChild(img);
    }
    const title = el('span', { class: 't' });
    if (o.title != null) title.textContent = String(o.title);
    const close = o.close === false ? null : el('button', {
      class: 'win-close', type: 'button',
      html: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    });
    if (close) {
      if (o.close != null) {
        const c = String(o.close);
        close.title = c;
        close.setAttribute('aria-label', c);
      }
      if (typeof o.onClose === 'function') close.addEventListener('click', o.onClose);
    }
    if (head) {
      head.insertBefore(ico, head.firstChild); // 图标/标题固定居左,不被页面残留子节点挤走
      head.insertBefore(title, ico.nextSibling);
    }
    if (close) {
      if (head) head.appendChild(close);
      for (const n of o.beforeClose || []) {
        if (n && n.parentNode === head) head.insertBefore(n, close); // 插槽节点挪到 ✕ 之前
      }
    }
    return { ico, title, close };
  }

  window.UI_KIT = {
    el, buttonRow, progressBar, bigBadge, feedback, focusPrimary, focusTrap, keyedList, listNav, winShell,
  };
})();
