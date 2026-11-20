# 历史改写 · History Rewritten

输入历史问题，自动查找来源，比较同一组条件下历史选择的后果。你可以检查每条规则和证据，修改假设，再离线复算。

[在线演示](https://hoanacantincus-cmd.github.io/history-rewritten/) · [分析方法](#分析方法) · [添加案例](#贡献)

## 自托管

需要 Node.js 22.18 或更高版本。执行 `npm ci` 后，把 `.env.example` 复制为 `.env`，填写 `BRAVE_SEARCH_API_KEY`、`OPENAI_MODEL` 和模型服务需要的 `OPENAI_API_KEY`。使用兼容模型服务时，可以修改 `OPENAI_BASE_URL`。该服务需支持 Chat Completions 的 JSON object 响应格式。浏览器通过本机后端使用这些配置。

```sh
npm ci
npm run build
npm start
```

打开 [本机 H5](http://127.0.0.1:4173/)，输入历史事件或反事实问题。可附网址，也可把无法自动读取的材料作为短摘录提交。当前自动读取支持公开 HTML 和纯文本页面。扫描件或 PDF 可通过手工填写出处和摘录纳入分析。

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
2. **建模。** 分析包记录历史基线、同一决策变量的替代选项、共享参数、可执行规则和证据。史料不足时返回缺口。事件身份或干预有实质歧义时给出可确认的问题。
3. **复算。** 在每个情景中分别运行基线和各个替代方案。各规则读取上一步状态。对同一目标按规则顺序取第一条适用规则。参与方只能读到已向其开放的字段。前提不确定时保留未知值。数值比较和差值范围只描述列入分析的情景。
4. **审阅。** 模拟结果和史实时间线各有出处。修改假设会产生新的建模记录。相同的分析包、引擎版本和推演设置可离线复算。

分析包由 [运行时 Schema](src/schema.ts) 校验。数值字段声明单位，比例用 `1`。规则支持带条件的状态更新、布尔运算、比较和基础算术。反馈通过下一步状态实现。后决策史实只用于核对时间线。关键机制缺少数据时可用定性规则和有明确假设的情景。

## 验证状态

预览版包含跨领域的独立演示、证据与规则测试，以及用替身服务运行的检索和建模接口测试。真实 Brave Search 加在线模型的六题盲测是正式发布 `v0.1.0` 的验收项，题目在 [测试清单](test/live-questions.json) 中。配置服务后，逐题运行 `research`，核查每条关键引文、分岔点和规则，再用 `simulate` 断网复算。

```sh
npm run check
npm test
npm run build
```

## 贡献

添加示例时，从现有分析包或新题研究结果出发，逐条核查核心事实，说明可变条件和限制，至少为一组假设手算基线与改写结果。把新增案例文件及复算命令附在 PR 中。

代码采用 [MIT 许可](LICENSE)，仓库原创示例内容采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。第三方史料保留各自来源。首页地图为 Abraham Ortelius 的 [*Typus Orbis Terrarum*（1570）](https://library.missouri.edu/specialcollections/items/show/1339)。Courtesy of Special Collections and Rare Books, University of Missouri Libraries.
