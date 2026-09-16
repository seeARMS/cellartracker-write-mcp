export interface Bottle { id: string; wine: string; wineId?: string; size?: string; location: string; bin: string }
export interface Inventory { accountId: string; bottles: Bottle[] }
export interface ConsumptionDetails { date: string; type: number; note: string }
export interface ConsumedBottle extends ConsumptionDetails { id: string; consumedId: string; wineId: string }
export interface ConsumptionHistory { accountId: string; records: ConsumedBottle[] }
export interface ConsumptionCellar extends Cellar { consumed(ids: string[]): Promise<ConsumptionHistory>; consume(ids: string[], details: ConsumptionDetails): Promise<void> }
export type BrowserRequest = { kind: 'consumed'; page: number } | { kind: 'consumptionForm' } | { kind: 'consumptionDetails'; wineId: string; consumedId: string } | { kind: 'consume'; ids: string[]; details: ConsumptionDetails; currency: string } | { kind: 'inventory'; page: number } | { kind: 'relocationForm' } | { kind: 'relocate'; ids: string[]; location: string; bin: string };
export interface BrowserResponse { status: number; text: string; url: string }
export interface Transport { request(request: BrowserRequest): Promise<BrowserResponse> }
export interface Cellar { inventory(): Promise<Inventory>; relocate(ids: string[], location: string, bin: string): Promise<void> }
export class SafeError extends Error {}
