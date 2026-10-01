import {SafeError,type Bottle,type ConsumptionDetails,type D1Database,type RetryMetadata} from './types.js';
export interface Operation {
 id:string;owner:string;requestKey:string;fingerprint:string;accountId:string;
 bottles:Bottle[];details:ConsumptionDetails;status:string;createdAt:number;expiresAt:number;
 submittedAt?:number;observation?:Observation;
}
export interface Observation {consumedIds:string[];remainingIds:string[];conflictIds:string[];message?:string;retry?:RetryMetadata}
export class CloudStore {
 constructor(private db:D1Database,readonly owner:string){}
 private decode(row:any):Operation|null{return row?{...JSON.parse(row.body),status:row.status,submittedAt:row.submitted_at??undefined,observation:row.observation?JSON.parse(row.observation):undefined}:null;}
 async byRequest(key:string){return this.decode(await this.db.prepare('SELECT * FROM operations WHERE owner=? AND request_key=?').bind(this.owner,key).first());}
 async get(id:string){const op=this.decode(await this.db.prepare('SELECT * FROM operations WHERE owner=? AND id=?').bind(this.owner,id).first());if(!op)throw new SafeError('Consumption operation not found for this owner.');return op;}
 async create(op:Operation){
  const now=Date.now();
  await this.db.batch([
   this.db.prepare("UPDATE operations SET status='expired' WHERE owner=? AND status='planned' AND expires_at<=?").bind(this.owner,now),
   this.db.prepare("DELETE FROM bottle_claims WHERE owner=? AND operation_id IN (SELECT id FROM operations WHERE owner=? AND status='expired' AND submitted_at IS NULL)").bind(this.owner,this.owner)
  ]);
  try{
   await this.db.batch([
    this.db.prepare('INSERT INTO operations(id,owner,request_key,fingerprint,account_id,body,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(op.id,this.owner,op.requestKey,op.fingerprint,op.accountId,JSON.stringify(op),'planned',op.createdAt,op.expiresAt),
    ...op.bottles.map(b=>this.db.prepare('INSERT INTO bottle_claims(owner,account_id,bottle_id,operation_id) VALUES(?,?,?,?)').bind(this.owner,op.accountId,b.id,op.id))
   ]);
  }catch{
   const existing=await this.byRequest(op.requestKey);
   if(existing?.fingerprint===op.fingerprint)return existing;
   throw new SafeError('The request key or a selected bottle is already reserved by another operation. Inspect or cancel that unsubmitted plan; never automatically create a replacement after an uncertain write.');
  }
  return op;
 }
 async begin(id:string){
  let results;
  try{results=await this.db.batch([
   this.db.prepare('INSERT INTO account_locks(owner,operation_id) VALUES(?,?)').bind(this.owner,id),
   this.db.prepare("UPDATE operations SET status='checking' WHERE id=? AND owner=? AND status='planned' AND expires_at>?").bind(id,this.owner,Date.now())
  ]);}catch{throw new SafeError('Another consumption is running or unresolved. Read its status before any new execution.');}
  if(results[1].meta.changes!==1){await this.unlock(id);throw new SafeError('The plan is expired, canceled, or already submitted. Inspect its status.');}
 }
 async submit(id:string){const now=Date.now();const r=await this.db.prepare("UPDATE operations SET status='submitted', submitted_at=? WHERE id=? AND owner=? AND status='checking' AND expires_at>?").bind(now,id,this.owner,now).run();return r.meta.changes===1;}
 async outcome(id:string,status:string,observation:Observation){await this.db.prepare('UPDATE operations SET status=?, observation=? WHERE id=? AND owner=?').bind(status,JSON.stringify(observation),id,this.owner).run();}
 async failBeforeSubmission(id:string,observation:Observation){await this.db.prepare("UPDATE operations SET status='conflict', observation=? WHERE id=? AND owner=? AND status='checking' AND submitted_at IS NULL").bind(JSON.stringify(observation),id,this.owner).run();await this.unlock(id);}
 async unlock(id:string){await this.db.prepare('DELETE FROM account_locks WHERE owner=? AND operation_id=?').bind(this.owner,id).run();}
 async cancel(id:string){
  const r=await this.db.prepare("UPDATE operations SET status='canceled' WHERE id=? AND owner=? AND status IN ('planned','checking','conflict','expired') AND submitted_at IS NULL").bind(id,this.owner).run();
  if(!r.meta.changes)throw new SafeError('Submitted or unresolved consumption cannot be canceled or retried. Inspect its status.');
  await this.db.batch([this.db.prepare('DELETE FROM bottle_claims WHERE owner=? AND operation_id=?').bind(this.owner,id),this.db.prepare('DELETE FROM account_locks WHERE owner=? AND operation_id=?').bind(this.owner,id)]);
  return this.get(id);
 }
}
