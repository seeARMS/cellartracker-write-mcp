import {SafeError,type Bottle,type Inventory} from './types.js';
export interface BottleSelection { bottle_ids?:string[]; wine_id?:string; quantity?:number; location?:string; bin?:string; size?:string }
export function selectBottles(inventory:Inventory,selection:BottleSelection):Bottle[]{
  if(selection.bottle_ids!==undefined){
    if([selection.wine_id,selection.quantity,selection.location,selection.bin,selection.size].some(v=>v!==undefined))throw new SafeError('Use bottle_ids OR wine_id/quantity with source filters, not both.');
    const ids=selection.bottle_ids;
    if(!ids.length||ids.length>1000||ids.some(id=>!/^\d+$/.test(id)))throw new SafeError('Provide 1–1000 numeric bottle IDs.');
    const normalized=ids.map(id=>BigInt(id).toString());
    if(new Set(normalized).size!==ids.length)throw new SafeError('Duplicate bottle IDs.');
    const byId=new Map(inventory.bottles.map(b=>[b.id,b]));
    return normalized.map(id=>{const b=byId.get(id);if(!b)throw new SafeError(`Bottle ${id} is not in the current inventory.`);return b;});
  }
  if(!selection.wine_id||!/^\d+$/.test(selection.wine_id)||!Number.isInteger(selection.quantity)||selection.quantity!<1||selection.quantity!>1000)throw new SafeError('Provide bottle_ids or an exact wine_id and quantity (1–1000).');
  const wineId=BigInt(selection.wine_id).toString();
  const matches=inventory.bottles.filter(b=>b.wineId===wineId&&(selection.location===undefined||b.location===selection.location)&&(selection.bin===undefined||b.bin===selection.bin)&&(selection.size===undefined||b.size===selection.size));
  if(matches.length<selection.quantity!)throw new SafeError(`Only ${matches.length} bottles match the exact wine and source filters; requested ${selection.quantity}.`);
  const groups=new Set(matches.map(b=>JSON.stringify([b.location,b.bin,b.size])));
  if(groups.size>1)throw new SafeError('Matching bottles span multiple locations, bins, or sizes. Specify source filters or explicit bottle_ids.');
  return matches.sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1).slice(0,selection.quantity);
}
