# Fangliding 匿名访问契约修正

> 日期：2026-07-31

## 结论

Fangliding 公共页面无需登录。控制台曾显示“浏览器会话”配置，是源站注册表把一次临时 403 错误建模成认证能力造成的，并非站点真实要求。

## 代码修正

- `config/source-adapters.json` 删除 Fangliding 的 `auth` 元数据，并将适配器版本更新为 `0.4.2`。
- 通用认证管理器和 `SourceAuthPanel` 保留，继续服务确实声明可选认证能力的来源；不增加 Fangliding 专用判断。
- `scripts/fangliding_bridge.py` 保留 Cookie/请求头环境别名作为运维级覆盖能力，但它们不参与默认搜索，也不会暴露在普通用户界面。
- `scripts/check_source_auth.mjs` 固化契约：Fangliding 必须是 `auth: null`、`available_for_default: true`，同时验证 18comic 的可选认证声明仍然有效。
- `scripts/check_public_repo.py` 同时扫描已跟踪文件与未被 Git 忽略的新文件，防止新文档在首次提交前绕过本机隐私检查。

## 用户行为

选择 Fangliding 或“全部可用源站一起爬取”后可以直接搜索、查看详情、在线阅读和下载，无需配置账号、Cookie 或请求头。临时 403、超时或站点不可达应显示为来源可用性错误，不能提示成需要登录。

## 生效方式

源站注册表由 API 进程启动时加载。修改后执行：

```powershell
cd "<项目目录>"
.\scripts\dev.ps1 -Fresh
```

这只会重启项目的 3000/8080 服务，不会重启电脑。

## 验收命令

```powershell
python .\scripts\check_source_adapters.py
node .\scripts\check_source_auth.mjs
python .\scripts\check_fangliding_pagination.py
python .\scripts\check_fangliding_reader.py
python .\scripts\run_source_adapter_self_tests.py
npm --prefix .\apps\web run lint
npm --prefix .\apps\web run test
```
