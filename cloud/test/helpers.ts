import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {D1Database,D1Statement,Bottle,ConsumptionDetails,ConsumedBottle,ConsumptionCellar} from '../worker/types.js';
import {callTool as realCallTool} from '../worker/index.js';
import type {Environment} from '../worker/types.js';
import type {RetryClock} from '../worker/backoff.js';
const clocks=new WeakMap<object,RetryClock>();
export function callTool(request:Request,env:Environment,name:string,args:Record<string,any>,fetcher:typeof fetch){
 let clock=env.DB?clocks.get(env.DB):undefined;
 if(!clock){let now=Date.now();clock={now:()=>now,sleep:async(ms:number)=>{now+=ms;},random:()=>0};if(env.DB)clocks.set(env.DB,clock);}
 return realCallTool(request,env,name,args,fetcher,clock);
}
export class SqliteD1 implements D1Database{
 readonly sqlite=new DatabaseSync(':memory:');
 constructor(){this.sqlite.exec('PRAGMA foreign_keys=ON');for(const name of readdirSync('drizzle').filter(n=>n.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(resolve('drizzle',name),'utf8'));}
 prepare(sql:string):D1Statement{
  let values:any[]=[];const statement=this.sqlite.prepare(sql);
  const api={bind:(...v:any[])=>{values=v;return api;},first:async()=>statement.get(...values)??null,run:async()=>{const r=statement.run(...values);return {meta:{changes:Number(r.changes)}};}};
  return api as D1Statement;
 }
 async batch(statements:D1Statement[]){this.sqlite.exec('BEGIN IMMEDIATE');try{const result=[];for(const s of statements)result.push(await s.run());this.sqlite.exec('COMMIT');return result;}catch(e){this.sqlite.exec('ROLLBACK');throw e;}}
 close(){this.sqlite.close();}
}
export function bottle(id:string,bin='23',size='750ml'):Bottle{return {id,wine:'2020 Synthetic Cabernet',wineId:'100',size,location:'Synthetic cellar',bin};}
export class FakeCellar implements ConsumptionCellar{
 writes=0;accountId='123';history:ConsumedBottle[]=[];loseResponse=false;failReadAfterWrite=false;omitHistory=false;wrongNote=false;pauseInventory?:()=>Promise<void>;
 constructor(public bottles:Bottle[]=[bottle('1'),bottle('2')]){}
 async inventory(){await this.pauseInventory?.();if(this.failReadAfterWrite&&this.writes)throw Error('synthetic read failure');return structuredClone({accountId:this.accountId,bottles:this.bottles});}
 async consumed(ids:string[]){return structuredClone({accountId:this.accountId,records:this.history.filter(r=>ids.includes(r.id))});}
 async consume(ids:string[],details:ConsumptionDetails){this.writes++;this.bottles=this.bottles.filter(b=>!ids.includes(b.id));if(!this.omitHistory)this.history.push(...ids.map(id=>({id,consumedId:'9'+id,wineId:'100',...details,note:this.wrongNote?'Different synthetic note':details.note})));if(this.loseResponse)throw Error('synthetic lost response');}
}
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
export function inventoryHtml(bottles:Bottle[],page=1,pages=1,total=bottles.length){return `<div id="header"><a href="user.asp?iUserOverride=123">Synthetic</a></div><a>In My Cellar (${total} bottles)</a><a id="top_gotolink">page ${page} of ${pages}</a><table id="main_table"><tr><th><a href="list.asp?O=BinSort">Bin</a></th></tr>${bottles.map(b=>`<tr><td><input name="iInventory" value="${b.id}"></td><td><span class="bar">synthetic</span><span class="loc">${escape(b.location)}</span><span class="bin">${escape(b.bin)}</span></td><td class="name"><a href="wine.asp?iWine=${b.wineId}">Wine</a><span class="siz">${b.size}</span><h3>${escape(b.wine)}</h3></td></tr>`).join('')}</table>`;}
export function upstream(){
 let bottles=[bottle('1'),bottle('2')];const history:ConsumedBottle[]=[];let posts=0;const urls:string[]=[];
 const fetcher=async(input:any,options:any)=>{
  const u=new URL(input);urls.push(input);if(u.origin!=='https://www.cellartracker.com')throw Error('origin leak');
  let text='';
  if(u.pathname==='/list.asp'&&u.searchParams.get('table')==='Inventory')text=inventoryHtml(bottles);
  else if(u.pathname==='/list.asp')text=`<div id="header"><a href="user.asp?iUserOverride=123">Synthetic</a></div><a>Consumed (${history.length} bottles)</a><a id="top_gotolink">page 1 of 1</a><table id="main_table">${history.map(r=>`<tr><td><input name="iConsumed" value="${r.consumedId}"><a href="wine.asp?iWine=100">Wine</a><a href="popup/bottlehistory.asp?iBottle=${r.id}">Bottle</a></td></tr>`).join('')}</table>`;
  else if(u.pathname==='/popup/consume_form.asp')text='<form id="bulk_popup_form" action="bulkconsume.asp" method="post"><input name="Consumed"><select name="iConsumptionType"><option value="1">Drank</option></select><input name="ConsumptionNote"><input name="Revenue"><select name="RevenueCurrency"><option value="USD">USD</option></select><input name="WriteTN" type="checkbox"></form>';
  else if(u.pathname==='/bulkconsume.asp'){
   if(options.method!=='POST')throw Error('invalid method');posts++;
   const ids=new URLSearchParams(options.body).getAll('iInventory');const [month,day,year]=u.searchParams.get('Consumed')!.split('/');
   const date=`${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`;
   bottles=bottles.filter(b=>!ids.includes(b.id));history.push(...ids.map(id=>({id,wineId:'100',consumedId:'9'+id,date,type:1,note:u.searchParams.get('ConsumptionNote')!})));text='<response/>';
  }else if(u.pathname==='/editconsumed.asp'){
   const r=history.find(r=>r.consumedId===u.searchParams.get('iConsumed'))!;const [y,m,d]=r.date.split('-');
   text=`<div id="header"><a href="user.asp?iUserOverride=123">Synthetic</a></div><form id="wine_form"><input name="iWine" value="100"><input name="iConsumed" value="${r.consumedId}"><select name="ConsumptionType"><option value="1" selected>Drank</option></select><input name="ConsumptionDate" value="${Number(m)}/${Number(d)}/${y}"><input name="ConsumptionNote" value="${escape(r.note)}"></form>`;
  }else throw Error('unexpected endpoint');
  return new Response(text,{headers:{'content-type':'text/html; charset=utf-8'}});
 };
 return {fetcher:fetcher as typeof fetch,get posts(){return posts;},urls};
}
