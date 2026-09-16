import {selectBottles,type BottleSelection} from './selection.js';
import { randomUUID } from 'node:crypto';
import { MoveStore, type Move } from './store.js';
import { SafeError, type Cellar, type Inventory } from './types.js';
export function validateLabel(value: string) {
  if (value.length > 40 || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value) || value === '(use current)') throw new SafeError('Location and bin must be exact labels of at most 40 characters, without control characters, surrounding whitespace, or the reserved placeholder.');
}
export class MoveService {
  constructor(private cellar: Cellar, private store: MoveStore) {}
  async plan(sourceBin: string, destinationBin: string, location?: string, destinationLocation?: string): Promise<Move> {
    [sourceBin,destinationBin,...(location === undefined ? []:[location]),...(destinationLocation === undefined ? []:[destinationLocation])].forEach(validateLabel);
    const inventory = await this.cellar.inventory();
    const candidates = inventory.bottles.filter(b=>b.bin===sourceBin && (location === undefined || b.location===location));
    if (!candidates.length) throw new SafeError('No bottles match that exact source bin/location.');
    const locations = [...new Set(candidates.map(b=>b.location))];
    if (locations.length !== 1) throw new SafeError(`Source bin exists in multiple locations: ${JSON.stringify(locations)}. Specify location.`);
    const source = {location:locations[0],bin:sourceBin};
    const destination = {location:destinationLocation ?? source.location,bin:destinationBin};
    if (!destination.location) throw new SafeError('Destination location cannot be empty.');
    if (source.location===destination.location && source.bin===destination.bin) throw new SafeError('Source and destination are the same.');
    const now=Date.now();
    const move: Move={id:randomUUID(),createdAt:new Date(now).toISOString(),expiresAt:new Date(now+15*60_000).toISOString(),accountId:inventory.accountId,source,destination,bottles:candidates,status:'planned'};
    await this.store.save(move); return move;
  }
  async planBottles(selection: BottleSelection, destinationBin: string, destinationLocation?: string): Promise<Move> {
    validateLabel(destinationBin);if(destinationLocation!==undefined)validateLabel(destinationLocation);
    const inventory=await this.cellar.inventory();const bottles=selectBottles(inventory,selection);
    if(bottles.some(b=>!(destinationLocation??b.location)))throw new SafeError('Specify a destination location for bottles with no current location.');
    if(bottles.some(b=>b.bin===destinationBin && b.location===(destinationLocation??b.location)))throw new SafeError('A selected bottle is already at its destination; select only bottles to move.');
    const now=Date.now();
    const move:Move={id:randomUUID(),scope:'bottles',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+15*60_000).toISOString(),accountId:inventory.accountId,destination:{location:destinationLocation,bin:destinationBin},bottles,status:'planned'};
    await this.store.save(move);return move;
  }
  private classify(move: Move, inventory: Inventory) {
    if (inventory.accountId!==move.accountId) throw new SafeError('Signed-in account changed. Refusing to continue this operation.');
    const byId=new Map(inventory.bottles.map(b=>[b.id,b]));
    const movedIds: string[]=[],remainingIds: string[]=[],conflictIds: string[]=[];
    for (const original of move.bottles) {
      const b=byId.get(original.id);
      if (b?.location===(move.destination.location??original.location) && b.bin===move.destination.bin) movedIds.push(original.id);
      else if (b?.location===original.location && b.bin===original.bin) remainingIds.push(original.id);
      else conflictIds.push(original.id);
    }
    return {movedIds,remainingIds,conflictIds};
  }
  async status(id: string) {
    const move=await this.store.get(id);
    return {...move,observedNow:this.classify(move,await this.cellar.inventory())};
  }
  async execute(id: string): Promise<Move> {
    const move=await this.store.get(id);
    // A lost response must never silently replay a write, even after restart.
    if (move.status!=='planned') return move;
    if (Date.parse(move.expiresAt)<Date.now()) throw new SafeError('Plan expired. Create a fresh plan.');
    let inventory=await this.cellar.inventory();
    const state=this.classify(move,inventory);
    const currentSource=inventory.bottles.filter(b=>b.location===move.source?.location&&b.bin===move.source?.bin).map(b=>b.id).sort();
    const planned=move.bottles.map(b=>b.id).sort();
    if (state.remainingIds.length!==planned.length || (move.scope!=='bottles' && JSON.stringify(currentSource)!==JSON.stringify(planned))) {
      move.status='conflict'; move.message='Source inventory changed since planning. Create a new plan.';
      Object.assign(move,state); await this.store.save(move); return move;
    }
    move.status='running'; await this.store.save(move);
    let failure=false;
    const groups=new Map<string,string[]>();
    for(const b of move.bottles){const location=move.destination.location??b.location;groups.set(location,[...(groups.get(location)??[]),b.id]);}
    const batches=[...groups].flatMap(([location,ids])=>Array.from({length:Math.ceil(ids.length/50)},(_,i)=>({location,ids:ids.slice(i*50,i*50+50)})));
    for (let index=0; index<batches.length; index++) {
      const {ids,location}=batches[index];
      try {
        // Recheck account and exact remaining bottle positions before each batch.
        if (index>0) inventory=await this.cellar.inventory();
        const current=this.classify(move,inventory);
        if (current.conflictIds.length || ids.some(id=>!current.remainingIds.includes(id))) throw new SafeError('Bottle positions changed during execution.');
        await this.cellar.relocate(ids,location,move.destination.bin);
      } catch { failure=true; }
      try {
        inventory=await this.cellar.inventory();
        Object.assign(move,this.classify(move,inventory));
      } catch {
        move.status='unknown'; move.message='Write outcome cannot be verified. Do not retry automatically; use get_move_status after restoring the connection.';
        move.updatedAt=new Date().toISOString(); await this.store.save(move); return move;
      }
      move.updatedAt=new Date().toISOString();
      await this.store.save(move);
      if (failure || move.conflictIds!.length || ids.some(id=>!move.movedIds!.includes(id))) break;
    }
    move.status=move.movedIds?.length===planned.length?'complete':'partial';
    move.message=move.status==='complete'?'Every selected bottle was verified at its destination.':'Stopped after an error, conflict, or incomplete batch. Inspect get_move_status before deciding how to recover; this operation will not replay writes.';
    await this.store.save(move); return move;
  }
}
