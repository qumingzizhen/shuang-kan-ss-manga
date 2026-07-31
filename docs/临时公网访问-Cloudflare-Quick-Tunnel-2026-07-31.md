# 无域名临时公网访问：Cloudflare Quick Tunnel

> 日期：2026-07-31
> 适用场景：项目运行在本机，手机无需安装客户端，直接使用浏览器访问临时 HTTPS 地址。

## 访问链路

```text
手机浏览器
  -> https://随机子域名.trycloudflare.com
  -> Cloudflare Quick Tunnel（默认 HTTP/2）
  -> 本机 http://127.0.0.1:3100
  -> Next.js /v1/** 同源反向代理
  -> 本机 http://127.0.0.1:8080
  -> 本机网络/VPN
  -> 漫画源站
```

公网只暴露前端入口。API、状态数据库和下载目录仍仅在本机使用。手机端是否开启 VPN 不决定源站可达性；真正请求源站的是运行后端的电脑，因此需要电脑侧网络能够访问对应源站。

## 统一启动

在 PowerShell 中执行：

```powershell
cd "<项目目录>"
.\scripts\public-access.ps1
```

该命令现在统一管理三段服务：

1. `public-api.ps1`：后台启动或复用 `127.0.0.1:8080` API，并通过 `/health` 验证。
2. `public-web.ps1`：构建并后台启动 `127.0.0.1:3100` 生产前端。
3. `public-tunnel.ps1`：创建 Cloudflare Quick Tunnel，并验证公网 URL 实际可访问。

不再需要先开一个 `dev.ps1` 窗口来维持 API。API 有独立 PID 和日志，不会因为开发终端关闭而被连带停止。

首次运行会生成 `apps/web/.next-public` 独立生产构建。代码未变化时可以跳过构建：

```powershell
.\scripts\public-access.ps1 -SkipBuild
```

如果后端部署在另一台设备，可传入远程地址。此时脚本不会启动本机 API：

```powershell
.\scripts\public-access.ps1 -BackendApiUrl "http://192.168.1.20:8080"
```

## 状态与关闭

查看 API、前端、隧道和当前临时网址：

```powershell
.\scripts\public-access.ps1 -Status
```

健康状态必须同时满足：

- `Public API is running`
- `Public production web is running`
- `Quick Tunnel is healthy`

关闭三段服务：

```powershell
.\scripts\public-access.ps1 -Stop
```

停止顺序为隧道、前端、API。脚本会核对 PID 对应的可执行文件和命令行，避免误停其他程序。

## 隧道稳定性

Quick Tunnel 默认强制使用 HTTP/2：

```powershell
.\scripts\public-tunnel.ps1 -WebPort 3100 -Protocol http2
```

原因是部分 VPN 或网络环境会让 QUIC 进程继续存活，却持续连接超时。状态检查现在会实际请求公网 URL，不再仅凭 PID 判断。再次运行启动命令时，如果发现旧隧道进程存在但公网 URL 不可达，会只替换该隧道进程，并生成新的随机网址。

需要诊断时仍可显式选择：

```powershell
.\scripts\public-tunnel.ps1 -WebPort 3100 -Protocol auto
.\scripts\public-tunnel.ps1 -WebPort 3100 -Protocol quic
```

## 运行状态与日志

运行状态保存在 Git 已忽略的目录：

```text
.data\public-api
.data\public-web
.data\quick-tunnel
```

主要日志：

```text
.data\public-api\api.stdout.log
.data\public-api\api.stderr.log
.data\public-web\next.stdout.log
.data\public-web\next.stderr.log
.data\quick-tunnel\cloudflared.stderr.log
```

## 常见问题

### 页面显示“离线”

先执行：

```powershell
.\scripts\public-access.ps1 -Status
```

如果 API 停止，重新执行统一启动命令即可。过去只启动前端与隧道、API 随 `dev.ps1` 终端退出，是页面能打开但显示离线的根因；该生命周期缺口现已修复。

### 隧道 PID 存在，但手机打不开

如果状态显示 `public URL is unreachable`，再次执行：

```powershell
.\scripts\public-access.ps1 -SkipBuild
```

脚本会保留 API 和前端，只替换失效隧道。新的随机网址与旧网址不同。

### 页面能打开，但搜索失败

依次检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8080/health
Invoke-RestMethod http://127.0.0.1:8080/v1/sources
```

然后查看 `.data\public-api\api.stderr.log`。源站可达性取决于运行后端的电脑网络，不取决于手机网络。

### 访问权限

当前按需求不提供登录。任何拿到临时网址的人都可以访问，因此不要把网址提交到 Git、README、Issue 或公开群聊。Quick Tunnel 没有固定域名和可用性保证，电脑关机、休眠、断网或停止脚本都会中断访问。
