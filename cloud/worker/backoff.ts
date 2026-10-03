import {RetryError,type CooldownSource,type RetryDiagnostics} from './types.js';
export interface RetryClock {now:()=>number;sleep:(ms:number)=>Promise<void>;random:()=>number}
export const realClock:RetryClock={now:()=>Date.now(),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),random:()=>Math.random()};
export const readRetryPolicy={maxAttempts:3,maxElapsedMs:30000,attemptTimeoutMs:20000,operationTimeoutMs:90000};
// Retry-After is either delta-seconds or an HTTP date. Never expose the raw header.
export function retryAfterMs(value:string|null,now:number):number|undefined{
 if(value===null)return undefined;const s=value.trim();
 if(/^\d+$/.test(s)){const seconds=Number(s);return Math.min(8_640_000_000_000_000-now,seconds*1000);}
 if(!/^(?:[A-Za-z]{3}, |[A-Za-z]+, |[A-Za-z]{3} )[\x20-\x7e]+$/.test(s))return undefined;
 const date=Date.parse(s);return Number.isFinite(date)?Math.max(0,date-now):undefined;
}
export function backoffMs(attempt:number,retryAfter:number|undefined,random:number){
 const base=Math.min(8000,1000*2**(attempt-1));
 return Math.max(base,retryAfter??0)+Math.floor(Math.max(0,Math.min(1,random))*250);
}
export function cooldownSource(attempt:number,retryAfter:number|undefined,exhausted:boolean):CooldownSource{
 return retryAfter!==undefined&&retryAfter>=Math.max(exhausted?60000:0,Math.min(8000,1000*2**(attempt-1)))?'provider_retry_after':'fallback';
}
export function retryFailure(code:string,status:number|undefined,attempts:number,retryAt:number,now:number,source:CooldownSource='fallback',diagnostics:RetryDiagnostics={error_origin:'read_failure'}){
 const description=diagnostics.error_origin==='saved_provider_cooldown'?'A saved provider cooldown is active. No upstream request was sent.':diagnostics.error_origin==='snapshot_state'&&code==='CELLARTRACKER_RATE_LIMITED'?'A saved snapshot-refresh cooldown is active. No upstream request was sent.':code==='CELLARTRACKER_RATE_LIMITED'?'The fixed upstream request returned HTTP 429. The next safe read is deferred until retry_at.':code==='CELLARTRACKER_READ_IN_PROGRESS'?'An inventory snapshot is already being refreshed.':code==='CELLARTRACKER_SNAPSHOT_EXPIRED'?'The requested inventory snapshot expired or was invalidated.':'The bounded upstream read could not complete.';
 const boundedRetryAt=Math.min(8_640_000_000_000_000,retryAt);
 const allowed=code!=='CELLARTRACKER_SNAPSHOT_EXPIRED'&&code!=='CELLARTRACKER_PENDING_BUDGET';
 return new RetryError(`[${code}] ${description} ${allowed?'Automatically resume safe reads no earlier than retry_at, reusing the same request and operation IDs.':'Inspect the saved request before continuing.'} Consumption submissions are never replayed.`,{error_code:code,...(status===undefined?{}:{upstream_status:status}),attempts,retry_at:new Date(boundedRetryAt).toISOString(),retry_after_seconds:Math.max(0,Math.ceil((boundedRetryAt-now)/1000)),cooldown_source:source,...diagnostics,automatic_retry_allowed:allowed,submission_retry_allowed:false});
}
