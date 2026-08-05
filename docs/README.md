# 文档索引

> 本文档是 `docs/` 目录的索引与维护约定。按主题分类，新增或删除文档后请同步更新本页与根目录 `README.md` 的「相关文档」清单。

## 架构与总体设计

- [系统架构](architecture.md) —— Rust / Node / Python 分层职责与优化后的运行链路
- [项目架构与数据库设计](项目架构与数据库设计.md) —— Web/App 共用后端、源站适配器与 PostgreSQL/Redis/对象存储设计
- [技术栈](stack.md) —— 各层组件选型速览
- [架构决策记录](decisions.md) —— ADR 形式的决策历史
- [客户端策略](client-strategy.md) —— Web 优先策略
- [路线图](roadmap.md) —— 分阶段实施计划与完成状态
- [持久化设计](persistence.md) —— 任务仓储的两种运行模式
- [任务队列](task-queue.md) —— 队列契约与 NATS 规划
- [任务生命周期](task-lifecycle.md) —— 状态机与事件约定
- [任务输出契约](task-output.md) —— 任务完成后的持久化结果结构
- [开发 API 说明](dev-api-shim.md) —— 本地 Node.js 开发 API 的职责与边界
- [公开发布与隐私边界](public-release.md) —— 公开仓库允许/禁止的内容

## 功能模块

- [源站适配器](source-adapters.md) —— 统一适配器注册、能力声明与新增来源指南
- [文件库设计](file-library.md) —— 本地下载内容的只读库存层
- [标签中文映射](tag-translations.md) —— 词条翻译与跨站对齐
- [控制台功能实施规划](console-feature-plan.md) —— 控制台左侧功能与基础设施实施计划
- [连接状态与任务更新降级设计](连接状态与任务更新降级设计-2026-07-31.md) —— 前端连接状态、任务实时更新与公网隧道兼容

## 重构与优化记录

- [工程化优化实施计划与性能基线](engineering-optimization-plan-2026-07-26.md) —— 工程化阶段目标与性能量化基线
- [文档优化执行矩阵](文档优化执行矩阵-2026-07-28.md) —— 121 条建议转成的 P0/P1/P2 任务矩阵
- [优化实施与验收报告](优化实施与验收报告-2026-07-28.md) —— P0/P1 轮实施结论（[LaTeX 源码](优化实施与验收报告-2026-07-28.tex)）
- [代码结构与可复用性审查](代码结构与可复用性审查.md) —— 2026-06 代码结构审查结论
- [抽象复用问题整改与验收](抽象复用问题整改与验收-2026-07-29.md) —— 高优先级问题整改与验收报告
- [搜索结果与封面链路重构说明](search-thumbnail-refactor-2026-07-25.md)
- [搜索结果信息分层与跨来源排序说明](search-result-hierarchy-and-sorting-2026-07-26.md)
- [全来源搜索链路与 Fangliding 结果解析重构](unified-search-pipeline-refactor-2026-07-28.md)
- [任务详情抽屉组件拆分说明](task-detail-drawer-refactor-2026-07-27.md)
- [最近在线阅读组件拆分说明](remote-reader-history-refactor-2026-07-27.md)
- [在线阅读首图提速说明](在线阅读首图提速-2026-08-02.md) — 建会话只抓首页索引、首图后台预热、页列表惰性补全与短时复用
- [在线阅读加载提速-实施方案-2026-08-02.md](在线阅读加载提速-实施方案-2026-08-02.md) — 读图转码、缓存治理、后台页列表扩展
- [长期大规模优化计划-2026-08-05.md](长期大规模优化计划-2026-08-05.md) — 六个阶段滚动路线图，涵盖可观测/阅读器/爬取/存储/部署
- [性能基线台账-2026-08-05.md](性能基线台账-2026-08-05.md) — 阅读/下载/内存 KPI 与更新规则

## 来源恢复与故障记录

- [Fangliding 来源恢复记录](fangliding-source-recovery-2026-07-28.md)
- [Fangliding 公开访问 403 诊断与会话修复](fangliding-403诊断与会话修复-2026-07-29.md)
- [Fangliding 匿名访问契约修正](fangliding-匿名访问修正-2026-07-31.md)
- [Fangliding 真实访问链路修复](fangliding-真实访问链路修复-2026-07-31.md)

## 部署与运维

- [跨设备同源反向代理部署指南](跨设备反向代理部署-2026-07-29.md) —— Next.js/Nginx 同源转发与验证
- [无域名临时公网访问：Cloudflare Quick Tunnel](临时公网访问-Cloudflare-Quick-Tunnel-2026-07-31.md) —— 手机/异地浏览器临时访问

## 文档资产

- [项目功能变更记录.docx](项目功能变更记录.docx) —— 功能变更日志（Word 导出）
- [项目架构与数据库设计.docx](项目架构与数据库设计.docx) —— 架构设计文档（Word 导出）
- [project-feature-log-next.docx](project-feature-log-next.docx) —— 功能日志草稿（历史资产）
- [design-render-contact-sheet.png](design-render-contact-sheet.png) —— Word 渲染 QA 图
- [feature-log-render-contact-sheet.png](feature-log-render-contact-sheet.png) —— Word 渲染 QA 图

## 维护约定

- **命名**：Markdown 文档使用小写 kebab-case；含中文标题的文档保留中文，但统一小写（如 `fangliding-真实访问链路修复-2026-07-31.md`）。带日期的记录统一使用 `名称-YYYY-MM-DD.md` 后缀。
- **过程文档 vs 稳定文档**：重构、修复记录属于过程文档，结论应及时同步进稳定文档（`architecture.md`、`source-adapters.md` 等）；README「相关文档」只列稳定文档与近期记录，完整清单看本索引。
- **资产**：渲染 QA 图片与 Word/LaTeX 导出件属于文档资产，直接放在 `docs/` 下；公开仓库隐私扫描会放行 `docs/*render*.png`。
- **增删流程**：新增文档后更新本索引；删除或改名文档前先搜索仓库引用（`rg "docs/…"`），并同步更新所有链接。