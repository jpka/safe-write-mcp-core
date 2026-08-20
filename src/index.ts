export { PlanError } from "./errors.js";
export type { PlanErrorCode } from "./errors.js";
export { NoopSink } from "./audit.js";
export type { AuditEvent, AuditSink, AuditStatus } from "./audit.js";
export { fingerprint } from "./fingerprint.js";
export { PlanStore } from "./planStore.js";
export type {
  ApproveResult,
  BeginExecuteResult,
  ConsumeResult,
  ConfirmResult,
  PendingPlan,
  PlanCreated,
  PlanCreateOptions,
  PlanMeta,
  PlanStoreOptions,
  ReconcileCallback,
  ReconcileResult,
  RejectResult,
} from "./planStore.js";
export { createApprovalServer, startApprovalServer } from "./approvalServer.js";
export type {
  ApprovalDecision,
  ApprovalServerHandle,
  ApprovalServerOptions,
  RenderablePlan,
  RenderPlan,
} from "./approvalServer.js";

// Journal exports
export { FileJournal, NoopJournal } from "./journal.js";
export type { Journal, JournalEntry, JournalStatus } from "./journal.js";
export { replayJournal } from "./replay.js";
