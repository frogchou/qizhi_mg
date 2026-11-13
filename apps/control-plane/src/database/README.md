# 控制平面数据库设计

PostgreSQL 是第一期任务状态、审计与恢复信息的唯一持久化真相来源。大文件只存放在任务产物目录，数据库记录其路径、校验值和产生关系。

## 表与职责

| 表 | 作用 | 主字段 |
| --- | --- | --- |
| `agents` | 智能体稳定身份 | `id`, `display_name`, `created_at` |
| `agent_versions` | 智能体包版本及审核状态 | `id`, `agent_id`, `version`, `status`, `manifest` |
| `tasks` | 用户提交的业务任务 | `id`, `goal`, `acceptance_mode`, `state`, `workspace_path`, `planner_summary`, `current_plan_version` |
| `task_input_uploads` | 创建任务前的短暂上传暂存 | `id`, `owner_subject`, `original_filename`, `media_type`, `size_bytes`, `sha256`, `storage_key`, `state`, `expires_at` |
| `task_inputs` | 已冻结到特定任务的私有资料快照 | `id`, `task_id`, `source_type`, `display_name`, `workspace_relative_path`, `source_ref`, `provenance`, `sha256` |
| `task_input_audits` | 资料上传、冻结、授权和下载审计 | `id`, `task_id`, `task_input_id`, `upload_id`, `action`, `actor_subject`, `detail` |
| `task_plans` | 冻结的可执行计划 | `id`, `task_id`, `version`, `plan`, `state` |
| `task_nodes` | 计划中的单个节点 | `id`, `plan_id`, `node_key`, `capability`, `agent_id`, `agent_version`, `depends_on`, `workspace_path`, `display_title`, `rationale`, `state`, `input` |
| `task_attempts` | 节点的一次执行尝试 | `id`, `task_node_id`, `instance_id`, `unit_name`, `lease_token`, `lease_expires_at`, `last_heartbeat_at`, `result_received_at`, `state` |
| `task_events` | 实例上报的有序事件 | `id`, `instance_id`, `sequence`, `event_type`, `payload` |
| `task_checkpoints` | 已确认的恢复点 | `id`, `task_attempt_id`, `checkpoint`, `confirmed_at` |
| `task_interactions` | 中台或智能体提出的待答问题 | `id`, `task_id`, `task_node_id`, `plan_node_key`, `source`, `response_schema`, `checkpoint`, `state`, `answer`, `resume_round` |
| `task_interaction_messages` | 交互问题、用户回答及附件元数据 | `interaction_id`, `sequence`, `role`, `structured_content`, `attachments` |
| `task_sessions` | 任务规划、审批、恢复与执行决定的时间序列 | `task_id`, `kind`, `payload`, `occurred_at` |
| `approval_requests` | 人工审核请求与决定 | `id`, `task_id`, `kind`, `state`, `decision` |
| `audit_events` | 只追加的管理与执行审计 | `id`, `occurred_at`, `actor`, `action`, `payload` |

## 关键约束

- `agent_versions` 对 `(agent_id, version)` 唯一，避免同一包版本被重复审核。
- `task_events` 对 `(instance_id, sequence)` 唯一，过期或重复回调不能覆盖当前状态。
- `task_attempts.lease_token` 与 `lease_expires_at` 决定某个实例是否仍有资格写入事件。
- 业务表中的 JSON 使用 `jsonb`，便于在协议版本演进时保留原始事实。
- 数据库层不允许应用更新或删除 `audit_events`；第一期不承诺防范拥有数据库管理员权限者的篡改。
- 任务目录保存可移植的计划、会话、节点文件和产物；数据库保存事务状态、检索索引、租约与审计。目录快照不能替代数据库的并发和租约判断。
- `task_input_uploads` 只能是 `ready`、`consumed` 或 `discarded`；创建任务只接受同一主体尚未过期的 `ready` 上传。暂存路径只供中台使用，绝不返回浏览器或智能体。
- `task_inputs.workspace_relative_path` 必须被解析为任务根目录内的相对路径；任务资料内容存在文件系统快照，数据库仅保存元数据、来源与校验值。
- `task_input_audits` 是追加记录。资料正文、暂存绝对路径、令牌和 API Key 不能出现在其 `detail` 中。
- `task_interactions` 在同一任务、计划节点与恢复轮次只有一条 `pending` 记录；状态按 `pending → answered → resumed` 推进，或由管理员显式转为 `cancelled`。浏览器回答由幂等键保护。
- `task_nodes.node_type` 与 `definition` 保存不可变的编译节点定义；`human_interaction` 也拥有运行时节点，但不伪造智能体身份或执行尝试。

### 交付验收轮次（迁移 0007）

`task_acceptance_rounds` 每个任务、每轮有唯一记录。id 为客户端决定需匹配的 UUID，task_id 关联任务，round 从 1 递增。criteria 保存来源于用户原话的要求、优先级和依据。assessment 保存逐项状态、理由、引用证据、智能体披露的资料缺项及核验异常。created_at 为完成核验时间。decision 和 decided_at 为管理员决定及时间，尚未决定时为空。supplement_node 保存该轮批准的补查节点与有界上下文，在重启后供调度器恢复。原执行图及先前节点结果保留。
