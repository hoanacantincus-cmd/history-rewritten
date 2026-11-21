# 历史改写 · History Rewritten

在「如果」后输入一句话，系统自动查找来源、构建情景并返回历史可能走向。有可核对的计数时，结果展示模型概率。详细史料、规则与复算入口可以展开查看。

[在线演示](https://hoanacantincus-cmd.github.io/history-rewritten/) · [分析方法](#分析方法) · [添加案例](#贡献)

## 自托管

需要 Node.js 22.18 或更高版本。执行 `npm ci` 后，把 `.env.example` 复制为 `.env`，填写 `OPENAI_MODEL` 和模型供应商要求的 `OPENAI_API_KEY`。使用 DeepSeek 时设置 `OPENAI_BASE_URL=https://api.deepseek.com` 和 `OPENAI_MODEL=deepseek-flash`。模型接口须支持 Chat Completions 的 JSON object 响应格式。

只配置模型即可运行。默认检索 Wikimedia 和 Wikisource，并找出部分档案和机构引用。配置 `BRAVE_SEARCH_API_KEY` 可改用 Brave Search 扩大检索范围。密钥由本机后端读取。

```sh
npm ci
npm run build
npm start
```

打开 [本机 H5](http://127.0.0.1:4173/)，在「如果」后输入一句话。系统自动确定分析时限、观察指标和情景。当前自动读取支持公开 HTML 和纯文本页面。扫描件或 PDF 的短摘录可以通过命令行补充。

GitHub Pages 提供可离线计算的示例，也接受导入分析包。自托管服务默认监听回环地址，适合个人在本机运行。

## 命令行

```sh
npm run research -- "如果一份历史条约延后生效，会怎样？" --out analysis.json
npm run simulate -- analysis.json --scenario all
npm run simulate -- public/examples/alaska-1867.json --scenario share-40
```

`research` 支持重复传入 `--source URL`。也可传入 `--sources FILE`，文件内容是由 `{url, title?, excerpt?}` 组成的 JSON 数组。两个命令都接受 `--out FILE`。复算可用 `--horizon N` 缩短已建模的窗口。

## 分析方法

1. **查证。** 搜索查询依据问题生成。读取原始页面后合并重复内容。自动生成的引文须能在读取到的文本中逐字定位。引文能定位属于必要检查，主张是否被解释准确仍可由读者核对。
2. **建模。** 分析包记录历史基线、改写方案、共享参数、可执行规则和证据。分别审查内部资源与制度、外部局势、各方博弈和天气。天气可能影响结果时优先寻找同时期的记录或再分析资料。关键事实缺失时说明缺口。
3. **多智能体复算。** 规则读取上一步状态。参与方只接收当时可见的状态，可为每方定义备选行动和无量纲效用。每轮选取可行且效用最高的行动。其反应进入下一轮的状态，影响其他各方。信息不足或效用并列时保留未知结果。
4. **概率。** 有可核对的联合频数或等可能机制时，逐个计算互斥情景并按计数加权。某个结局的下界为已判定情景对应的权重，上界再加上尚未判定的权重。概率条件包括所列场景、简化规则与可比性假设。缺少权重依据时展示条件走向。手动调整情景会使原概率权重失效。
5. **审阅。** 模拟结果和史实时间线各有出处。相同的分析包、引擎版本和推演设置可离线复算。新版引擎也可复算第一版分析包。

分析包由 [运行时 Schema](src/schema.ts) 校验。数值字段声明单位，比例用 `1`。规则支持带条件的状态更新、布尔运算、比较和基础算术。后决策史实只用于核对时间线。

多智能体工作流参考 [MiroFish](https://github.com/666ghj/MiroFish)，建模记录参考 [ODD 协议](https://doi.org/10.18564/jasss.4259)，共同初始条件下改变一个决策的对照参考 [结构反事实模型](https://arxiv.org/abs/1302.4929)。近代天气资料可查 [NOAA 20CR](https://www.psl.noaa.gov/data/20thC_Rean/) 或 [ECMWF ERA5](https://www.ecmwf.int/en/forecasts/datasets/complete-era5-global-atmospheric-reanalysis)，是否可用取决于事件年代、地点与所需的空间分辨率。

## 验证状态

预览版包含跨领域的独立演示、证据与规则测试，以及用替身服务运行的检索和建模接口测试。真实在线检索和模型的六题盲测是正式发布 `v0.1.0` 的验收项，题目在 [测试清单](test/live-questions.json) 中。逐题运行 `research`，核查每条关键引文、分岔点和规则，再用 `simulate` 断网复算。

```sh
npm run check
npm test
npm run build
```

## 贡献

添加示例时，从现有分析包或新题研究结果出发，逐条核查核心事实，说明可变条件和限制，至少为一组假设手算基线与改写结果。把新增案例文件及复算命令附在 PR 中。

代码采用 [MIT 许可](LICENSE)，仓库原创示例内容采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。第三方史料保留各自来源。首页地图为 Abraham Ortelius 的 [*Typus Orbis Terrarum*（1570）](https://library.missouri.edu/specialcollections/items/show/1339)。Courtesy of Special Collections and Rare Books, University of Missouri Libraries.
