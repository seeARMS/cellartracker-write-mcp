import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SafeError, type Bottle } from './types.js';
export interface Move {
  id: string; createdAt: string; expiresAt: string; accountId: string;
  scope?: 'bin'|'bottles';
  source?: { location: string; bin: string }; destination: { location?: string; bin: string };
  bottles: Bottle[]; status: 'planned'|'running'|'complete'|'partial'|'unknown'|'conflict';
  updatedAt?: string; movedIds?: string[]; remainingIds?: string[]; conflictIds?: string[]; message?: string;
}
export class OperationStore<T extends {id:string}> {
  constructor(readonly directory: string) {}
  private path(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new SafeError('Invalid operation ID.');
    return join(this.directory, `${id}.json`);
  }
  async save(move: T) {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    await chmod(this.directory,0o700);
    const path = this.path(move.id); const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp,JSON.stringify(move,null,2)+'\n',{mode:0o600,flag:'wx'});
    await rename(temp,path);
  }
  async get(id: string): Promise<T> {
    try { return JSON.parse(await readFile(this.path(id),'utf8')); }
    catch(e) { if (e instanceof SafeError) throw e; throw new SafeError('Operation not found or unreadable.'); }
  }
}

export class MoveStore extends OperationStore<Move> {}
