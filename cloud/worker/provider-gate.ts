import {realClock,retryFailure,type RetryClock} from './backoff.js';
import type {CooldownSource,D1Database,ProviderGate} from './types.js';
interface Cooldown {retry_at:number;source:CooldownSource}
export const providerRequestSpacingMs=2000;
export class ProviderCooldown implements ProviderGate {
 constructor(private db:D1Database,private owner:string,private account:string,private clock:RetryClock=realClock){}
 async assertAvailable(){
  // An unbound setup verification still throttles the same owner's subsequent bound requests.
  const row=await this.db.prepare('SELECT retry_at,source FROM provider_cooldowns WHERE owner=? AND (account_id=? OR account_id=?) AND retry_at>? ORDER BY retry_at DESC LIMIT 1').bind(this.owner,this.account,'unbound',this.clock.now()).first<Cooldown>();
  if(row)throw retryFailure('CELLARTRACKER_RATE_LIMITED',undefined,0,row.retry_at,this.clock.now(),row.source==='provider_retry_after'?'provider_retry_after':'fallback',{error_origin:'saved_provider_cooldown'});
 }
 async record(retryAt:number,source:CooldownSource){
  await this.db.prepare(`INSERT INTO provider_cooldowns(owner,account_id,retry_at,source) VALUES(?,?,?,?)
   ON CONFLICT(owner,account_id) DO UPDATE SET retry_at=excluded.retry_at,source=excluded.source
   WHERE excluded.retry_at>provider_cooldowns.retry_at`).bind(this.owner,this.account,Math.min(8_640_000_000_000_000,retryAt),source).run();
 }
 async pace(deadline:number){
  while(true){
   await this.assertAvailable();
   const now=this.clock.now();
   if(now>=deadline)throw retryFailure('CELLARTRACKER_PACING_DEADLINE',undefined,0,now+providerRequestSpacingMs,now,'fallback',{error_origin:'request_pacing'});
   const slot=await this.db.prepare(`INSERT INTO provider_request_slots(owner,account_id,next_at) VALUES(?,?,?)
    ON CONFLICT(owner,account_id) DO UPDATE SET next_at=excluded.next_at
    WHERE provider_request_slots.next_at<=?`).bind(this.owner,this.account,now+providerRequestSpacingMs,now).run();
   if(slot.meta.changes)return;
   const row=await this.db.prepare('SELECT next_at FROM provider_request_slots WHERE owner=? AND account_id=?').bind(this.owner,this.account).first<{next_at:number}>();
   const retryAt=row?.next_at??now+providerRequestSpacingMs;
   if(retryAt>=deadline)throw retryFailure('CELLARTRACKER_PACING_DEADLINE',undefined,0,retryAt,now,'fallback',{error_origin:'request_pacing'});
   await this.clock.sleep(Math.max(1,retryAt-this.clock.now()));
  }
 }
}
