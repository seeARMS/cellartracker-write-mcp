import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { SafeError } from './types.js';
export const stateDir=process.env.CELLARTRACKER_STATE_DIR ?? join(homedir(),'.local','share','cellartracker-write-mcp');
export async function configuration(create=false){
  const path=join(stateDir,'pairing.json');
  await mkdir(stateDir,{recursive:true,mode:0o700});await chmod(stateDir,0o700);
  if(create){
    try{await writeFile(path,JSON.stringify({port:17843,token:randomBytes(32).toString('hex')},null,2)+'\n',{mode:0o600,flag:'wx'});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  }
  try{
    const config=JSON.parse(await readFile(path,'utf8'));
    if(config.port!==17843 || !/^[0-9a-f]{64}$/.test(config.token))throw Error();
    return {...config,path} as {port:number;token:string;path:string};
  }catch{throw new SafeError('Run cellartracker-write-mcp setup first to create the local pairing file.');}
}
