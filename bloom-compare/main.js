'use strict';

const $ = (id) => document.getElementById(id);
const worker = new Worker('worker.js');

const GRID_COLS = 160, GRID_ROWS = 80;
let busy = false;

// ---------- 工具 ----------
const fmtInt = (n) => n.toLocaleString('zh-CN');
const fmtPct = (x) => (x * 100).toFixed(3) + '%';
const fmtBytes = (b) => {
  if (b >= 1 << 20) return (b / (1 << 20)).toFixed(2) + ' MiB';
  if (b >= 1 << 10) return (b / (1 << 10)).toFixed(2) + ' KiB';
  return b + ' B';
};
const fmtOps = (o) => o >= 1e6 ? (o / 1e6).toFixed(2) + ' M ops/s' : fmtInt(Math.round(o)) + ' ops/s';

function log(msg, cls = '') {
  const el = $('log');
  const line = document.createElement('div');
  line.className = 'log-line ' + cls;
  line.textContent = `[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`;
  el.prepend(line);
  while (el.children.length > 200) el.lastChild.remove();
}

function theoryFPR(m, k, n) {
  return Math.pow(1 - Math.exp(-k * n / m), k);
}

// ---------- 配置 ----------
function readConfig() {
  const m = parseInt($('cfgM').value, 10);
  const k = parseInt($('cfgK').value, 10);
  const n = parseInt($('cfgN').value, 10);
  if (!Number.isInteger(m) || m < 1024) throw new Error('位数组大小至少 1024 bit');
  if (!Number.isInteger(k) || k < 1 || k > 32) throw new Error('哈希函数个数需在 1~32');
  if (!Number.isInteger(n) || n < 1) throw new Error('插入数量必须为正整数');
  return { m, k, n };
}

function updateTheory() {
  try {
    const { m, k, n } = readConfig();
    $('theoryFpr').textContent = fmtPct(theoryFPR(m, k, n));
    $('optimalK').textContent = Math.max(1, Math.round((m / n) * Math.LN2));
    $('spaceClassic').textContent = fmtBytes(Math.ceil(m / 8));
    $('spaceCounting').textContent = fmtBytes(m);
  } catch (_) { /* 输入非法时静默 */ }
}

// ---------- 统计表 ----------
function renderStats(s) {
  $('stClassicCount').textContent = fmtInt(s.classic.count);
  $('stCountingCount').textContent = fmtInt(s.counting.count);
  $('stClassicFill').textContent = fmtPct(s.classic.fillRate);
  $('stCountingFill').textContent = fmtPct(s.counting.fillRate);
  $('stClassicMem').textContent = fmtBytes(s.classic.memoryBytes);
  $('stCountingMem').textContent = fmtBytes(s.counting.memoryBytes);
  $('stOverflow').textContent = fmtInt(s.counting.overflows);
  $('fillBarClassic').style.width = Math.min(100, s.classic.fillRate * 100) + '%';
  $('fillBarCounting').style.width = Math.min(100, s.counting.fillRate * 100) + '%';
}

// ---------- Canvas 可视化 ----------
function drawGrid(canvas, grid, cols, rows, colorFn) {
  const ctx = canvas.getContext('2d');
  const cw = canvas.width / cols, ch = canvas.height / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = grid[r * cols + c];
      ctx.fillStyle = colorFn(v);
      ctx.fillRect(c * cw, r * ch, Math.ceil(cw), Math.ceil(ch));
    }
  }
}

// 普通：0→深色，1→亮蓝；计数：按平均计数 0→4+ 渐变（绿→黄→红）
const classicColor = (v) => `hsl(215, 80%, ${12 + v * 55}%)`;
const countingColor = (v) => {
  if (v <= 0) return 'hsl(150, 30%, 10%)';
  const t = Math.min(1, v / 4);
  return `hsl(${140 - t * 140}, 85%, ${25 + t * 25}%)`;
};

function requestGrid() {
  worker.postMessage({ type: 'grid', cols: GRID_COLS, rows: GRID_ROWS });
}

// ---------- 操作 ----------
function setBusy(b, label) {
  busy = b;
  for (const id of ['btnInit', 'btnInsert', 'btnFpTest', 'btnDelete', 'btnReset', 'btnBench'])
    $(id).disabled = b;
  $('btnCancel').disabled = !b;
  $('status').textContent = label || (b ? '运行中…' : '空闲');
}

function run(op, payload, label) {
  if (busy) return;
  setBusy(true, label);
  worker.postMessage(Object.assign({ type: op }, payload));
}

function initFilters() {
  try {
    const { m, k, n } = readConfig();
    run('init', { m, k, n }, '初始化过滤器…');
    log(`初始化：m=${fmtInt(m)} bit, k=${k}, 预计插入 n=${fmtInt(n)}`);
  } catch (err) { log(err.message, 'err'); }
}

// ---------- Worker 消息 ----------
worker.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'ready':
      setBusy(false);
      renderStats(msg.stats);
      requestGrid();
      if (msg.reset) log('已重置两个过滤器');
      break;
    case 'progress':
      $('status').textContent =
        `${msg.op}: ${fmtInt(msg.done)} / ${fmtInt(msg.total)} (${(msg.done / msg.total * 100).toFixed(1)}%)`;
      $('progressBar').style.width = (msg.done / msg.total * 100) + '%';
      break;
    case 'result': {
      setBusy(false);
      $('progressBar').style.width = '0%';
      renderStats(msg.stats);
      requestGrid();
      const tag = msg.canceled ? '（已取消）' : '';
      if (msg.op === 'insert') {
        $('stClassicInsert').textContent = fmtOps(msg.opsPerSec);
        $('stCountingInsert').textContent = fmtOps(msg.opsPerSec);
        log(`插入 ${fmtInt(msg.inserted)} 条${tag}，耗时 ${msg.ms.toFixed(0)} ms，吞吐 ${fmtOps(msg.opsPerSec)}`, 'ok');
      } else if (msg.op === 'fptest') {
        $('stClassicFpr').textContent = fmtPct(msg.classicFPR);
        $('stCountingFpr').textContent = fmtPct(msg.countingFPR);
        $('stTheoryFpr').textContent = fmtPct(msg.theoryFPR);
        $('stClassicQuery').textContent = fmtOps(msg.opsPerSec);
        $('stCountingQuery').textContent = fmtOps(msg.opsPerSec);
        log(`误判率实测${tag}：查询 ${fmtInt(msg.queried)} 条非成员，` +
          `普通=${fmtPct(msg.classicFPR)}，计数=${fmtPct(msg.countingFPR)}，理论=${fmtPct(msg.theoryFPR)}`, 'ok');
      } else if (msg.op === 'delete') {
        const it = msg.integrity;
        const okTxt = it.sampled > 0
          ? `完整性抽样 ${fmtInt(it.sampled)} 条剩余元素，假阴性 ${it.falseNeg} 条`
          : '无剩余元素可抽样';
        log(`删除 ${fmtInt(msg.removed)} 条${tag}，耗时 ${msg.ms.toFixed(0)} ms；${okTxt}`,
          it.falseNeg === 0 ? 'ok' : 'err');
      }
      break;
    }
    case 'grid':
      drawGrid($('canvasClassic'), msg.classicGrid, msg.cols, msg.rows, classicColor);
      drawGrid($('canvasCounting'), msg.countingGrid, msg.cols, msg.rows, countingColor);
      renderStats(msg.stats);
      break;
    case 'error':
      setBusy(false);
      log('错误：' + msg.message, 'err');
      break;
  }
};

worker.onerror = (e) => { setBusy(false); log('Worker 错误：' + e.message, 'err'); };

// ---------- 事件绑定 ----------
$('btnInit').onclick = initFilters;
$('btnInsert').onclick = () => {
  try { run('insert', { count: readConfig().n }, '插入中…'); }
  catch (err) { log(err.message, 'err'); }
};
$('btnFpTest').onclick = () => {
  const count = parseInt($('cfgProbe').value, 10) || 100000;
  run('fptest', { count }, '误判率测试中…');
};
$('btnDelete').onclick = () => {
  const count = parseInt($('cfgDel').value, 10) || 10000;
  run('delete', { count }, '删除中…（仅计数布隆）');
};
$('btnReset').onclick = () => run('reset', {}, '重置中…');
$('btnCancel').onclick = () => worker.postMessage({ type: 'cancel' });
$('btnBench').onclick = () => {
  // 一键对比基准：重置 → 插入 → 误判率测试（消息按序排队，Worker 顺序执行）
  if (busy) return;
  try {
    const { n } = readConfig();
    const probe = parseInt($('cfgProbe').value, 10) || 100000;
    log('开始对比基准：重置 → 插入 → 误判率测试');
    setBusy(true, '基准运行中…');
    worker.postMessage({ type: 'reset' });
    worker.postMessage({ type: 'insert', count: n });
    worker.postMessage({ type: 'fptest', count: probe });
  } catch (err) { log(err.message, 'err'); }
};
for (const id of ['cfgM', 'cfgK', 'cfgN']) $(id).oninput = updateTheory;

updateTheory();
initFilters();
