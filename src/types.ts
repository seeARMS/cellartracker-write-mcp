export interface Bottle { id: string; wine: string; location: string; bin: string }
export interface Inventory { accountId: string; bottles: Bottle[] }
export type BrowserRequest = { kind: 'inventory'; page: number } | { kind: 'relocationForm' } | { kind: 'relocate'; ids: string[]; location: string; bin: string };
export interface BrowserResponse { status: number; text: string; url: string }
export interface Transport { request(request: BrowserRequest): Promise<BrowserResponse> }
export interface Cellar { inventory(): Promise<Inventory>; relocate(ids: string[], location: string, bin: string): Promise<void> }
export class SafeError extends Error {}
