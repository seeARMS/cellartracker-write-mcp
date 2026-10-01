import {RetryError,type CooldownSource} from './types.js';
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
export function retryFailure(code:string,status:number|undefined,attempts:number,retryAt:number,now:number,source:CooldownSource='fallback'){
 const description=code==='CELLARTRACKER_RATE_LIMITED'?'CellarTracker rate-limited the request.':code==='CELLARTRACKER_READ_IN_PROGRESS'?'An inventory snapshot is already being refreshed.':code==='CELLARTRACKER_SNAPSHOT_EXPIRED'?'The requested inventory snapshot expired or was invalidated.':'The bounded upstream read could not complete.';
 const boundedRetryAt=Math.min(8_640_000_000_000_000,retryAt);
 return new RetryError(`[${code}] ${description} The server stopped within its bounded read retry policy. Do not automatically repeat this tool call; respect retry_at. Consumption submissions are never retried.`,{error_code:code,...(status===undefined?{}:{upstream_status:status}),attempts,retry_at:new Date(boundedRetryAt).toISOString(),retry_after_seconds:Math.max(0,Math.ceil((boundedRetryAt-now)/1000)),cooldown_source:source,automatic_retry_allowed:false,submission_retry_allowed:false});
}
