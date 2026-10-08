import {parseInventory} from './cellar.js';
import {parseHistory,parseConsumptionDetails} from './history.js';
import {summarize} from './consumption.js';
import {CloudStore,type Operation,type Observation} from './store.js';
import {realClock,readRetryPolicy,retryFailure,type RetryClock} from './backoff.js';
import {RetryError,SafeError,type Bottle,type ConsumedBottle,type D1Database,type D1Statement,type ProviderGate,type Transport} from './types.js';

export const reconciliationPolicy={callMs:90000,leaseMs:95000,workflowMs:600000,maxBytes:1500000};
type HistoryRow=ReturnType<typeof parseHistory>['records'][number];
interface Paging {pages:number;total:number}
interface Progress {
 phase:'inventory'|'history'|'details'|'done';nextPage:number;
 inventoryPaging?:Paging;historyPaging?:Paging;bottles:Bottle[];rows:HistoryRow[];details:ConsumedBottle[];
}
interface Checkpoint {scope:string;generation_id:string;body:string;started_at:number;expires_at:number;lease_id:string|null;lease_until:number}
const initial=():Progress=>({phase:'inventory',nextPage:1,bottles:[],rows:[],details:[]});

// This class has only inventory, history and detail GETs. Execution never reads this table.
export class ReconciliationReads {
 private store:CloudStore;
 constructor(private db:D1Database,private owner:string,private account:string,private sessionExpiry:number,private transport:Transport,private gate:ProviderGate,private clock:RetryClock=realClock){this.store=new CloudStore(db,owner,clock);}
 private row(id:string){return this.db.prepare('SELECT * FROM reconciliation_reads WHERE owner=? AND operation_id=?').bind(this.owner,id).first<Checkpoint>();}
 private expired(){return new SafeError('[CELLARTRACKER_RECONCILIATION_EXPIRED] Read evidence expired or its operation/account/session scope changed. Deliberately restart read-only reconciliation with restart_reconciliation=true; never replay consumption.');}
 private fenced(){return new SafeError('[CELLARTRACKER_RECONCILIATION_FENCED] This reader lost its lease. Its evidence was not accepted. Continue read-only reconciliation; never replay consumption.');}
 private metadata(row:Checkpoint,state:Progress,complete=false){return {generation_id:row.generation_id,phase:state.phase,next_page:state.phase==='inventory'||state.phase==='history'?state.nextPage:null,details_completed:state.details.length,as_of:new Date(row.started_at).toISOString(),expires_at:new Date(row.expires_at).toISOString(),complete,continuation_required:!complete,automatic_retry_allowed:false,submission_retry_allowed:false};}
 private encode(state:Progress){const body=JSON.stringify(state);if(new TextEncoder().encode(body).length>reconciliationPolicy.maxBytes)throw new SafeError('[CELLARTRACKER_RECONCILIATION_SIZE] Parsed reconciliation exceeds the bounded storage size. No partial evidence can complete an operation.');return body;}
 private async save(id:string,row:Checkpoint,lease:string,state:Progress){
  const now=this.clock.now();const r=await this.db.prepare('UPDATE reconciliation_reads SET body=? WHERE owner=? AND operation_id=? AND generation_id=? AND lease_id=? AND lease_until>? AND expires_at>?').bind(this.encode(state),this.owner,id,row.generation_id,lease,now,now).run();
  if(r.meta.changes!==1)throw this.fenced();
 }
 private paging(data:{page:number;pages:number;total:number;accountId:string},page:number,expected?:Paging):Paging{
  if(data.accountId!==this.account||data.page!==page||!Number.isInteger(data.pages)||data.pages<1||data.pages>100||!Number.isInteger(data.total)||data.total<0||data.page>data.pages||(expected&&(data.pages!==expected.pages||data.total!==expected.total)))throw new SafeError('[CELLARTRACKER_RECONCILIATION_CHANGED] Account or pagination changed. No partial evidence can complete an operation.');
  return expected??{pages:data.pages,total:data.total};
 }
 private unique(ids:string[],total:number){if(ids.length>total||new Set(ids).size!==ids.length)throw new SafeError('[CELLARTRACKER_RECONCILIATION_INCOMPLETE] Duplicate or excess rows make reconciliation incomplete.');}
 private async read(state:Progress,op:Operation){
  const matching=state.rows.filter(r=>op.bottles.some(b=>b.id===r.id));
  const request=state.phase==='inventory'?{kind:'inventory' as const,page:state.nextPage}:state.phase==='history'?{kind:'consumed' as const,page:state.nextPage}:{kind:'consumptionDetails' as const,wineId:matching[state.details.length].wineId,consumedId:matching[state.details.length].consumedId};
  const response=await this.transport.request(request);
  const url=new URL(response.url);if(response.status!==200||url.origin!=='https://www.cellartracker.com'||/login/i.test(url.pathname))throw new SafeError('[CELLARTRACKER_RECONCILIATION_RESPONSE] Read response did not remain authenticated on the provider.');
  if(state.phase==='inventory'){
   const data=parseInventory(response.text);state.inventoryPaging=this.paging(data,state.nextPage,state.inventoryPaging);state.bottles.push(...data.bottles);this.unique(state.bottles.map(b=>b.id),data.total);
   if(state.nextPage===data.pages){if(state.bottles.length!==data.total)throw new SafeError('[CELLARTRACKER_RECONCILIATION_INCOMPLETE] Inventory total is incomplete.');state.phase='history';state.nextPage=1;}else state.nextPage++;
  }else if(state.phase==='history'){
   const data=parseHistory(response.text);state.historyPaging=this.paging(data,state.nextPage,state.historyPaging);state.rows.push(...data.records);this.unique(state.rows.map(r=>r.consumedId),data.total);
   if(state.nextPage===data.pages){if(state.rows.length!==data.total)throw new SafeError('[CELLARTRACKER_RECONCILIATION_INCOMPLETE] History total is incomplete.');state.phase=state.rows.some(r=>op.bottles.some(b=>b.id===r.id))?'details':'done';}else state.nextPage++;
  }else{
   const row=matching[state.details.length],data=parseConsumptionDetails(response.text,row);
   if(data.accountId!==this.account)throw new SafeError('[CELLARTRACKER_RECONCILIATION_CHANGED] Account changed on history details.');
   state.details.push({...row,date:data.date,type:data.type,note:data.note});if(state.details.length===matching.length)state.phase='done';
  }
 }
 private classify(op:Operation,state:Progress):Observation{
  const out:Observation={consumedIds:[],remainingIds:[],conflictIds:[]};const current=new Map(state.bottles.map(b=>[b.id,b]));
  for(const original of op.bottles){const b=current.get(original.id),rows=state.details.filter(r=>r.id===original.id),r=rows[0];
   if(!b&&rows.length===1&&r.wineId===original.wineId&&r.date===op.details.date&&r.type===1&&r.note===op.details.note)out.consumedIds.push(original.id);
   else if(!rows.length&&b&&b.wineId===original.wineId&&b.size===original.size&&b.location===original.location&&b.bin===original.bin)out.remainingIds.push(original.id);
   else out.conflictIds.push(original.id);
  }return out;
 }
 async status(id:string,restart=false){
  const callDeadline=this.clock.now()+reconciliationPolicy.callMs;const op=await this.store.get(id);
  if(op.accountId!==this.account)throw new SafeError('[CELLARTRACKER_RECONCILIATION_CHANGED] Operation differs from the approved account.');
  if(this.clock.now()>=this.sessionExpiry)throw new SafeError('The approved session cutoff passed. No reconciliation request is permitted.');
  await this.gate.assertAvailable();
  const scope=JSON.stringify([this.account,op.fingerprint,op.submittedAt??null,this.sessionExpiry]);let row=await this.row(id);const now=this.clock.now();
  if(row&&!restart&&(row.scope!==scope||row.expires_at<=now))throw this.expired();
  const lease=crypto.randomUUID(),generation=crypto.randomUUID(),expiry=Math.min(now+reconciliationPolicy.workflowMs,this.sessionExpiry);
  if(!row||restart){
   const saved=await this.db.prepare(`INSERT INTO reconciliation_reads(owner,operation_id,scope,generation_id,body,started_at,expires_at,lease_id,lease_until) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(owner,operation_id) DO UPDATE SET scope=excluded.scope,generation_id=excluded.generation_id,body=excluded.body,started_at=excluded.started_at,expires_at=excluded.expires_at,lease_id=excluded.lease_id,lease_until=excluded.lease_until WHERE reconciliation_reads.lease_until<=?`).bind(this.owner,id,scope,generation,this.encode(initial()),now,expiry,lease,Math.min(now+reconciliationPolicy.leaseMs,expiry),now).run();
   if(!saved.meta.changes){row=await this.row(id);throw retryFailure('CELLARTRACKER_RECONCILIATION_IN_PROGRESS',undefined,0,row!.lease_until,now,'fallback',{error_origin:'reconciliation_state',operation_id:id});}
   row=(await this.row(id))!;
  }else{
   const acquired=await this.db.prepare('UPDATE reconciliation_reads SET lease_id=?,lease_until=? WHERE owner=? AND operation_id=? AND scope=? AND generation_id=? AND lease_until<=? AND expires_at>?').bind(lease,Math.min(now+reconciliationPolicy.leaseMs,row.expires_at),this.owner,id,scope,row.generation_id,now,now).run();
   if(!acquired.meta.changes)throw retryFailure('CELLARTRACKER_RECONCILIATION_IN_PROGRESS',undefined,0,row.lease_until,now,'fallback',{error_origin:'reconciliation_state',operation_id:id});
  }
  const state=JSON.parse(row.body)as Progress;
  try{
   while(state.phase!=='done'){
    // Leave room for the existing pacing/response deadline and checkpoint write.
    if(Math.min(callDeadline,row.expires_at)-this.clock.now()<readRetryPolicy.maxElapsedMs)break;
    await this.read(state,op);await this.save(id,row,lease,state);
   }
   if(this.clock.now()>=row.expires_at)throw this.expired();
   if(state.phase!=='done'){
    if(row.expires_at-this.clock.now()<readRetryPolicy.maxElapsedMs)throw this.expired();
    return {...summarize(await this.store.get(id)),reconciliation:this.metadata(row,state)};
   }
   if((await this.store.get(id)).submittedAt!==op.submittedAt)throw this.expired();
   const observed=this.classify(op,state),complete=observed.consumedIds.length===op.bottles.length;
   const live=this.clock.now();
   const fence='EXISTS (SELECT 1 FROM reconciliation_reads WHERE owner=? AND operation_id=? AND generation_id=? AND lease_id=? AND lease_until>? AND expires_at>?)';
   const args=[this.owner,id,row.generation_id,lease,live,live];
   const writes:D1Statement[]=[];
   if(complete&&op.submittedAt!==undefined)writes.push(this.db.prepare(`UPDATE operations SET status='complete',observation=? WHERE owner=? AND id=? AND status IN ('submitted','unknown') AND submitted_at=? AND ${fence}`).bind(JSON.stringify(observed),this.owner,id,op.submittedAt,...args));
   writes.push(this.db.prepare(`DELETE FROM account_locks WHERE owner=? AND operation_id=? AND EXISTS (SELECT 1 FROM operations WHERE owner=? AND id=? AND status='complete') AND ${fence}`).bind(this.owner,id,this.owner,id,...args));
   writes.push(this.db.prepare('DELETE FROM reconciliation_reads WHERE owner=? AND operation_id=? AND generation_id=? AND lease_id=? AND lease_until>? AND expires_at>?').bind(...args));
   const result=await this.db.batch(writes);if(result.at(-1)!.meta.changes!==1)throw this.fenced();
   return {...summarize(await this.store.get(id)),observed_now:observed,reconciliation:{...this.metadata(row,state,true),verified_at:new Date(live).toISOString()}};
  }catch(error){
   // Provider failure retains already completed pages; malformed evidence requires explicit restart.
   if(!(error instanceof RetryError))await this.db.prepare('UPDATE reconciliation_reads SET expires_at=0 WHERE owner=? AND operation_id=? AND generation_id=? AND lease_id=?').bind(this.owner,id,row.generation_id,lease).run();
   if(error instanceof RetryError)throw new RetryError(error.message,{...error.metadata,operation_id:id});
   throw error;
  }finally{await this.db.prepare('UPDATE reconciliation_reads SET lease_id=NULL,lease_until=0 WHERE owner=? AND operation_id=? AND generation_id=? AND lease_id=?').bind(this.owner,id,row.generation_id,lease).run();}
 }
}
