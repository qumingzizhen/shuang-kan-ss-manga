# 搜索结果与封面链路重构说明（2026-07-25）

## 1. 兼容性结论

本次重构没有删除、改名或改变任何已有入口、请求参数、业务流程和返回结构：

- `GET /v1/search-thumbnails?source_id&url&referer` 路径、参数和图片响应保持不变。
- `TaskSearchResult.thumbnail_url` 类型与含义保持不变。
- 搜索、选择、批量下载、在线阅读和单项下载流程保持不变。
- “任务控制台、文件库、审核、基础设施”四个导航名称与顺序保留。
- 未新增第三方依赖，继续使用原有 React、Node.js 和项目内并发工具。

新增的 `thumbnail_attempt` 仅是浏览器对同一内部图片代理的缓存破坏参数，服务端忽略该参数，不改变公开契约。

## 2. 背景重叠根因与修复

### 优化前

```css
.detail-body {
  display: grid;
  gap: 16px;
}
```

详情正文没有声明隐式 Grid 行尺寸。搜索卡片实际内容高度大于可用视口时，隐式行被压缩，后续 `Payload / Output` 区域在搜索结果结束前开始绘制。实测修复前：

- 搜索结果网格底部：`1250px`
- 后续技术详情顶部：`1008px`
- 几何顺序断言：失败

抽屉同时使用半透明 `--surface` 和 `backdrop-filter`，进一步放大了底层黑色 JSON 区域的视觉干扰。

### 优化后

```css
.detail-body {
  display: grid;                  /* 保留原有详情布局模型。 */
  gap: 16px;                      /* 保留原有区块间距。 */
  grid-auto-rows: max-content;    /* 隐式行按内容高度排版，禁止后续区块提前覆盖。 */
  background: var(--surface-solid); /* 隔离主页面和详情内容的绘制层。 */
}
```

原始输入和输出改为默认折叠的 `TaskTechnicalDetails`。组件关闭时不创建 `<pre>`，也不执行两次大对象 `JSON.stringify`；只有排障人员主动展开时才生成内容，关闭后立即卸载。

实测修复后：

- 搜索结果网格底部：`1250px`
- 加载哨兵底部：`1324px`
- 技术详情顶部：`1340px`
- 几何顺序断言：通过
- 默认原始 JSON DOM：`2 → 0`

## 3. 封面加载链路

### 优化前

```tsx
onError={(event) => {
  event.currentTarget.hidden = true;
  event.currentTarget.parentElement?.classList.add("empty");
}}
```

第一次请求失败就永久隐藏图片，没有等待、重试或恢复路径。后端单次请求失败后直接返回 `502`；另外 18comic 实际返回的两个 CDN 根域没有进入安全白名单。

### 优化后

```tsx
const nextAttempt = attempt + 1;       // 只增加当前卡片的尝试序号。
if (nextAttempt >= attemptLimit) {     // 达到上限后才进入最终失败态。
  setStatus("failed");                // 不进行无限重试。
  return;
}
setStatus("waiting");                 // 保留加载反馈，不显示永久失败。
retryTimer.current = window.setTimeout(
  () => setStatus("loading"),          // 延时后重新请求同一内部代理。
  retryDelayMs,
);
```

前端状态机为 `missing → loading → waiting → loaded/failed`，采用 `800ms、1800ms` 有界退避，并在组件卸载、URL 变化或加载成功时清理定时器。

后端 `thumbnail-cache.mjs` 负责：

1. 参数与来源 ID 校验。
2. URL、协议、允许域名和公网 DNS 校验。
3. 相同封面的 single-flight 并发合并。
4. `408/425/429/5xx`、网络超时和临时 DNS 失败的最多三次有界重试。
5. 响应类型、体积上限和最小有效图片校验。
6. 临时文件原子写入与失败清理。
7. 小于最小有效体积的旧缓存自动删除并重新拉取。

缓存目录只在整条重试链开始时创建一次；缓存未命中只执行一次 `stat`，不再在 single-flight 外内重复检查。

## 4. CDN 正确性与运行性能

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 18comic 历史封面域名通过安全策略 | 60/130（46.2%） | 130/130（100%） |
| 默认详情页 JSON 序列化 | 每次渲染 2 次 | 关闭时 0 次 |
| 默认详情页原始 JSON DOM | 2 块 | 0 块 |
| Dashboard 主文件 | 4827 行 | 4612 行 |
| dev API 主文件 | 3109 行 | 2932 行 |
| 搜索结果与后续区块几何顺序 | 重叠 | 正常文档流 |

真实匿名 CDN 样本结果：

| 域名类型 | 首次代理 | 本地缓存命中 |
| --- | ---: | ---: |
| 新增白名单 CDN 1 | 200，约 1.16s，48KB | 约 3.1ms |
| 新增白名单 CDN 2 | 200，约 1.56s，52KB | 约 30.1ms（含首次本地连接） |
| 原有 CDN | 200 | 约 1.9–2.8ms |

模块测试模拟两个并发浏览器请求、第一次上游返回 `503`、第二次成功。结果为上游总调用 `2` 次，而不是每个浏览器请求各自重试产生 `4` 次，证明重试链受 single-flight 合并。

## 5. 文件拆分与设计依据

| 文件 | 修改 | 设计依据 |
| --- | --- | --- |
| `search-results.tsx` | 承载无限加载和封面状态机 | 搜索结果展示高内聚，避免 Dashboard 管理图片计时器 |
| `task-technical-details.tsx` | 按需序列化原始任务数据 | 调试能力与业务结果分离，降低初始 DOM 和 CPU 开销 |
| `thumbnail-cache.mjs` | 承载下载、重试、DNS、缓存和原子写入 | HTTP 路由只编排输入输出，底层能力可单测和复用 |
| `thumbnail-policy.mjs` | 集中 URL 清洗和安全策略 | 消除前后函数散落；常量集合只创建一次 |
| `source-adapters.json` | 补充实际 CDN 根域 | 继续采用显式白名单，不使用放开任意域名的危险方案 |
| `globals.css` | 修复 Grid 内容流和不透明隔离 | 从排版模型消除重叠，不依赖提高 z-index 掩盖问题 |

源代码只在 single-flight、按需序列化和安全 referer 等非显而易见边界保留必要注释；逐项修改理由集中记录在本文，避免给每一行重复添加低价值注释形成新的代码噪声。

## 6. 回归结果

- 2048、900、760、600、390px 均无横向溢出。
- 五档宽度下“结果网格 → 加载哨兵 → 技术详情”顺序全部通过。
- 2048px 首批 10 张真实封面全部加载成功。
- 人为把首张图片改为不可连接地址后，状态从 `waiting` 自动恢复为 `loaded`。
- 技术详情展开时出现 2 个 JSON 区块，关闭后恢复为 0。
- 审核、基础设施入口保留，明确禁用并显示“规划中”。
