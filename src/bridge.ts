import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { SafeError, type Transport, type BrowserRequest, type BrowserResponse } from './types.js';
interface Job { id: string; expiresAt: number; request: BrowserRequest; resolve(value: BrowserResponse):void; reject(error:Error):void; timer:NodeJS.Timeout; delivered:boolean }
export class BrowserBridge implements Transport {
  private jobs = new Map<string,Job>();
  private server = createServer((req,res)=>{void this.handle(req,res).catch(()=>this.reply(res,400,{error:'Invalid bridge message'}));});
  private poll?: {res:ServerResponse;timer:NodeJS.Timeout};
  private lastSeen=0;
  constructor(private token:string,private port:number) {}
  async start() { await new Promise<void>((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,'127.0.0.1',()=>resolve());}); }
  async close() {
    if(this.poll){clearTimeout(this.poll.timer);this.reply(this.poll.res,204);this.poll=undefined;}
    for(const job of this.jobs.values()){clearTimeout(job.timer);job.reject(new SafeError('Bridge closed.'));}this.jobs.clear();
    await new Promise<void>(resolve=>this.server.close(()=>resolve()));
  }
  connected(){return Date.now()-this.lastSeen<45_000;}
  request(request:BrowserRequest):Promise<BrowserResponse> {
    if(!this.connected()) return Promise.reject(new SafeError('Chrome companion is disconnected. Open a signed-in CellarTracker tab and connect the extension.'));
    return new Promise((resolve,reject)=>{
      const id=randomUUID();
      const timer=setTimeout(()=>{this.jobs.delete(id);reject(new SafeError('Browser request timed out. A submitted write may have succeeded; inspect operation status.'));},60_000);
      this.jobs.set(id,{id,request,expiresAt:Date.now()+55_000,resolve,reject,timer,delivered:false});this.dispatch();
    });
  }
  private reply(res:ServerResponse,status:number,data?:unknown){if(res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(data===undefined?'':JSON.stringify(data));}
  private dispatch(){
    if(!this.poll)return;
    const job=[...this.jobs.values()].find(j=>!j.delivered&&j.expiresAt>Date.now());if(!job)return;
    const {res,timer}=this.poll;this.poll=undefined;clearTimeout(timer);job.delivered=true;
    this.reply(res,200,{id:job.id,expiresAt:job.expiresAt,request:job.request});
  }
  private async handle(req:IncomingMessage,res:ServerResponse){
    const origin=req.headers.origin;
    if(req.headers.host!==`127.0.0.1:${this.port}` || (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))){this.reply(res,403);return;}
    const auth=req.headers.authorization ?? '';
    const expected=`Bearer ${this.token}`;
    if(Buffer.byteLength(auth)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected))){this.reply(res,401);return;}
    if(req.method==='GET'&&req.url==='/health'){this.reply(res,200,{connected:this.connected()});return;}
    if(req.method==='GET'&&req.url==='/poll'){
      this.lastSeen=Date.now();
      if(this.poll){this.reply(res,409,{error:'Another companion is already polling'});return;}
      const timer=setTimeout(()=>{if(this.poll?.res===res){this.poll=undefined;this.reply(res,204);}},20_000);
      this.poll={res,timer};res.on('close',()=>{if(this.poll?.res===res){clearTimeout(timer);this.poll=undefined;}});this.dispatch();return;
    }
    if(req.method==='POST'&&req.url==='/result'){
      let size=0;const chunks:Buffer[]=[];
      for await(const chunk of req){size+=chunk.length;if(size>15_000_000){this.reply(res,413);return;}chunks.push(chunk);}
      const data=JSON.parse(Buffer.concat(chunks).toString());
      const job=this.jobs.get(data.id);
      if(!job || !job.delivered){this.reply(res,410);return;}
      if(typeof data.error==='string'){job.reject(new SafeError('Chrome could not complete the request. Check the signed-in tab; writes require read-back reconciliation.'));}
      else {
        const r=data.response;
        if(!r || !Number.isInteger(r.status)||typeof r.text!=='string'||typeof r.url!=='string'){this.reply(res,400);return;}
        job.resolve(r);
      }
      clearTimeout(job.timer);this.jobs.delete(job.id);this.lastSeen=Date.now();this.reply(res,200,{ok:true});return;
    }
    this.reply(res,404);
  }
}
