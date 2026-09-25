'use strict';
importScripts('bloom.js');

let classic = null;
let counting = null;
let config = null;
let cancelFlag = false;

const CHUNK = 50000; // 每块处理量，块间让出事件循环以响应取消/进度

const yieldLoop = () => new Promise(r => setTimeout(r, 0));

function key(i) { return 'key-' + i; }   // 已插入元素
function probe(i) { return 'probe-' + i; } // 未插入元素（用于误判率实测）

function stats() {
  return {
    classic: {
      count: classic.count,
      fillRate: classic.fillRate(),
      memoryBytes: classic.memoryBytes(),
    },
    counting: {
      count: counting.count,
      fillRate: counting.fillRate(),
      memoryBytes: counting.memoryBytes(),
      overflows: counting.overflows,
    },
  };
}

async function insertBatch(count) {
  const t0 = performance.now();
  let done = 0;
  while (done < count) {
    if (cancelFlag) break;
    const end = Math.min(done + CHUNK, count);
    for (let i = done; i < end; i++) {
      const k = key(i);
      classic.add(k);
      counting.add(k);
    }
    done = end;
    postMessage({ type: 'progress', op: 'insert', done, total: count });
    await yieldLoop();
  }
  const ms = performance.now() - t0;
  postMessage({
    type: 'result', op: 'insert', canceled: cancelFlag,
    inserted: done, ms,
    opsPerSec: done / (ms / 1000),
    stats: stats(),
  });
}

async function fpTest(count) {
  const t0 = performance.now();
  let fpClassic = 0, fpCounting = 0, done = 0;
  while (done < count) {
    if (cancelFlag) break;
    const end = Math.min(done + CHUNK, count);
    for (let i = done; i < end; i++) {
      const p = probe(i);
      if (classic.has(p)) fpClassic++;
      if (counting.has(p)) fpCounting++;
    }
    done = end;
    postMessage({ type: 'progress', op: 'fptest', done, total: count });
    await yieldLoop();
  }
  const ms = performance.now() - t0;
  postMessage({
    type: 'result', op: 'fptest', canceled: cancelFlag,
    queried: done, ms,
    opsPerSec: done / (ms / 1000),
    classicFPR: fpClassic / done,
    countingFPR: fpCounting / done,
    theoryFPR: theoreticalFPR(config.m, config.k, classic.count),
    stats: stats(),
  });
}

async function deleteBatch(count) {
  const t0 = performance.now();
  const total = Math.min(count, counting.count);
  let removed = 0, done = 0;
  while (done < total) {
    if (cancelFlag) break;
    const end = Math.min(done + CHUNK, total);
    for (let i = done; i < end; i++) {
      if (counting.remove(key(i))) removed++;
    }
    done = end;
    postMessage({ type: 'progress', op: 'delete', done, total });
    await yieldLoop();
  }
  // 完整性校验：抽样确认剩余元素未被删除操作破坏（假阴性检测）
  const remaining = counting.count;
  const sampleN = Math.min(20000, remaining);
  let falseNeg = 0;
  if (sampleN > 0) {
    const step = remaining / sampleN;
    for (let s = 0; s < sampleN; s++) {
      const idx = total + Math.floor(s * step);
      if (!counting.has(key(idx))) falseNeg++;
    }
  }
  const ms = performance.now() - t0;
  postMessage({
    type: 'result', op: 'delete', canceled: cancelFlag,
    removed, ms,
    opsPerSec: removed / (ms / 1000),
    integrity: { sampled: sampleN, falseNeg },
    stats: stats(),
  });
}

// 生成画布用的填充率网格：把位数组分桶聚合
function makeGrid(cols, rows) {
  const cells = cols * rows;
  const classicGrid = new Float32Array(cells);
  const countingGrid = new Float32Array(cells);
  const perCell = Math.ceil(config.m / cells);

  const words = classic.words;
  for (let c = 0; c < cells; c++) {
    const bitStart = c * perCell;
    const bitEnd = Math.min(bitStart + perCell, config.m);
    if (bitStart >= bitEnd) break;
    let set = 0;
    const w0 = bitStart >>> 5, w1 = (bitEnd - 1) >>> 5;
    for (let w = w0; w <= w1; w++) {
      let v = words[w];
      // 掩掉桶外的位（边界处理）
      const lo = w === w0 ? bitStart & 31 : 0;
      const hi = w === w1 ? (bitEnd - 1) & 31 : 31;
      v &= (0xffffffff << lo) >>> 0;
      v &= (0xffffffff >>> (31 - hi));
      v = v - ((v >>> 1) & 0x55555555);
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
      set += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    }
    classicGrid[c] = set / (bitEnd - bitStart);
  }

  const counters = counting.counters;
  for (let c = 0; c < cells; c++) {
    const s0 = c * perCell;
    const s1 = Math.min(s0 + perCell, config.m);
    if (s0 >= s1) break;
    let sum = 0;
    for (let s = s0; s < s1; s++) sum += counters[s];
    countingGrid[c] = sum / (s1 - s0); // 平均计数值
  }

  postMessage(
    { type: 'grid', cols, rows, classicGrid, countingGrid, stats: stats() },
    [classicGrid.buffer, countingGrid.buffer]
  );
}

onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init': {
        config = { m: msg.m, k: msg.k };
        const seeds = makeSeeds();
        classic = new BloomFilter(msg.m, msg.k, seeds);
        counting = new CountingBloomFilter(msg.m, msg.k, seeds);
        cancelFlag = false;
        postMessage({ type: 'ready', stats: stats(), theoryK: optimalK(msg.m, msg.n || 1) });
        break;
      }
      case 'insert': cancelFlag = false; await insertBatch(msg.count); break;
      case 'fptest': cancelFlag = false; await fpTest(msg.count); break;
      case 'delete': cancelFlag = false; await deleteBatch(msg.count); break;
      case 'reset':
        classic.reset(); counting.reset();
        postMessage({ type: 'ready', stats: stats(), reset: true });
        break;
      case 'cancel': cancelFlag = true; break;
      case 'grid': makeGrid(msg.cols, msg.rows); break;
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
