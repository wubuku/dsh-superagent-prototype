# AI 员工上岗前，公司要先想清楚三件事

一句话：给公司装一个「AI 员工团队」，难点不是让它会说话。真正的难点有三条：**做事先有批准、干活有隔离、做完有账可查**。这三条做成了基础设施，AI 员工才能被放心用。

- **制度在已有的系统里**：该走什么流程、谁审批、什么时候验收——这些本来就在公司的业务系统（BOS）里，不用重写，AI 员工照着办。[](source:status)
- **知识在已有的知识库里**：答案必须能指出出处，编不出来就说「资料不足」。[](source:status)
- **新增的只有一层「信任层」**：谁能开工（准入）、在哪干活（独立办公室）、干完记什么（台账）。这一层，才是我们比「一个聊天机器人」多交付的东西。[](source:status)

@answer scope="给管理层与业务负责人 · 不含实现细节 · 现状如实标注"
@meta locale=zh-CN repo_url=https://github.com/wubuku/dsh-superagent-prototype.git repo_revision=2a78e8e8b2e811bd313ceae7e0a67550be24b195
@source status title="四个模块的现状（如实盘点）" path=docs/drafts/enterprise-superagent-dev-plan.md lines=23:36
@source terms title="Mandate 与准入链的术语提示" path=docs/drafts/enterprise-superagent-dev-plan.md lines=7:7
@source lifecycle title="Ticket 与 Assignment 的生命周期" path=docs/drafts/enterprise-superagent-architecture.md lines=344:386

## 一张图看懂：四个系统各管一件事 {#big-picture span=12}

@architecture id=system-map title="四个系统各管一件事，谁也不在谁的肚子里"
| user | 员工（主人） | external |
| portal | 入口：邮件 / 群消息 / 工单 / 业务事件 | frontend |
| bos | BOS · 制度：流程 / Case / 审批 / 版本 | backend |
| rag | 知识库 · 只回原文、能溯源 | database |
| orch | AI 员工调度中心 · 派活 / 准入 / 台账 | security |
| node | 独立办公室 · 在员工电脑或云端 | cloud |
| memory | 外挂记忆 · 跨会话记得住 | database |
| portal > orch | 事情进来了 |
| orch > bos | 查制度、发起流程 |
| orch > rag | 查知识 |
| orch > node | 派活 |
| node > orch | 交活 + 副作用清单 |
| node > memory | 留下经验 |
| orch > user | 主动办结 / 待确认 |
| user > portal | 确认 / 补充 |

四个系统各自独立部署，走标准接口相连。**没有一个大平台把它们装进肚子**——这正是它们能各自升级、各自替换的原因。

## 您最该问的三个问题 {#three-questions span=12}

| 您担心的事 | 我们的答案 | 落点 |
| --- | --- | --- |
| 「它会不会乱来？」 | **每次开工都要有凭据**：凭什么开这个工、依据哪次审批，一条条记下来 | 准入链 {good:已设计} |
| 「它会不会看到不该看的？」 | **一任务一间独立办公室**：独立目录、独立凭据、独立网络出口，干完即焚 | 任务域 {good:已设计} |
| 「出了事查得清吗？」 | **每一笔对外动作都记账**：做了 / 可能做了 / 没做，三态对账，人工可裁定 | 台账与对账 {good:已设计} |

这三件事合起来，就是「信任层」。它不改变您现有的系统，只在关键位置加检查点。

## 事情进来之后：一次性的灵活办，会重复的沉淀成制度 {#routing span=12}

@workflow id=route-flow title="AI 员工先判断：一次性灵活办，会重复的沉淀成制度"
| trigger | 事情进来了 | external |
| judge | 一次性还是重复？ | backend |
| adhoc | 灵活办结 | backend |
| lookup | 查 BOS 现成流程 | backend |
| model | 建模并发布 | backend |
| run | 发起流程 | backend |
| trigger > judge | |
| judge > adhoc | 一次性 |
| judge > lookup | 会重复 |
| lookup > run | 有现成 |
| lookup > model | 没有 |
| model > run | 固化后 |
| run > adhoc | 到节点为止 | emphasis |

这是这套系统最值钱的地方：**同样的活干第二遍时，不用再从头想一遍**。第一遍怎么干、谁批的、卡在哪，都被固化成流程；下次自动照办，人只看例外。

@steps id=route-steps
| t | 事情进来了 | 可能来自一封邮件、一条群消息，也可能来自收货、订单这类业务事件。 | route-flow | trigger |
| j | 先判断 | AI 员工自己判断：一次性的事灵活办；会重复的事，值得沉淀。 | route-flow | judge |
| a | 灵活办结 | 一次性的，在调度中心里协调几个 AI 员工直接办完，不惊动制度。 | route-flow | adhoc |
| l | 查制度 | 会重复的，先查 BOS 里有没有现成的流程或 Case，可能不止一个。 | route-flow | lookup |
| m | 没有就建 | 没有：AI 起草、编译、发布——但发布要人审批，AI 不能自己给自己发制度。 | route-flow | model |
| r | 跑起来 | 发起实例，流程跑到某个节点，就轮到对应岗位的 AI 助理接手。 | route-flow | run |

## 一个真实场景跑起来是什么样 {#scene span=12}

@sequence id=scene-seq title="从「一封邮件」到「事情办完、账对上了」"
| actor event | 事情来了 | external |
| actor staff | 员工（主人） | frontend |
| actor ai | AI 员工助理 | backend |
| actor bos | BOS 制度 | backend |
| actor rag | 知识库 | database |
| actor office | 独立办公室 | security |
| phase | 判断与查制度 |
| event | ai | 收到：供应商说这批货对不上 |
| ai | bos | 查：有没有「收货异常处理」流程？ |
| bos | ai | 有，第 3 版，正在生效 | return |
| phase | 开工要凭据 |
| ai | bos | 发起实例，取这次开工的凭据 |
| bos | ai | 凭据已签发：依据本流程第 3 版 | return |
| phase | 在隔离的地方干活 |
| ai | rag | 查这批货的历史验收记录 |
| rag | ai | 证据（附原文出处） | return |
| ai | office | 在一间独立办公室处理，用完即焚 |
| office | ai | 完成，附「我做了哪些对外动作」清单 | return |
| phase | 交活与对账 |
| ai | staff | 主动办结：结论 + 依据，送达到主人 |
| ai | bos | 回写结果，进入对账 |
| staff | ai | 有异议，补充指示 | return |

关键在最后一步：**AI 交活时必须附一份「我做了哪些对外动作」的清单**。没有清单的「完成」，我们一律不认——这是防止「AI 说做完了但其实没做 / 做了但没说」的唯一办法。[](source:lifecycle)

## 三条通道，AI 员工不靠猜 {#channels span=12}

| 它要知道的 | 去哪里查 | 举例 |
| --- | --- | --- |
| 制度：这类事该不该做、按什么流程做 | **BOS** | 收货异常该走哪条流程、谁审批、什么时候验收 |
| 知识：我们怎么理解这门生意 | **知识库** | 这批货的历史、客户的特殊要求、法规条款 |
| 干活的方法 | **技能包（SKILL）** | 怎么读一张验收单、怎么核对一个批次号 |

三条通道分开的好处：制度改了不影响知识，知识更新不用动制度，技能升级不用改前两者。**任何一条出问题，都能单独定位、单独修**。

## 现状说实话 {#status span=12}

| 模块 | 现在到哪一步了 | 能拿出去用吗 |
| --- | --- | --- |
| **BOS（制度）** | 20+ 万行的大型 PoC，大量能用的真家伙，但**尚未建成企业版** | 试点可用 {caution:需配合} |
| **知识库** | 已在生产项目中使用 | 可用 {good:已在用} |
| **AI 员工记忆** | 社区版接近生产可用，企业版在移植中 | 部分可用 {caution:在移植} |
| **调度中心 + 信任层** | 设计已完成，工程未开始 | 新工程 {caution:新建} |

我们不会把「快好了」说成「已经好了」。这份表就是我们的承诺基线。**给试点客户的第一个版本，只承诺上表里真正站得住的部分。**

## 下一步 {#next span=12}

- [ ] 选定一个试点业务（一个部门、一类事就够），给出 2–3 个真实场景
- [ ] 指定一名业务接口人：他决定「这件事该不该由 AI 办」
- [ ] 约定验收标准：AI 办完的事，谁来签字、按什么标准算办对了
