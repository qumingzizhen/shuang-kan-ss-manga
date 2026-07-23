# 词条翻译与跨站对齐

项目使用 [EhTagTranslation Database](https://github.com/EhTagTranslation/Database)
作为 E-Hentai 标准词条和中文名称的基础数据，同时维护各漫画来源自己的真实词条。
不能确认语义完全相同的词条不会通过模糊匹配强行合并。

## 当前覆盖情况

18comic 词表来自 JM API 返回的真实 `album.tags`。当前快照抽样了 600 部漫画：

- 成功读取：600/600
- 不同词条：409
- 词条出现次数：3,096
- 可安全解析并发送给 18comic：409/409（100%）
- 按出现次数计算的解析覆盖：3,096/3,096（100%）
- 确认可与 E-Hentai 共用语义的词条：97 个，共覆盖 1,950 次出现
- 其余 312 个保留为 18comic 专用词条，不会被错误翻译成另一个站的标签

这里的“专用词条”主要包括“韩漫、连载中、剧情向、禁漫书库、C93”等。
E-Hentai 没有完全等价的分类时，系统保留 18comic 原词；用户仍可用中文输入、选择和搜索，
但不会把它伪装成一个含义不同的 E-Hentai 标签。

机器可读报告位于：
`config/tag-vocabularies/alignment-report.json`。
检查脚本会强制要求唯一词条和出现频次的安全解析覆盖率都不低于 90%。

## 搜索时如何解析

- E-Hentai：发送规范英文词条，例如 `female:big breasts`。
- 18comic：发送本站实际词条，例如 `巨乳`。
- 中文、英文别名和繁体词都可以触发输入建议。
- 全局禁用词条会同时展开标准词、中文词、别名和来源词，因此两个站返回不同写法时仍能过滤。
- 只有精确简繁匹配或人工确认的映射才能成为跨站同义词；无法确认的词条按来源隔离。

## 更新流程

更新 E-Hentai 基础词典：

```powershell
.\scripts\dev-env.ps1
python .\scripts\update_tag_translations.py
```

重新抽样 18comic 真实词条（需要网络）：

```powershell
python .\scripts\sample_18comic_tags.py --max-albums 600 --workers 4
```

同步来源映射并执行覆盖率审计：

```powershell
python .\scripts\sync_source_tag_mappings.py --minimum-coverage 0.90
python .\scripts\audit_tag_alignment.py --minimum-coverage 0.90
```

人工确认的例外映射放在 `config/source-tag-overrides.json`。重新生成时不会丢失现有
`source_terms`。完整项目检查 `.\scripts\check.ps1` 也会执行对齐审计。

## 数据文件

- `apps/web/src/lib/tag-translations.json`：浏览器使用的统一词典
- `apps/web/src/lib/tag-translations.meta.json`：上游版本和覆盖摘要
- `config/tag-vocabularies/18comic.json`：18comic 实测词表快照
- `config/tag-vocabularies/alignment-report.json`：覆盖率报告
- `config/source-tag-overrides.json`：人工确认映射和明确的来源专用词

## 署名和许可

E-Hentai 中文名称改编自 EhTagTranslation 社区数据库。其数据库文本默认采用
CC BY-NC-SA 3.0，部分命名空间可能有额外条款，具体以上游数据库内说明为准。
生成的词典数据沿用上游条款，与本项目应用程序代码的许可相互独立。

- 上游项目：<https://github.com/EhTagTranslation/Database>
- 发布镜像：<https://github.com/EhTagTranslation/DatabaseReleases>
