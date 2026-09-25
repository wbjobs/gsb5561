/* 验收测试：node test/filters.test.cjs */
const assert = require('assert');
const {
  BloomFilter,
  CountingBloomFilter,
  theoreticalFPR,
  optimalK,
  densityBuckets,
  murmur3_32,
  COUNTER_MAX,
} = require('../filters.js');

const seeds = new Uint32Array([0x9e3779b9, 0x85ebca6b]);
let passed = 0;
function ok(name, cond, extra) {
  assert(cond, name + (extra ? ' | ' + extra : ''));
  passed++;
  console.log('  ✓ ' + name + (extra ? '  (' + extra + ')' : ''));
}

console.log('1. 哈希与位数组边界');
{
  const m = 100003, k = 7;
  const f = new BloomFilter(m, k, seeds);
  for (let i = 0; i < 50000; i++) {
    const buf = f._pos('bound-' + i, k, f._buf);
    for (let j = 0; j < k; j++) {
      assert(Number.isInteger(buf[j]) && buf[j] >= 0 && buf[j] < m, '位置越界: ' + buf[j]);
    }
  }
  ok('5 万键 × k 个哈希位置全部在 [0, m) 内', true);
  ok('m 非 8 的倍数时位图大小正确', f.bits.length === Math.ceil(m / 8));
}

console.log('2. 误判率：理论值 vs 实测值');
{
  const m = 10_000_000, k = 7, n = 1_000_000;
  const f = new BloomFilter(m, k, seeds);
  for (let i = 0; i < n; i++) f.add('key-' + i);
  let fp = 0;
  const probes = 200_000;
  for (let i = 0; i < probes; i++) if (f.has('probe-' + i)) fp++;
  const measured = fp / probes;
  const theory = theoreticalFPR(m, k, n);
  ok('实测误判率与理论值接近（相对误差 < 30%）',
     Math.abs(measured - theory) / theory < 0.3,
     `理论 ${(theory * 100).toFixed(4)}% vs 实测 ${(measured * 100).toFixed(4)}%`);
  ok('假阴性为 0', (() => { for (let i = 0; i < n; i += 997) if (!f.has('key-' + i)) return false; return true; })());
  ok('最优 k 计算正确', optimalK(m, n) === Math.round((m / n) * Math.LN2), `k*=${optimalK(m, n)}`);
}

console.log('3. 计数布隆：删除不破坏其他元素');
{
  const m = 1_000_000, k = 5, n = 100_000;
  const c = new CountingBloomFilter(m, k, seeds);
  for (let i = 0; i < n; i++) c.add('key-' + i);
  // 删除前一半
  let removed = 0;
  for (let i = 0; i < n / 2; i++) if (c.remove('key-' + i)) removed++;
  ok('删除全部成功', removed === n / 2);
  // 后一半必须全部仍在（不允许被破坏）
  let corrupted = 0;
  for (let i = n / 2; i < n; i++) if (!c.has('key-' + i)) corrupted++;
  ok('未删除元素零破坏', corrupted === 0, `corrupted=${corrupted}`);
  // 已删除元素大部分应消失（允许少量误判残留）
  let ghost = 0;
  for (let i = 0; i < n / 2; i++) if (c.has('key-' + i)) ghost++;
  const theory = theoreticalFPR(m, k, n / 2);
  ok('已删除元素残留率 ≤ 理论误判率量级', ghost / (n / 2) < Math.max(theory * 3, 0.001),
     `ghost=${ghost}/${n / 2}`);
  // 删除不存在的键必须被拒绝（防止误减计数）
  ok('删除不存在的键返回 false', c.remove('never-inserted') === false);
}

console.log('4. 计数溢出（饱和）处理');
{
  const m = 64, k = 1;
  const c = new CountingBloomFilter(m, k, seeds);
  // 同一位置反复累加：相同键哈希到同一位置
  for (let i = 0; i < COUNTER_MAX + 50; i++) c.add('same-key');
  const pos = c._pos('same-key', 1, c._buf)[0];
  ok('计数器饱和在 255 不回绕', c.counters[pos] === COUNTER_MAX, `counter=${c.counters[pos]}`);
  ok('溢出次数被统计', c.overflows === 50, `overflows=${c.overflows}`);
  ok('饱和后 has 仍为 true', c.has('same-key'));
}

console.log('5. 哈希函数个数可配置 & 填充率可视化');
{
  for (const k of [1, 3, 7, 16, 32]) {
    const f = new BloomFilter(100_000, k, seeds);
    for (let i = 0; i < 5000; i++) f.add('k' + k + '-' + i);
    const expectedFill = 1 - Math.exp((-k * 5000) / 100_000);
    ok(`k=${k} 填充率符合理论`, Math.abs(f.fillRatio() - expectedFill) < 0.02,
       `${(f.fillRatio() * 100).toFixed(2)}% vs 理论 ${(expectedFill * 100).toFixed(2)}%`);
  }
  const f = new BloomFilter(80_000, 3, seeds);
  for (let i = 0; i < 10_000; i++) f.add('viz-' + i);
  const buckets = densityBuckets(f, 100);
  ok('密度桶数量正确', buckets.length === 100);
  const avg = buckets.reduce((a, b) => a + b, 0) / 100 / 255;
  ok('密度均值 ≈ 实际填充率', Math.abs(avg - f.fillRatio()) < 0.02,
     `avg=${(avg * 100).toFixed(2)}% fill=${(f.fillRatio() * 100).toFixed(2)}%`);
}

console.log('6. 百万级插入：内存与性能');
{
  const m = 10_000_000, k = 7, n = 1_000_000;
  const std = new BloomFilter(m, k, seeds);
  const cnt = new CountingBloomFilter(m, k, seeds);
  const memBefore = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) { std.add('key-' + i); cnt.add('key-' + i); }
  const t1 = process.hrtime.bigint();
  const qt0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) { std.has('probe-' + i); cnt.has('probe-' + i); }
  const qt1 = process.hrtime.bigint();
  const insertMs = Number(t1 - t0) / 1e6;
  const queryMs = Number(qt1 - qt0) / 1e6;
  ok('标准位图内存 = m/8 字节', std.memoryBytes() === Math.ceil(m / 8),
     fmtMB(std.memoryBytes()));
  ok('计数器内存 = m 字节', cnt.memoryBytes() === m, fmtMB(cnt.memoryBytes()));
  ok('插入 100 万条无内存溢出（TypedArray 定长）',
     std.bits.byteLength + cnt.counters.byteLength <= m / 8 + m);
  console.log(`    插入 ${n.toLocaleString()} 条耗时 ${insertMs.toFixed(0)}ms ` +
    `(${(n / insertMs * 1000 / 1e6).toFixed(2)}M ops/s)，查询耗时 ${queryMs.toFixed(0)}ms`);
  ok('插入性能 > 50 万 ops/s', n / insertMs * 1000 > 500_000);
  // 重置
  std.reset(); cnt.reset();
  ok('重置后填充率归零', std.fillRatio() === 0 && cnt.fillRatio() === 0);
}

console.log('7. MurmurHash3 分布 sanity');
{
  const seen = new Set();
  for (let i = 0; i < 100_000; i++) seen.add(murmur3_32('dist-' + i, 42) % 1024);
  ok('低 10 bit 覆盖率 > 99%', seen.size / 1024 > 0.99, `${seen.size}/1024`);
}

function fmtMB(b) { return (b / 1024 / 1024).toFixed(2) + ' MiB'; }

console.log(`\n全部通过：${passed} 项断言 ✓`);
