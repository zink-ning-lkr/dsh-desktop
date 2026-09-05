// i18n.js —— 文案集中与术语统一(P2-6 结构先行):主进程共享 t(key, params)。
// 文案表 i18n/zh-CN.json 启动后首次调用时同步加载并缓存;表缺失或键不存在时
// 回退 key 本身,保证功能不受文案表影响。渲染层暂未接入(渐进收编:先收编主进程
// 自绘文案,渲染层后续经 preload 暴露 t(key))。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const TABLE = new Map();
let loaded = false;
function table() {
  if (!loaded) {
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'i18n', 'zh-CN.json'), 'utf8'));
      for (const [k, v] of Object.entries(raw)) {
        if (k === '$comment' || typeof v !== 'object' || v === null) continue;
        for (const [k2, v2] of Object.entries(v)) {
          if (typeof v2 === 'string') TABLE.set(`${k}.${k2}`, v2);
        }
      }
    } catch { /* 文案表缺失:全部回退 key */ }
  }
  return TABLE;
}

// t('tray.running') → '运行中';占位符 {name} 经 params 替换(缺失时原样保留)
function t(key, params) {
  let s = table().get(key) || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

module.exports = { t };
