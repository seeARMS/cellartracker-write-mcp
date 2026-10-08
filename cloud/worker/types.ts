import type {ResponseDiagnostics} from './diagnostics.js';
export class SafeError extends Error {}
export type CooldownSource='provider_retry_after'|'fallback';
export interface ProviderGate {assertAvailable(cached?:boolean):Promise<void>;record(retryAt:number,source:CooldownSource,code?:string):Promise<void>;pace?(deadline:number):Promise<void>;acquire?(deadline:number):Promise<string>;release?(lease:string):Promise<void>;rateLimited?(providerDelay:number|undefined):Promise<{retryAt:number;source:CooldownSource;streak:number}>;block?(code:string):Promise<void>}
export interface RetryDiagnostics {error_origin:'upstream_http'|'saved_provider_cooldown'|'snapshot_state'|'request_pacing'|'read_failure'|'pending_request'|'reconciliation_state';request_kind?:BrowserRequest['kind'];upstream_page?:number;total_upstream_attempts?:number;successful_upstream_reads?:number;rate_limit_streak?:number;request_id?:string;operation_id?:string;response_classification?:'http_rate_limit'|'service_error'|'network_failure';response_metadata?:ResponseDiagnostics}
export interface RetryMetadata extends RetryDiagnostics {error_code:string;upstream_status?:number;attempts:number;retry_at:string;retry_after_seconds:number;cooldown_source:CooldownSource;automatic_retry_allowed:boolean;submission_retry_allowed:false}
export class RetryError extends SafeError {constructor(message:string,readonly metadata:RetryMetadata){super(message);}}
export class AccessError extends SafeError {constructor(message:string,readonly status:number){super(message);}}
export interface Bottle {id:string;wine:string;wineId?:string;size?:string;location:string;bin:string}
export interface Inventory {accountId:string;bottles:Bottle[]}
export interface ConsumptionDetails {date:string;type:number;note:string}
export interface ConsumedBottle extends ConsumptionDetails {id:string;consumedId:string;wineId:string}
export interface ConsumptionHistory {accountId:string;records:ConsumedBottle[]}
export type BrowserRequest={kind:'inventory'|'consumed';page:number}|{kind:'consumptionForm'}|{kind:'consumptionDetails';wineId:string;consumedId:string}|{kind:'consume';ids:string[];details:ConsumptionDetails;currency:string;expiresAt?:number};
export interface Transport {request(request:BrowserRequest):Promise<{status:number;text:string;url:string}>}
export interface ConsumptionCellar {inventory():Promise<Inventory>;consumed(ids:string[]):Promise<ConsumptionHistory>;prepareConsumption?(details:ConsumptionDetails):Promise<string>;consume(ids:string[],details:ConsumptionDetails,currency?:string,expiresAt?:number):Promise<void>}
export interface D1Statement {bind(...values:unknown[]):D1Statement;first<T=Record<string,unknown>>():Promise<T|null>;run():Promise<{meta:{changes:number}}>}
export interface D1Database {prepare(sql:string):D1Statement;batch(statements:D1Statement[]):Promise<{meta:{changes:number}}[]>}
export interface Environment {DB?:D1Database;CELLARTRACKER_OWNER_USER_ID?:string;CELLARTRACKER_EXPECTED_ACCOUNT_ID?:string;CELLARTRACKER_READS_ENABLED?:string;CELLARTRACKER_WRITES_ENABLED?:string;CELLARTRACKER_SESSION_JSON?:string;CELLARTRACKER_COOKIE?:string;CELLARTRACKER_SESSION_EXPIRES_AT?:string}
