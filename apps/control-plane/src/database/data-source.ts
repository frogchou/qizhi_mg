import 'reflect-metadata';

import { DataSource } from 'typeorm';

import { InitialControlPlaneMigration } from './migrations/0001-initial-control-plane';
import { AgentOrchestrationMigration } from './migrations/0002-agent-orchestration';
import { TaskObservabilityMigration } from './migrations/0003-task-observability';
import { TaskArtifactsAndReworkMigration } from './migrations/0004-task-artifacts-and-rework';
import { TaskInputsMigration } from './migrations/0005-task-inputs';
import { TaskInteractionsMigration } from './migrations/0006-task-interactions';
import { TaskAcceptance1763136000000 } from './migrations/0007-task-acceptance';

export function createControlPlaneDataSource(databaseUrl: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    migrations: [InitialControlPlaneMigration, AgentOrchestrationMigration, TaskObservabilityMigration, TaskArtifactsAndReworkMigration, TaskInputsMigration, TaskInteractionsMigration, TaskAcceptance1763136000000],
    synchronize: false,
  });
}

export async function runMigrations(dataSource: DataSource): Promise<void> {
  await dataSource.runMigrations({ transaction: 'all' });
}
