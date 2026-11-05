# 架构设计评审：`super-agent-architecture-design.md`（对抗性复核）

> 评审日期：2026-11-05
> 评审对象：`docs/drafts/super-agent-architecture-design.md`（1555 行，HEAD `cba1194`）
> 评审约束：只读不改；未联网验证厂商行为；未读 `.archify/`、`tests/` 全量与 DSH 全仓。

## 复核更正（主会话已证实）

P0-1 的结论已由主会话用 `src/core/evals.ts` 复核成立，需在引用本报告时按以下口径理解：

- `decideEval` 约 L284-288 比较 `this.policy().version !== evaluation.policyVersion`，不一致即触发重排/放弃；因此“原型判定链路完全不比对版本”不成立。
- `policyChanged` 约 L218-221 主动 reassess 所有活跃 Eval；因此原型不只有 “resume revalidate” 一条版本路径。
- `evalId` 约 L107 含 `policy.version`；`deadline` 约 L108 从 `at` 起算（与 D5 “从 claim 起算” 的差别在 `at`/claim 的取值，而不是没有起算点）。
- 结论应表述为：**原型已具备“比对 + 重排”，缺的是合并窗口、重判上限、lease + fencing、饥饿可观测**；本报告的 P0-1 反对的是“只记录不比对”这一前提，而不是反对“有界重判”这一增量本身。

---

# 1. 总评

**这份文档到了“可讨论、T0/T1 可局部实现”的程度，但还不到“可作为 T1/T2 开工合同或对外交付”的程度。** 它的概念切分（谁拥有事实、五个平面、三条通道）和证据标注明显强于一般设计稿；差距不在文采，而在三处关键问题：

1. **一个核心事实前提与 HEAD 源码冲突**（policyVersion 并非“只记录不比对”）；
2. **三张协议表不满足文档自己写的三条硬规则**（tenant、lease、attempt 没有闭合）；
3. **四个运行面缺失**（成本/容量、迁移/混沌、人工队列、SLO），其中人工队列是安全阀本身。

核对范围：全文 1555 行；原型源码 `src/core/evals.ts`、`src/core/tickets.ts`、`src/app/{runtime,assessment,delivery,effects,sessions,passes,migration}.ts`、`src/policy.ts`、`src/executor/dsh.ts`、`src/app/tools/main.ts`；上游 `event-driven-architecture-research.md` 的 §7.4/§10–§12。DSH 侧只使用你给的三条已核实事实，未读全仓；未联网验证厂商行为；未读 `.archify/` 与 `tests/`。

---

# 2. 问题清单

## P0（不修就会按错误合同开工）

### P0-1　核心增量建立在错误的原型事实上：policyVersion 其实已经比对

- **位置**：§0 #5（L15）、§5.3（L315）、§9.1（L628）、§10.1 #15（L675）、§13.1（L841）、§7-D3（L504）、§17 M0-2（L1082）。
- **问题**：文档反复称“`policyVersion` 只记录不比对”，并以此作为“本文与上游文档的核心增量”、ADR D3 的 A 选项、M0-2 验收的前提。
- **证据**：**与补充上下文中的“已核实事实”冲突。** `src/core/evals.ts:284-288` 在 `decideEval` 开头明确比较 `this.policy().version !== evaluation.policyVersion`，不一致时对活跃 Eval 调 `reassess(..., 'policyChanged')`，对 gate-only 调 `finish('unavailable', ...)`；`:218-220` 还在 `policyChanged` 时主动重排所有活跃 Eval。`src/app/assessment.ts:275` 只是“用当前 settings 计算 outcome”，随后会被上述检查拦下，不能推出“旧判定会被接受”。上游 L479 的原始观察是“投递状态机没有 policyVersion 分支”，这是对的；但上游 L603 把它升级成“判定链路没有比对”，这一步不成立。
- **危害**：D3、M0-2、§18/M3 的“旧策略继续授权”风险分析全部失真；M0-2 的“旧版本判定提交被拒”在 HEAD 上已成立（只缺“2 次上限”），会给出错误绿灯；后续实现会重复做已有能力，真正缺的“无合并窗口、无上限、无 lease/attempt”反而被掩盖。
- **建议**：把结论改成“原型已比对但无合并窗口、无 2 次上限、无 lease/attempt；本文增量是有界重判 + fencing”，同步修正上述 6 处与上游 §7.4/§10–12；M0-2 改为“跨重启、无 `policyChanged` 回调时仍能拦住 + 第 3 次策略变更必须 escalate”。

### P0-2　tenantId 在 §11 是硬要求，在 §5/§10 的协议表里不存在

- **位置**：§11.1 L761-765；§11.2 L779-784；§5.1 L225-249；§5.3 L290-301；§10.2 L686-690；Delivery 唯一键 L239。
- **问题**：§11 要求 Event、AssessmentResult、Decision、Ticket、Report 必带 `tenantId`，并要求 `assess.read` 校验 tenant、receipt 键带 tenant 前缀、Delivery 不得跨 tenant；但 §5.1 的 Event 字段表、§5.3 的 AssessmentResult 字段表、§10.2 的 `assess.read/request/submit` 全部没有 `tenantId`；§11.1 自己的 `Decision`/`Report` 必带字段行也漏了 tenant。
- **证据**：L761-762“必带 `tenantId`”；L779“`assess.read` 必须校验 `tenantId`”；L781“key 必须带 tenant 前缀”；L782“Delivery 行不得跨 tenant”；而 §5.1 L225-249 字段表、§5.3 L290-301 字段表、§10.2 L686-690 均无该字段；§5.1 L228 的“缺失后果”栏已经写“跨租户时无法隔离”，说明作者知道问题但没落到字段。
- **危害**：§11.2 说“写进协议校验而不是文档”，但协议里没有可校验的字段，多租户隔离无法实现；`(eventId, consumerId)` 这类键在不同租户复用会串数据；M1-6 与 S4 无法验收；后补字段会迫使所有适配器与键迁移。
- **建议**：把 `tenantId` 加入 Event/Delivery/AssessmentResult/`assess.request|read|submit` 与 Decision/Report，并把所有幂等键与 Delivery 唯一键改成 `(tenantId, ...)`；在 §5 表里直接引用 §11.2 的三条规则，避免两处各写一套。

### P0-3　leaseId / attempt 有三个领域、没有实体、没有 TTL、没有写入者

- **位置**：§5.1 L246；§5.3 L293-294；§6.2 L410/L414；§10.2 L686-690；§17 M1-1 L1091；§22.3 L1442；§20.6 L1286-1291。
- **问题**：`leaseId` 同时表示 Delivery 领取、Assessor 租约、Assignment 租约；`attempt` 同时是 Eval 的“第几次判定”、Delivery 的 `attempts` 计数、引擎任务的 attempt；全文没有 Lease 实体/表/字段/写入者/TTL，M1-1 突然出现“60 秒”，§22.3 只说“有租约/心跳”。
- **证据**：§5.1 L246 `leaseId/leaseUntil`；§5.3 L293-294 `leaseId/attempt`；§6.2 L410/L414 队列与 Assignment 的 `leaseId/attempts`；§10.2 `assess.release` 的注释“判完不释放会让租约空转到 deadline”证明租约是独立事实，但没有建模；M1-1 L1091 的 60 秒是全文唯一数值。
- **危害**：fencing 无法实现；跨域 token 可被复用；`attempt` 无法判“当前最大”；T1/T2 的 claim、改派、重复判定、超时回收都无法落地；M1-1/M3-1 的验收没有判定口径。
- **建议**：定义 `Lease{scope ∈ delivery|eval|assignment, subjectId, holderId, token, generation, expiresAt}`（或按 scope 分表），明确 TTL、续租、释放、回收和写入者；`attempt` 存在 Eval/Assignment 实体上并由控制面单调递增；Delivery 用 `attempts` 计数，不与 `attempt` 混名。

### P0-4　判定校验链有四个版本，且 evidence 白名单可被版本分支绕过

- **位置**：§5.3 L303-311（七步，policy #4 在 evidence #6 之前，无 deadline）；§13.2 L845-853（“五件事”，无 evidence，deadline #4）；§13.2.1 T2 L872（“落库判定草稿”）；§5.5 L346（“拒绝并重排一次”）；§5.3 L308（`rejected` 后由 Engine 决定）；§21.4 L1382-1387。
- **问题**：同一份判定，在 §5.3 被 `rejected` 后由 Engine 决定重排，在 §5.5 是“拒绝并重排一次”，在 §13.2 进入 `pending-policy` 等 30 秒，在 §13.2.1 T4 只有“未达上限”才重派——四种处置。更严重的是：§13.2 的五件事完全没有 evidence 白名单；§5.3 把 policyVersion 放在 evidence 之前，版本不匹配时进入 `pending-policy` 并“落库判定草稿”，使带 `knowledge_ref` 的提交在策略变化时绕过 `unauthorized_evidence`。
- **证据**：L308、L346、L853、L872 的原文；§21.4 要求“在 Engine 写 Decision 之前”拒绝知识证据；T2 落库草稿发生在写 Decision 之前，因此白名单没有执行。
- **危害**：实现者按 §13.2 会漏掉整份文档唯一的授权不变量；按 §5.3 会把非法 evidence 存进草稿；同一个迟到结果可能被丢弃/重排两次；审计事件缺失。
- **建议**：只保留一条规范链（建议顺序：evalId → attempt → lease → deadline（服务端接收时间）→ evidence 白名单 → policyVersion → outcome/Mandate → 单事务写），§13.2/§21.4 全部引用它；任何版本分支之前先执行 evidence 检查并写 `assessment.evidence_rejected`；删除“拒绝并重排一次”的第三种说法，明确 §5.3 #4 的处置就是 §13.2 状态机。

### P0-5　审批撤销不停止执行：规则写成了它自己列出的违规后果

- **位置**：§20.3 L1260；§5.5 L346；§13.2.3 L902-907；§12.1 L805；§4.1 L189。
- **问题**：规则写“审批后撤销：未开始的工单停止，执行中的写 `policy-changed` 并按 §13.2 处理”，而同一行的“违反后果”就是“**已撤销的授权继续生效**”。`policy-changed` 只通知，不停止 Assignment；§5.5/§13.2.3 也明确“工单执行不中止”。
- **证据**：L1260 原文；§5.5 L346“工单执行不中止但写 `policy-changed`”；原型有 `executor.stop`/`tickets.end` 的 stop 路径（`src/executor/dsh.ts:519-537`），但协议没有 `revocation → stop` 的映射。
- **危害**：撤销后 worker 仍可继续产生外部副作用（发布、合并、写外部系统）；审计只能显示撤销时间，不能阻止动作；这是文档自己承认的“已撤销的授权继续生效”。
- **建议**：区分 `revocation` 与普通策略变更：撤销必须 `stop Assignment` + fencing + 释放 lease + 拒绝后续 effect，并定义“已发出的外部动作是补偿还是允许完成”；普通策略收紧可以“不中止但标记”。补一条在途撤销的验收测试。

### P0-6　人工升级/审批没有队列契约，而文档同时声明不做 UI 和 SLA

- **位置**：§13.2.1 L866/L875；§13.2.3 L889；§8.1 L581；§1.3 L76/L78；§20.3 L1252-1259；§21.2 L1336。
- **问题**：`escalated`、审批、知识评审都依赖人，但没有定义队列归属、owner、SLA 数值、超时动作、通知渠道、认领/转办、审计字段；同时 §1.3 明确“不做管理 UI/面板/审批流界面”“不做 SLA”，§8.1 又把 UI 标为“不排期”，但 §13.2.3 用“请求者在面板看到 escalated，可手动接受/忽略/关闭”和“SLA 超时”作为状态机出口。
- **证据**：L866“直到人工处理或 SLA 超时”（SLA 未定义）；L889“面板……可手动接受、忽略或关闭”（面板不在范围）；L76/L78 明确不做；L1336“责任人”未定义；L1256 的 `ApprovalRecord` 也没有队列/超时字段。
- **危害**：`escalated` 成为永久黑洞，安全阀失效；M0-2/M4-4 无法收口；积压无人处理时“不允许静默 ignore”只是口号；无人审批时是否继续执行没有默认动作，可能导致越权或全量停摆。
- **建议**：定义最小 `HumanTask` 契约（`tenantId, kind, ref(evalId|ticketId|knowledgeId), ownerRole, createdAt, slaDueAt, state, decision, decidedBy, decidedAt, reason, timeoutAction`），明确超时默认动作（建议：不批准、挂起并告警，不自动接受），提供 CLI/API 队列（不要求 UI）；把 §1.3 的“不做 SLA”改为“不做计费 SLA，但操作超时必须定义”。

### 支撑证据：字段拉平（§5 / §10 / §13 / §19–§22）

| 字段 | 出现的表 | 冲突 |
| --- | --- | --- |
| `tenantId` | §11.1 L761-765 必带；§5.1 L225-249、§5.3 L290-301、§10.2 L686-690 缺失 | 硬要求无字段，无法校验 |
| `schemaVersion` | §5.2 L217 要求所有消息带；仅 Event 与 `assess.request` 有 | read/submit/Result/Delivery 均缺 |
| `leaseId` | §5.1 L246、§5.3 L294、§6.2 L410/L414、§10.2 L686-690 | 三个领域共名，无 scope/实体 |
| `attempt` | §5.3 L294、§5.1 `attempts`、§20.6 task attempt | 三种语义，无唯一写入者 |
| `deadline` | §5.1 L246 业务 deadline；§5.3 request deadline；§13.2 L852 `completedAt ≤ deadline` | 谁设置、以哪个时钟为准未定义 |
| `policyChangeSeq` | §13.2.3 L900 合并用；§5/§10 协议无此字段 | 有定序意图，但没进协议 |
| `seq` / `stateSeq` | §22.2 L1434；§20.2.1 L1234 | 两个“单写者顺序”，不同写入者 |
| `stateHash` / `evidenceHash` / `mandateHash` / `reportHash` | §20.2.1 L1234；§15.3 L1001-1003 | 均无算法/规范化/写入者 |
| `ApprovalRecord` vs `humanDecisionSignal` | §20.3 L1256 vs §20.2.1 L1233 | `at` vs `decidedAt`；`approvedScope` 缺失 |

## P1（不改会在 T1/T2 返工或产生可观测事故）

### P1-1　D1 的“换队列载体不改变正确性”与“事务性队列是内核”矛盾

- **位置**：§0 #1 L11；§7-D1 L504-508；§6.2 L410；§16.1 L1031。
- **问题**：文档把“事务性持久队列”列为核心内核，又认为把 SQLite 队列换成 Redis Streams/SQS 只是“替换实现”。
- **证据**：SQLite 的 effect 入队与 Ticket/Mandate/首 Assignment 在同一 DB 事务（`tickets.ts:37-56` + `engine.ts` 的 atomic）；Redis/SQS 无法参加该事务。“换 B 是替换实现”只在有 outbox+relay 时成立。
- **危害**：T2 采用外部队列后可能出现“Ticket 已提交但没有 launch effect”或“effect 已发但 Ticket 回滚”；这正是 #1 声称已经解决的事故。
- **建议**：把 D1 的契约改成“DB outbox + relay 到外部队列”，或明确 T2 仍保留 DB outbox；把“易”改为“中/难”，并加一条崩溃窗口测试。

### P1-2　`policyVersion` 不是单调版本，却被当作唯一幂等键

- **位置**：§13.2.3 L898（`reassess:{evalId}:{policyVersion}` 唯一约束）、L901（`policy-changed:{ticketId}:{policyVersion}`）；`src/policy.ts:116-117`。
- **问题**：`policyVersion` 是 `{rules, mode, sources}` 的内容哈希，不是单调序号。A→B→A 会生成同一个 version；唯一键会抑制第二次合法重判/通知。
- **证据**：`policy.ts:116-117` 的哈希实现；§13.2.3 L900 已经定义了 `policyChangeSeq`，却在 L898/L901 不用它。
- **危害**：策略回退后 Eval 卡在 `pending-policy` 或工单收不到变更通知；审计无法区分“没有变化”和“回退到旧版本”。
- **建议**：幂等键改用 `policyChangeSeq`（单调），`policyVersion` 只做内容身份；如果必须保留 version 键，改为 `(evalId, policyChangeSeq)` 并保存两个字段。

### P1-3　成本/容量/准入没有安全上限（这不是“计费”）

- **位置**：§1.3 L78；§3.3 L165；§5.3 L301；§15.1 L984；§15.4 L1014。
- **问题**：文档明确不做计费/配额，但没有定义单 Eval/单工单的成本上限、token 预算、全局模型调用断路器、事件积压上限与 intake 背压；“cost/model”是可选字段，`maxWorkers` 只是并发数。
- **证据**：L78 把“配额、SLA”整体排除；L165 只有 `maxWorkers` 1–16；L301 `cost/model` 可选；L984 只有“running/queued”没有停留时长；L1014 的“队列积压超阈值”没有阈值。
- **危害**：M1 试运行遇到一条坏规则或注入循环时，Eval/Worker 可无限重试；事件洪峰只进不出；成本与延迟同时失控，且没有 kill switch。
- **建议**：增加 `evalBudget`（最大模型调用/token）、`ticketBudget`（累计成本）、`maxOutstandingEvals`、`maxEventBacklogAge` 与全局 `pauseAutoSync/pauseAdmission` 断路器；区分“不做计费”与“必须做预算保护”。

### P1-4　T1→T2 的迁移、双跑、回滚没有方案

- **位置**：§6.2 L406-417；§16.1 L1030；§16.2 L1044；§16.3 L1054；§17 L1129。
- **问题**：有 schema 迁移和备份恢复，但没有“在途 Eval/Assignment/Delivery 如何从 SQLite 迁到外部队列/Postgres”的切流、双跑、回滚方案；§16.2 的回滚只有“恢复备份”，RPO 15 分钟意味着丢 15 分钟数据。
- **证据**：§16.1 用 S2/S3 触发迁移，但没有 cutover 步骤；§16.2 的 RPO/RTO 是目标不是机制；§16.3 只讲 schema 版本。
- **危害**：第一次 T2 部署时，在途租约/判定/effect 要么重复执行，要么丢失；回滚只能回退到旧库，无法解释已发生的副作用。
- **建议**：加一个迁移章节：冻结窗口、双写/影子读、按 `tenantId` 分批切、`lease` 失效策略、回滚判据（新旧两版同时可读）与演练里程碑。

### P1-5　deadline/lease 的时钟权威与判定时刻未定义

- **位置**：§5.3 L298（`completedAt` 由 assessor 填）；§13.2 L852（`completedAt ≤ deadline`）；§13.2.1 T2 L872（“租约仍有效”）；§22.3 L1442。
- **问题**：`completedAt` 是远端 assessor 自报的；控制面用它判“是否迟到”，等于让被考核方自己填到达时间。租约有效性又在“到达时”检查，而结果可能在租约到期前就已算完。
- **证据**：§5.3 字段表 `completedAt` 无服务端接收时间；§13.2 的检查 4 只用 `completedAt`；T2 要求“租约仍有效”，与“deadline 从 claim 起算”组合后，慢 assessor 的合法结果会被 `leaseLost` 丢掉。
- **危害**：恶意/漂移的 assessor 可以伪造“未迟到”；正常慢 assessor 的合法结果被重复计算或丢弃；跨节点时钟漂移会让同一份结果在不同节点得到不同判定。
- **建议**：同时记录 `completedAt`（诊断）与 `receivedAt`（控制面时钟，用于迟到判定）；明确 lease 有效性是在“完成时”还是“到达时”判断；给 T2 定义时钟漂移预算（例如 ±N 秒）与超限处理。

### P1-6　可观测性有指标但没有“什么算坏”的数字

- **位置**：§15.1 L984；§15.4 L1014；§13.2.4 L915；§17 M1-1 L1091。
- **问题**：`eval_pending_policy_age` 的触发线是“—”，§15.4 的 P1“队列积压超阈值”没有数值，§15.1 只列“running/queued”没有最老条目年龄；M1-1 的 60 秒是唯一硬数字。
- **证据**：L915 表格触发线为 `—`；L1014 “超阈值”无定义；L984 承认没有“从入队到现在多久”。
- **危害**：on-call 无法判断“现在是否坏了”；M1/M2 的告警只能靠人盯；SLO 无法验收；M1-1 的回收目标无法证明。
- **建议**：定义 4 个带数字的 SLO（如 Eval p95、最老 pending 年龄、Assignment 无报告时长、Delivery 重试年龄），并把 §15.4 的 P1/P2 绑定到具体阈值与窗口。

### P1-7　数据模型只给了少量键，缺少按租户/工单/时间的索引与分区决定

- **位置**：§1.3 L80“不写 DDL/索引”；§16.4 L1062-1063；§5.1 L239；§11.2 L773。
- **问题**：文档可以不做 DDL，但不能不决定“按 tenantId/工单/时间怎么查”；目前只有 Delivery 唯一键，Ticket/Decision/Journal/Audit 的查询键与索引没有定义，而 §16.4 又要求按 `state + updatedAt` 清理。
- **证据**：L80 明确排除 DDL/索引；L1062-1063 的保留策略依赖 `state + updatedAt` 与 `occurredAt` 分区；§11.2 要求租户分区。
- **危害**：T2 多租户上线后 Watchdog/审计查询退化为全表扫描；retention 无法按租户执行；后补索引需要锁表或重建。
- **建议**：至少给出逻辑键与索引清单（`journal(tenantId, occurredAt)`、`delivery(tenantId, consumerId, state, due)`、`ticket(tenantId, state, updatedAt)`、`decision(tenantId, threadKey, at)`、`effect(kind, due, seq)`），DDL 仍可推迟。

### P1-8　降级矩阵只覆盖三个领域系统，漏掉控制面依赖

- **位置**：§19.4 L1174-1180；§15.1 L980-986。
- **问题**：矩阵只写流程引擎/知识库/过程状态不可用；没有数据库、外部队列、模型 provider、DSH Session controller、凭据代理、时钟源不可用时怎么办。
- **证据**：L1174-1180 的三行矩阵；§15.1 的健康分组只是“可见”，没有对应动作。
- **危害**：第一次模型 provider 429、DB 锁竞争或 Session controller 重启时，系统没有定义的降级/拒绝/排队行为；可能静默停止主动工作，或继续接受注定失败的 Eval。
- **建议**：扩展矩阵为“组件 → 允许/禁止/降级标记 → 恢复动作”，至少覆盖 DB、queue、model provider、Session controller、credential proxy、clock。

### P1-9　§18.1 的证伪实验无法验证 30 秒合并窗口，且会与 §13.2.4 断路器互相污染

- **位置**：§18.1 L1135；§13.2.2 L884；§13.2.4 L918；§17 M0-2 L1082。
- **问题**：实验把策略变更提高到“每分钟一次”，即两次保存间隔 60 秒，大于 30 秒窗口，窗口内永远不会有第二次保存；它只能测“单次变更后的重判”，不能测“合并”。若实验中还有人工保存，`>1/min for 5 min` 会触发 §13.2.4 的暂停自动同步，结果被保护动作污染。M0-2 又要求“2 次内收敛”，但实验没有设计第 3 次变更来验证上限。
- **证据**：L1135 的“每分钟一次”；L884 的 30 秒窗口；L918 的 `>1/min for 5 min`；L1082 的 M0-2 目标。
- **危害**：实验可能“通过”但没有测到合并；也可能因断路器触发而误判为策略抖动不可收敛；2 次上限没有负向用例。
- **建议**：用可控时钟/测试开关做两次间隔 <20 秒的保存来测合并；单独做“连续 3 次变更”测上限；测期间关闭自动同步断路器或记录其状态，避免把保护动作当成收敛失败。

### P1-10　对 Flowable/Camunda/Dify/RAGFlow 的“原生能力”断言未验证

- **位置**：§19.5 L1187；§20.6 L1286-1292；§20.6 L1299；§23.3 L1492。
- **问题**：L1187 断言“Flowable/Camunda 类引擎已有任务、信号、补偿、人工任务，RAG 生态已有检索、切分、评估”；L1286-1292 的能力表直接写“原生（claim）”“原生完成”“原生（message correlation）”；L1299 断言“引擎通常按任务已结束拒绝重复完成，但不保证同一业务动作只生效一次”；L1492 断言“无法复用 Flowable/Camunda 的任务、信号、补偿、人工任务”。这些是具体产品行为，不是本文的设计选择。
- **证据**：L1190 自己写了“本文只看公开文档的形态，未验证具体版本能力”，但上述表格与结论仍用“原生/已有/无法”这种确定语气；全文没有版本号或文档链接。
- **危害**：选型时把“某引擎应该有”当成“已有”，会低估适配器工作量；把“通常拒绝重复完成”当成幂等保证，会在 Camunda/Flowable 的具体版本上产生重复外部动作。
- **建议**：逐条改为“〔判断，未验证版本〕”或“需按选定版本验证”；把能力表改成“协议承诺 `supportsTaskClaim` 等，适配器负责证明”；L1299 改为“必须假设同一业务动作可能被执行两次，账本用 receipt 兜底”。

### P1-11　身份/信任/能力三组字段有多个写法，且没有写入者

- **位置**：§5.1 L231/L235/L249；§11.1 L761-765；§5.4 L250-256；§10.2 L686-690；§23.1 L1460-1470。
- **问题**：Event 用 `actor + actorKind`，§11.1 用 `principalId + actorRef`，没有映射；`trustLevel` 只有三个中文值，没有枚举/写入者/派生规则；`capabilitySnapshot` 在 Delivery 行没有写入者/读取者；Agent 8 个能力、Assessor 3 个能力、领域系统 5+3+2 个能力是三套词表。
- **证据**：上述字段表；§5.4 的 8 项；§10.2 的 `supportsRead/supportsProgress/supportsCancel`；§23.1 的 `supportsAsOf/supportsSensitivity...`。
- **危害**：S1 的“不可信外部”无法判定；Delivery 的能力快照无法校验；适配器各自解释 capability，D10 的“显式声明、不静默降级”落不了地。
- **建议**：统一一个身份元组（`principalId, actorRef, actorKind, trustLevel`）与枚举；定义 `trustLevel` 的派生函数与写入者；统一 `Capability` 类型（按能力域分 namespace），并在 Delivery/Assessment/领域端口复用同一结构。

### P1-12　M2 的数字与 §10.3.1 的预注册口径冲突

- **位置**：§17 M2-2 L1102-1103；§10.3.1 L723/L730；§17 M2-1 L1101。
- **问题**：M2-2 写“成功率下降 <1%”，§10.3.1 预注册的是“下降 ≥0.5 个百分点”；M2-1 的“改善 ≥30%”没有基线；而 L723 自己说“10%/p95 翻倍是拍的，没有基线”。
- **证据**：三处原文。
- **危害**：M2 验收可以按 1% 通过，但按 0.5pp 应失败；同一个实验出现两个结论；读者不知道哪个是合同。
- **建议**：只保留 §10.3.1 的预注册数字；M2-2 引用它，M2-1 改为“方向性目标，不设百分比”，直到有基线。

### P1-13　§3.2 的“唯一写入者”规则被自己的表破坏

- **位置**：§3.2 L123 vs L125；L131 的 `*` 定义；§5.1 L239。
- **问题**：Event 平面写 `Delivery 行*`，Delivery 平面又写 `Delivery 状态*` 和 `Receipt*（与 Outbox 共用）`；`*` 被定义为“只有它能写”。
- **证据**：两张表的原文；L131 的定义。
- **危害**：T2 多进程下两个写入者会丢更新/重复投递；同一行状态被两个平面改，`attempts/leaseId` 无法保证单调；调试时无法定位责任方。
- **建议**：明确 Event 只写 Trigger/Journal，Delivery 平面独占 Delivery 行/状态/Receipt；Outbox 只能作为 Delivery 的内部写入者，不单独标 `*`。

### P1-14　RunState 声明“单写者”，但多 agent 协作时没有 owner/CAS

- **位置**：§22.2 L1434；§23.1 L1470；§19.2 L1159；§22.1 L1418-1422。
- **问题**：`seq/updatedAt` 被描述为“单写者顺序”，但同一 run 的 `waitingOn` 可能由多个 agent 写；`RunStatePort` 声明 `supportsCompareAndSet`，协议却只用 `seq`，没有把 seq 当 CAS token。
- **证据**：L1434“单写者顺序”；L1470 的 `supportsCompareAndSet`；§22.1 的“每个 run 一条记录”与多 agent 上下文。
- **危害**：T2 两个 agent 同时写 waitingOn 会互相覆盖；`seq` 只能事后比较，不能阻止并发写；过程状态的“可丢弃”假设建立在从未损坏的前提上。
- **建议**：指定每个 run 的唯一 writer（协调 Agent/Assignment），或按字段分 writer；写入必须携带 `seq` 做 CAS，失败返回冲突而不是覆盖。

## P2（不改不致命，但会误导实现或拖慢评审）

1. **§0 L9 “每条给出反例形态”没有兑现**：只有 #1 有“反例形态”；#2/#4/#8/#9/#10/#20/#23/#24 是规范性裁决，不可能被实验证伪。建议把这些标成“裁决/约束”，不要放在“可被反驳的硬结论”里。
2. **目录 §18 写“最脆弱的两个论断”（L41），正文是“四个论断”（L1133）**：目录与正文不一致。
3. **§1.2 L70 把“多租户、身份、安全、可观测性”写成“第 2 阶段，不在本文”，但 §11–§15 就在本文**；§8.1 L577 又把可观测性写成“下一阶段”。建议改成“第 2 阶段，见 §11–§15”，避免读者以为这些还没写。
4. **§6.4 的故障域计数与 §4.3/§6.2 不一致**：T1 写 3 个域（L472），但 §4.3 L208 允许 Assessor 独立进程、Router 可“独立但同机”，§6.2 默认 Assessor 在控制面；T2 写 N+2，但 §6.3 还有评估集群 M。建议按“进程/主机/控制面”三层重新计数。
5. **三处源码引用指错文件**：§9.1 L628 用 `evals.ts:107-111` 证明“不比对”（实际比对在 `:284-288`）；§13.2.2 L884 用 `effects.ts:83-88` 证明“2 秒 pass”（实际定时器在 `passes.ts:28`）；§3.3 L165 用 `dsh.ts:229-235` 证明“seq 顺序”（实际排序在 `effects.ts:109-113`）。
6. **§13.3 的 `degradedFrom` 语义反了**：L934 写“消费者支持 v3、生产者仅 v2 → 标注 `degradedFrom=v3`”；生产者根本没有 v3，谈不上“从 v3 降级”。建议改为记录 `producerVersion=v2` 或 `expectedVersion=v3`；同时 `degradedFrom` 没有进任何消息 schema（L937 要求必须记录）。
7. **关键对象只有字段名，没有 schema**：Decision、Report、Finding、Alert、health 在 §11.1/§15 被要求，但没有字段表；`evidenceHash/mandateHash/reportHash/stateHash` 在 §15.3/§20.2.1 被要求，但没有规范化/算法/写入者。`stateHash` 算法在 §24.1 L1553 承认待定。
8. **三套序号混用**：`seq`（§22.2 L1434）、`stateSeq`（§20.2.1 L1234）、`policyChangeSeq`（§13.2.3 L900）没有说明是否是同一序列空间；`suspended`（L907）也没有出现在任何 Ticket 状态清单里。
9. **§20.2.1 L1234 “与观察同一事务写入”跨外部引擎不可能**：引擎读和账本写在两个系统里，`stateHash` 只能证明“写入的 payload 未被改写”，不能证明“它就是当时的引擎状态”。建议改成“以 `observedAt` 标记观察时刻，hash 只做完整性校验”。
10. **policyVersion 的覆盖范围没有写清**：`src/policy.ts:116-117` 的哈希只含 rules/mode/sources；`blockedCommands`（`policy.ts:96`）与 `maxWorkers` 不在内。若安全命令黑名单变更不应影响运行中的 worker，需要明确写出来；否则“策略变更会通知”会有盲区。

---

# 3. 结构性缺口（第 3 项逐条判断）

| 缺口 | 文档现状 | 如果现在不写，会在哪个阶段爆炸 |
| --- | --- | --- |
| **成本与容量** | 只有 `maxWorkers` 1–16；`cost/model` 可选；`§1.3 L78` 明确不做计费/配额；没有单 Eval/单工单预算、模型断路器、事件积压上限、intake 背压 | **M1 试运行**：一条坏规则或注入循环会让 Eval/Worker 无限重试；事件洪峰只进不出；成本与延迟同时失控，且没有 kill switch |
| **迁移与灰度** | 有 schema 迁移（§16.3）与备份恢复（§16.2），没有 T1→T2 的切流/双跑/回滚；回滚只有恢复备份，RPO 15 分钟 | **第一次 T2 部署**：在途 Eval/Assignment/Delivery/lease 在 SQLite 与外部队列之间重复执行或丢失；回滚无法解释已发生的副作用 |
| **失败注入与混沌** | §17 M3-1/2 只覆盖杀节点与网络分区；§9.2 有少量推断；没有时钟漂移、重复/乱序、DB 满盘、provider 429 的矩阵；deadline/lease 依赖墙钟 | **T1/T2 多节点**：时钟漂移让合法结果变“迟到”或租约提前过期；at-least-once 重复投递导致重复副作用；假死节点无法与慢节点区分 |
| **人机协作面** | `escalated`、审批、知识评审都提到人，但没有队列/owner/SLA/超时动作/通知渠道；同时 §1.3/§8.1 声明不做 UI 与 SLA | **M0-2 首次转人工 / M4 审批**：`escalated` 永久堆积，安全阀失效；“不允许静默 ignore”无法执行；无人审批时继续/停止没有默认行为 |
| **SLO 与告警阈值** | §15.1 有指标，§15.4 有 P0–P3，但 `eval_pending_policy_age` 触发线是“—”，P1“队列积压超阈值”无数值；§15.1 承认没有“最老条目年龄” | **M1 运维交接**：on-call 无法判断“现在是否坏了”；§17 的“60 秒”“5%”“1%”无法互相校验；SLO 无法验收 |
| **数据模型键/索引** | §1.3 明确不写 DDL/索引；只有 Delivery 唯一键；§16.4 的保留策略依赖 `state+updatedAt` 与 `occurredAt`，但没有索引/分区决定 | **T2 多租户**：Watchdog/审计查询全表扫描；按租户清理无法执行；补索引需要锁表/重建；`(eventId, consumerId)` 键缺 tenant 会串数据 |
| **外部依赖降级矩阵** | §19.4 只覆盖流程引擎/知识库/过程状态；没有 DB、外部队列、模型 provider、Session controller、凭据代理、时钟源 | **第一次 provider 429 / DB 锁竞争 / Session controller 重启**：没有“允许/禁止/降级标记”的定义，可能静默停止主动工作，或继续接受注定失败的 Eval |
| **租户配额与隔离** | §11 有 tenant 边界，但没有 per-tenant 并发/事件/成本配额；M1-6 只要求“两个 tenant 不串数据” | **M1-6 之后的第一个大租户**：一个租户的积压/成本会挤占其他租户；隔离只有字段没有资源边界 |

---

# 4. 不该改的地方

以下部分看起来“可以简化/更优雅”，但改了会破坏概念完整性：

1. **不要把 principal / actor / agent 合并成“用户”**（#12）。三者的分离是审计链与授权链的支点；合并会让“谁触发、谁执行、谁批准”重新糊在一起。
2. **不要为了少一张表把 Journal 与 Delivery 合并**（D6）。两者的生命周期、写入者、重试语义不同；合并后无法区分“事件已记录”和“事件已投递”。
3. **不要为了统一把三个领域系统端口合成一个“集成接口”**（D14）。统一接口会把流程引擎的人工任务语义、知识库的 provenance、过程状态的 CAS 混成一个抽象，换实现时又把业务代码改一遍。
4. **不要删掉 `evidence` 四类白名单，或把知识只放进 `rationale`**（§21.4）。这是阻止“文档说可以就等于批准”的唯一协议层闸门；语义层风险可以承认，但不能拆掉协议层的锁。
5. **不要把五个平面压成一个 “orchestrator”**。整份文档最值钱的部分就是“谁拥有事实”的切分；压平后所有单写者论证失效。
6. **不要用单调计数器替换 `policyVersion` 的内容哈希**。哈希用于“内容是否相同”，计数器用于“先后与幂等”；应新增 `policyChangeSeq`，而不是二选一。
7. **不要因为人工契约缺失就删掉 `escalated` / 审批状态**。应补 HumanTask 契约；删掉状态只会把“转人工”变成静默丢弃，违背 #21。
8. **不要为了让测试好过而把 at-least-once 改成 exactly-once，或把 T1 合回单进程**。receipt/idempotency 与失败域拆分是这套设计的核心，不是可选项。
9. **不要把 #2/#4/#8/#9/#20/#23/#24 改成“实验结论”**。它们是规范性裁决；正确做法是标注“裁决”，而不是编一个无法证伪的实验。

---

# 5. 三个最该先解决的问题（按“改动成本 / 危害”比排序）

| 顺序 | 问题 | 改动成本 | 危害 | 先做理由 |
| --- | --- | --- | --- | --- |
| **1** | **P0-1：policyVersion 事实前提** | 低（6 处文字 + 上游勘误 + M0-2 断言） | 极高 | 它决定“核心增量、D3、M0-2、风险分析”是否成立；不改，后面所有验收都建在错误前提上 |
| **2** | **P0-2 + P0-3 + P0-4：租户/租约/attempt + 唯一校验链** | 中（一页协议表 + 一条规范链） | 极高 | 这三项是 T1/T2 的实现合同；分开改会互相返工，必须一次拉平；不修，适配器一开工就会遇到键冲突与 evidence 绕过 |
| **3** | **P0-6：人工升级/审批队列契约** | 中低（HumanTask 契约 + CLI/API，不要求 UI） | 高 | `escalated` 是文档自己的安全阀；没有 owner/SLA/超时动作，M0-2 与 M4 无法收口，积压会静默增长 |

**紧随其后的是 P0-5（撤销不停止执行）**：它的安全危害最高，成本主要是新增 `revocation → stop Assignment` 路径与一个在途撤销测试，所以排在第 4，而不是前 3。

---

# 6. 被评审的文档版本

| 文件 | 行数 | 评审时 HEAD 短哈希 |
| --- | --- | --- |
| `docs/drafts/super-agent-architecture-design.md` | 1555 | `cba1194` |
| `docs/drafts/event-driven-architecture-research.md` | 688 | `cba1194` |

HEAD 完整哈希：`cba1194b19136760d459618c608e90a99259b0b2`

用途：后续按本报告修复时，用这三个值确认“评审基线”与“修复后增量”之间的差异；本报告不修改 design 文档本身。
