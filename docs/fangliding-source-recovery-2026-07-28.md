# Fangliding 来源恢复记录

> 日期：2026-07-28

> 影响范围：`fangliding` 搜索、图库详情和整本下载共同使用的旧请求客户端初始化链路。

## 故障现象

近期搜索任务中的 Fangliding 来源单独失败，其余来源仍能返回结果。最新来源错误为：

```text
argument should be a str or an os.PathLike object where __fspath__ returns a str, not 'NoneType'
```

历史记录中还出现过源站返回 HTTP 403 后切换 `curl_cffi`，以及上游临时返回 HTTP 502 的情况。此次持续不可用的直接原因不是搜索参数或页面解析，而是本地请求客户端尚未发起网络请求就因空路径退出。

## 根因

Fangliding 桥接器调用旧下载器时，`FANGLIDING_CURL_CA_BUNDLE` 没有配置会得到 `None`。旧下载器在自动启用 `curl_cffi` 时直接执行：

```python
Path(args.curl_ca_bundle).expanduser()
```

因此触发 `Path(None)`。项目位于中文路径时，`curl_cffi` 又需要一个纯英文 CA 文件路径，不能简单改成项目根目录下的固定文件。

## 修复方案

修复位于项目内的 `scripts/fangliding_bridge.py`，没有修改来源接口、任务入参、业务流程或输出结构：

1. 显式配置 `FANGLIDING_CURL_CA_BUNDLE` 时继续保留原值；
2. 未配置时，优先选择当前工作目录下的 `.cache/tmp`；
3. 当前目录包含非 ASCII 字符时，回退到系统临时目录；
4. 只接受纯英文路径，所有候选均不满足时返回可操作的配置错误；
5. 仍由旧客户端下载并维护 CA 文件，桥接器只负责提供合法路径。

该处理集中在桥接边界，避免把路径兼容逻辑复制到搜索、图库和下载三个业务函数中。

## 回归覆盖

`scripts/check_fangliding_pagination.py` 现同时验证：

- 未配置 CA 路径时不会返回空值；
- 自动路径只包含 ASCII 字符；
- CA 文件名稳定；
- 搜索分页仍按原有页码规则执行。

此外使用无敏感含义的测试关键词完成了两级真实回归：

1. 直接运行 Python 桥接器，确认 HTTP 403 后可以切换 `curl_cffi` 并返回结果；
2. 启动隔离的开发 API，通过 `POST /v1/tasks/search` 创建 Fangliding 单源任务，任务完成且 `source_errors` 为零。

## 运维提示

正常使用无需新增配置。只有系统临时目录也包含非 ASCII 字符或不可写时，才需要手动指定：

```powershell
$env:FANGLIDING_CURL_CA_BUNDLE = "E:\MangaDevCache\fangliding-ca.pem"
```

该文件只保存公共 CA 证书，不包含 Cookie、账号或来源认证信息，可以放在缓存目录；不要把浏览器请求头、Cookie 或私有链接写入公开仓库。
