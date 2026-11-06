# 企业级 Super-Agent：一页看懂它的架构设计

被借鉴的原型只设计了一台「接活、派活、记账」的机器，没有设计它怎么**懂业务**。本设计补上这一块：**三类事实各归其位**——制度事实留在 BOS，认知事实留在 Spring-AI-RAG，运行事实落成本项目的编排事实。本项目只持有以 thread 为锚的编排事实，通过四个抽象接口与三个系统相连；不建流程、不建知识库、不复制治理语义。三条硬要求把范围撑开：事件来源更广；Router、Worker、Watchdog 可以是不同厂商、不同运行时的 agent；关键角色跨进程隔离。[](source:intent)[](source:facts)

- 三类事实与三条失效规则是全篇的推导起点，模块与状态机都从它长出来，不从原型继承。[](source:facts)
- 接口按语义切分，不按系统切分；换掉任何一个承载系统，上层都不用改。[](source:ports)
- 执行节点属于人、不属于租户；节点内按任务域隔离，凭据随任务创建与销毁。[](source:isolation)
- 这是架构设计，不是实现说明；每条结论都挂决策编号，尚未写任何代码。[](source:open)

@answer scope="架构设计 · 设计基线 · 决策核对 · 尚未实现"
@meta locale=zh-CN repo_url=https://github.com/wubuku/dsh-superagent-prototype.git repo_revision=211116a065c09f63a118bfec19d4640aedc16b28
@source intent title="设计起点：硬要求、盲区与划分理由" path=docs/drafts/enterprise-superagent-architecture.md lines=11:71
@source carriers title="我们已有的三个系统" path=docs/drafts/enterprise-superagent-architecture.md lines=72:103
@source facts title="三类事实与三条失效规则" path=docs/drafts/enterprise-superagent-architecture.md lines=104:129
@source assembly title="装配：只有抽象，没有具体系统" path=docs/drafts/enterprise-superagent-architecture.md lines=130:170
@source entities title="核心实体：thread、来源轨道、编排事实" path=docs/drafts/enterprise-superagent-architecture.md lines=171:219
@source ports title="四个接口的语义契约" path=docs/drafts/enterprise-superagent-architecture.md lines=220:255
@source lifecycle title="三条生命周期" path=docs/drafts/enterprise-superagent-architecture.md lines=256:304
@source isolation title="隔离与信任" path=docs/drafts/enterprise-superagent-architecture.md lines=305:358
@source human title="人工介入的三个层次" path=docs/drafts/enterprise-superagent-architecture.md lines=359:372
@source knowledge title="知识生产线" path=docs/drafts/enterprise-superagent-architecture.md lines=373:396
@source inherit title="与原型的关系" path=docs/drafts/enterprise-superagent-architecture.md lines=397:429
@source open title="仍未回答的问题" path=docs/drafts/enterprise-superagent-architecture.md lines=430:508

## 三个系统与本项目怎么连起来？ {#assembly span=12}

@diagram architecture id=assembly-map source=diagram.assembly.json title="三个承载系统与本项目的装配关系"

三个承载系统各管一类事实，本项目只管编排事实。连接只走四个抽象接口：`FlowCatalog` 管制度、`KnowledgeQuery` 管认知、`CollaborationMemory` 管协作线索、`TenantDirectory` 管租户身份。图中只画了前三个；`TenantDirectory` 的适配对象可以是 BOS，也可以是任何企业身份目录。[](source:ports)[](source:carriers)

每个系统都只是某个接口的适配器，不是架构里的固定位置。换掉任何一个，上层都不用改；三个系统自己怎么演进，也不影响编排层的概念结构。[](source:assembly)

租户标识在四个系统里各有各的含义，彼此不建映射表。接口只传不透明标识，由对方判断是否有效。[](source:assembly)

## 一次事件从进来到收口？ {#event-flow}

@sequence id=event-flow-diagram title="一次事件的端到端"
| actor source | 来源 | external |
| actor adapter | 来源适配器 | backend |
| actor orchestrator | 编排层 | backend |
| actor node | 执行节点 | frontend |
| actor bos | BOS | external |
| phase | 准入与派发 |
| source | adapter | 事件 |
| adapter | orchestrator | 归属 thread | emphasis |
| orchestrator | node | 派发任务 | emphasis |
| phase | 执行与上报 |
| node | orchestrator | 完成 + 副作用清单 | emphasis |
| phase | 对账与收口 |
| adapter | orchestrator | 核实结论 | security |
| orchestrator | bos | 业务收口 | return |

判定「哪些事件属于同一条 thread」由来源适配器做，本项目只签发与保管标识。跨来源合并只能由人显式发起，合并后仍保留多条来源轨道。[](source:entities)

任务完成时必须交出副作用清单，区分「已确认提交」与「可能提交、状态未知」。缺清单的上报不计为完成。[](source:lifecycle)

「已确认」只认可核实的凭据。节点声称已提交但无从核实，一律记为未知；核实由来源适配器做，编排存储只收结论。[](source:lifecycle)

## thread 与任务域怎么走完一生？ {#thread-lifecycle span=12}

@diagram lifecycle id=thread-lifecycle-diagram source=diagram.thread-lifecycle.json title="thread 的生命周期与任务域的接缝"

thread 归属唯一租户，创建时写定，之后不可更换。要交给另一个租户就新建 thread 并引用旧的，而不是转移归属。[](source:entities)

结束是终止态：全部来源轨道关闭、且在途任务为零，thread 才结束，之后不再接收事件。可复活的线索会让同一个标识承载两段不同历史。[](source:lifecycle)

任务域是执行节点上为单个任务建的独立执行环境。它销毁时只留一份到期即删的只读移交包，原始数据不在节点留存。[](source:entities)

## 哪些照抄原型，哪些必须新建？ {#inheritance}

原型里已经跑通、语义又不受三条硬要求影响的机制，直接照抄；原型没有、本项目必须新增的，单独列出。[](source:inherit)

| 类别 | 内容 | 理由 |
| --- | --- | --- |
| **照抄** | 副作用队列、授权与能力分层、线索订阅与扇出、停止 / 恢复 / 唤醒、评估去抖与超时、策略版本复查、幂等与回执 | 语义已验证，且不受来源更广、agent 异构、进程隔离影响 |
| **不继承** | 单进程单数据库的单写者、把一切会话放进同一宽松权限、由来源决定线索标识、把派生态存进库里 | 与三条硬要求直接冲突 |
| **必须新增** | 执行节点的三层隔离、对账三态语义、以 thread 为锚的编排事实与编排存储 | 原型中完全没有归属 |

「照抄」不等于「不加核对」。每一条照抄的机制在实现前仍要按本设计的租户与隔离要求重新审视。[](source:inherit)

## 这张图不能承诺什么？ {#limitations}

读这页最容易高估的边界，逐条列出。本页是设计，不是实现。[](source:open)[](source:knowledge)

| 边界 | 本设计的内容 | 读图提示 |
| --- | --- | --- |
| **成熟度** | 架构设计，尚未实现；没有任何对应代码 | 不要把图当作可运行系统的说明书 |
| **系统现状** | BOS 已能以 MCP 形式被消费；Spring-AI-RAG 的图谱与多租户仍在迭代；BlueCortex 的会话语义面向单个助手 | 图里画的是「如何使用」，不是「已经具备」 |
| **接口细节** | 本文只写「问什么、答什么、不答什么」，不写传输与实现 | 接口名是语义切分，不是接口定义 |
| **授权链** | 调用身份、Mandate（任务授权）、工具授权三层必须分开，但每层由谁判定尚未收敛 | 不要把三层合成一个权限字段 |
| **未决问题** | 会话主语、与 BOS 的接缝、多层审查落点、异构 agent 之间的通信 | 四项留白。第四项已拆成九种模式与候选路线，均未定 |
| **跨进程通信** | 执行节点只出站、不直连编排存储、进度流不是权威 | 原型只有同进程对象调用，这三条是跨出去之后必须补的 |
| **知识怎么写进去** | agent 只能提交提案，人确认后才入库；被推翻时另记一条溯源，历史决定保持原样 | 知识不由 agent 自行写入，这是它区别于「记忆」的地方 |

执行节点属于人，因此租户边界只能由节点内部的任务域保证，不能由「归属哪个租户」保证。这是刻意的取舍：把节点绑死到租户上隔离最强，但员工要为每个团队各跑一个常驻组件。[](source:isolation)

人工介入分三层：节点上看与接、编排层改派与停止、业务系统里审批与验收。缺一层，BYOM 的意义就少一块。[](source:human)

@callout id=design-goal level=note title="设计目标"
企业级的第一性是适用范围的扩大——来源更多、参与者更多、部署位置更多——而不是能力更强。因此本设计先定边界与归属，再谈效率。
