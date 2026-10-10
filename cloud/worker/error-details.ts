import type {BrowserRequest,D1Database} from './types.js';
import {SafeError} from './types.js';
import {realClock,type RetryClock} from './backoff.js';
import {responseDiagnostics} from './diagnostics.js';

export const errorDetailsPolicy={bodyBytes:32768,headerBytes:16384,retentionMs:3600000,maxRecords:10};
const credentialField=/(?:password|passwd|pwhash|authorization|cookie|secret|tokens?|csrf|xsrf|apikey|accesskey|sessionkey|sessionid|credentials?)(?:value|confirmation)?$/i;
const isCredentialField=(name:string)=>credentialField.test(name.replace(/[-_.]/g,''));
function trailingSecretPrefix(text:string,secret:string){
 const prefix=new Uint32Array(secret.length);for(let i=1,j=0;i<secret.length;i++){while(j&&secret[i]!==secret[j])j=prefix[j-1];if(secret[i]===secret[j])j++;prefix[i]=j;}
 let matched=0;for(const char of text){while(matched&&char!==secret[matched])matched=prefix[matched-1];if(char===secret[matched])matched++;if(matched===secret.length)matched=prefix[matched-1];}return matched;
}
// Redact credential fields, then known values (including freshly rotated cookies).
// Ordinary provider messages, request IDs, rule IDs and timestamps stay intact.
export function redactErrorText(text:string,secrets:string[]){
 let out=text.replace(/\b(?:Bearer|Basic)\s+(?!realm(?:\s|=)|error(?:\s|=)|scope(?:\s|=))[A-Za-z0-9+/_=.~-]+/gi,'[REDACTED_AUTH]');
 out=out.replace(/(["']?\b([\w.-]{1,80})["']?\s*[:=]\s*)(["'])(.*?)\3/gs,(all,prefix,name,quote,value)=>isCredentialField(name)?prefix+quote+'[REDACTED]'+quote:all);
 out=out.replace(/(^|[?&;\s])([\w.-]{1,80})=([^&;\s<>"']+)/g,(all,sep,name)=>isCredentialField(name)?sep+name+'=[REDACTED]':all);
 out=out.replace(/(["']([\w.-]{1,80})["']\s*:\s*)([^"'\s,}\]]+)/g,(all,prefix,name)=>isCredentialField(name)?prefix+'"[REDACTED]"':all);
 out=out.replace(/<input\b[^>]*>/gi,tag=>{
  const name=tag.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
  return name&&isCredentialField(name)?tag.replace(/(\bvalue\s*=\s*)(["'])(.*?)\2/gis,'$1$2[REDACTED]$2'):tag;
 });
 const variants=new Set<string>();
 for(const value of secrets.filter(v=>v.length>=4&&v!=='null')){
  variants.add(value);variants.add(encodeURIComponent(value));variants.add(encodeURIComponent(value).replace(/%[0-9A-F]{2}/g,s=>s.toLowerCase()));
  variants.add(JSON.stringify(value).slice(1,-1));variants.add(value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'));
 }
 for(const value of [...variants].sort((a,b)=>b.length-a.length)){
  out=out.split(value).join('[REDACTED]');
  // A bounded body may end in the middle of an echoed credential.
  const length=trailingSecretPrefix(out,value);if(length>=4)out=out.slice(0,-length)+'[REDACTED_PARTIAL]';
 }
 out=out.replace(/(["']?\b([\w.-]{1,80})["']?\s*[:=]\s*)(["'])([^"']*)$/s,(all,prefix,name,quote)=>isCredentialField(name)?prefix+quote+'[REDACTED_PARTIAL]':all);
 return out;
}
export function cookieSecrets(cookie:string){return cookie.split(/;\s*/).map(pair=>pair.slice(pair.indexOf('=')+1)).filter(Boolean);}
export class ProviderErrorDetails {
 constructor(private db:D1Database,private owner:string,private account:string,private clock:RetryClock=realClock){}
 private async purge(){
  await this.db.prepare('DELETE FROM provider_error_details WHERE owner=? AND expires_at<=?').bind(this.owner,this.clock.now()).run();
  await this.db.prepare('DELETE FROM provider_error_details WHERE owner=? AND id NOT IN (SELECT id FROM provider_error_details WHERE owner=? ORDER BY created_at DESC,id DESC LIMIT ?)').bind(this.owner,this.owner,errorDetailsPolicy.maxRecords).run();
 }
 async capture(response:Response,request:BrowserRequest,secrets:string[],signal:AbortSignal){
  const id=crypto.randomUUID(),now=this.clock.now();let body='',bytes=0,truncated=false,readError=signal.aborted;
  const parts:Uint8Array[]=[];
  const reader=response.body?.getReader();
  try{
   if(reader){let done=false;
    while(!signal.aborted){
     let abort:()=>void=()=>{};
     const aborted=new Promise<never>((_,reject)=>{abort=()=>reject(new Error('Diagnostic body deadline'));signal.addEventListener('abort',abort,{once:true});});
     let next:ReadableStreamReadResult<Uint8Array>;try{next=await Promise.race([reader.read(),aborted]);}finally{signal.removeEventListener('abort',abort);}
     if(next.done){done=true;break;}const remaining=errorDetailsPolicy.bodyBytes-bytes;
     parts.push(next.value.slice(0,remaining));bytes+=Math.min(next.value.byteLength,remaining);
     if(next.value.byteLength>remaining||bytes===errorDetailsPolicy.bodyBytes){truncated=true;break;}
    }
    if(!done)void reader.cancel().catch(()=>{});
   }
  }catch{readError=true;try{void reader?.cancel().catch(()=>{});}catch{}}
  const captured=new Uint8Array(bytes);let offset=0;for(const part of parts){captured.set(part,offset);offset+=part.byteLength;}
  const charset=response.headers.get('content-type')?.match(/charset=([^;\s]+)/i)?.[1]??'utf-8';
  try{body=new TextDecoder(charset).decode(captured);}catch{body=new TextDecoder().decode(captured);}
  const headers:Record<string,string>={};let headerBytes=0,headersTruncated=false;
  for(const [name,value]of response.headers){
   const safe=isCredentialField(name)?'[REDACTED]':redactErrorText(value,secrets);
   const size=new TextEncoder().encode(JSON.stringify([name,safe])).length;if(headerBytes+size>errorDetailsPolicy.headerBytes){headersTruncated=true;continue;}
   headers[name]=safe;headerBytes+=size;
  }
  const redacted=new TextEncoder().encode(redactErrorText(body,secrets));if(redacted.byteLength>errorDetailsPolicy.bodyBytes)truncated=true;
  const data={error_id:id,recorded_at:new Date(now).toISOString(),expires_at:new Date(now+errorDetailsPolicy.retentionMs).toISOString(),status:response.status,request_kind:request.kind,...('page'in request?{page:request.page}:{}),headers,headers_truncated:headersTruncated,body:new TextDecoder().decode(redacted.subarray(0,errorDetailsPolicy.bodyBytes),{stream:true}),body_bytes_captured:bytes,body_truncated:truncated,body_read_failed:readError,response_metadata:{...responseDiagnostics(response.headers,undefined),body_retained:true},untrusted_provider_data:true};
  await this.db.prepare('INSERT INTO provider_error_details(id,owner,account_id,created_at,expires_at,body) VALUES(?,?,?,?,?,?)').bind(id,this.owner,this.account,now,now+errorDetailsPolicy.retentionMs,JSON.stringify(data)).run();
  await this.purge();return id;
 }
 async get(id?:string){
  await this.purge();
  const row=await this.db.prepare(`SELECT body FROM provider_error_details WHERE owner=? AND account_id=? AND expires_at>?${id?' AND id=?':''} ORDER BY created_at DESC,id DESC LIMIT 1`).bind(this.owner,this.account,this.clock.now(),...(id?[id]:[])).first<{body:string}>();
  if(!row)throw new SafeError('No retained provider error matches this owner/account. Records expire after one hour; earlier categorical-only errors cannot be recovered.');
  return JSON.parse(row.body);
 }
}
