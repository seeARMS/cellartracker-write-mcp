import {selectBottles,type BottleSelection} from './selection.js';
import {validateConsumption} from './validation.js';
import {CloudStore,type Operation,type Observation} from './store.js';
import {RetryError,SafeError,type ConsumptionCellar,type Inventory,type ConsumptionHistory} from './types.js';
export interface PlanInput extends BottleSelection {request_id:string;date:string;note?:string}
export function summarize(op:Operation){return {operation_id:op.id,request_id:op.requestKey,status:op.status,dry_run:op.submittedAt===undefined,created_at:new Date(op.createdAt).toISOString(),expires_at:new Date(op.expiresAt).toISOString(),bottles:op.bottles,quantity:op.bottles.length,date:op.details.date,reason:'drank',note:op.details.note,...(op.observation?{verification:op.observation}:{})};}
export class CloudConsumption {
 constructor(private cellar:ConsumptionCellar,private store:CloudStore,private accountId:string){}
 private account(inv:{accountId:string}){if(inv.accountId!==this.accountId)throw new SafeError('CellarTracker account differs from the approved account binding. No write allowed.');}
 async plan(input:PlanInput){
  const details={date:input.date,type:1,note:input.note??''};validateConsumption(details);
  const canonical={...input,bottle_ids:input.bottle_ids?.map(id=>BigInt(id).toString()).sort(),wine_id:input.wine_id?BigInt(input.wine_id).toString():undefined,note:details.note};delete (canonical as any).request_id;
  const fingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.entries(canonical).sort(([a],[b])=>a.localeCompare(b)))))))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const old=await this.store.byRequest(input.request_id);
  if(old){if(old.fingerprint!==fingerprint)throw new SafeError('This request ID already identifies different consumption details. Do not reuse it for another action.');return summarize(old);}
  const inventory=await this.cellar.inventory();this.account(inventory);
  const bottles=selectBottles(inventory,input);const history=await this.cellar.consumed(bottles.map(b=>b.id));this.account(history);
  if(history.records.length)throw new SafeError('A selected bottle already has consumption history. Reconcile it before planning.');
  const now=Date.now();const op=await this.store.create({id:crypto.randomUUID(),owner:this.store.owner,requestKey:input.request_id,fingerprint,accountId:inventory.accountId,bottles,details,status:'planned',createdAt:now,expiresAt:now+15*60_000});
  return summarize(op);
 }
 private classify(op:Operation,inventory:Inventory,history:ConsumptionHistory):Observation{
  this.account(inventory);this.account(history);if(op.accountId!==inventory.accountId)throw new SafeError('Consumption account binding changed.');
  const current=new Map(inventory.bottles.map(b=>[b.id,b]));const out:Observation={consumedIds:[],remainingIds:[],conflictIds:[]};
  for(const original of op.bottles){
   const b=current.get(original.id);const rows=history.records.filter(r=>r.id===original.id);const row=rows[0];
   if(!b&&rows.length===1&&row.wineId===original.wineId&&row.date===op.details.date&&row.type===1&&row.note===op.details.note)out.consumedIds.push(original.id);
   else if(!rows.length&&b&&b.wineId===original.wineId&&b.size===original.size&&b.location===original.location&&b.bin===original.bin)out.remainingIds.push(original.id);
   else out.conflictIds.push(original.id);
  }
  return out;
 }
 private async observe(op:Operation){return this.classify(op,await this.cellar.inventory(),await this.cellar.consumed(op.bottles.map(b=>b.id)));}
 async execute(id:string){
  const op=await this.store.get(id);
  if(op.status!=='planned')return summarize(op);
  if(op.expiresAt<=Date.now())throw new SafeError('Dry-run plan expired. Make a deliberate fresh plan; do not reuse it.');
  await this.store.begin(id);let submissionBoundary=false;
  try{
   const before=await this.observe(op);
   if(before.remainingIds.length!==op.bottles.length)throw new SafeError('Bottle identity, inventory, or history changed after the dry run. No consumption submitted.');
   if(op.expiresAt<=Date.now())throw new SafeError('Dry-run plan expired during fresh preflight. No consumption submitted.');
   submissionBoundary=true;if(!await this.store.submit(id)){
    const stopped=await this.store.get(id);
    if(stopped.status==='checking'&&stopped.expiresAt<=Date.now())await this.store.failBeforeSubmission(id,{consumedIds:[],remainingIds:[],conflictIds:[],message:'Dry-run plan expired before submission. No consumption submitted.'});
    return summarize(await this.store.get(id));
   }
   try{await this.cellar.consume(op.bottles.map(b=>b.id),op.details);}catch{/* A lost response is not a failed write. Always read back; never replay. */}
   const after=await this.observe(op);const complete=after.consumedIds.length===op.bottles.length;
   after.message=complete?'Verified exact bottle removal and matching consumption date, reason, and note.':'Outcome is unresolved. This operation will never replay; inspect its status. Other consumption stays blocked until reconciliation.';
   await this.store.outcome(id,complete?'complete':'unknown',after);if(complete)await this.store.unlock(id);
  }catch(e){
   const observation={consumedIds:[],remainingIds:[],conflictIds:[],message:submissionBoundary?'Outcome could not be verified. Do not retry or replace this consumption operation.':e instanceof SafeError?e.message:'Preflight verification failed. No consumption submitted.',...(e instanceof RetryError?{retry:e.metadata}:{})};
   if(submissionBoundary)await this.store.outcome(id,'unknown',observation);else await this.store.failBeforeSubmission(id,observation);
  }
  return summarize(await this.store.get(id));
 }
 async status(id:string){
  const op=await this.store.get(id);const observed=await this.observe(op);
  if(['submitted','unknown','checking'].includes(op.status)&&observed.consumedIds.length===op.bottles.length){await this.store.outcome(id,'complete',observed);await this.store.unlock(id);op.status='complete';op.observation=observed;}
  return {...summarize(op),observed_now:observed};
 }
 async cancel(id:string){return summarize(await this.store.cancel(id));}
}
