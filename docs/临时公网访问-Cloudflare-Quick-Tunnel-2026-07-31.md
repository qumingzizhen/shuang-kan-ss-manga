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

打开第一个 PowerShell 窗口：

```powershell
cd "<项目目录>"
.\scripts\dev.ps1 -Fresh
```

保持该窗口开启。确认 `http://127.0.0.1:3000` 可以访问后，再打开第二个
PowerShell 窗口：

```powershell
cd "<项目目录>"
.\scripts\public-tunnel.ps1
```

脚本会输出类似下面的临时地址：

```text
https://random-words.trycloudflare.com
```

手机直接在浏览器打开该地址即可。

## 状态与关闭

查看当前隧道状态和网址：

```powershell
.\scripts\public-tunnel.ps1 -Status
```

关闭隧道：

```powershell
.\scripts\public-tunnel.ps1 -Stop
```

关闭后原来的临时网址立即失效。再次启动会生成新的随机网址。

运行状态、PID、网址与日志保存在 Git 已忽略的目录：

```text
.data\quick-tunnel
```

脚本关闭进程前会校验 PID 对应的可执行文件路径，避免误杀其他程序。

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
