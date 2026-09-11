// redact.js —— token 脱敏单一事实源(纯函数,不依赖 electron):
// dsh 0.1.2-alpha.2 起服务地址带一次性 ?token= 鉴权参数,未被消费前可用于劫持会话;
// 日志文件与导出的错误报告会被用户分享,所有对外落盘的输出统一脱敏。
// 内存中的 dshWebUrl/启动快照保持原样(加载页面/排障需要完整地址)。
// core.js(主进程日志)与 diagnostics.js(错误报告)共用本文件——此前两处各写一份正则,改规则会漂移。
'use strict';

function redactToken(s) {
  return String(s).replace(/([?&]token=)[^\s&]+/gi, '$1***');
}

module.exports = { redactToken };
