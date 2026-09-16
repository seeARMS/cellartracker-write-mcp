import type { Bottle, Cellar, Inventory } from '../src/types.js';
export function bottle(id:string,location='Example cellar',bin='23'):Bottle{return {id,wine:'2020 Example Wine',wineId:'100',size:'750ml',location,bin};}
export function html(bottles:Bottle[],page=1,pages=1,total=bottles.length,account='123'){
 const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 return `<div id="header"><a href="user.asp?iUserOverride=${account}">Example user</a></div><a>In My Cellar (${total} bottles)</a><a id="top_gotolink">page ${page} of ${pages}</a><table id="main_table"><tr><th><a href="list.asp?O=BinSort">Bin</a></th></tr>${bottles.map(b=>`<tr><td><input name="iInventory" value="${b.id}"></td><td><span class="bar">barcode</span><span class="loc">${escape(b.location)}</span><span class="bin">${escape(b.bin)}</span></td><td class="name"><a href="wine.asp?iWine=${b.wineId}">Wine</a><span class="siz">${b.size}</span><h3>${escape(b.wine)}</h3></td></tr>`).join('')}</table>`;
}
export class FakeCellar implements Cellar{
 calls:string[][]=[];accountId='123';failAfterWrite=false;partial=false;
 constructor(public bottles:Bottle[]){}
 async inventory():Promise<Inventory>{return structuredClone({accountId:this.accountId,bottles:this.bottles});}
 async relocate(ids:string[],location:string,bin:string){this.calls.push(ids);for(const id of this.partial?ids.slice(0,1):ids){Object.assign(this.bottles.find(b=>b.id===id)!,{location,bin});}if(this.failAfterWrite)throw Error('Lost response');}
}
