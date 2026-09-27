# 火柴棒 - 交付报告

| 项 | 值 |
| --- | --- |
| **App 名称** | 火柴棒 |
| 仓库 | z-biz-game-matchwork-cos |
| 品类 | 益智 · 火柴等式 |
| 依赖 | 0（零构建、零二进制资产） |
| 关卡 | 60 关 = 5 档 × 12，par ∈ {1,2,3} |
| node 断言 | 103 条 / 0 失败（6 个 suite） |
| 浏览器断言 | 见「构建验证结论」——以主代理门禁实跑为准，未跑绿不发布 |
| 难度证据 | 每关随包 `par / space / states / route / proof`，复解不过不入库 |

## 任务摘要

"移动 N 根火柴让等式成立"里的 N 不是一个难度档位，而是一个穷举计数：
par=1 的题把 `{已亮段} × {未亮段}` 的候选空间完整枚举（本仓最大 550 个候选），
par≥2 的题由带记忆 BFS 逐深度推进，并记录它**实际展开了多少个状态**（本仓最大 2,354）。
量不出来的关不会进题池。

## 真实文件清单

```
index.html css/game.css server.cjs package.json .gitignore LICENSE electron/main.cjs
js/main.js js/view.js
js/core/  board.js game.js solve.js make.js library.js storage.js rng.js（+ 其规格所需其余模块）
js/data/lots.js   60 关 + BAKE / BAKED_AT 元数据
test/  board game library rng solve storage （6 个 suite，另有 fixture.mjs）
tools/ bake.mjs harness.mjs playtest.mjs verify.sh
.github/workflows/ ci.yml pages.yml
README.md DESIGN.md deliverable.md
```

## 改动表：一开始错在哪 → 现在为什么对

| # | 现象 | 处理 | 依据 |
| --- | --- | --- | --- |
| 1 | 仓库缺 DESIGN.md 与 deliverable.md | 由主代理按重新测量的 `lots.js` 数据补齐 | 本报告与 DESIGN.md 的每个数字都来自 `node --input-type=module` 实读 |
| 2 | 规格文档说"par=3 未穷举，只有下界"，但数据里的 `proof` 标签只有 `exhaustive-1`(24) 与 `exhaustive-bfs`(36) 两种取值，**不区分** par=2 与 par=3 的证明强度 | 本报告的立场是**照实描述标签**，并把"par=3 是否达到同等穷举强度"列入未实现清单待复核；不改标签、也不在文档里替代码夸大 | `proof` 分布实测；规格 §0 |
| 3 | 上一位负责浏览器层的代理在 150 轮上限处中断，最后一句是"发现第二个更大的浏览器层 bug，正在确认" | **该 bug 未被证实也未被修复**，因此本仓发布与否完全取决于主代理的门禁实跑结果，不采信任何自述 | 会话中断记录 |

## 构建验证结论

本机直接测量：`npm run check` rc=0；`node --test test/` **103 rows / 0 fail**；
`js/data/lots.js` 读取到 60 关，`par` 按档固定为 1 / 1 / 2 / 3 / 3，
最大候选空间 462 / 550 / 460 / 540 / 728，最大展开状态 191 / 841 / 2,354。

浏览器层由主代理门禁（内部调用本仓 `tools/verify.sh`）实跑判定；
本报告提交时尚未取到该次实跑结果，因此这里**不写浏览器断言数字**，
发布决定也只以那次实跑为准。

## 难度 / 唯一性的证据在哪

- **par 是计数**：`space` 给出合法搬法候选总量，`states` 给出证明过程实际展开量，
  两者随包发布，任何人可用 `node --input-type=module` 读 `js/data/lots.js` 复核。
- **复解一致**：`test/library.test.mjs` 从序列化 `spec` 重新求解并断言等于印着的 `par`；
  `test/solve.test.mjs` 独立覆盖搜索层。
- **0 搬的关不存在**：本来成立的等式不会作为关卡入库，因此 par 的下界不是空断言。
- **诚实档位**：`deep` 一档 par=3、展开 2,354 个状态——它把"证明有多贵"也写进了数据，
  而不是只写一个难度形容词。

## 未实现清单（写清楚，不留空头承诺）

- **par=3 的穷举强度待复核**：见改动表 #2。规格要求 par=3 只声明下界，
  而 `proof` 标签没有区分；要收紧的话应新增标签值（如 `bounded-3`）而不是改文档措辞。
- **浏览器层存在一条未证实的"第二个更大 bug"记录**：上一条会话在确认它时中断。
  若门禁实跑变红，那既不是回归也不是既成事实，而是这条未确认记录的落实，需要按现象重新定位。
- **音效 / 动画 / 火柴贴图素材**：没有（零二进制资产是硬约束）。
- **Electron**：`electron/main.cjs` 只过 `node --check`，未安装 electron、未真实启动。
- **真机触摸**：手势只经 CDP 合成事件验证。
- **多语言**：UI 只有中文。
