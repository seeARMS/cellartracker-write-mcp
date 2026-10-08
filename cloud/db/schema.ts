import {sqliteTable,text,integer,primaryKey,uniqueIndex,index} from 'drizzle-orm/sqlite-core';
export const operations=sqliteTable('operations',{
 id:text('id').primaryKey(),owner:text('owner').notNull(),requestKey:text('request_key').notNull(),
 fingerprint:text('fingerprint').notNull(),accountId:text('account_id').notNull(),body:text('body').notNull(),
 status:text('status').notNull(),createdAt:integer('created_at').notNull(),expiresAt:integer('expires_at').notNull(),
 submittedAt:integer('submitted_at'),observation:text('observation'),checkingToken:text('checking_token'),checkingUntil:integer('checking_until')
},t=>[uniqueIndex('operations_owner_request').on(t.owner,t.requestKey),index('operations_owner_status').on(t.owner,t.status,t.expiresAt)]);
export const bottleClaims=sqliteTable('bottle_claims',{
 owner:text('owner').notNull(),accountId:text('account_id').notNull(),bottleId:text('bottle_id').notNull(),
 operationId:text('operation_id').notNull().references(()=>operations.id)
},t=>[primaryKey({columns:[t.owner,t.accountId,t.bottleId]}),index('claims_operation').on(t.operationId)]);
export const accountLocks=sqliteTable('account_locks',{
 owner:text('owner').primaryKey(),operationId:text('operation_id').notNull().references(()=>operations.id)
});
// One short-lived, credential-free discovery snapshot and refresh lease per owner.
export const inventorySnapshots=sqliteTable('inventory_snapshots',{
 owner:text('owner').primaryKey(),scope:text('scope').notNull(),snapshotId:text('snapshot_id'),body:text('body'),
 fetchedAt:integer('fetched_at').notNull().default(0),expiresAt:integer('expires_at').notNull().default(0),
 leaseId:text('lease_id'),leaseUntil:integer('lease_until').notNull().default(0),
 retryAt:integer('retry_at').notNull().default(0),retryCode:text('retry_code')
});
// Independent of discovery snapshots, so invalidation cannot erase provider backoff.
export const providerCooldowns=sqliteTable('provider_cooldowns',{
 owner:text('owner').notNull(),accountId:text('account_id').notNull(),retryAt:integer('retry_at').notNull(),source:text('source').notNull(),retryCode:text('retry_code').notNull().default('CELLARTRACKER_RATE_LIMITED')
},t=>[primaryKey({columns:[t.owner,t.accountId]})]);
export const providerRequestSlots=sqliteTable('provider_request_slots',{
 owner:text('owner').notNull(),accountId:text('account_id').notNull(),nextAt:integer('next_at').notNull()
},t=>[primaryKey({columns:[t.owner,t.accountId]})]);

// Credential-free coordination: one in-flight request and a persistent circuit breaker.
export const providerState=sqliteTable('provider_state',{
 owner:text('owner').primaryKey(),leaseId:text('lease_id'),leaseUntil:integer('lease_until').notNull().default(0),
 failures:integer('failures').notNull().default(0),lastFailureAt:integer('last_failure_at').notNull().default(0),blockedCode:text('blocked_code')
});
export const pendingRequests=sqliteTable('pending_requests',{
 owner:text('owner').notNull(),requestKey:text('request_key').notNull(),operationId:text('operation_id').notNull(),
 fingerprint:text('fingerprint').notNull(),body:text('body').notNull(),createdAt:integer('created_at').notNull(),
 retryAt:integer('retry_at').notNull().default(0),attempts:integer('attempts').notNull().default(0),
 leaseId:text('lease_id'),leaseUntil:integer('lease_until').notNull().default(0),error:text('error')
},t=>[primaryKey({columns:[t.owner,t.requestKey]})]);
// Parsed read-only reconciliation progress; never usable as execution preflight.
export const reconciliationReads=sqliteTable('reconciliation_reads',{
 owner:text('owner').notNull(),operationId:text('operation_id').notNull().references(()=>operations.id),
 scope:text('scope').notNull(),generationId:text('generation_id').notNull(),body:text('body').notNull(),
 startedAt:integer('started_at').notNull(),expiresAt:integer('expires_at').notNull(),
 leaseId:text('lease_id'),leaseUntil:integer('lease_until').notNull().default(0)
},t=>[primaryKey({columns:[t.owner,t.operationId]})]);
