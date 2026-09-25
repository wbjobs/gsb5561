# 布隆过滤器对比工具

普通布隆过滤器 vs 计数布隆过滤器的可视化对比工具。

## 运行

```bash
cd bloom-compare
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

（必须通过 HTTP 访问，Web Worker 不支持 file:// 协议。）

## 测试

```bash
node test.js   # 17 项正确性测试：误判率 vs 理论值、删除完整性、边界、溢出
```

## 功能

- **两种过滤器**：普通（位压缩 Uint32Array，m/8 字节）/ 计数（Uint8Array 计数器，m 字节）
- **可配置**：位数组大小 m、哈希函数个数 k（1~32）、插入数量 n
- **操作**：插入、查询（误判率测试）、删除（仅计数布隆，先验成员再递减，不破坏其他元素）、重置、取消
- **统计**：实测/理论误判率、空间占用、填充率、插入/查询吞吐、计数溢出次数
- **可视化**：Canvas 热力图实时展示位数组填充分布

## 技术要点

- **Web Worker**：全部插入/查询/删除在 Worker 分块执行（每块 5 万条，块间让出事件循环），主线程零阻塞，支持中途取消
- **TypedArray**：`Uint32Array` 位压缩 + `Uint8Array` 计数器，插入 100 万条仅占 m/8 ~ m 字节
- **Web Crypto**：`crypto.getRandomValues` 生成哈希种子
- **哈希**：FNV-1a 双哈希 `h_i = (h1 + i·h2) mod m`，步长强制为奇数保证均匀覆盖；`>>> 0` + 取模保证位索引边界
- **溢出处理**：计数器 255 饱和不回绕，溢出次数单独统计
- **理论对比**：误判率 `(1 - e^(-kn/m))^k`，并给出最优 k 建议 `(m/n)·ln2`

## 文件

| 文件 | 说明 |
|---|---|
| `bloom.js` | 过滤器核心实现（Worker 与 Node 测试共用） |
| `worker.js` | Web Worker：分块执行、进度上报、网格聚合 |
| `main.js` | UI 逻辑、统计表、Canvas 渲染 |
| `index.html` | 页面布局与样式 |
| `test.js` | Node 正确性测试 |
