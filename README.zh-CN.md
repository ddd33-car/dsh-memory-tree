# 记忆之树（dsh-memory-tree）

[English](README.md) ｜ **中文**

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

## 五步开始

```text
1. git clone https://github.com/ddd33-car/dsh-memory-tree.git
2. 在跑着的 DSH 里说：安装 <那个目录> 这个 bundle
   （或者在插件管理器里选「从本地目录安装」）
3. 会话标题旁边会出现「记忆之树」按钮，点它。
4. 首次打开会自动建 ~/.dsh/memory，并在后台采集你的会话日志
   （约每 1 万条约 3 秒）；生成完页面自己刷新。
5. 之后每 15 分钟自动刷新一次，面板上的「刷新」按钮可以立刻跑一次。
```

不用构建、不下载任何东西、不需要账号或 API key。

## 要求

- **DeepSeek Harness**，并且支持第三方插件（Profile / bundle 那套）。这是 DSH 插件，不是
  独立应用，页面渲染在 Harness 的 Web UI 里。
- **Node.js ≥ 22.15**——会话日志是 zstd 帧（`zlib.zstdDecompressSync`，22.15 才有），记忆库
  用的是内置 `node:sqlite`（22.5 起）。

没有原生模块，没有构建步骤。

**只在 Windows 11 + DSH Desktop 上实测过。** 代码都是纯 Node（`os.homedir`、`path.join`、
`node:zlib`、`node:sqlite`），macOS 和 Linux 理论上能跑，但我没试——你试了告诉我。

## 安装

```bash
git clone https://github.com/ddd33-car/dsh-memory-tree.git
```

然后用插件管理器把这个目录装成 bundle，或者在跑着的 Harness 里直接说「安装这个目录的
bundle」。不用构建。

装好后会话标题旁边会出现 **记忆之树** 按钮，点开在中间面板显示。首次使用会自动建
`~/.dsh/memory`、放三份默认配置、后台跑一次采集；页面生成完自己刷新。

**已经有记忆库在别处？**第一次运行前先把 `memoryDir` 指过去（见下），否则插件会在默认
位置另起一个空库。

## 配置

在 profile 的 patch 里给这个 bundle 传 `config`；可复制的模板在 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)：

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
- 面板顶部有 **← 返回对话**、**刷新**、**新窗口** 三个按钮。刷新会立刻采集一次再重载页面，
  不用等定时器。
- 有小光点从根尖往树干爬，那是"记忆被抽上去"的动效。
- 深刻 / 普通 / 淡忘：金色 / 灰蓝 / 暗灰，深刻的带 ★。
- `?demo=1` 或标题下的按钮切到一份冻结的 12 个月演示样本，方便给别人演示而不暴露真实记忆。
- **列表视图**：演示按钮下面那个按钮，把树换成按天的平铺总览——统计、未结、记住的事，
  然后每天一行，可以展开看原文。直达链接 `#LV`。
- 直达链接：`#L1` 根系、`#L2` 周、`#L3` 日、`#V` 全览、`#T` 今天。

## 出问题先看这里

| 现象 | 原因 / 怎么办 |
|---|---|
| 面板一直显示「记忆之树还没有生成」 | 采集没跑起来。先查 `node -v` 是否 ≥ 22.15；页面里会带上错误原文，Host 日志里也有。 |
| 按钮根本没出现 | 装上了但没激活。重启 DSH（Host 端插件在启动时挂载，只有前端会热更新）。 |
| 树只有一两根粗根 | 你的会话历史只有一两个月，这是数据本身，不是 bug。 |
| 天天用 DSH 但树是空的 | 插件读的是 `~/.dsh/sessions`。日志在别处的话设 `sessionsDir`。 |
| 页面能开，点某天右边空白 | 那天只记了工具调用，没有可读的对话；卡片是机械汇总。 |
| 不想让它动 `AGENTS.md` | 设 `digest: false`，然后手动删掉 `MEMORY:AUTO` 那段。 |
| 更新后没变化 | Host 端代码要重启才生效，前端单独改的才热更新。 |

也可以完全绕开插件，手工跑一遍看真实报错：

```bash
node src/refresh.mjs        # 采集 → 速览 → 网页
node src/report.mjs         # 只重建网页
node src/query.mjs status   # 库到底建没建
```

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
