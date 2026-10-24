# 记忆之树（dsh-memory-tree）

给 DeepSeek Harness 加一份**看得见**的记忆。

它读 DSH 本来就在写的会话日志，存成本地 SQLite，按时间让它淡忘，最后画成一棵树：
**年 → 月 → 周 → 日**，点进去能看到那天你到底说了什么。

全部在本机跑，没有服务、没有 API 调用、画树的链路里没有模型。

![树](docs/tree-demo.png)

## 它到底做什么

| 层 | 做什么 |
|---|---|
| **采集** | 扫 `~/.dsh/sessions/**/*.jsonl.zstd`，多帧 zstd 解压，只留你、助手、工具调用，丢掉系统注入。增量：没变的文件跳过。 |
| **索引** | 词 → 哪一天；加上日 / 周 / 月卡片。检索先答"哪几天"，再只在那几天里读原文。 |
| **淡忘** | 每天算显著度（说了多少、话题重复多少、有没有里程碑、有没有立规矩），按分位数分深刻 / 普通 / 淡忘。过期原文搬进冷存，只有淡忘档会真删，而且每次都留墓碑。 |
| **速览** | 十行摘要写进 `~/.dsh/AGENTS.md`，DSH 每个新会话自动加载。 |
| **树** | 树干是年，四条粗根是月份分组，月分周、周分日。深刻的日子是金色带 ★，淡忘的压暗。点一天看那天的原文。 |

## 要求

- 支持第三方插件的 DeepSeek Harness（Profile / bundle 那套）。
- **Node.js ≥ 22.5**——记忆库用的是内置 `node:sqlite`。

没有原生模块，没有构建步骤。

## 安装

用插件管理器从这个目录安装这个 bundle，或者在跑着的 Harness 里直接说「安装这个目录的
bundle」。不用构建，也不用额外下载。

装好后会话标题旁边会出现 **记忆之树** 按钮，点开在中间面板显示。首次使用会自动建
`~/.dsh/memory`、放三份默认配置、后台跑一次采集；页面生成完自己刷新。

**已经有记忆库在别处？**第一次运行前先把 `memoryDir` 指过去（见下），否则插件会在默认
位置另起一个空库。

## 配置

在 profile 的 patch 里给这个 bundle 传 `config`：

```yaml
- id: dsh-memory-tree
  name: dsh-memory-tree
  config:
    memoryDir: ~/.dsh/memory     # 库、卡片、网页都在这
    refreshMinutes: 15           # 0 就是关掉定时刷新
    digest: true                 # 是否把十行速览写进 ~/.dsh/AGENTS.md
    sessionsDir: ~/.dsh/sessions # 只有日志不在默认位置时才要填
```

`memoryDir` 第一次会被放进去三份文件，之后不会覆盖：

- `profile.json`：你的身份和规矩（手写，速览从这取）
- `decay.json`：半衰期和保留期
- `sources.json`：不采集哪些会话

## 页面

![根](docs/roots.png)

- 点树干 → 长出根系；点月 → 分会；点周 → 分日；点日 → 右侧看那天的原文。
- 有小光点从根尖往树干爬，那是"记忆被抽上去"的动效。
- 深刻 / 普通 / 淡忘：金色 / 灰蓝 / 暗灰，深刻的带 ★。
- `?demo=1` 或标题下的按钮切到一份冻结的 12 个月演示样本，方便给别人演示而不暴露真实记忆。
- 直达链接：`#L1` 根系、`#L2` 周、`#L3` 日、`#V` 全览、`#T` 今天。

## 命令行

```bash
node src/query.mjs status                 # 条数、跨度、最后采集时间
node src/query.mjs find "手柄"             # 哪几天提过，再给那天的原文
node src/query.mjs day 2026-10-24         # 某天的全部
node src/query.mjs remember "周五前交初稿"  # 记一条事实
node src/query.mjs context "帮我看下齿轮"   # 一行够不够得着，够不着就一个字不输出
```

库不在默认位置时设 `DSH_MEMORY_DIR`。

## 隐私

- 全部在本机：SQLite、HTML、日志。
- 唯一写到 `memoryDir` 之外的是 `~/.dsh/AGENTS.md`，而且只替换
  `<!-- MEMORY:AUTO:BEGIN -->` 到 `<!-- MEMORY:AUTO:END -->` 之间那块；`digest: false` 可完全关掉。
- 没有任何网络请求。

## 卸载

插件管理器里移除，然后删 `~/.dsh/memory`（记忆就是它），想从新会话里也去掉就把
`~/.dsh/AGENTS.md` 里那段 `MEMORY:AUTO` 块删掉。

## 已知限制

- `node:sqlite` 还是实验特性，脚本统一加 `--no-warnings`。
- 检索是关键词匹配（中文二元组 + 英文单词），同义说法靠共现词兜底；没有向量检索，也没有
  "上周 / 十月"这类时间解析。
- 周 / 月卡片是机械汇总，没上模型压缩。
- 采集是定时的，最新会话最多滞后 `refreshMinutes`。
- 树是一整张 SVG，攒到十年的日数据迟早要做虚拟化。

## 许可

MIT，见 [LICENSE](LICENSE)。
