# 安全与隐私

如果发现安全漏洞，请使用 GitHub 的私密安全公告（Private Security Advisory）
功能报告。请勿在公开 Issue 中提交 Cookie、请求头、访问令牌、已下载内容、
私有漫画地址或服务器凭据。

发布或推送代码前，请运行：

```text
python scripts/check_public_repo.py
```

运行凭据应保存在已被 Git 忽略的本地 `.env` 文件中，或交由部署环境的密钥管理器
保存。`.data`、`.cache`、`.tools`、`.private`、源站认证目录以及文档渲染检查目录
中的文件必须只保留在本地。
