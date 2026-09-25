'use strict';
/*
 * bloom.js — 普通布隆过滤器 + 计数布隆过滤器
 * 哈希策略：Web Crypto 生成随机种子 + FNV-1a 双哈希（double hashing）
 *   h_i(x) = (h1(x) + i * h2(x)) mod m,  i = 0..k-1
 */

// FNV-1a 32-bit，带种子（种子异或进初始偏移量）
function fnv1a(str, seed) {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // 追加一次混合，弱化低位相关性
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

// 用 Web Crypto 生成每实例独立的哈希种子
function makeSeeds() {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  return { seed1: buf[0], seed2: buf[1] };
}

class HashFamily {
  constructor(m, k, seeds) {
    if (!Number.isInteger(m) || m <= 0) throw new RangeError('位数组大小 m 必须为正整数');
    if (!Number.isInteger(k) || k <= 0) throw new RangeError('哈希函数个数 k 必须为正整数');
    this.m = m;
    this.k = k;
    this.seed1 = seeds.seed1;
    this.seed2 = seeds.seed2;
  }
  // 把 k 个位置写入 out（复用数组避免 GC），返回 out
  positions(key, out) {
    const h1 = fnv1a(key, this.seed1);
    let h2 = fnv1a(key, this.seed2);
    h2 = (h2 | 1) >>> 0; // 保证步长非零且为奇数，覆盖更均匀
    const m = this.m;
    for (let i = 0; i < this.k; i++) {
      // 边界处理：>>> 0 保证无符号，% m 保证落在 [0, m)
      out[i] = ((h1 + Math.imul(i, h2)) >>> 0) % m;
    }
    return out;
  }
}

class BloomFilter {
  constructor(m, k, seeds) {
    this.hash = new HashFamily(m, k, seeds);
    this.m = m;
    this.k = k;
    this.words = new Uint32Array((m + 31) >>> 5); // 位压缩存储，m/8 字节
    this.count = 0;
    this._scratch = new Uint32Array(k);
  }
  add(key) {
    const pos = this.hash.positions(key, this._scratch);
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i];
      this.words[p >>> 5] |= (1 << (p & 31));
    }
    this.count++;
  }
  has(key) {
    const pos = this.hash.positions(key, this._scratch);
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i];
      if ((this.words[p >>> 5] & (1 << (p & 31))) === 0) return false;
    }
    return true;
  }
  remove() { throw new Error('普通布隆过滤器不支持删除'); }
  reset() { this.words.fill(0); this.count = 0; }
  bitsSet() {
    let s = 0;
    const w = this.words;
    for (let i = 0; i < w.length; i++) {
      let v = w[i];
      v = v - ((v >>> 1) & 0x55555555);
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
      s += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    }
    return s;
  }
  fillRate() { return this.bitsSet() / this.m; }
  memoryBytes() { return this.words.byteLength; }
}

class CountingBloomFilter {
  constructor(m, k, seeds, maxCounter = 255) {
    this.hash = new HashFamily(m, k, seeds);
    this.m = m;
    this.k = k;
    this.counters = new Uint8Array(m); // 每位一个 8bit 计数器
    this.maxCounter = maxCounter;
    this.count = 0;
    this.overflows = 0; // 计数溢出（饱和）次数
    this._scratch = new Uint32Array(k);
  }
  add(key) {
    const pos = this.hash.positions(key, this._scratch);
    const c = this.counters;
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i];
      if (c[p] >= this.maxCounter) {
        this.overflows++; // 溢出处理：饱和不计数，避免回绕破坏其他元素
      } else {
        c[p]++;
      }
    }
    this.count++;
  }
  has(key) {
    const pos = this.hash.positions(key, this._scratch);
    const c = this.counters;
    for (let i = 0; i < pos.length; i++) {
      if (c[pos[i]] === 0) return false;
    }
    return true;
  }
  // 安全删除：先验证成员存在，再递减计数，避免误删破坏其他元素
  remove(key) {
    if (!this.has(key)) return false;
    const pos = this.hash.positions(key, this._scratch);
    const c = this.counters;
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i];
      if (c[p] > 0) c[p]--;
    }
    this.count--;
    return true;
  }
  reset() { this.counters.fill(0); this.count = 0; this.overflows = 0; }
  slotsUsed() {
    let s = 0;
    const c = this.counters;
    for (let i = 0; i < c.length; i++) if (c[i] !== 0) s++;
    return s;
  }
  fillRate() { return this.slotsUsed() / this.m; }
  memoryBytes() { return this.counters.byteLength; }
}

// 理论误判率: (1 - e^(-kn/m))^k
function theoreticalFPR(m, k, n) {
  if (m <= 0 || n < 0) return 0;
  return Math.pow(1 - Math.exp(-k * n / m), k);
}
// 最优哈希个数: k* = (m/n) * ln2
function optimalK(m, n) {
  return n > 0 ? Math.max(1, Math.round((m / n) * Math.LN2)) : 1;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BloomFilter, CountingBloomFilter, HashFamily, fnv1a, makeSeeds, theoreticalFPR, optimalK };
}
