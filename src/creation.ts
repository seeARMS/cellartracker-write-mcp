import {randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {readAccount} from './history.js';
import {validateLabel} from './moves.js';
import {OperationStore} from './store.js';
import {SafeError,type Inventory,type Cellar,type Transport,type Bottle} from './types.js';
export interface CreationInput {wineId:string;quantity:number;size:string;location:string;bin:string}
export function validateCreation(d:CreationInput){
 if(typeof d.wineId!=='string'||!/^\d+$/.test(d.wineId)||BigInt(d.wineId)<1n||!Number.isInteger(d.quantity)||d.quantity<1||d.quantity>240||typeof d.size!=='string'||!/^\d+(?:\.\d+)?(?:ml|L|oz)$/.test(d.size))throw new SafeError('Invalid wine ID, quantity (1–240), or bottle size.');
 validateLabel(d.location);validateLabel(d.bin);if(!d.location)throw new SafeError('Location is required.');
}
export function parseCreationForm(text:string,wineId:string){
 const $=load(text),f=$('form#wine_form');
 const fields=['iWine','Action','BinUI','Quantity','Size','DeliveryState','Location','Bin','BottleNote','StoreName','PurchaseDate','DeliveryDate','BottleCostCurrency','BottleCost','PurchaseNote'];
 const names=f.find('[name]').toArray().map(e=>$(e).attr('name')!);
 if(f.length!==1||f.attr('action')!=='purchase.asp'||f.attr('method')?.toLowerCase()!=='post'||names.some(n=>!fields.includes(n))||fields.some(n=>names.filter(x=>x===n).length!==(n==='DeliveryState'?2:1))||f.find('[name=iWine]').val()!==wineId||f.find('[name=Action]').val()!=='Add'||f.find('[name=BinUI]').val()!=='Bulk'||!f.find('[name=DeliveryState][value=delivered]').length)throw new SafeError('Bottle creation form contract changed. No bottles added.');
 const wine=f.find('#wine_summary h2').text().trim();const currency=String(f.find('[name=BottleCostCurrency]').val());
 if(!wine||!/^[A-Z]{3}$/.test(currency))throw new SafeError('Missing wine identity or currency on creation form.');
 return {accountId:readAccount(text),wine,currency,sizes:f.find('[name=Size] option').toArray().map(e=>$(e).attr('value')??$(e).text())};
}
export interface Creation {id:string;createdAt:string;expiresAt:string;accountId:string;wine:string;input:CreationInput;baselineIds:string[];status:'planned'|'running'|'complete'|'partial'|'unknown'|'conflict';addedIds?:string[];unexpectedIds?:string[];message?:string}
export class CreationStore extends OperationStore<Creation>{}
export class CreationService{
 constructor(private cellar:Cellar,private transport:Transport,private store:CreationStore){}
 private async form(wineId:string){const r=await this.transport.request({kind:'creationForm',wineId});if(r.status!==200||new URL(r.url).origin!=='https://www.cellartracker.com')throw new SafeError('Cannot read bottle creation form.');return parseCreationForm(r.text,wineId);}
 async plan(input:CreationInput){validateCreation(input);input={...input,wineId:BigInt(input.wineId).toString()};const inv=await this.cellar.inventory();const f=await this.form(input.wineId);if(f.accountId!==inv.accountId||!f.sizes.includes(input.size))throw new SafeError('Account changed or bottle size unsupported.');const now=Date.now();const op:Creation={id:randomUUID(),createdAt:new Date(now).toISOString(),expiresAt:new Date(now+900000).toISOString(),accountId:inv.accountId,wine:f.wine,input,baselineIds:inv.bottles.map(b=>b.id),status:'planned'};await this.store.save(op);return op;}
 private observe(op:Creation,inv:Inventory){
  if(inv.accountId!==op.accountId)throw new SafeError('Signed-in account changed.');
  const prior=new Set(op.baselineIds);const candidates=inv.bottles.filter(b=>!prior.has(b.id)&&b.wineId===op.input.wineId);
  const matches=(b:Bottle)=>b.size===op.input.size&&b.location===op.input.location&&b.bin===op.input.bin;
  return {addedIds:candidates.filter(matches).map(b=>b.id),unexpectedIds:candidates.filter(b=>!matches(b)).map(b=>b.id)};
 }
 async status(id:string){const op=await this.store.get(id);return {...op,observedNow:this.observe(op,await this.cellar.inventory())};}
 async execute(id:string){
  const op=await this.store.get(id);if(op.status!=='planned')return op;if(Date.parse(op.expiresAt)<Date.now())throw new SafeError('Plan expired. Create a fresh plan.');
  const inv=await this.cellar.inventory();const before=this.observe(op,inv);const f=await this.form(op.input.wineId);
  if(f.accountId!==op.accountId||f.wine!==op.wine||!f.sizes.includes(op.input.size)||JSON.stringify(inv.bottles.map(b=>b.id).sort())!==JSON.stringify([...op.baselineIds].sort())){Object.assign(op,before,{status:'conflict',message:'Inventory or creation form changed. No creation submitted.'});await this.store.save(op);return op;}
  op.status='running';await this.store.save(op);
  try{await this.transport.request({kind:'createBottles',details:op.input,currency:f.currency});}catch{/* A redirect or lost response may follow a successful POST. Never resubmit. */}
  try{Object.assign(op,this.observe(op,await this.cellar.inventory()));op.status=op.addedIds!.length===op.input.quantity&&!op.unexpectedIds!.length?'complete':op.addedIds!.length||op.unexpectedIds!.length?'partial':'unknown';}
  catch{op.status='unknown';}
  op.message=op.status==='complete'?'New bottle IDs verified with the requested wine, size, location, and bin.':'Creation outcome uncertain or incomplete. Inspect get_creation_status; never automatically create a replacement plan.';await this.store.save(op);return op;
 }
}
export async function searchWines(transport:Transport,query:string,page:number){
 const r=await transport.request({kind:'searchWines',query,page});if(r.status!==200||new URL(r.url).origin!=='https://www.cellartracker.com')throw new SafeError('Wine search failed.');const $=load(r.text);readAccount(r.text);
 const wines:{wineId:string;wine:string;region:string;type:string}[]=[];
 $('#main_table tr').each((_,e)=>{const row=$(e),id=row.find('input[name=iWine]').val();if(id===undefined)return;const wine=row.find('td.name h3').text().trim();if(typeof id!=='string'||!/^\d+$/.test(id)||!wine)throw new SafeError('Wine search markup changed.');wines.push({wineId:BigInt(id).toString(),wine,region:row.find('td.name .loc').text().trim(),type:row.find('td.type').text().trim()});});
 const paging=$('#top_gotolink').text().match(/page\s+([\d,]+)\s+of\s+([\d,]+)/i);
 const total=$('span').toArray().map(e=>$(e).text().trim()).find(t=>/^[\d,]+ Wines?$/.test(t));
 if(!paging&&!(total&&Number(total.split(' ')[0].replaceAll(',',''))===wines.length)&&!(!wines.length&&/There are no results found/i.test($('body').text())))throw new SafeError('Cannot verify search pagination.');
 const current=paging?Number(paging[1].replaceAll(',','')):1,pages=paging?Number(paging[2].replaceAll(',','')):1;if(current!==page)throw new SafeError('Unexpected search page.');return {wines,page:current,pages};
}
