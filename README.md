# 爽看 SS 漫画

[![公开仓库隐私检查](https://github.com/qumingzizhen/shuang-kan-ss-manga/actions/workflows/public-repository-check.yml/badge.svg)](https://github.com/qumingzizhen/shuang-kan-ss-manga/actions/workflows/public-repository-check.yml)

一个本地优先的多源漫画管理平台，提供漫画搜索、标签筛选、批量下载、在线阅读和本地文件库管理功能。

> 本项目不会绕过登录、付费墙、验证码、封禁或其他访问控制。使用者应遵守源站规则和所在地法律法规，并仅访问自己有权使用的内容。

## 主要功能

- 支持 `18comic`、`E-Hentai` 和 Fangliding 等来源，源站能力通过统一适配器注册。
- 支持多源合并搜索、部分源失败隔离、结果去重、封面缓存和下滑自动加载下一页。
- 支持中文标签映射：输入中文词条时可选择对应英文标签。
- 支持全局禁用词条：搜索结果会自动排除标题或标签中包含禁用词的漫画。
- 支持直接链接下载、批量下载、失败页记录、缺页修复和任务重试。
- 支持在线阅读、单双页/连续滚动、邻页预加载、书签和阅读进度保存。
- 支持本地漫画文件库、收藏、阅读状态、备注、健康检查以及 CBZ/PDF 导出。
- 本地 Cookie、请求头、下载文件和运行数据均被排除在公开仓库之外。

## 界面与服务结构

```text
浏览器
  -> Next.js 管理界面（apps/web）
  -> 本地开发 API（services/dev-api）
  -> Python 源站适配桥接（scripts/*_bridge.py）
  -> 本地下载、缓存与文件库（.data）
```

正式后端同时提供 Rust 分层实现：

```text
services/api             Rust Axum API
workers/download         下载任务 Worker
packages/domain          领域模型与任务契约
packages/source-adapter  源站适配器边界
packages/task-queue      任务队列抽象
packages/task-runtime    任务调度与运行时
```

开发 API 用于 Windows 本地直接运行；Rust 服务保留生产部署所需的领域、队列、仓储和 Worker 边界。两条链路使用一致的多源搜索与任务输出契约。

## 快速启动

在 Windows PowerShell 中进入项目目录，然后运行：

```powershell
cd "<项目目录>"
.\scripts\dev.ps1 -Fresh
```

启动完成后打开：

- Web 界面：<http://127.0.0.1:3000>
- 本地 API：<http://127.0.0.1:8080>

启动终端需要保持打开。关闭项目时，在该终端按 `Ctrl+C`。

日常启动时可以省略 `-Fresh`：

```powershell
.\scripts\dev.ps1
```

如果端口已被本项目占用，脚本会复用正在运行的服务；如果希望端口冲突时直接失败，可以运行：

```powershell
.\scripts\dev.ps1 -NoAutoPort
```

## 首次安装依赖

需要预先安装 Node.js 和 Python。首次使用时运行：

```powershell
cd "<项目目录>"
.\scripts\dev-env.ps1
python -m pip install --target .\.cache\python -r .\requirements.txt
npm --prefix .\apps\web install
```

项目会将 npm、Cargo、Rustup 和临时文件放在项目目录的 `.cache` 中，减少对系统盘的占用。中文路径环境下，启动脚本可能临时创建一个 ASCII 映射盘；它只是兼容视图，实际文件仍保存在原项目目录。

## 项目检查

提交代码或排查运行问题前，建议执行统一检查：

```powershell
.\scripts\check.ps1
```

检查范围包括：

- JSON 与源站配置校验
- Node.js 语法和搜索/并发/标签规则回归测试
- Python 桥接脚本编译、自测和下载调度测试
- Rust workspace 格式与编译检查
- Next.js 生产构建与 TypeScript 检查
- 公开仓库敏感信息和隐私文件扫描

该命令只执行检查，不会保持项目运行。

只进行公开仓库隐私扫描：

```powershell
python .\scripts\check_public_repo.py
```

## 来源与搜索

源站统一配置位于 `config/source-adapters.json`。前端通过 `/v1/sources` 获取来源描述，不需要为每个网站硬编码一套界面。

当前搜索链路会：

1. 校验来源是否启用并支持搜索；
2. 在限定并发下搜索多个来源；
3. 按需补全缺失标签；
4. 应用全局禁用词条；
5. 按“来源 + 漫画链接”去重；
6. 返回合并结果及单个来源的错误信息；
7. 在宽屏单行结果列表接近底部时，按页继续请求各来源并追加去重后的结果。

搜索任务默认每批最多获取 40 条候选结果。详情列表初次只渲染 10 行，继续下滑会先分批显示已获取结果，再通过 `POST /v1/tasks/{id}/search-more` 请求下一搜索页，避免一次渲染大量卡片阻塞界面。

18comic 默认优先使用 JM 移动 API，公开网页只作为保守兼容回退。用户可以在本地界面中配置自己有权使用的 Cookie 或请求头；认证信息保存在 `.data/source-auth`，不会提交到 GitHub。

## 阅读与下载

在线阅读器会合并相同页面的并发请求，并限制同时运行的页面桥接进程。连续滚动模式只主动预热当前页附近的少量页面，其余图片交给浏览器懒加载，以降低首次打开和快速翻页时的资源占用。

整本下载使用共享的有界并发调度器，并具备：

- 每个工作线程复用 HTTP 客户端；
- 图片通过临时 `.part` 文件原子写入；
- 下载失败、访问受限和异常小图片明确记录；
- 进度更新节流，避免大画廊频繁写入任务状态；
- 支持限制页数、失败阈值和来源级并发。

常用并发参数可参考 `.env.example`。不建议盲目提高并发，否则可能触发源站限流或封禁。

## 本地数据与隐私

以下目录只用于本地运行，并已被 Git 忽略：

```text
.data      下载内容、阅读缓存、任务记录和来源认证信息
.cache     项目依赖缓存和临时文件
.tools     项目本地工具
.private   私有配置或资料
```

不要把 Cookie、访问令牌、私有漫画链接、服务器密码或下载内容粘贴到公开 Issue。漏洞报告方式请参阅 [安全与隐私说明](SECURITY.md)。

## 相关文档

- [系统架构](docs/architecture.md)
- [源站适配器](docs/source-adapters.md)
- [开发 API 说明](docs/dev-api-shim.md)
- [文件库设计](docs/file-library.md)
- [标签中文映射](docs/tag-translations.md)
- [任务生命周期](docs/task-lifecycle.md)
- [任务输出契约](docs/task-output.md)
- [公开发布与隐私边界](docs/public-release.md)
- [项目架构与数据库设计](docs/项目架构与数据库设计.md)

## 参与开发

新增来源时，应优先复用 `scripts/source_bridge_core.py` 的 HTTP、重试、文件写入和下载调度能力，并在 `config/source-adapters.json` 中声明来源及能力。源站脚本只负责网站特有的 URL、解析和鉴权规则。

提交前请确保 `scripts/check.ps1` 全部通过，并确认工作区中没有本地凭据或下载内容。
