/* 冒烟测试：模拟 Worker 环境跑完整消息流 node test/worker.smoke.cjs */
const fs = require('fs');
const path = require('path');
const outbox = [];

globalThis.self = globalThis;
globalThis.BloomLib = require('../filters.js');
globalThis.postMessage = (m) => outbox.push(m);
globalThis.importScripts = () => {};

const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
eval(workerSrc);

function send(type, extra = {}) {
  return new Promise((resolve, reject) => {
    const n0 = outbox.length;
    globalThis.onmessage({ data: { type, ...extra } });
    const timer = setInterval(() => {
      const err = outbox.slice(n0).find((m) => m.type === 'error');
      if (err) { clearInterval(timer); reject(new Error(err.message)); return; }
      const done = outbox.slice(n0).find((m) => m.type === 'done' || m.type === 'ready');
      if (done) { clearInterval(timer); resolve(done); }
    }, 5);
  });
}

(async () => {
  const ready = await send('init', { m: 1_000_000, k: 7 });
  console.log('init ready, m =', ready.stats.m, 'k =', ready.stats.k, 'viz buckets =', ready.viz.stdDensity.length);

  const ins = await send('insert', { count: 100_000 });
  console.log('insert:', (ins.stats.op.opsPerSec / 1e6).toFixed(2) + 'M ops/s,',
    'std fill =', (ins.stats.std.fillRatio * 100).toFixed(2) + '%',
    'cnt fill =', (ins.stats.cnt.fillRatio * 100).toFixed(2) + '%');

  const q = await send('query', { count: 100_000 });
  console.log('query: std FPR =', (q.stats.op.stdMeasuredFPR * 100).toFixed(4) + '%',
    'cnt FPR =', (q.stats.op.cntMeasuredFPR * 100).toFixed(4) + '%',
    'theory =', (q.stats.theoreticalFPR * 100).toFixed(4) + '%',
    'falseNegatives =', q.stats.op.falseNegatives);
  if (q.stats.op.falseNegatives !== 0) throw new Error('出现假阴性！');

  const del = await send('delete', { count: 50_000 });
  console.log('delete 50k: corrupted =', del.stats.op.corrupted,
    'ghost =', del.stats.op.ghost + '/' + del.stats.op.checkDeleted,
    'cnt inserted =', del.stats.cnt.inserted);
  if (del.stats.op.corrupted !== 0) throw new Error('删除破坏了其他元素！');

  const rst = await send('reset');
  console.log('reset: fill =', rst.stats.std.fillRatio, rst.stats.cnt.fillRatio);
  if (rst.stats.std.fillRatio !== 0 || rst.stats.cnt.fillRatio !== 0) throw new Error('重置失败！');

  console.log('SMOKE TEST OK ✓');
})().catch((e) => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
