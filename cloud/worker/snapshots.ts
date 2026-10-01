import {RetryError,SafeError,type D1Database,type Inventory,type ProviderGate} from './types.js';
import {realClock,retryFailure,type RetryClock} from './backoff.js';
export const snapshotPolicy={ttlMs:120000,leaseMs:120000,waitMs:15000};
interface Row {scope:string;snapshot_id:string|null;body:string|null;fetched_at:number;expires_at:number;lease_id:string|null;lease_until:number;retry_at:number;retry_code:string|null}
export interface Snapshot {inventory:Inventory;metadata:{snapshot_id:string;as_of:string;expires_at:string;cached:boolean}}
export class InventorySnapshots {
 private scope:string;
 constructor(private db:D1Database,private owner:string,private account:string,private sessionExpiry:number,private clock:RetryClock=realClock,private gate?:ProviderGate){this.scope=JSON.stringify([account,sessionExpiry]);}
 private row(){return this.db.prepare('SELECT * FROM inventory_snapshots WHERE owner=?').bind(this.owner).first<Row>();}
 async invalidate(){await this.db.prepare('DELETE FROM inventory_snapshots WHERE owner=?').bind(this.owner).run();}
 async get(load:()=>Promise<Inventory>,snapshotId?:string):Promise<Snapshot>{
  const started=this.clock.now();
  while(true){
   const now=this.clock.now();if(now>=this.sessionExpiry)throw new SafeError('The approved session cutoff passed. Inventory access is disabled.');
   await this.gate?.assertAvailable();
   if(await this.db.prepare('SELECT operation_id FROM account_locks WHERE owner=?').bind(this.owner).first())throw new SafeError('[CELLARTRACKER_CONSUMPTION_IN_PROGRESS] Complete or reconcile the existing consumption before inventory discovery. No automatic tool retry is allowed.');
   const row=await this.row();
   if(row?.scope===this.scope&&row.body&&row.snapshot_id&&row.expires_at>now&&(!snapshotId||snapshotId===row.snapshot_id)){
    const inventory=JSON.parse(row.body) as Inventory;
    if(inventory.accountId!==this.account)throw new SafeError('Cached inventory differs from the approved account.');
    return {inventory,metadata:{snapshot_id:row.snapshot_id,as_of:new Date(row.fetched_at).toISOString(),expires_at:new Date(row.expires_at).toISOString(),cached:true}};
   }
   if(snapshotId)throw retryFailure('CELLARTRACKER_SNAPSHOT_EXPIRED',undefined,0,now,now);
   if(row?.scope===this.scope&&row.retry_at>now)throw retryFailure(row.retry_code==='CELLARTRACKER_RATE_LIMITED'?'CELLARTRACKER_RATE_LIMITED':'CELLARTRACKER_READ_COOLDOWN',undefined,0,row.retry_at,now);
   const lease=crypto.randomUUID();
   const acquired=await this.db.prepare(`INSERT INTO inventory_snapshots(owner,scope,lease_id,lease_until) VALUES(?,?,?,?)
    ON CONFLICT(owner) DO UPDATE SET scope=excluded.scope,body=NULL,snapshot_id=NULL,expires_at=0,lease_id=excluded.lease_id,lease_until=excluded.lease_until,retry_at=0,retry_code=NULL
    WHERE (inventory_snapshots.scope<>excluded.scope OR inventory_snapshots.expires_at<=?) AND inventory_snapshots.lease_until<=? AND inventory_snapshots.retry_at<=?`).bind(this.owner,this.scope,lease,now+snapshotPolicy.leaseMs,now,now,now).run();
   if(acquired.meta.changes){
    try{
     const inventory=await load();
     if(inventory.accountId!==this.account)throw new SafeError('CellarTracker account differs from the approved account binding.');
     const body=JSON.stringify(inventory);if(new TextEncoder().encode(body).length>1_500_000)throw new SafeError('Inventory snapshot exceeds the bounded storage size.');
     const fetched=this.clock.now(),expiry=Math.min(fetched+snapshotPolicy.ttlMs,this.sessionExpiry),id=crypto.randomUUID();
     const saved=await this.db.prepare('UPDATE inventory_snapshots SET body=?,snapshot_id=?,fetched_at=?,expires_at=?,lease_id=NULL,lease_until=0,retry_at=0,retry_code=NULL WHERE owner=? AND scope=? AND lease_id=? AND lease_until>?').bind(body,id,fetched,expiry,this.owner,this.scope,lease,fetched).run();
     if(!saved.meta.changes)throw new SafeError('Inventory changed during refresh. Restart discovery after the current consumption finishes.');
     return {inventory,metadata:{snapshot_id:id,as_of:new Date(fetched).toISOString(),expires_at:new Date(expiry).toISOString(),cached:false}};
    }catch(error){
     const now=this.clock.now(),retryAt=error instanceof RetryError?Date.parse(error.metadata.retry_at):now+5000;
     const code=error instanceof RetryError?error.metadata.error_code:null;
     await this.db.prepare('UPDATE inventory_snapshots SET body=NULL,snapshot_id=NULL,expires_at=0,lease_id=NULL,lease_until=0,retry_at=?,retry_code=? WHERE owner=? AND lease_id=?').bind(retryAt,code,this.owner,lease).run();
     throw error;
    }
   }
   if(this.clock.now()-started>=snapshotPolicy.waitMs)throw retryFailure('CELLARTRACKER_READ_IN_PROGRESS',undefined,0,this.clock.now()+1000,this.clock.now());
   await this.clock.sleep(250+Math.floor(this.clock.random()*250));
  }
 }
}
