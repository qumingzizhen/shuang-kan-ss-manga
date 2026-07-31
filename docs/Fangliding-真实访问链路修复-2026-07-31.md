# Fangliding 真实访问链路修复

> 日期：2026-07-31

## 结论

此前仅删除错误的登录配置入口，没有修复真实网络请求，因此不能视为完成。本次基于最新持久化任务、同 URL 请求对照和真实搜索/阅读回归，修复了两处独立断链：

1. 共享 `source_bridge_core.HttpClient` 已支持 `curl_cffi`，但重构后的 E-Hentai 兼容参数层未注册 `http_backend` 与 `impersonate`，Fangliding 实际始终使用 `urllib`，公共搜索页返回 Cloudflare HTTP 403。
2. 页面图片解析器按 DOM 顺序返回所有图片，导航按钮 `/img/f.png` 排在真正的 `img#img` 前面，单页下载错误地取到 841 字节按钮并被完整性校验拒绝。

## 实现

- `scripts/ehentai_bridge.py` 暴露共享 HTTP 传输参数；Fangliding 和 E-Hentai 继续共用搜索、图库、阅读及下载实现。
- `scripts/fangliding_bridge.py` 默认使用 `FANGLIDING_HTTP_BACKEND=auto` 和 `FANGLIDING_IMPERSONATE=chrome124`，仍允许环境变量覆盖。
- `requirements.txt` 锁定项目运行环境已使用的 `curl-cffi==0.15.0`，避免换机或服务器部署后静默退回 `urllib`。
- 页面图片解析优先返回 `id="img"` 的主图；仅在主图不存在时使用已过滤候选，并排除 E-Hentai 兼容页面的导航图标。
- 阻断错误不再提示“提供授权会话”，而是要求检查来源可用性和网络路径；Fangliding 仍为匿名来源。
- 适配器版本更新为 `0.4.3`。

## 真实验收

同一公开搜索 URL 的对照结果：

- `urllib` / 普通 curl：HTTP 403，响应带 `Cf-Mitigated: challenge`。
- 项目已有 `curl_cffi 0.15.0`、`chrome124`：HTTP 200，返回完整搜索页。
- Fangliding 桥接器真实搜索：返回 5 条结果，图库 URL、分类、上传时间、页数和封面均存在。
- 隔离开发 API（18080）单源任务：`status=completed`、`result_count=5`、`source_errors=0`、`failed=0`；服务验收后立即关闭并清理。
- 真实图库阅读：解析 27 页；第一页为 `image/webp`，响应和落盘均为 109,198 字节；临时图片验收后删除。

## 回归保障

`check_fangliding_pagination.py` 固化默认传输后端和匿名错误文案；`check_fangliding_reader.py` 增加导航图标位于主图前后的页面夹具。E-Hentai 自测同时验证共享解析器不会受损。

## 生效方式

源站注册表和桥接进程需要由新的 API 进程加载：

```powershell
cd "<项目目录>"
.\scripts\dev.ps1 -Fresh
```

该命令只重启项目的 3000/8080 服务，不会重启电脑。
