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
   srOnly      视觉隐藏但读屏可读的文本节点

   ---- 明确暂不提供(避免死代码,待消费方出现时再落地) ----
   winShell : 辅助窗统一外壳属阶段 3(窗口模型归一),届时四窗一并改造;
   field    : 表单行属阶段 3(accel → settings 三分区);
   listNav  : 列表行 roving tabindex 必须与阶段 2 的 keyed diff 同时落地——
             当前 status 每 150ms 全量重建列表,任何在此之上的焦点管理都会被重置冲掉。 */
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
     buttons 元素:{ label, id?, primary?, style?: 'danger'|'success', disabled?, title? }
     onPick(button, index) —— 下标会随按钮排列漂移,语义分发请用 button.id(既有约定)。 */
  function buttonRow(container, buttons, onPick, opts) {
    const o = opts || {};
    container.textContent = '';
    const list = buttons || [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const variant = (b.style === 'danger' || b.style === 'success') ? ' ' + b.style : '';
      const btn = el('button', {
        class: 'btn' + (b.primary ? ' primary' : '') + variant,
        text: b.label,
        type: 'button',
      });
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

  // ---------- 视觉隐藏但读屏可读 ----------
  function srOnly(text) {
    return el('span', { class: 'sr-only', text: text == null ? '' : String(text) });
  }

  window.UI_KIT = {
    el, buttonRow, progressBar, bigBadge, feedback, focusPrimary, focusTrap, srOnly,
  };
})();
