/* main.js — 主线程：UI、Canvas 可视化、与 Worker 通信（不做重计算，保证不卡顿） */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    m: $('cfg-m'), k: $('cfg-k'), n: $('cfg-n'),
    optimalHint: $('optimal-hint'),
    btnInit: $('btn-init'), btnInsert: $('btn-insert'), btnQuery: $('btn-query'),
    btnDelete: $('btn-delete'), btnReset: $('btn-reset'),
    progressBar: $('progress-bar'), progressText: $('progress-text'), status: $('status'),
    stdCanvas: $('std-canvas'), cntCanvas: $('cnt-canvas'),
    stdFillBar: $('std-fill-bar'), cntFillBar: $('cnt-fill-bar'),
    stdFillText: $('std-fill-text'), cntFillText: $('cnt-fill-text'),
    log: $('log'),
  };

  const worker = new Worker('worker.js');
  let busy = false;

  // ---------- 工具 ----------
  function fmtInt(x) { return Math.round(x).toLocaleString('zh-CN'); }
  function fmtBytes(b) {
    if (b >= 1 << 20) return (b / (1 << 20)).toFixed(2) + ' MiB';
    if (b >= 1 << 10) return (b / (1 << 10)).toFixed(2) + ' KiB';
    return b + ' B';
  }
  function fmtPct(x) {
    if (x === 0) return '0';
    if (x < 1e-6) return x.toExponential(2);
    return (x * 100).toFixed(4) + '%';
  }
  function fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms.toFixed(1) + ' ms'; }

  function log(msg, cls) {
    const line = document.createElement('div');
    line.className = 'log-line' + (cls ? ' ' + cls : '');
    line.textContent = '[' + new Date().toLocaleTimeString('zh-CN') + '] ' + msg;
    els.log.prepend(line);
    while (els.log.children.length > 60) els.log.removeChild(els.log.lastChild);
  }

  function setBusy(b, label) {
    busy = b;
    [els.btnInit, els.btnInsert, els.btnQuery, els.btnDelete].forEach((btn) => { btn.disabled = b; });
    els.status.textContent = label || (b ? '处理中…' : '就绪');
  }

  function setProgress(done, total) {
    const pct = total > 0 ? (done / total) * 100 : 0;
    els.progressBar.style.width = pct.toFixed(1) + '%';
    els.progressText.textContent = fmtInt(done) + ' / ' + fmtInt(total) + ' (' + pct.toFixed(1) + '%)';
  }

  // ---------- Canvas 位数组密度可视化 ----------
  function drawDensity(canvas, density) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const buckets = density.length;
    const bw = w / buckets;
    for (let i = 0; i < buckets; i++) {
      const v = density[i] / 255;
      // 蓝(空) -> 绿 -> 红(满)
      const hue = 220 - v * 220;
      ctx.fillStyle = 'hsl(' + hue + ', 85%, ' + (45 + v * 10) + '%)';
      ctx.fillRect(Math.floor(i * bw), 0, Math.ceil(bw), h);
    }
  }

  function updateViz(viz) {
    if (!viz) return;
    drawDensity(els.stdCanvas, viz.stdDensity);
    drawDensity(els.cntCanvas, viz.cntDensity);
    els.stdFillBar.style.width = (viz.stdFill * 100).toFixed(2) + '%';
    els.cntFillBar.style.width = (viz.cntFill * 100).toFixed(2) + '%';
    els.stdFillText.textContent = fmtPct(viz.stdFill);
    els.cntFillText.textContent = fmtPct(viz.cntFill);
  }

  // ---------- 统计表 ----------
  function renderStats(stats) {
    const op = stats.op || {};
    const measured = op.op === 'query';
    const rows = [
      ['内存占用', fmtBytes(stats.std.memoryBytes), fmtBytes(stats.cnt.memoryBytes)],
      ['已插入元素', fmtInt(stats.std.inserted), fmtInt(stats.cnt.inserted)],
      ['位数组填充率', fmtPct(stats.std.fillRatio), fmtPct(stats.cnt.fillRatio)],
      ['理论误判率 (1-e^(-kn/m))^k', fmtPct(stats.theoreticalFPR), fmtPct(stats.theoreticalFPR)],
      ['实测误判率', measured ? fmtPct(op.stdMeasuredFPR) : '—',
                  measured ? fmtPct(op.cntMeasuredFPR) : '—'],
      ['插入吞吐', op.op === 'insert' ? fmtInt(op.opsPerSec) + ' ops/s' : '—',
                  op.op === 'insert' ? fmtInt(op.opsPerSec) + ' ops/s' : '—'],
      ['查询吞吐', op.op === 'query' ? fmtInt(op.opsPerSec) + ' ops/s' : '—',
                  op.op === 'query' ? fmtInt(op.opsPerSec) + ' ops/s' : '—'],
      ['删除吞吐', '不支持', op.op === 'delete' ? fmtInt(op.opsPerSec) + ' ops/s' : '—'],
      ['计数溢出(饱和)次数', '—', fmtInt(stats.cnt.overflows)],
    ];
    const tbody = $('stats-body');
    tbody.innerHTML = '';
    for (const [label, a, b] of rows) {
      const tr = document.createElement('tr');
      const highlight = label === '实测误判率' ? ' class="hl"' : '';
      tr.innerHTML = '<td' + highlight + '>' + label + '</td><td>' + a + '</td><td>' + b + '</td>';
      tbody.appendChild(tr);
    }
    $('cfg-info').textContent =
      'm = ' + fmtInt(stats.m) + ' bits, k = ' + stats.k +
      ', n = ' + fmtInt(stats.n) + ', 建议最优 k = ' + stats.optimalK;
  }

  // ---------- Worker 消息 ----------
  worker.onmessage = function (e) {
    const msg = e.data;
    switch (msg.type) {
      case 'ready':
        renderStats(msg.stats);
        updateViz(msg.viz);
        setBusy(false);
        setProgress(0, 0);
        log(msg.reset ? '已重置两个过滤器。' : '过滤器已初始化（种子由 Web Crypto 派生）。', 'ok');
        break;
      case 'progress':
        setProgress(msg.done, msg.total);
        if (msg.viz) updateViz(msg.viz);
        break;
      case 'done': {
        renderStats(msg.stats);
        updateViz(msg.viz);
        setBusy(false);
        const op = msg.stats.op;
        if (op.cancelled) {
          log('操作被重置中断（已完成 ' + fmtInt(op.count) + ' 条）。', 'warn');
        } else if (op.op === 'insert') {
          log('插入 ' + fmtInt(op.count) + ' 条，耗时 ' + fmtMs(op.elapsedMs) +
              '（' + fmtInt(op.opsPerSec) + ' ops/s）。', 'ok');
        } else if (op.op === 'query') {
          log('查询 ' + fmtInt(op.count) + ' 个不存在键：标准误判 ' + fmtPct(op.stdMeasuredFPR) +
              ' / 计数误判 ' + fmtPct(op.cntMeasuredFPR) +
              '，理论 ' + fmtPct(msg.stats.theoreticalFPR) +
              '；假阴性 ' + op.falseNegatives + '/' + fmtInt(op.sampleSize) + '（应为 0）。', 'ok');
        } else if (op.op === 'delete') {
          log('计数布隆删除 ' + fmtInt(op.count) + ' 条，耗时 ' + fmtMs(op.elapsedMs) +
              '；已删键残留(误判) ' + op.ghost + '/' + op.checkDeleted +
              '，未删键被破坏 ' + op.corrupted + '/' + op.checkRemaining + '（应为 0）。', 'ok');
        }
        break;
      }
      case 'error':
        setBusy(false);
        log('错误: ' + msg.message, 'err');
        break;
    }
  };

  // ---------- 事件 ----------
  function readConfig() {
    return {
      m: Math.max(8, parseInt(els.m.value, 10) || 0),
      k: Math.max(1, parseInt(els.k.value, 10) || 1),
      n: Math.max(1, parseInt(els.n.value, 10) || 1),
    };
  }

  function updateOptimalHint() {
    const { m, n } = readConfig();
    const kStar = Math.max(1, Math.round((m / n) * Math.LN2));
    const p = Math.pow(1 - Math.exp((-kStar * n) / m), kStar);
    els.optimalHint.textContent =
      '按当前 m/n，最优 k ≈ ' + kStar + '，理论误判率 ≈ ' + fmtPct(p);
  }

  els.btnInit.addEventListener('click', () => {
    const { m, k } = readConfig();
    setBusy(true, '初始化中…');
    log('初始化：m=' + fmtInt(m) + ' bits, k=' + k + ' …');
    worker.postMessage({ type: 'init', m, k });
  });
  els.btnInsert.addEventListener('click', () => {
    const { n } = readConfig();
    setBusy(true, '插入中…');
    worker.postMessage({ type: 'insert', count: n });
  });
  els.btnQuery.addEventListener('click', () => {
    const { n } = readConfig();
    setBusy(true, '查询中…');
    worker.postMessage({ type: 'query', count: n });
  });
  els.btnDelete.addEventListener('click', () => {
    const { n } = readConfig();
    setBusy(true, '删除中…');
    worker.postMessage({ type: 'delete', count: n });
  });
  els.btnReset.addEventListener('click', () => {
    worker.postMessage({ type: 'reset' });
  });
  [els.m, els.k, els.n].forEach((el) => el.addEventListener('input', updateOptimalHint));

  updateOptimalHint();
  // 自动以默认配置初始化
  els.btnInit.click();
})();
