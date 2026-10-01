// Adapted from the MIT-licensed local cellartracker-write-mcp.
import {load} from 'cheerio/slim';
import {SafeError,type ConsumptionDetails} from './types.js';
export function readAccount(html:string){const $=load(html);const href=$('#header a[href*="user.asp?iUserOverride="]').attr('href');const id=href&&new URL(href,'https://www.cellartracker.com').searchParams.get('iUserOverride');if(!id||!/^\d+$/.test(id))throw new SafeError('Cannot verify the signed-in account on consumption history.');return id;}
export function parseHistory(html:string){
 const $=load(html);const accountId=readAccount(html);
 const count=$('a').toArray().map(e=>$(e).text()).find(t=>/^Consumed\s*\([\d,]+ bottles?\)/i.test(t))?.match(/\(([\d,]+) bottles?\)/i);
 if(!count)throw new SafeError('Cannot verify consumption history total.');
 const total=Number(count[1].replaceAll(',',''));const paging=$('#top_gotolink').text().match(/page\s+([\d,]+)\s+of\s+([\d,]+)/i);
 if(total>0&&!paging)throw new SafeError('Missing consumption history pagination.');
 const records:{id:string;consumedId:string;wineId:string}[]=[];
 $('#main_table tr').each((_,e)=>{
  const row=$(e);const input=row.find('input[name="iConsumed"]');if(!input.length)return;
  const consumedId=input.attr('value');const links=row.find('a[href*="bottlehistory.asp?iBottle="]');
  const href=links.attr('href');const id=href&&new URL(href,'https://www.cellartracker.com').searchParams.get('iBottle');
  const wineHref=row.find('a[href^="wine.asp?iWine="]').first().attr('href');const wineId=wineHref&&new URL(wineHref,'https://www.cellartracker.com').searchParams.get('iWine');
  if(links.length!==1||!id||!consumedId||!wineId||![id,consumedId,wineId].every(v=>/^\d+$/.test(v)))throw new SafeError('Consumption history bottle identifiers are missing or ambiguous.');
  records.push({id:BigInt(id).toString(),consumedId:BigInt(consumedId).toString(),wineId:BigInt(wineId).toString()});
 });
 return {accountId,records,total,page:paging?Number(paging[1].replaceAll(',','')):1,pages:paging?Number(paging[2].replaceAll(',','')):1};
}
export function parseConsumptionDetails(html:string,expected:{consumedId:string;wineId:string}){
 const $=load(html);const f=$('#wine_form');const fields=['iWine','iConsumed','ConsumptionType','ConsumptionDate','ConsumptionNote'];
 if(fields.some(name=>f.find(`[name="${name}"]`).length!==1)||f.find('[name="iWine"]').val()!==expected.wineId||f.find('[name="iConsumed"]').val()!==expected.consumedId)throw new SafeError('Consumption detail form identity or fields changed.');
 const date=String(f.find('[name="ConsumptionDate"]').val()).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
 if(!date)throw new SafeError('Unrecognized consumption date format.');
 const details:ConsumptionDetails={date:`${date[3]}-${date[1].padStart(2,'0')}-${date[2].padStart(2,'0')}`,type:Number(f.find('[name="ConsumptionType"]').val()),note:String(f.find('[name="ConsumptionNote"]').val())};
 return {accountId:readAccount(html),...details};
}
