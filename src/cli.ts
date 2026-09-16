#!/usr/bin/env node
import { join } from 'node:path';
import { readFile,mkdir,stat } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configuration,stateDir } from './config.js';
import { BrowserBridge } from './bridge.js';
import { MoveStore } from './store.js';
import { createMcp } from './server.js';
import { SafeError,type Transport } from './types.js';
import { CookieTransport,saveSession,sessionFromHar } from './http.js';
import {CellarTracker} from './cellar.js';
async function main(){
  const command=process.argv[2]??'serve';
  const sessionPath=process.env.CELLARTRACKER_SESSION_FILE??join(stateDir,'session.json');
  if(command==='setup'){
    const config=await configuration(true);
    console.log(`Optional browser-companion pairing file: ${config.path}\nFor direct cookie authentication, run: cellartracker-write-mcp import-har /path/to/private.har\nSession files must stay private and outside your repository.`);return;
  }
  if(command==='import-har'){
    const path=process.argv[3];if(!path)throw new SafeError('Usage: cellartracker-write-mcp import-har /path/to/private.har');
    let session;try{session=sessionFromHar(JSON.parse(await readFile(path,'utf8')));}catch(e){if(e instanceof SafeError)throw e;throw new SafeError('Cannot read HAR file.');}
    await saveSession(sessionPath,session);console.log(`Imported CellarTracker session to ${sessionPath}. Treat the source HAR as a credential and remove it when no longer needed.`);return;
  }
  if(!['serve','bridge','diagnose'].includes(command))throw new SafeError('Usage: cellartracker-write-mcp [setup|serve|bridge|import-har <file>|diagnose]');
  await mkdir(stateDir,{recursive:true,mode:0o700});
  const release=await lockfile.lock(stateDir,{realpath:false,retries:0});
  let bridge:BrowserBridge|undefined;
  let transport:Transport;
  const hasSession=await stat(sessionPath).then(()=>true,()=>false);
  const mode=process.env.CELLARTRACKER_TRANSPORT??(hasSession?'cookie':'browser');
  try{
    if(mode==='cookie'&&command!=='bridge')transport=await new CookieTransport(sessionPath).init();
    else if(mode==='browser'||command==='bridge'){const config=await configuration();bridge=new BrowserBridge(config.token,config.port);await bridge.start();transport=bridge;}
    else throw new SafeError('CELLARTRACKER_TRANSPORT must be cookie or browser.');
    if(command==='diagnose'){
      const inventory=await new CellarTracker(transport).inventory();
      console.log(JSON.stringify({authenticated:true,transport:mode,totalBottles:inventory.bottles.length,locations:[...new Set(inventory.bottles.map(b=>b.location))]},null,2));
      await bridge?.close();await release();return;
    }
    const server=createMcp(transport,new MoveStore(join(stateDir,'operations')),()=>bridge?bridge.connected():true,mode);
    if(command==='serve')await server.connect(new StdioServerTransport());
    else console.error('Local bridge listening on 127.0.0.1:17843. Use serve for MCP stdio.');
    let closing=false;
    const close=async()=>{if(closing)return;closing=true;await server.close();await bridge?.close();await release();process.exit(0);};
    process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
    if(command==='serve')process.stdin.on('end',()=>void close());
  }catch(e){await bridge?.close();await release();throw e;}
}
main().catch(e=>{const code=(e as NodeJS.ErrnoException).code;console.error(e instanceof SafeError?e.message:code==='EADDRINUSE'||code==='ELOCKED'?'Another CellarTracker server is active (or its lock is recovering). Stop it before starting another.':'Startup failed. Check installation and local state directory permissions.');process.exitCode=1;});
