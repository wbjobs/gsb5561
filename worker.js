/*
 * worker.js — 所有过滤器计算均在 Worker 内执行，主线程永不阻塞。
 * 消息协议：
 *   接收: {type:'init', m, k} / {type:'insert', count} / {type:'query', count}
 *         {type:'delete', count} / {type:'reset'}
 *   发送: {type:'ready'} / {type:'progress', ...} / {type:'done', op, stats}
 *         {type:'error', message}
 */
importScripts('filters.js');

const {
  BloomFilter,
  CountingBloomFilter,
  deriveSeeds,
  theoreticalFPR,
  optimalK,
  densityBuckets,
} = self.BloomLib;

const CHUNK = 50000;      // 每块处理量，块间让出事件循环以响应 reset 等消息
const VIZ_BUCKETS = 480;  // 可视化密度桶数

let std = null;   // 标准布隆过滤器
let cnt = null;   // 计数布隆过滤器
let config = null;
let insertedTotal = 0;    // 已插入元素数（key-<i>, i in [0, insertedTotal)）
let deletedTotal = 0;     // 已从计数过滤器删除的数量（删除最旧的 key）
let cancelled = false;

function keyAt(i) { return 'key-' + i; }
function probeAt(i) { return 'probe-' + i; } // 与插入集不交的探测集

function vizPayload() {
  return {
    stdDensity: densityBuckets(std, VIZ_BUCKETS),
    cntDensity: densityBuckets(cnt, VIZ_BUCKETS),
    stdFill: std.fillRatio(),
    cntFill: cnt.fillRatio(),
  };
}

function baseStats() {
  const n = insertedTotal;
  return {
    m: config.m,
    k: config.k,
    n,
    optimalK: optimalK(config.m, Math.max(1, n)),
    theoreticalFPR: theoreticalFPR(config.m, config.k, n),
    std: {
      memoryBytes: std.memoryBytes(),
      fillRatio: std.fillRatio(),
      inserted: std.inserted,
    },
    cnt: {
      memoryBytes: cnt.memoryBytes(),
      fillRatio: cnt.fillRatio(),
      inserted: cnt.inserted,
      overflows: cnt.overflows,
    },
  };
}

// 分块执行，块间 postMessage 进度并让出事件循环
async function runChunked(total, fn, onProgress) {
  cancelled = false;
  let done = 0;
  while (done < total) {
    if (cancelled) return { cancelled: true, done };
    const size = Math.min(CHUNK, total - done);
    fn(done, size);
    done += size;
    if (onProgress) onProgress(done, total);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { cancelled: false, done };
}

const handlers = {
  async init(msg) {
    const m = Math.max(8, msg.m | 0);
    const k = Math.max(1, Math.min(64, msg.k | 0));
    const seeds = await deriveSeeds(m + '/' + k);
    std = new BloomFilter(m, k, seeds);
    cnt = new CountingBloomFilter(m, k, seeds);
    config = { m, k };
    insertedTotal = 0;
    deletedTotal = 0;
    postMessage({ type: 'ready', stats: baseStats(), viz: vizPayload() });
  },

  async insert(msg) {
    const count = Math.max(0, msg.count | 0);
    const startIndex = insertedTotal;
    const t0 = performance.now();
    const res = await runChunked(count, (offset, size) => {
      for (let i = 0; i < size; i++) {
        const key = keyAt(startIndex + offset + i);
        std.add(key);
        cnt.add(key);
      }
    }, (done, total) => {
      postMessage({ type: 'progress', op: 'insert', done, total, viz: vizPayload() });
    });
    const elapsed = performance.now() - t0;
    insertedTotal += res.done;
    const stats = baseStats();
    stats.op = {
      op: 'insert',
      count: res.done,
      cancelled: res.cancelled,
      elapsedMs: elapsed,
      opsPerSec: res.done / (elapsed / 1000),
    };
    postMessage({ type: 'done', op: 'insert', stats, viz: vizPayload() });
  },

  async query(msg) {
    // 用从未插入的 probe-* 键测误判率；同时抽查已插入键验证无误漏报
    const count = Math.max(1, msg.count | 0);
    let stdFP = 0;
    let cntFP = 0;
    const t0 = performance.now();
    const res = await runChunked(count, (offset, size) => {
      for (let i = 0; i < size; i++) {
        const key = probeAt(offset + i);
        if (std.has(key)) stdFP++;
        if (cnt.has(key)) cntFP++;
      }
    }, (done, total) => {
      postMessage({ type: 'progress', op: 'query', done, total });
    });
    const elapsed = performance.now() - t0;

    // 抽查已插入键（假阴性必须恒为 0）
    let fnErrors = 0;
    const sample = Math.min(insertedTotal, 10000);
    for (let i = 0; i < sample; i++) {
      const idx = Math.floor((i / sample) * insertedTotal);
      if (!std.has(keyAt(idx))) fnErrors++;
    }

    const stats = baseStats();
    stats.op = {
      op: 'query',
      count: res.done,
      cancelled: res.cancelled,
      elapsedMs: elapsed,
      opsPerSec: res.done / (elapsed / 1000),
      stdMeasuredFPR: stdFP / res.done,
      cntMeasuredFPR: cntFP / res.done,
      falseNegatives: fnErrors,
      sampleSize: sample,
    };
    postMessage({ type: 'done', op: 'query', stats, viz: vizPayload() });
  },

  async delete(msg) {
    // 仅计数布隆支持删除：删除最旧的 count 个已插入键
    const available = insertedTotal - deletedTotal;
    const count = Math.min(Math.max(0, msg.count | 0), available);
    let removed = 0;
    const t0 = performance.now();
    const res = await runChunked(count, (offset, size) => {
      for (let i = 0; i < size; i++) {
        if (cnt.remove(keyAt(deletedTotal + offset + i))) removed++;
      }
    }, (done, total) => {
      postMessage({ type: 'progress', op: 'delete', done, total, viz: vizPayload() });
    });
    const elapsed = performance.now() - t0;
    deletedTotal += res.done;

    // 验证：已删除的键应消失（允许误判），未删除的键必须仍在（不允许被破坏）
    let ghost = 0;       // 已删除但仍判定存在（误判，允许）
    let corrupted = 0;   // 未删除却判定不存在（破坏其他元素，不允许）
    const checkDeleted = Math.min(res.done, 5000);
    for (let i = 0; i < checkDeleted; i++) {
      if (cnt.has(keyAt(deletedTotal - res.done + i))) ghost++;
    }
    const remaining = insertedTotal - deletedTotal;
    const checkRemaining = Math.min(remaining, 5000);
    for (let i = 0; i < checkRemaining; i++) {
      const idx = deletedTotal + Math.floor((i / checkRemaining) * remaining);
      if (!cnt.has(keyAt(idx))) corrupted++;
    }

    const stats = baseStats();
    stats.op = {
      op: 'delete',
      count: res.done,
      removed,
      cancelled: res.cancelled,
      elapsedMs: elapsed,
      opsPerSec: res.done / (elapsed / 1000),
      deletedTotal,
      ghost,
      corrupted,
      checkDeleted,
      checkRemaining,
    };
    postMessage({ type: 'done', op: 'delete', stats, viz: vizPayload() });
  },

  async reset() {
    cancelled = true; // 中断进行中的批量操作
    if (std) std.reset();
    if (cnt) cnt.reset();
    insertedTotal = 0;
    deletedTotal = 0;
    if (config) {
      postMessage({ type: 'ready', stats: baseStats(), viz: vizPayload(), reset: true });
    }
  },
};

onmessage = function (e) {
  const msg = e.data;
  const handler = handlers[msg.type];
  if (!handler) return;
  Promise.resolve(handler(msg)).catch((err) => {
    postMessage({ type: 'error', message: String(err && err.stack || err) });
  });
};
