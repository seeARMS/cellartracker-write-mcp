import {sqliteTable,text,integer,primaryKey,uniqueIndex,index} from 'drizzle-orm/sqlite-core';
export const operations=sqliteTable('operations',{
 id:text('id').primaryKey(),owner:text('owner').notNull(),requestKey:text('request_key').notNull(),
 fingerprint:text('fingerprint').notNull(),accountId:text('account_id').notNull(),body:text('body').notNull(),
 status:text('status').notNull(),createdAt:integer('created_at').notNull(),expiresAt:integer('expires_at').notNull(),
 submittedAt:integer('submitted_at'),observation:text('observation')
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
 owner:text('owner').notNull(),accountId:text('account_id').notNull(),retryAt:integer('retry_at').notNull(),source:text('source').notNull()
},t=>[primaryKey({columns:[t.owner,t.accountId]})]);
export const providerRequestSlots=sqliteTable('provider_request_slots',{
 owner:text('owner').notNull(),accountId:text('account_id').notNull(),nextAt:integer('next_at').notNull()
},t=>[primaryKey({columns:[t.owner,t.accountId]})]);
