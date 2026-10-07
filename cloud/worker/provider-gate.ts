import {realClock,retryFailure,type RetryClock} from './backoff.js';
import {SafeError,type CooldownSource,type D1Database,type ProviderGate} from './types.js';
interface Cooldown {retry_at:number;source:CooldownSource;retry_code?:string}
export const providerRequestSpacingMs=10000;
export class ProviderCooldown implements ProviderGate {
 constructor(private db:D1Database,private owner:string,private account:string,private clock:RetryClock=realClock){}
 async status(){
  const state=await this.db.prepare('SELECT failures,last_failure_at,blocked_code FROM provider_state WHERE owner=?').bind(this.owner).first<{failures:number;last_failure_at:number;blocked_code:string|null}>();
  const row=await this.db.prepare('SELECT retry_at,source,retry_code FROM provider_cooldowns WHERE owner=? AND retry_at>? ORDER BY retry_at DESC LIMIT 1').bind(this.owner,this.clock.now()).first<Cooldown>();
  return {blocked_code:state?.blocked_code??null,rate_limit_streak:state?.failures??0,last_rate_limit_at:state?.last_failure_at?new Date(state.last_failure_at).toISOString():null,retry_at:row?new Date(row.retry_at).toISOString():null,cooldown_source:row?.source??null,cooldown_code:row?.retry_code??null,automatic_retry_allowed:false};
 }
 async assertAvailable(cached=false){
  const state=await this.db.prepare('SELECT blocked_code FROM provider_state WHERE owner=?').bind(this.owner).first<{blocked_code:string|null}>();
  if(state?.blocked_code)throw new SafeError(`[${state.blocked_code}] Upstream access needs owner review through the supported provider flow. Automatic retries are paused. No upstream request was sent.`);
  if(cached)return;
  // An unbound setup verification still throttles the same owner's subsequent bound requests.
  const row=await this.db.prepare('SELECT retry_at,source,retry_code FROM provider_cooldowns WHERE owner=? AND retry_at>? ORDER BY retry_at DESC LIMIT 1').bind(this.owner,this.clock.now()).first<Cooldown>();
  if(row)throw retryFailure(row.retry_code==='CELLARTRACKER_RATE_LIMITED'?'CELLARTRACKER_RATE_LIMITED':'CELLARTRACKER_READ_COOLDOWN',undefined,0,row.retry_at,this.clock.now(),row.source==='provider_retry_after'?'provider_retry_after':'fallback',{error_origin:'saved_provider_cooldown'});
 }
 async block(code:string){
  if(!['CELLARTRACKER_BROWSER_CHALLENGE','CELLARTRACKER_ACCESS_DENIED','CELLARTRACKER_AUTHENTICATION_REQUIRED'].includes(code))throw new SafeError('Invalid provider block classification.');
  await this.db.prepare('INSERT INTO provider_state(owner,blocked_code) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET blocked_code=excluded.blocked_code').bind(this.owner,code).run();
 }
 async rateLimited(providerDelay:number|undefined){
  const now=this.clock.now();
  await this.db.prepare(`INSERT INTO provider_state(owner,failures,last_failure_at) VALUES(?,1,?)
   ON CONFLICT(owner) DO UPDATE SET failures=CASE WHEN provider_state.last_failure_at<? THEN 1 ELSE MIN(provider_state.failures+1,32) END,last_failure_at=excluded.last_failure_at`).bind(this.owner,now,now-24*3600000).run();
  const state=await this.db.prepare('SELECT failures FROM provider_state WHERE owner=?').bind(this.owner).first<{failures:number}>();
  const streak=state!.failures,base=Math.min(6*3600000,15*60000*2**Math.min(streak-1,5));
  const source:CooldownSource=providerDelay!==undefined&&providerDelay>=base?'provider_retry_after':'fallback';
  const retryAt=Math.min(8_640_000_000_000_000,now+Math.max(base,providerDelay??0)+Math.floor(this.clock.random()*1000));
  await this.record(retryAt,source);return {retryAt,source,streak};
 }
 // The lease exceeds the capped fetch deadline. A crashed reader cannot leave a permanent lock.
 // Owner scope also serializes pre-binding verification with bound requests.
 async acquire(deadline:number){
  const lease=crypto.randomUUID();
  while(true){
   await this.assertAvailable();const now=this.clock.now();
   if(now>=deadline)throw retryFailure('CELLARTRACKER_PACING_DEADLINE',undefined,0,now+providerRequestSpacingMs,now,'fallback',{error_origin:'request_pacing'});
   const row=await this.db.prepare(`INSERT INTO provider_state(owner,lease_id,lease_until) VALUES(?,?,?)
    ON CONFLICT(owner) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until WHERE provider_state.lease_until<=?`).bind(this.owner,lease,deadline+5000,now).run();
   if(row.meta.changes)return lease;
   const state=await this.db.prepare('SELECT lease_until FROM provider_state WHERE owner=?').bind(this.owner).first<{lease_until:number}>();
   if(state!.lease_until>=deadline)throw retryFailure('CELLARTRACKER_READ_IN_PROGRESS',undefined,0,state!.lease_until,now,'fallback',{error_origin:'request_pacing'});
   await this.clock.sleep(Math.min(250,Math.max(1,state!.lease_until-now)));
  }
 }
 async release(lease:string){await this.db.prepare('UPDATE provider_state SET lease_id=NULL,lease_until=0 WHERE owner=? AND lease_id=?').bind(this.owner,lease).run();}
 async record(retryAt:number,source:CooldownSource,code='CELLARTRACKER_RATE_LIMITED'){
  await this.db.prepare(`INSERT INTO provider_cooldowns(owner,account_id,retry_at,source,retry_code) VALUES(?,?,?,?,?)
   ON CONFLICT(owner,account_id) DO UPDATE SET retry_at=excluded.retry_at,source=excluded.source,retry_code=excluded.retry_code
   WHERE excluded.retry_at>provider_cooldowns.retry_at`).bind(this.owner,this.account,Math.min(8_640_000_000_000_000,retryAt),source,code==='CELLARTRACKER_RATE_LIMITED'?code:'CELLARTRACKER_READ_COOLDOWN').run();
 }
 async pace(deadline:number){
  while(true){
   await this.assertAvailable();
   const now=this.clock.now();
   if(now>=deadline)throw retryFailure('CELLARTRACKER_PACING_DEADLINE',undefined,0,now+providerRequestSpacingMs,now,'fallback',{error_origin:'request_pacing'});
   const slot=await this.db.prepare(`INSERT INTO provider_request_slots(owner,account_id,next_at) VALUES(?,?,?)
    ON CONFLICT(owner,account_id) DO UPDATE SET next_at=excluded.next_at
    WHERE provider_request_slots.next_at<=?`).bind(this.owner,'owner',now+providerRequestSpacingMs,now).run();
   if(slot.meta.changes)return;
   const row=await this.db.prepare('SELECT next_at FROM provider_request_slots WHERE owner=? AND account_id=?').bind(this.owner,'owner').first<{next_at:number}>();
   const retryAt=row?.next_at??now+providerRequestSpacingMs;
   if(retryAt>=deadline)throw retryFailure('CELLARTRACKER_PACING_DEADLINE',undefined,0,retryAt,now,'fallback',{error_origin:'request_pacing'});
   await this.clock.sleep(Math.max(1,retryAt-this.clock.now()));
  }
 }
}
