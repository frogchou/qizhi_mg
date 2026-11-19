# 智能体管理与开发说明

> 本文以当前 `qizhi_mg` 代码为准，说明中台如何发现、审核、调度、监督和退役智能体，以及新增智能体必须遵守的开发原则。它区分“当前已实现行为”和“后续生产化方向”，不将产品愿景当作既有能力。

## 1. 一句话模型

在栖知中，智能体是一个**独立部署、版本化、可审核、按任务临时拉起的程序包**。

它不是控制平面内被直接导入的一个函数，也不是永远常驻的聊天机器人。中台只相信已经审核并就绪的能力声明；执行时由节点管理服务把该版本启动为独立的 `systemd` 临时服务实例。

```text
智能体包（静态声明）
        ↓ 发现：只读 YAML / Schema，不运行代码
待审核版本 pending_review
        ↓ 管理员批准 + 配置自检
已就绪版本 ready
        ↓ 中台规划并绑定到某个 DAG 节点
节点管理器启动独立 systemd 实例
        ↓ 心跳、事件、结果回调
中台验证、归档、调度后继节点或交付
```

## 2. 角色与责任边界

| 组件 | 负责什么 | 明确不负责什么 |
| --- | --- | --- |
| 控制平面 `apps/control-plane` | 智能体目录、审批、任务规划、DAG 编译、调度、租约、审计、交付和恢复 | 不导入或直接调用智能体的业务代码 |
| 节点管理器 `apps/node-manager` | 保存已审核版本的启动记录；创建、停止和自检独立实例 | 不接受中台或浏览器传入的任意 Shell 命令 |
| 智能体包 `agents/<package>` | 声明能力，读取任务信封，完成一类业务工作，报告事件和结果 | 不决定自己是否获准上线，不修改其他任务的状态 |
| Agent Protocol `packages/agent-protocol` | 定义语言无关的清单、任务信封、事件、结果和执行图契约 | 不绑定 Codex、RAGFlow 或 TypeScript 实现 |
| 公共运行时 `packages/agent-runtime` | 读取并校验任务信封、发心跳、原子写结果、回调中台 | 不包含某一业务智能体的业务判断 |
| 运行时适配层 | 以统一接口调用 Native、Codex 等运行环境 | 不替代中台对结果、工件和租约的校验 |

这条边界很重要：即使一个候选智能体包中包含恶意代码，在“发现”阶段也不应有机会运行；即使 Codex 规划器提出调用某个能力，也不能绕过审核状态启动它。

## 3. 智能体包的固定结构

一个标准智能体包的最小结构如下：

```text
agents/my-agent-v1.0.0/
├─ agent.yaml
├─ README.md
├─ schemas/
│  ├─ input.schema.json
│  └─ result.schema.json
└─ src/
   ├─ main.ts
   ├─ run-task.ts
   └─ self-check.ts
```

### 3.1 `agent.yaml`：智能体的静态身份证

示例：

```yaml
protocolVersion: v1
agentId: ppt-maker
displayName: PPT 制作
version: 1.0.1
runtime: codex
entryCommand:
  - ../../node_modules/.bin/tsx
  - src/main.ts
selfCheckCommand: ../../node_modules/.bin/tsx src/self-check.ts
capabilities:
  - name: presentation.create
    description: 根据业务简报生成、校验并交付 PowerPoint 演示文稿
```

其中：

- `agentId + version` 唯一定位一个智能体版本；
- `runtime` 当前可声明 `native`、`codex` 或 `pi`；它描述主要运行环境，不授予额外权限；
- `entryCommand` 是唯一会被节点管理器执行的启动命令，必须在审核快照中固定；
- `selfCheckCommand` 只应用于批准后的首次自检；
- `capabilities` 是规划器可选择的业务能力，而不是任意自然语言标签。

### 3.2 输入、输出 Schema：中台与智能体的合同

`schemas/input.schema.json` 规定调用方允许传什么；`schemas/result.schema.json` 规定结果至少应包含什么。中台会在发现、批准和规划编译阶段校验这些 Schema。

例如知识检索智能体要求：

```json
{
  "required": ["query"],
  "properties": {
    "query": { "type": "string", "minLength": 1 }
  }
}
```

因此规划器不能给 `knowledge.retrieve` 虚构一个未声明的 `keywordList` 参数。Schema 不通过的版本不能进入 `ready`，未通过编译的执行图也不能调度。

### 3.3 业务入口与公共运行时

智能体入口通常很薄，只负责装配公共运行时、业务实现和运行时适配器：

```ts
const execution = await loadAgentExecution();
try {
  await execution.complete(await runTask(execution.envelope, execution.reporter));
} catch (error) {
  await execution.fail(error);
}
```

`loadAgentExecution()` 读取中台指定的 `MG_TASK_ENVELOPE_PATH`，检查任务、节点、实例、租约和目录边界；`runTask()` 才是智能体特有的业务代码。这样每个智能体不用重复实现心跳、结果落盘和回调安全检查。

## 4. 管理生命周期

### 4.1 发现：只读声明，不运行候选代码

控制平面的 `AgentPackageDiscoveryService` 扫描 `MG_AGENT_PACKAGE_ROOT` 下包含 `agent.yaml` 的一级目录。它只读取：

- `agent.yaml`；
- 输入 Schema；
- 结果 Schema。

它不会 `import` TypeScript，不执行 `main.ts`，也不会运行 `self-check.ts`。声明合格后，中台把不可变快照写入 PostgreSQL 的 `agent_versions`，初始状态为：

```text
pending_review
```

目录监听器会在文件变化后重新扫描；一个包发现失败不会阻塞其他包，并会记录 `agent.discovery_failed` 审计事件。

### 4.2 审核与自检：从声明可信到可运行

管理员批准精确版本后，状态变化如下：

```text
pending_review / offline / self_check_failed
        ↓ approve
self_checking
        ↓ 自检通过                    ↓ 自检失败
ready                              self_check_failed
```

自检由节点管理器执行。自检应该只验证运行条件，例如：

- `codex --version` 能否执行；
- 必填环境变量格式是否正确；
- 外部 URL 是否是合法 URL；
- 本地依赖工具是否存在。

自检不得读取企业业务资料、不得生成正式交付物、不得修改其他任务。通过后，控制平面才会向节点管理器同步审核过的启动记录。

### 4.3 就绪目录：节点管理器只认审核过的启动记录

节点管理器保存 `{ agentId, version, packagePath, entryCommand }` 的就绪目录。控制平面请求启动时只传智能体身份、版本、任务工作目录和环境文件位置；节点管理器按自己的就绪目录解析真实命令。

这避免了一个危险模式：浏览器、规划器或任务输入直接要求节点管理器执行任意路径或任意 Shell 字符串。

节点管理器重启后，控制平面会把数据库里仍为 `ready` 的审核快照重新同步过去；不会因此重新批准候选包或重新执行自检。

### 4.4 上线、下线、升级与删除

| 操作 | 当前行为 |
| --- | --- |
| 上线 | 审批并自检通过，版本进入 `ready` |
| 下线 | `ready → draining → offline`；拒绝新的启动，已经取得租约的工作允许完成 |
| 升级 | 创建更高的新版本、使用新的包目录、重新发现和审核；旧版本可在合适时机下线 |
| 删除 | 先检查是否仍有活跃工单、待执行计划节点、租约或停止中的实例；有依赖时拒绝删除 |
| 恢复删除的身份 | 必须使用新的独立目录与严格更高的版本号，再次审核 |

已审核或已上线版本的包目录不能复用于另一版本。更新代码、清单或 Schema 时必须发布新版本，而不是修改正在 `ready` 的旧包。

## 5. 任务执行时如何选择和启动智能体

### 5.1 只有 `ready` 能力可以参与规划

用户提交需求后，中台并不按关键词硬编码选择智能体。`CapabilityCatalogService` 从数据库的 `ready` 审核快照中读取可用能力及其输入/输出 Schema；Codex 规划器只能在这个目录中生成结构化任务图。

规划结果还要经过 Agent Protocol 编译器校验：

- 能力是否存在且为 `ready`；
- 每个节点输入是否符合该能力 Schema；
- 依赖关系是否存在循环；
- 上下游证据/工件绑定是否合法；
- 共享目录是否显式声明共享组；
- 是否有且仅有一个可达的 `end` 终点。

通过后，节点被绑定到**精确的** `agentId + version`。规划器不能自行指定任意二进制文件。

### 5.2 每个节点是一次可追踪的运行尝试

调度器等待依赖完成后，为节点创建：

- 独立节点目录；
- `envelope.json` 任务信封；
- 一次性 `leaseToken`；
- 尝试编号 `attemptNumber`；
- 受限环境文件；
- 数据库中的 `task_attempts` 记录。

然后通过节点管理器以 transient systemd unit 启动：

```text
mg-agent-<instanceId>
```

节点管理器收到 systemd 的“已接受启动请求”并不代表智能体已工作。只有智能体发出第一条 `heartbeat`，中台才认定其已经成功引导。

### 5.3 事件、心跳、结果和工件

智能体通过内部接口发送有序事件：

```text
started → progress → checkpoint → completed
                         └─ 或 failed / heartbeat / output
```

每条事件都带 `instanceId`、递增序号和 `leaseToken`。中台只接受身份、租约和状态均匹配的事件；重复、迟到或来自旧尝试的事件不能推进工单。

结果回调包含：

- 面向下游与用户的结构化 `output`；
- 有出处的 `evidence`；
- 风险 `risks`；
- 任务目录内相对路径和 SHA-256 组成的 `artifacts`。

公共运行时先原子写入 `nodes/<node-key>/result.json`，再回调中台。中台会复核工件路径仍在节点目录内、实际 SHA-256 与声明一致，之后才会归档并调度下游节点。

### 5.4 监督、停止与恢复

公共运行时启动后立即发心跳，之后每 10 秒发一次；中台的 `TaskLivenessService` 独立于浏览器 SSE 工作：

- 首次心跳超时或后续心跳丢失，实例被标为中断；
- 中台请求节点管理器停止失联实例；
- 第一次失联自动重新调度一次；
- 再次失联则明确标记失败，不无限静默重试；
- 用户停止工单时，中台中止规划/验收、撤销节点实例，最终转为 `cancelled`。

活动事件和运行日志均持久化。SSE 只是向界面实时推送，不是唯一事实来源；网页断开或服务重启后都能从数据库回放。

## 6. 任务目录、资料和会话原则

每个工单拥有任务根目录：

```text
/home/middleground/data/workspaces/<task-id>/
├─ plans/       # 原始与已编译的执行图
├─ session/     # 面向人类的状态、会话与记忆记录
├─ nodes/       # 每个执行节点的独立目录
├─ artifacts/   # 已归档、不可被后续尝试覆盖的交付物
└─ quality/     # 质量与验收材料
```

下游智能体不会自动看见上游全部目录。中台根据已编译 DAG，把允许使用的证据或工件复制到下游自己的 `input/` 目录，并以 `inputBindings` / `taskInputBindings` 明确授权。用户上传或栖知资料筐引用的材料会先冻结为任务私有快照；之后即使用户清空资料筐，工单仍读取自己的副本。

任务目录中禁止写入 API Key、密码、令牌或完整敏感环境变量。外部服务凭据只能通过节点的受限环境文件传递。

## 7. 智能体开发原则

以下是新增或修改智能体时必须遵守的原则。

### 原则一：能力小而清楚，职责单一

一个智能体可以声明一组紧密相关的能力，但不应成为“万能智能体”。例如：

- 知识检索：返回带来源的证据；
- PPT 制作：根据已授权材料生成 PPT；
- 质量管理：定义标准并验收指定目标；
- 互联网研究：检索公开资料并保留引用。

“选择哪个智能体、先后关系如何”属于中台 DAG 编排；“如何完成本领域工作”属于智能体。

### 原则二：声明先于执行，审核先于启用

候选包进入 `agents/` 后，只能被静态发现为待审核。不得在模块导入、副作用脚本、清单解析或自检之外的流程中自动联网、读企业资料或执行正式任务。

### 原则三：契约先于提示词

先设计输入 Schema、输出 Schema、证据格式、工件格式和错误语义，再编写提示词或业务逻辑。自然语言提示词不应替代机器可校验的字段约束。

### 原则四：版本不可变，升级创建新包

已审核版本的代码、清单、Schema 和启动路径视为审计对象。任何变更都应：

```text
新包目录 → 新版本号 → 待审核 → 自检 → 就绪 → 切换/下线旧版本
```

禁止直接修改正在运行或已审核版本的包内容。

### 原则五：最小资料可见性

智能体只读取自己节点目录和中台显式材料化的 `input/` 文件。不要假设能遍历同工单其他节点目录，更不得依赖其他工单目录。需要资料时，应在能力 Schema 中声明输入字段，并让规划器通过绑定授权。

### 原则六：结果必须是用户需要的内容，而非过程摘要

`output.answer` 应提供完整 Markdown 答复；旧能力可使用 `output.text`。`output.summary`、`passed: true`、日志片段或“已生成文件”都只是执行信息，不能替代用户要求的总结、说明、分析或交付内容。

文件交付仍必须出现在 `artifacts` 中，并声明真实相对路径与 SHA-256。

### 原则七：可观察、可诊断、可恢复

业务实现应在关键阶段报告 `started`、`progress`、`checkpoint`；长时间任务还应发送受限长度的 `output`。不得在长任务中无声等待。

错误要转换为可公开、可理解且不含敏感信息的消息；中台负责将执行事件、审计记录和结构化服务日志关联到任务、节点和实例。

### 原则八：自检只检查运行条件

`self-check.ts` 只检查可执行文件、配置形状、URL 格式和本地依赖。它不查询企业知识库、不创建交付物、不消耗真实业务资料。

### 原则九：运行时可以替换，业务协议保持稳定

业务智能体不应把自己绑死在某个模型提供方：

- `native` 可直接调用确定性 API、文件工具或本地程序；
- `codex` 当前经由本机 Codex CLI 适配层执行；
- `pi` 为预留运行时；
- 未来可新增 Codex app-server 适配器，但仍使用同一任务信封、事件和结果协议。

目前 Codex 型智能体将工作目录传给 `codex exec --cd <node-workspace>`，每次调用是独立 CLI 进程；同一工单的不同节点不共享隐藏 Codex 会话，只通过中台材料化的资料协作。

### 原则十：当前原型的权限限制必须被正视

当前第一期按单机受信任环境设计，服务和智能体以 root 账号运行；Codex 内容制作调用也使用较宽松的本地执行权限。因此“任务目录”当前主要是工作和审计边界，不是完整的操作系统安全沙箱。

正式生产化应逐步增加：低权限服务账号、`systemd` 的 `ReadWritePaths` / `ProtectSystem` / `PrivateTmp`、CPU 与内存配额、运行时并发控制和网络访问白名单。

## 8. 新增一个智能体的推荐步骤

1. **界定能力**：写清楚它解决什么业务问题、不解决什么、需要哪些输入、交付什么结果。
2. **设计协议**：先写 `input.schema.json` 与 `result.schema.json`，定义正文、证据、风险和工件。
3. **创建新包目录**：使用新的包目录和语义化版本号，不覆盖已审核包。
4. **写静态清单**：在 `agent.yaml` 中声明身份、运行时、能力、入口与自检命令。
5. **实现业务代码**：`main.ts` 使用公共 `agent-runtime`；`run-task.ts` 仅处理业务；所有文件输出限制在节点目录。
6. **实现无业务数据自检**：只验证运行依赖和配置格式。
7. **写 README**：说明能力、输入输出、运行时、目录产物、失败条件和人工验收点。
8. **本地验证**：运行类型检查、协议/清单检查和针对业务逻辑的单元测试。
9. **部署后待审核**：让目录发现服务登记为 `pending_review`，由管理员批准后观察自检和就绪状态。
10. **真实烟囱测试**：提交最小工单，检查心跳、SSE、结果、工件哈希、下游绑定、停止和恢复行为。

常用命令：

```bash
corepack pnpm run typecheck
corepack pnpm run agent:validate
corepack pnpm test
```

`agent:validate` 当前包含已登记智能体的清单/自检验证；新增智能体后，应同步扩展该脚本或增加针对该包的独立校验与测试。

## 9. 代码导航

| 主题 | 主要代码或文档 |
| --- | --- |
| 包扫描与待审核登记 | `apps/control-plane/src/registry/agent-package-discovery.service.ts`、`registry.service.ts` |
| 发布、下线、删除 | `apps/control-plane/src/registry/factory-releases.controller.ts`、`agent-retirement.ts` |
| 节点就绪目录与启动 | `apps/node-manager/src/catalog/`、`apps/node-manager/src/supervisor/systemd.supervisor.ts` |
| 通用消息协议 | `packages/agent-protocol/src/` |
| 智能体公共启动与回调 | `packages/agent-runtime/src/` |
| DAG 规划与编译 | `apps/control-plane/src/planning/`、`packages/agent-protocol/src/compiler.ts` |
| 节点调度、绑定、恢复 | `apps/control-plane/src/tasks/task-scheduler.service.ts`、`task-recovery.service.ts`、`task-liveness.service.ts` |
| 事件、SSE、运行日志 | `apps/control-plane/src/internal/`、`apps/control-plane/src/observability/` |
| Codex CLI 适配 | `packages/codex-runtime/src/index.ts` |
| 示例：知识检索智能体 | `agents/ragflow-knowledge/` |
| 示例：PPT / Codex 智能体 | `agents/ppt-maker/` |

## 10. 当前实现边界

当前系统已实现单机 Linux + systemd + PostgreSQL 下的智能体发现、审核、自检、独立实例启动、DAG 调度、任务目录隔离、事件回调、SSE 监控、停止、一次失联重试、交付归档、人工验收与返工。

尚不应误认为已经具备的能力包括：多服务器节点集群调度、多租户权限体系、强操作系统沙箱、跨节点共享内存、Codex app-server 会话托管、自动弹性扩缩容和完整企业级 RBAC。这些是后续可在不破坏本文协议边界的前提下逐步演进的方向。
