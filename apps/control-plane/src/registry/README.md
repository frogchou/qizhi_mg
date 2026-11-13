# 智能体注册与审核

注册服务只读取一个候选包的 `agent.yaml`、输入 Schema 和结果 Schema，并将其原始清单快照登记为 `pending_review`。发现阶段不导入 TypeScript，不执行自检，更不会启动智能体进程。

发现和批准都会对输入、结果 Schema 做语义校验，确保其能转换为中台和 Agent Protocol 使用的受支持 Schema 子集。例如，数组必须声明 `items`。这样有问题的候选包不会在真实任务规划时才暴露错误；发现失败会记录 `agent.discovery_failed` 审计事件，已有的待审批旧版本会被隔离为 `self_check_failed` 并记录 `agent.pending_schema_quarantined`，也不能绕过校验被批准。

管理员通过 `POST /v1/agents/:agentId/versions/:version/approve` 批准某一精确版本后，状态才变为 `self_checking` 并请求节点管理器自检；节点管理器确认后才可变为 `ready`。发现、批准及自检结果都写入 `audit_events`。

控制面每次启动后会调用 `RegistryService.synchronizeReadyCatalog()`，把数据库中已经是 `ready` 的受审核版本重新同步给节点管理器。同步前会再次校验其数据库中保存的不可变声明快照；旧版本若不再符合支持的 Schema 约束，会被隔离为 `self_check_failed`，写入 `agent.ready_schema_quarantined` 审计事件，并且不会同步到节点管理器。该步骤不会读取智能体业务代码、不会重新自检、更不会提升 `pending_review` 版本；它只恢复已经批准的启动记录，避免节点管理器状态文件丢失或重启后无法拉起已审核智能体。

`AgentPackageDiscoveryService` 同时扫描 `MG_AGENT_PACKAGE_ROOT`（默认是控制面进程工作目录下的 `agents/`）并监听该目录。发现一个包含 `agent.yaml` 的一级目录时，它只读取清单与 JSON Schema、以 `system` 身份登记为 `pending_review`；不会导入、启动或自检其中的业务代码。管理员仍须显式批准精确的版本，才会触发首次自检和就绪同步。

扫描按目录名稳定排序并且逐包隔离：一个包的清单或 Schema 无效时，控制面向 `audit_events` 写入 `agent.discovery_failed`（包路径和截断后的原因），同时继续扫描后续目录。启动日志会输出成功/失败数量；失败包不会让已经正确部署的其他智能体从待审批列表中消失。

受审核版本的包目录必须保持不变。发布代码或清单变更时，应创建新的一级版本目录（例如 `ragflow-knowledge-v1.0.1/`），再登记和审核新版本；注册服务拒绝将一个已经分配给 `ready` 或 `self_checking` 版本的目录复用于另一版本。尚未审核版本如果被重新发布到新的目录，发现服务会刷新其声明快照，仍保持 `pending_review`。

外部 API 采用固定管理员 Bearer token。服务只保存其 SHA-256 哈希，比较使用恒定时间算法。
