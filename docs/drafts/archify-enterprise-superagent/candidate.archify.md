# 企业级 Super-Agent：一页看懂它的架构设计

一句话：给企业配一支「AI 员工团队」的中枢——把活派出去、把账记清楚，让公司敢把真业务交给 AI。分工是：**流程与审批归 BOS，知识归 Spring-AI-RAG，个人记忆归 BlueCortex，而「此刻谁在干什么」的台账归本项目**。三条硬要求把范围撑开：事件来源更广；AI 角色可以来自不同厂商、不同运行时；关键角色跨进程隔离。[](source:intent)[](source:facts)

- 先认词：thread 是「一件事的完整案卷」，台账（编排事实）回答「谁在干什么、谁在等谁」，任务域是「每个任务一间独立办公室」。[](source:facts)[](source:entities)
- 本项目只做编排这一层：流程、知识、记忆三个承载者都只接不建；换掉任何一个，上层不用改。[](source:ports)
- 隔离靠任务域：凭据随任务生灭；执行节点属于人、不属于租户。[](source:isolation)
- 这是设计，不是实现：每条结论都挂前提编号、可回查，尚未写任何代码。[](source:open)

@answer scope="架构设计 · 设计基线 · 决策核对 · 尚未实现"
@meta locale=zh-CN repo_url=https://github.com/wubuku/dsh-superagent-prototype.git repo_revision=3fd0a1d3b45a6110a63b4d0c1af26809a83e5e9a
@source intent title="设计起点：硬要求、盲区与划分理由" path=docs/drafts/enterprise-superagent-architecture.md lines=11:75
@source carriers title="我们已有的三个系统" path=docs/drafts/enterprise-superagent-architecture.md lines=76:109
@source facts title="三类事实与三条失效规则" path=docs/drafts/enterprise-superagent-architecture.md lines=110:135
@source assembly title="装配：只有抽象，没有具体系统" path=docs/drafts/enterprise-superagent-architecture.md lines=136:176
@source entities title="核心实体：thread、来源轨道、编排事实" path=docs/drafts/enterprise-superagent-architecture.md lines=177:229
@source ports title="四个接口的语义契约" path=docs/drafts/enterprise-superagent-architecture.md lines=230:265
@source lifecycle title="三条生命周期" path=docs/drafts/enterprise-superagent-architecture.md lines=266:316
@source isolation title="隔离与信任" path=docs/drafts/enterprise-superagent-architecture.md lines=317:372
@source human title="人工介入的三个层次" path=docs/drafts/enterprise-superagent-architecture.md lines=373:386
@source knowledge title="知识生产线" path=docs/drafts/enterprise-superagent-architecture.md lines=387:410
@source inherit title="与原型的关系" path=docs/drafts/enterprise-superagent-architecture.md lines=411:443
@source open title="仍未回答的问题" path=docs/drafts/enterprise-superagent-architecture.md lines=444:536

## 先认六个词（30 秒） {#glossary}

后面所有面板都用这几个词。每个词都给了白话解释；要查严格定义，看来源章节。[](source:entities)[](source:facts)

| 词 | 白话解释 |
| --- | --- |
| **thread** | 一件事从发生到收口的完整案卷；由本项目编号建档，不沿用任何来源系统的编号 |
| **来源轨道** | 同一件事在不同来源（代码平台、聊天、邮件）里各留一条记录线；合并要人显式发起 |
| **编排事实（台账）** | 「谁在干什么、谁在等谁、哪笔账没对上」的记录；归本项目，不归任何 agent 的记忆 |
| **任务域** | 每个任务的独立办公室：独立目录、独立凭据、独立出口；任务结束即焚毁 |
| **移交包** | 办公室焚毁后留下的只读交接单；到期删除，不含凭据和原始数据 |
| **租户** | 一份台账的隔离边界；四个系统各有各的租户含义，彼此不建映射表 |

## 三个系统怎么分工、怎么连？ {#assembly span=12}

@diagram architecture id=assembly-map source=diagram.assembly.json title="三个既有系统与本项目的装配关系"

三个既有系统各管一摊。BOS 管「该不该做、按什么流程做」；Spring-AI-RAG 管「公司知道什么」；BlueCortex 管每个参与者「上次是怎么做的」。[](source:carriers)

本项目管剩下的事：**此刻谁在干什么**。它记台账、派任务、盯执行、对结果——这些不放进任何 agent 的记忆，也不放进 BOS。[](source:facts)[](source:carriers)

连接只走接口：问制度走 `FlowCatalog`，问知识走 `KnowledgeQuery`，问记忆走 `CollaborationMemory`。它只问「这条线索上发生过什么」，不问「现在干到哪」——现状在台账里。[](source:ports)

BlueCortex 是外挂记忆（Claude-Mem 的移植）：它在旁边观察每个 agent 的会话，把痕迹提炼成观察与摘要，下个会话开始时注入回去。图上它的边就是这条钩子上报。[](source:carriers)

每个系统都只是某个接口的适配器。换掉任何一个，上层不用改；三个系统自己怎么演进，也不影响编排层。[](source:assembly)

租户标识在四个系统里各有含义，彼此不建映射表；接口只传不透明标识，由对方判断是否有效。[](source:assembly)

## 一次事件从进来到收口 {#event-flow}

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
| orchestrator | bos | 回到既有流程 | return |

@steps id=event-steps
| arrive | 来源 | 事件进来：可能来自代码平台、聊天或邮件。 | event-flow-diagram | source |
| thread | 来源适配器 | 判断它属于哪条 thread；没有就申请建档。 | event-flow-diagram | adapter |
| dispatch | 编排层 | 记台账，把任务派给执行节点。 | event-flow-diagram | orchestrator |
| execute | 执行节点 | 在任务域里干活，完成后必须交副作用清单。 | event-flow-diagram | node |
| reconcile | 来源适配器 | 核实副作用：确认、未发生、或未知；未知转人工。 | event-flow-diagram | adapter |

判定「哪些事件属于同一条 thread」由来源适配器做；本项目只签发与保管编号。跨来源合并只能由人显式发起，合并后仍保留多条来源轨道。[](source:entities)

任务完成必须交副作用清单，区分「已确认提交」与「可能提交、状态未知」；缺清单不算完成。[](source:lifecycle)

「已确认」只认可核实的凭据：节点说做了但无从核实，一律记为未知；核实由来源适配器做，台账只收结论。[](source:lifecycle)

## thread 的一生，与任务域的交接 {#thread-lifecycle span=12}

@diagram lifecycle id=thread-lifecycle-diagram source=diagram.thread-lifecycle.json title="thread 的生命周期：三个状态与终止条件"

thread 归属唯一租户，建档时写定，之后不可更换。要交给另一个租户，就新建 thread 并引用旧的，而不是转移归属。[](source:entities)

结束是终止态：全部来源轨道关闭、且在途任务为零，thread 才结束；之后不再接收事件。可复活的线索会让同一个编号承载两段不同的历史。[](source:lifecycle)

任务域是执行节点上为单个任务建的独立办公室。它销毁时只留一份到期即删的只读移交包；原始数据不在节点留存。[](source:entities)

## 哪些照抄原型，哪些必须新建？ {#inheritance}

原型里已经跑通、语义又不受三条硬要求影响的机制，直接照抄；原型没有的，单独新建。[](source:inherit)

| 类别 | 内容 | 理由 |
| --- | --- | --- |
| **照抄** | 副作用队列、授权与能力分层、线索订阅与扇出、停止 / 恢复 / 唤醒、评估去抖与超时、策略版本复查、幂等与回执 | 语义已验证，且不受来源更广、agent 异构、进程隔离影响 |
| **不继承** | 单进程单数据库的单写者、把一切会话放进同一宽松权限、由来源决定线索编号、把派生态存进库里 | 与三条硬要求直接冲突 |
| **必须新增** | 执行节点的三层隔离、对账三态语义、以 thread 为锚的编排事实与编排存储 | 原型中完全没有归属 |

「照抄」不等于「不加核对」：每一条照抄的机制在实现前仍要按本设计的租户与隔离要求重新审视。[](source:inherit)

## 这张图不能承诺什么？ {#limitations}

读这页最容易高估的边界，逐条列出。本页是设计，不是实现。[](source:open)[](source:knowledge)

| 边界 | 本设计的内容 | 读图提示 |
| --- | --- | --- |
| **成熟度** | 架构设计，尚未实现；没有任何对应代码 | 不要把图当作可运行系统的说明书 |
| **系统现状** | BOS 已能以 MCP（Model Context Protocol）形式被消费；Spring-AI-RAG 的图谱与多租户仍在迭代；BlueCortex 是参与者一侧的跨会话记忆，不承载协作状态 | 图里画的是「如何使用」，不是「已经具备」 |
| **接口细节** | 本文只写「问什么、答什么、不答什么」，不写传输与实现 | 接口名是语义切分，不是接口定义 |
| **授权链** | 调用身份、Mandate（任务授权）、工具授权三层必须分开，但每层由谁判定尚未收敛 | 不要把三层合成一个权限字段 |
| **未决问题** | 会话主语、与 BOS 的接缝、多层审查落点、异构 agent 之间的通信 | 四项留白。第四项已拆成九种模式与候选路线，均未定 |
| **跨进程通信** | 执行节点只出站、不直连编排存储、进度流不是权威 | 原型只有同进程对象调用，这三条是跨出去之后必须补的 |
| **BYOM 双形态** | 执行节点可以是云端、也可以是员工电脑；云端节点的 agent 仍可把「手」伸到员工机器（嵌套 BYOM） | 两种都是预期形态；员工侧 daemon 的构建仍是未决问题 |
| **知识怎么写进去** | agent 只能提交提案，人确认后才入库；被推翻时另记一条溯源，历史决定保持原样 | 知识不由 agent 自行写入，这是它区别于「记忆」的地方 |

执行节点属于人，所以租户边界只能靠节点内部的任务域保证，不能靠「归属哪个租户」。这是刻意取舍：绑死租户隔离最强，但员工要为每个团队各跑一个常驻组件。[](source:isolation)

人工介入分三层：节点上看与接、编排层改派与停止、业务系统里审批与验收。缺一层，BYOM（员工机器上的 agent 加入协作）的意义就少一块。[](source:human)

@callout id=design-goal level=note title="设计目标"
企业级的第一性是适用范围的扩大——来源更多、参与者更多、部署位置更多——而不是能力更强。因此本设计先定边界与归属，再谈效率。
