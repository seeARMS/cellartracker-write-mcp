import {realClock,retryFailure,type RetryClock} from './backoff.js';
import type {CooldownSource,D1Database,ProviderGate} from './types.js';
interface Cooldown {retry_at:number;source:CooldownSource}
export class ProviderCooldown implements ProviderGate {
 constructor(private db:D1Database,private owner:string,private account:string,private clock:RetryClock=realClock){}
 async assertAvailable(){
  // An unbound setup verification still throttles the same owner's subsequent bound requests.
  const row=await this.db.prepare('SELECT retry_at,source FROM provider_cooldowns WHERE owner=? AND (account_id=? OR account_id=?) AND retry_at>? ORDER BY retry_at DESC LIMIT 1').bind(this.owner,this.account,'unbound',this.clock.now()).first<Cooldown>();
  if(row)throw retryFailure('CELLARTRACKER_RATE_LIMITED',429,0,row.retry_at,this.clock.now(),row.source==='provider_retry_after'?'provider_retry_after':'fallback');
 }
 async record(retryAt:number,source:CooldownSource){
  await this.db.prepare(`INSERT INTO provider_cooldowns(owner,account_id,retry_at,source) VALUES(?,?,?,?)
   ON CONFLICT(owner,account_id) DO UPDATE SET retry_at=excluded.retry_at,source=excluded.source
   WHERE excluded.retry_at>provider_cooldowns.retry_at`).bind(this.owner,this.account,Math.min(8_640_000_000_000_000,retryAt),source).run();
 }
}
