export class SafeError extends Error {}
export type CooldownSource='provider_retry_after'|'fallback';
export interface ProviderGate {assertAvailable():Promise<void>;record(retryAt:number,source:CooldownSource):Promise<void>}
export interface RetryMetadata {error_code:string;upstream_status?:number;attempts:number;retry_at:string;retry_after_seconds:number;cooldown_source:CooldownSource;automatic_retry_allowed:false;submission_retry_allowed:false}
export class RetryError extends SafeError {constructor(message:string,readonly metadata:RetryMetadata){super(message);}}
export class AccessError extends SafeError {constructor(message:string,readonly status:number){super(message);}}
export interface Bottle {id:string;wine:string;wineId?:string;size?:string;location:string;bin:string}
export interface Inventory {accountId:string;bottles:Bottle[]}
export interface ConsumptionDetails {date:string;type:number;note:string}
export interface ConsumedBottle extends ConsumptionDetails {id:string;consumedId:string;wineId:string}
export interface ConsumptionHistory {accountId:string;records:ConsumedBottle[]}
export type BrowserRequest={kind:'inventory'|'consumed';page:number}|{kind:'consumptionForm'}|{kind:'consumptionDetails';wineId:string;consumedId:string}|{kind:'consume';ids:string[];details:ConsumptionDetails;currency:string};
export interface Transport {request(request:BrowserRequest):Promise<{status:number;text:string;url:string}>}
export interface ConsumptionCellar {inventory():Promise<Inventory>;consumed(ids:string[]):Promise<ConsumptionHistory>;consume(ids:string[],details:ConsumptionDetails):Promise<void>}
export interface D1Statement {bind(...values:unknown[]):D1Statement;first<T=Record<string,unknown>>():Promise<T|null>;run():Promise<{meta:{changes:number}}>}
export interface D1Database {prepare(sql:string):D1Statement;batch(statements:D1Statement[]):Promise<{meta:{changes:number}}[]>}
export interface Environment {DB?:D1Database;CELLARTRACKER_OWNER_USER_ID?:string;CELLARTRACKER_EXPECTED_ACCOUNT_ID?:string;CELLARTRACKER_READS_ENABLED?:string;CELLARTRACKER_WRITES_ENABLED?:string;CELLARTRACKER_SESSION_JSON?:string;CELLARTRACKER_SESSION_EXPIRES_AT?:string}
