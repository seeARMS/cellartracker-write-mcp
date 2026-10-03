import {SafeError,RetryError,type D1Database} from './types.js';
import {realClock,retryFailure,type RetryClock} from './backoff.js';
import type {PlanInput} from './consumption.js';
import {validateConsumption} from './validation.js';
export const pendingPolicy={leaseMs:120000,maxAttempts:12,maxAgeMs:86400000};
export interface ConsumptionIntent {request_id:string;wine:string;quantity:number;date:string;note?:string}
interface Row {owner:string;request_key:string;operation_id:string;fingerprint:string;body:string;created_at:number;retry_at:number;attempts:number;lease_id:string|null;lease_until:number;error:string|null}
export async function fingerprint(value:unknown){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export class PendingRequests {
 constructor(private db:D1Database,private owner:string,private clock:RetryClock=realClock){}
 private row(id:string){return this.db.prepare('SELECT * FROM pending_requests WHERE owner=? AND request_key=?').bind(this.owner,id).first<Row>();}
 async get(id:string){const row=await this.row(id);if(!row)throw new SafeError('Pending consumption request not found for this owner.');return {request_id:id,operation_id:row.operation_id,pending:JSON.parse(row.body),attempts:row.attempts,created_at:new Date(row.created_at).toISOString(),retry_at:new Date(row.retry_at).toISOString(),last_error:row.error?JSON.parse(row.error):null,automatic_retry_allowed:row.attempts<pendingPolicy.maxAttempts&&this.clock.now()<row.created_at+pendingPolicy.maxAgeMs&&!(row.error&&JSON.parse(row.error).terminal),background_worker_scheduled:false};}
 async saveIntent(input:ConsumptionIntent){
  if(!input.wine.trim())throw new SafeError('A wine description is required to save the request.');
  validateConsumption({date:input.date,type:1,note:input.note??''});
  const intent={wine:input.wine,quantity:input.quantity,date:input.date,note:input.note??''};
  const key=await fingerprint(intent);const old=await this.row(input.request_id);
  if(old){if(JSON.stringify(JSON.parse(old.body).intent)!==JSON.stringify(intent))throw new SafeError('This request ID already identifies a different consumption instruction.');return this.get(input.request_id);}
  await this.db.prepare('INSERT OR IGNORE INTO pending_requests(owner,request_key,operation_id,fingerprint,body,created_at) VALUES(?,?,?,?,?,?)').bind(this.owner,input.request_id,crypto.randomUUID(),key,JSON.stringify({phase:'lookup',intent}),this.clock.now()).run();
  return this.saveIntent(input);
 }
 async prepare(input:PlanInput,key:string){
  let row=await this.row(input.request_id);
  if(row&&JSON.parse(row.body).phase==='lookup'){
   const intent=JSON.parse(row.body).intent;
   if(intent.date!==input.date||intent.note!==(input.note??'')||intent.quantity!==(input.bottle_ids?.length??input.quantity))throw new SafeError('Exact plan differs from the saved consumption date, quantity, or note.');
   await this.db.prepare('UPDATE pending_requests SET fingerprint=?,body=? WHERE owner=? AND request_key=? AND fingerprint=?').bind(key,JSON.stringify({phase:'plan',intent,input}),this.owner,input.request_id,row.fingerprint).run();
   row=await this.row(input.request_id);
  }
  if(!row){
   await this.db.prepare('INSERT OR IGNORE INTO pending_requests(owner,request_key,operation_id,fingerprint,body,created_at) VALUES(?,?,?,?,?,?)').bind(this.owner,input.request_id,crypto.randomUUID(),key,JSON.stringify({phase:'plan',input}),this.clock.now()).run();
   row=await this.row(input.request_id);
  }
  if(row!.fingerprint!==key)throw new SafeError('This request ID already identifies different consumption details. Do not reuse it for another action.');
  const now=this.clock.now();
  if(row!.attempts>=pendingPolicy.maxAttempts||now>=row!.created_at+pendingPolicy.maxAgeMs)throw retryFailure('CELLARTRACKER_PENDING_BUDGET',undefined,0,now,now,'fallback',{error_origin:'pending_request',request_id:input.request_id,operation_id:row!.operation_id});
  if(row!.error&&JSON.parse(row!.error).terminal)throw new SafeError('This pending request requires review of its saved error before continuing. No automatic retry is allowed.');
  if(row!.retry_at>now||row!.lease_until>now)throw retryFailure('CELLARTRACKER_READ_IN_PROGRESS',undefined,0,Math.max(row!.retry_at,row!.lease_until),now,'fallback',{error_origin:'pending_request',request_id:input.request_id,operation_id:row!.operation_id});
  const lease=crypto.randomUUID();
  const changed=await this.db.prepare('UPDATE pending_requests SET lease_id=?,lease_until=?,attempts=attempts+1 WHERE owner=? AND request_key=? AND lease_until<=? AND retry_at<=? AND attempts<?').bind(lease,now+pendingPolicy.leaseMs,this.owner,input.request_id,now,now,pendingPolicy.maxAttempts).run();
  if(!changed.meta.changes)throw retryFailure('CELLARTRACKER_READ_IN_PROGRESS',undefined,0,now+pendingPolicy.leaseMs,now,'fallback',{error_origin:'pending_request',request_id:input.request_id,operation_id:row!.operation_id});
  return {id:row!.operation_id,lease};
 }
 async assertLease(id:string,lease:string){const row=await this.row(id);if(row?.lease_id!==lease||row.lease_until<=this.clock.now())throw new SafeError('Pending request lease expired. A later attempt owns its result.');}
 async finish(id:string,lease:string,error?:unknown){
  // No native exceptions, headers, response bodies, or credentials are persisted.
  const metadata=error instanceof RetryError?error.metadata:error?{terminal:true,error_code:error instanceof SafeError?'VALIDATION_OR_ACCESS_FAILURE':'INTERNAL_FAILURE'}:undefined;
  await this.db.prepare('UPDATE pending_requests SET lease_id=NULL,lease_until=0,retry_at=?,error=? WHERE owner=? AND request_key=? AND lease_id=?').bind(error instanceof RetryError?Date.parse(error.metadata.retry_at):0,metadata?JSON.stringify(metadata):null,this.owner,id,lease).run();
 }
}
