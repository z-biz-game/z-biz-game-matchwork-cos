# 火柴棒 · MATCHWORK

搬火柴让等式成立：每一关旁边那个「最少 N 搬」不是配置出来的难度档位，而是在**合法版面图**上
做完整穷举量出来的最短解长度。量不出来的关卡不会出现在题池里。

零依赖（`dependencies` 与 `devDependencies` 都是 `{}`）、零二进制资产、无打包器、无 `npm install`。
需要的一切只有 Node（≥21，浏览器测试用它自带的 `fetch`/`WebSocket`）与本机的 Chrome。

## 跑起来

```bash
npm start                 # node server.cjs → http://127.0.0.1:5217/
node server.cjs 5185      # 换端口（tools/verify.sh 用的就是 5185）
```

没有构建步骤：`js/data/lots.js` 是 60 行**已烘焙**的题池（十六进制版面 + 实测 par），
它是签进仓库的源文件，浏览器直接读它。

## 验证

```bash
npm run check             # 对每一个源文件跑 node --check，含 tools 与 test
node --test               # 6 个 node 套件（core 纯度、规则、求解、存档、题池、会话）
bash tools/verify.sh      # node 套件 + 真实 Chrome（CDP）五段浏览器断言 @boot @play @routes @save @pointer
SKIP_UNIT=1 bash tools/verify.sh          # 只跑浏览器（CI 的 browser job 就是这么做的）
SHOTS=/tmp/puzzle-brief/shots bash tools/verify.sh   # 顺带留 boot / 完成态两张截图
SCENARIOS="pointer" bash tools/verify.sh  # 改 view.js 之后只重跑指针段
node tools/bake.mjs       # 重新量一遍 60 行题池（写 js/data/lots.js，正常开发不需要跑）
```

`tools/verify.sh` 只用 **5185 / 9345** 这一对端口，理由写在它开头的注释里：兄弟仓各自占着
5180/9340、5181/9341、5188/9348…，撞端口**不会报错**——DevTools 照样应答，驱动就会连到
**别人的**标签页上，于是所有断言打在另一个游戏的 `window.<hook>` 上，最坏情况是"0 行断言"看着像通过。

浏览器段也可以单独当命令行玩具用：

```bash
node tools/playtest.mjs open http://127.0.0.1:5185/
node tools/playtest.mjs drag 28,26        # 用真实 Input.dispatchMouseEvent 拖一根火柴
node tools/playtest.mjs shot /tmp/now.png
node tools/playtest.mjs eval "@boot" nonav
```

## 结构

```
js/core/board.js    版面模型：7 段数字 + 4 段算符星 + 锁死的 =；规则只在这里实现一次
                    （字形合法、前导零、中间不为负、× 优先于 + −、同级从左到右）
js/core/solve.js    穷举：depth-1 全积 / depth-2 嵌套积 / 逐层 BFS 走完整个连通分量
js/core/make.js     构建期反向生成（只有 tools/bake.mjs 导入，浏览器不加载）
js/core/library.js  题池读取、行复验、战役排序、#/daily 与 #/random/<tier>/<token> 路由
js/core/game.js     一局会话：手里捏着哪根、已搬几手、撤销/重开/提示/成绩
js/core/rng.js      FNV-1a hashSeed + mulberry32：同一个 token 在任何设备同一题
js/core/storage.js  localStorage 单键存档（唯一允许碰 window 世界的 core 文件，且它会抛异常）
js/view.js          像素与手势：画火柴、跟随指针、把 client 坐标换算成段索引；不判合法性
js/main.js          DOM、路由、存档、成绩卡，并挂出 window.matchwork 测试钩子
js/data/lots.js     60 行烘焙题池 + BAKE 报告（构建期产物，签进仓库）
test/*.test.mjs     6 套 node 断言（tools/harness.mjs 打印 rows: N fail: N）
tools/{bake,playtest}.mjs tools/verify.sh
```

`js/core/*` 里不出现 `document.`/`window.`（`storage.js` 是唯一例外：它守卫 localStorage，
守卫失败就抛，不返回 null）。合法性判断只有一个实现处：`board.js`。UI 的任何 bug 都不能
发明第二条规则。

## 玩法与规则

- 一手 **搬** = 拿走一根亮着的（未锁死）火柴 + 放下一根到灭着的（未锁死）位置。**全盘火柴总数不变**，
  所以可选动作恰好是 `{亮} × {灭}` 这个笛卡尔积，状态空间有限、可穷举。
- **等号的两根锁死**：既不能搬走，也不能往上放。没有这条规则，"从 = 上偷一根变成 ≠"就是合法解，游戏作废。
- 数字必须是合法七段字形；不允许多位数以 0 开头；算符只有 `+ − ×`；`×` 优先，同级从左到右；
  中间结果不允许为负（`3 − 5 + 4 = 2` 是拒绝，不是"再算算"）。
- 操作：按住一根亮火柴 → 拖到灭位置 → 松手放下 = 一手。拖到非法位置/已亮位置/等号段 → 弹回原位，
  **不计入搬数**；拖过画布边界也不会有任何权限——边界外不存在落点（`slotAt` 返回 null），松手不计一手，
  火柴仍在手里，画布的盒子/背板尺寸与页面滚动都不会因为过拖而动（`@pointer` 里逐条断言）。
  键盘：`u` 撤销、`h` 提示、`r` 重开、`Esc` 收起成绩卡。
- 提示按钮说的是"这是某条最短解的第一步，之后还差 k 搬"，k 由穷举给出；用提示完成的关卡
  记为"达最少"，但不会是"完美"。

## 那个数字从哪来

`tools/bake.mjs` 先造一个**成立的**等式，再倒着搬 `k` 手（每手都必须合法但不成立；`k` 按档取
1、1–2、2、3、3–4），然后用 `solve.js` 量出真正的最短 par，只保留实测值恰好落在本档的题。
倒着走的这条路反过来走就是一段真实解，所以恒有 `par ≤ k`——这条不变式是被检查的，不是被信任的。
报告原样存进 `BAKE.report`（`genMs` 是**每次尝试的平均**毫秒，`attempts` 是外层尝试数，
`rejects` 是每题内部预算 120–240 个候选里被丢弃的计数）：

| 档 | 标签 | 实测 par | 题数 | 外层尝试 | 接受率 | 平均生成 | 最大分量 | 拒绝原因（合计） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single | 单挑 | 1 | 12/12 | 12 | 100.0% | 4.2 ms | 462 版面 | `n1Band` 7 |
| splay | 多解 | 1 | 12/12 | 12 | 100.0% | 10 ms | 550 版面 | `par2` 9 · `n1Band` 30 · `walkDeadEnd` 1 |
| setup | 布局 | 2 | 12/12 | 12 | 100.0% | 1.5 ms | 191 态 | `par1` 10 |
| tangle | 缠绕 | 3 | 12/12 | 12 | 100.0% | 67.5 ms | 841 态 | `par2` 188 · `par1` 152 · `richBand` 21 · `walkDeadEnd` 28 |
| deep | 深水 | 3 | 12/12 | 12 | 100.0% | 112.8 ms | 2354 态 | `par2` 95 · `par1` 77 · `walkDeadEnd` 22 · `richBand` 8 · `par4` 1 |

五档合计：生成 196 ms、复验 21.6 ms、最大连通分量 2354 个合法版面（最深档，单次全扫 39 ms）。
外层接受率之所以是 100%，是因为丢弃都发生在**每题内部**的候选预算里（上表 `rejects`，合计 649 个候选），
而不是外层拿不到题；这也是"不许随机撒火柴然后试解"的代价：生成是构建期成本，不是点击成本。
`already-true` / `unsolvable` / `sweep-*`（预算内跑不完）这类结论**永不印数字**，也不会进题池。
浏览器打开每一行时都会拿磁盘上的十六进制版面**重新量一遍**（`library.verifyRow`），
`test/library.test.mjs` 与 `@boot` 段各自独立复算 60 行——数字是谁算的、在哪复现，一目了然。

## 存档

单键 `matchwork.save.v1`（版本号写在文件里）：战役解锁位、每题 `best{moves,hints}`、每日成绩、
总搬数/提示数/拒绝数。`best` 只会变小、`unlocked` 只会变大；损坏、被改过或来自未来的存档
一律回落到默认值而不是被采信。想重来就点面板底部的「清空存档」。

## 已知边界

- 无音频、无字体、无图片：画布全程序化。
- 只有中文文案；没有 i18n 层。
- `electron/main.cjs` 是能跑的外壳，但 CI 不启动它（浏览器测试走 `server.cjs`）。
- 题池固定 60 关 + 每日 + 按 token 的随机档；没有云存档，换设备只剩分享链接 `#/lot/<id>`。
