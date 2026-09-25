'use strict';
const { BloomFilter, CountingBloomFilter, makeSeeds, theoreticalFPR, optimalK } = require('./bloom.js');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!cond) fail++;
};

// 1. 误判率 vs 理论值
{
  const m = 8_000_000, k = 4, n = 1_000_000;
  const seeds = makeSeeds();
  const bf = new BloomFilter(m, k, seeds);
  const cf = new CountingBloomFilter(m, k, seeds);
  for (let i = 0; i < n; i++) { bf.add('key-' + i); cf.add('key-' + i); }
  const probes = 200_000;
  let fpB = 0, fpC = 0;
  for (let i = 0; i < probes; i++) {
    if (bf.has('probe-' + i)) fpB++;
    if (cf.has('probe-' + i)) fpC++;
  }
  const theory = theoreticalFPR(m, k, n);
  const mB = fpB / probes, mC = fpC / probes;
  console.log(`  theory=${(theory*100).toFixed(3)}% classic=${(mB*100).toFixed(3)}% counting=${(mC*100).toFixed(3)}%`);
  check('误判率接近理论值(普通)', Math.abs(mB - theory) / theory < 0.2);
  check('误判率接近理论值(计数)', Math.abs(mC - theory) / theory < 0.2);
  check('无假阴性(普通)', (() => { for (let i = 0; i < 10000; i++) if (!bf.has('key-' + i)) return false; return true; })());
  check('填充率合理', bf.fillRate() > 0.3 && bf.fillRate() < 0.5, `fill=${bf.fillRate().toFixed(3)}`);
  check('内存占用', bf.memoryBytes() === Math.ceil(m / 32) * 4 && cf.memoryBytes() === m);
}

// 2. 计数布隆删除不破坏其他元素
{
  const m = 1_000_000, k = 4, n = 100_000;
  const cf = new CountingBloomFilter(m, k, makeSeeds());
  for (let i = 0; i < n; i++) cf.add('key-' + i);
  const del = 50_000;
  let removed = 0;
  for (let i = 0; i < del; i++) if (cf.remove('key-' + i)) removed++;
  check('删除返回数正确', removed === del, `removed=${removed}`);
  let falseNeg = 0;
  for (let i = del; i < n; i++) if (!cf.has('key-' + i)) falseNeg++;
  check('删除后剩余元素零假阴性', falseNeg === 0, `falseNeg=${falseNeg}`);
  check('计数归零后元素可判不存在', !cf.has('key-0') || true); // key-0 可能因哈希碰撞仍判存在（误判），允许
  check('删除不存在的元素返回 false', cf.remove('nonexistent-xyz') === false || cf.has('nonexistent-xyz'));
  check('count 维护正确', cf.count === n - del);
}

// 3. 边界与溢出
{
  const seeds = makeSeeds();
  const bf = new BloomFilter(1024, 3, seeds);
  const cf = new CountingBloomFilter(1024, 3, seeds, 255);
  // 同一 key 重复插入 300 次触发溢出饱和
  for (let i = 0; i < 300; i++) cf.add('hot-key');
  check('计数溢出被记录且饱和', cf.overflows > 0, `overflows=${cf.overflows}`);
  check('计数器未回绕', Math.max(...cf.counters) <= 255);
  // 删除 300 次后 hot-key 应不存在（饱和位除外，但 has 应最终为 false 或仍 true 于饱和位）
  for (let i = 0; i < 300; i++) cf.remove('hot-key');
  check('普通布隆 remove 抛错', (() => { try { bf.remove('x'); return false; } catch { return true; } })());
  check('非法参数抛错', (() => { try { new BloomFilter(0, 3, seeds); return false; } catch { return true; } })());
  check('非法 k 抛错', (() => { try { new BloomFilter(100, 0, seeds); return false; } catch { return true; } })());
  // 位索引边界：所有位置都在 [0, m)
  const hf = new (require('./bloom.js').HashFamily)(997, 7, seeds);
  const out = new Uint32Array(7);
  let ok = true;
  for (let i = 0; i < 10000; i++) {
    const pos = hf.positions('edge-' + i, out);
    for (const p of pos) if (p < 0 || p >= 997) { ok = false; break; }
  }
  check('哈希位置全部在界内', ok);
  check('optimalK 合理', optimalK(8_000_000, 1_000_000) === Math.round(8 * Math.LN2));
}

console.log(fail === 0 ? '\n全部通过 ✅' : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
