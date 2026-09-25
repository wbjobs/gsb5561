/*
 * filters.js — 布隆过滤器核心实现（标准 + 计数），同时被 Web Worker 与 Node 测试复用。
 *
 * 哈希策略：MurmurHash3 (x86_32) 双哈希。
 *   h1 = murmur3(key, seedA), h2 = murmur3(key, seedB) | 1（保证为奇数，覆盖整个位数组）
 *   第 i 个哈希位置: pos_i = (h1 + i * h2) mod m
 * 种子由 Web Crypto (SHA-256) 派生，保证每次初始化哈希函数族随机且独立。
 */
(function (global, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  } else {
    global.BloomLib = mod;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const COUNTER_MAX = 255; // Uint8 计数器上限（饱和处理）

  // ---------- MurmurHash3 x86_32 ----------
  function murmur3_32(str, seed) {
    let h1 = seed >>> 0;
    const c1 = 0xcc9e2d51;
    const c2 = 0x1b873593;
    const len = str.length;
    const nblocks = len >> 2;

    for (let i = 0; i < nblocks; i++) {
      let k1 = (str.charCodeAt(i * 4) & 0xff) |
        ((str.charCodeAt(i * 4 + 1) & 0xff) << 8) |
        ((str.charCodeAt(i * 4 + 2) & 0xff) << 16) |
        ((str.charCodeAt(i * 4 + 3) & 0xff) << 24);
      k1 = Math.imul(k1, c1);
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = Math.imul(k1, c2);
      h1 ^= k1;
      h1 = (h1 << 13) | (h1 >>> 19);
      h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
    }

    let k1 = 0;
    const tail = nblocks * 4;
    switch (len & 3) {
      case 3: k1 ^= (str.charCodeAt(tail + 2) & 0xff) << 16; // falls through
      case 2: k1 ^= (str.charCodeAt(tail + 1) & 0xff) << 8;  // falls through
      case 1:
        k1 ^= str.charCodeAt(tail) & 0xff;
        k1 = Math.imul(k1, c1);
        k1 = (k1 << 15) | (k1 >>> 17);
        k1 = Math.imul(k1, c2);
        h1 ^= k1;
    }

    h1 ^= len;
    h1 ^= h1 >>> 16;
    h1 = Math.imul(h1, 0x85ebca6b);
    h1 ^= h1 >>> 13;
    h1 = Math.imul(h1, 0xc2b2ae35);
    h1 ^= h1 >>> 16;
    return h1 >>> 0;
  }

  // ---------- 种子派生（Web Crypto，带降级） ----------
  async function deriveSeeds(label) {
    const out = new Uint32Array(2);
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle) {
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode('bloom-filter-seeds:' + label + ':' + Date.now())
        );
        const view = new DataView(digest);
        out[0] = view.getUint32(0);
        out[1] = view.getUint32(4);
        return out;
      }
    } catch (e) { /* 降级到 getRandomValues */ }
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(out);
    } else {
      out[0] = (Math.random() * 0xffffffff) >>> 0;
      out[1] = (Math.random() * 0xffffffff) >>> 0;
    }
    return out;
  }

  // ---------- 双哈希位置生成 ----------
  function makePositionFn(m, seedA, seedB) {
    return function positions(key, k, out) {
      const h1 = murmur3_32(key, seedA);
      let h2 = murmur3_32(key, seedB);
      h2 = (h2 | 1) >>> 0; // 奇数步长，保证遍历整个位数组
      for (let i = 0; i < k; i++) {
        // h1 + i*h2 < 2^32 + 64*2^32，远在 double 精度安全范围内
        out[i] = (h1 + i * h2) % m;
      }
      return out;
    };
  }

  // ---------- 标准布隆过滤器（Uint8Array 位图） ----------
  class BloomFilter {
    constructor(m, k, seeds) {
      this.m = m;
      this.k = k;
      this.bits = new Uint8Array((m + 7) >>> 3);
      this.setBits = 0;
      this.inserted = 0;
      this._pos = makePositionFn(m, seeds[0], seeds[1]);
      this._buf = new Uint32Array(k);
    }
    add(key) {
      const pos = this._pos(key, this.k, this._buf);
      for (let i = 0; i < this.k; i++) {
        const p = pos[i];
        const byte = p >>> 3;
        const mask = 1 << (p & 7);
        if (!(this.bits[byte] & mask)) this.setBits++;
        this.bits[byte] |= mask;
      }
      this.inserted++;
    }
    has(key) {
      const pos = this._pos(key, this.k, this._buf);
      for (let i = 0; i < this.k; i++) {
        const p = pos[i];
        if (!(this.bits[p >>> 3] & (1 << (p & 7)))) return false;
      }
      return true;
    }
    fillRatio() { return this.setBits / this.m; }
    memoryBytes() { return this.bits.byteLength; }
    reset() { this.bits.fill(0); this.setBits = 0; this.inserted = 0; }
  }

  // ---------- 计数布隆过滤器（Uint8Array 计数器，255 饱和） ----------
  class CountingBloomFilter {
    constructor(m, k, seeds) {
      this.m = m;
      this.k = k;
      this.counters = new Uint8Array(m);
      this.nonzero = 0;
      this.inserted = 0;
      this.overflows = 0; // 计数溢出（饱和）次数
      this._pos = makePositionFn(m, seeds[0], seeds[1]);
      this._buf = new Uint32Array(k);
    }
    add(key) {
      const pos = this._pos(key, this.k, this._buf);
      for (let i = 0; i < this.k; i++) {
        const p = pos[i];
        const c = this.counters[p];
        if (c === 0) { this.counters[p] = 1; this.nonzero++; }
        else if (c < COUNTER_MAX) { this.counters[p] = c + 1; }
        else { this.overflows++; } // 饱和：不再递增，防止回绕破坏其他元素
      }
      this.inserted++;
    }
    has(key) {
      const pos = this._pos(key, this.k, this._buf);
      for (let i = 0; i < this.k; i++) {
        if (this.counters[pos[i]] === 0) return false;
      }
      return true;
    }
    // 删除前先确认成员存在，避免误删破坏其他元素的计数
    remove(key) {
      if (!this.has(key)) return false;
      const pos = this._pos(key, this.k, this._buf);
      for (let i = 0; i < this.k; i++) {
        const p = pos[i];
        const c = this.counters[p];
        if (c > 0 && c < COUNTER_MAX) {
          this.counters[p] = c - 1;
          if (c === 1) this.nonzero--;
        }
        // c === COUNTER_MAX（曾饱和）时不递减：无法确定真实计数，保守保留
      }
      this.inserted--;
      return true;
    }
    fillRatio() { return this.nonzero / this.m; }
    memoryBytes() { return this.counters.byteLength; }
    reset() { this.counters.fill(0); this.nonzero = 0; this.inserted = 0; this.overflows = 0; }
  }

  // ---------- 理论误判率 ----------
  // p = (1 - e^(-kn/m))^k
  function theoreticalFPR(m, k, n) {
    if (m <= 0 || n <= 0) return 0;
    return Math.pow(1 - Math.exp((-k * n) / m), k);
  }

  // 最优哈希个数 k* = (m/n) * ln2
  function optimalK(m, n) {
    if (n <= 0) return 1;
    return Math.max(1, Math.round((m / n) * Math.LN2));
  }

  // ---------- 位数组密度采样（用于 Canvas 可视化） ----------
  // 将位数组聚合为 buckets 个桶，每桶 0~255 表示填充密度
  const POPCOUNT = new Uint8Array(256);
  for (let i = 1; i < 256; i++) POPCOUNT[i] = POPCOUNT[i >> 1] + (i & 1);

  function densityBuckets(filter, buckets) {
    const out = new Uint8Array(buckets);
    if (filter instanceof BloomFilter) {
      const bytes = filter.bits;
      const perBucket = bytes.length / buckets;
      for (let b = 0; b < buckets; b++) {
        const start = Math.floor(b * perBucket);
        const end = Math.max(start + 1, Math.floor((b + 1) * perBucket));
        let ones = 0;
        for (let i = start; i < end && i < bytes.length; i++) ones += POPCOUNT[bytes[i]];
        out[b] = Math.round((ones / ((end - start) * 8)) * 255);
      }
    } else {
      const counters = filter.counters;
      const perBucket = counters.length / buckets;
      for (let b = 0; b < buckets; b++) {
        const start = Math.floor(b * perBucket);
        const end = Math.max(start + 1, Math.floor((b + 1) * perBucket));
        let nz = 0;
        for (let i = start; i < end && i < counters.length; i++) if (counters[i] > 0) nz++;
        out[b] = Math.round((nz / (end - start)) * 255);
      }
    }
    return out;
  }

  return {
    BloomFilter,
    CountingBloomFilter,
    deriveSeeds,
    theoreticalFPR,
    optimalK,
    densityBuckets,
    murmur3_32,
    COUNTER_MAX,
  };
});
