# 无域名临时公网访问：Cloudflare Quick Tunnel

> 日期：2026-07-31
> 适用场景：本机运行项目，手机不安装客户端，直接通过浏览器访问临时 HTTPS 地址。

## 访问链路

```text
手机浏览器
  -> https://随机子域名.trycloudflare.com
  -> Cloudflare Quick Tunnel
  -> 本机 http://127.0.0.1:3000
  -> Next.js /v1/** 同源反向代理
  -> 本机 http://127.0.0.1:8080
  -> 本机 VPN
  -> 漫画源
```

只对外转发 Web 端口 `3000`。开发 API、数据库、Redis、NATS、MinIO
等端口仍然只在本机使用。

## 当前工具

Windows x64 版 `cloudflared` 保存在：

```text
E:\Programs\Cloudflared\cloudflared.exe
```

首次配置使用的版本为 `2026.7.3`，下载后已对照 GitHub Release
提供的 SHA-256：

```text
8635da433b6df8194746e88ed9d2589566c20e38bfc2a80e431a348b7c765841
```

该程序是独立可执行文件，不安装服务、驱动或开机启动项。

## 启动

打开第一个 PowerShell 窗口，启动本地开发环境和 API：

```powershell
cd "<项目目录>"
.\scripts\dev.ps1 -Fresh
```

保持该窗口开启。确认 `http://127.0.0.1:8080/health` 可以访问后，再打开第二个
PowerShell 窗口，启动独立生产前端和隧道：

```powershell
cd "<项目目录>"
.\scripts\public-access.ps1
```

首次运行会在 `apps/web/.next-public` 创建独立生产构建，然后由 `3100` 端口提供公网源站。
该目录不会覆盖本地开发使用的 `.next`，也不会提交到 Git。后续代码没有变动时可跳过构建：

```powershell
.\scripts\public-access.ps1 -SkipBuild
```

不要把开发服务器 `3000` 端口直接暴露到公网。开发版包含 Turbopack/HMR 脚本，移动网络下加载慢且可能无法完成客户端水合。

脚本会输出类似下面的临时地址：

```text
https://random-words.trycloudflare.com
```

手机直接在浏览器打开该地址即可。

## 页面连接状态

页面会分别检测普通 API 与任务实时事件流：

- `实时`：API 与 SSE 事件流均可用；
- `在线 · 轮询`：API 正常，但当前隧道无法稳定传输 SSE，页面每 4 秒自动刷新任务；
- `离线`：任务 API 确实不可达，页面每 6 秒自动探测恢复。

因此，手机通过 Quick Tunnel 访问时看到“在线 · 轮询”属于正常降级，搜索、下载、阅读和文件库仍走同源 `/v1/**` 反向代理。浏览器会继续尝试恢复 SSE，成功后自动切回“实时”。
## 状态与关闭

查看生产前端、隧道状态和网址：

```powershell
.\scripts\public-access.ps1 -Status
```

同时关闭生产前端和隧道：

```powershell
.\scripts\public-access.ps1 -Stop
```

`public-web.ps1` 与 `public-tunnel.ps1` 是底层组件脚本，只在单独排查生产前端或隧道时使用。

关闭后原来的临时网址立即失效。再次启动会生成新的随机网址。

运行状态、PID、网址与日志保存在 Git 已忽略的目录：

```text
.data\public-web
.data\quick-tunnel
```

脚本关闭进程前会校验 PID 对应的可执行文件与启动命令，避免误杀其他程序。

## 使用边界

- 当前按使用者要求不配置登录。任何拿到临时网址的人都可以访问。
- 不要把临时网址发布到公开群聊、论坛、GitHub Issue 或 README。
- 项目、本机 VPN 和 Quick Tunnel 必须同时保持运行。
- 电脑关机、休眠、断网、切换网络或关闭隧道都会中断访问。
- Quick Tunnel 用于临时测试，不保证固定域名、长期在线或大文件下载稳定性。
- 漫画搜索和图片下载仍由本机后端发起，手机的网络或 VPN 不决定源站可达性。
- 本地 Cookie、请求头、下载内容和隧道运行状态不会提交到 GitHub。

## 常见问题

### 手机打开显示 502

本机 `3000` 端口没有正常运行。检查第一个 PowerShell 窗口，并在本机打开：

```text
http://127.0.0.1:3000
```

### 页面能打开，但搜索失败

检查本机 API：

```text
http://127.0.0.1:8080/health
```

同时确认本机 VPN 节点可以访问对应漫画源。

### 找不到 cloudflared

确认文件存在：

```powershell
Test-Path "E:\Programs\Cloudflared\cloudflared.exe"
```

也可以在非默认位置运行：

```powershell
.\scripts\public-tunnel.ps1 -CloudflaredPath "E:\其他目录\cloudflared.exe"
```
