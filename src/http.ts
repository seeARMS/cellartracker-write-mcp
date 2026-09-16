import {readFile,writeFile,rename,stat,chmod,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CookieJar} from 'tough-cookie';
import {SafeError,type Transport,type BrowserRequest} from './types.js';
import {validateLabel} from './moves.js';
const origin='https://www.cellartracker.com';
export function buildRequest(request:BrowserRequest){
  if(request.kind==='inventory'){
    if(!Number.isInteger(request.page)||request.page<1||request.page>500)throw new SafeError('Invalid inventory page.');
    return {path:`/list.asp?table=Inventory&Page=${request.page}`,method:'GET'};
  }
  if(request.kind==='relocationForm')return {path:'/popup/relocate_form.asp',method:'GET'};
  const {ids,location,bin}=request;
  if(!ids.length||ids.length>50||new Set(ids).size!==ids.length||ids.some(id=>!/^\d+$/.test(id)))throw new SafeError('Invalid bottle IDs.');
  validateLabel(location);validateLabel(bin);if(!location)throw new SafeError('Location is required.');
  const latin=(value:string)=>{
    let out='';for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);out+=code>255&&code!==381?'&#'+code+';':value[i];}
    return escape(out).replace(/\+/g,'%2B').replace(/%20/g,'+');
  };
  return {path:'/relocate.asp?searchId=&UISource=&SetLocation='+latin(location)+'&SetBin='+latin(bin)+(bin===''?'&Bin_delete=on':''),method:'POST',body:'BulkAction=&'+ids.map(id=>'iInventory='+id).join('&')};
}
export interface Session { cookie?:string; jar?:object; userAgent:string }
export async function saveSession(path:string,session:Session){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temp=path+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify(session)+'\n',{mode:0o600,flag:'wx'});await rename(temp,path);await chmod(path,0o600);
}
export function sessionFromHar(har:any):Session{
  const entries=har?.log?.entries;
  if(!Array.isArray(entries))throw new SafeError('Invalid HAR file.');
  const requests=entries.filter((e:any)=>{
    try{const u=new URL(e.request.url);return u.origin===origin&&u.pathname==='/list.asp';}catch{return false;}
  });
  for(const e of requests.reverse()){
    const headers=new Map<string,string>((e.request.headers??[]).map((h:any)=>[String(h.name).toLowerCase(),String(h.value)]));
    const cookie=headers.get('cookie') || (e.request.cookies??[]).map((c:any)=>`${c.name}=${c.value}`).join('; ');
    const userAgent=headers.get('user-agent');
    if(cookie&&userAgent&&!/[\r\n]/.test(cookie+userAgent))return {cookie,userAgent};
  }
  throw new SafeError('HAR has no authenticated CellarTracker inventory request. Export that request with sensitive data locally; do not upload it.');
}
export class CookieTransport implements Transport {
  private jar!:CookieJar;private userAgent='';
  constructor(private path:string,private fetcher:typeof fetch=fetch){}
  async init(){
    try{
      const info=await stat(this.path);
      if(process.platform!=='win32' && (info.mode&0o077))throw new SafeError('Session file permissions are too broad. Run chmod 600 on the session file.');
      const session:Session=JSON.parse(await readFile(this.path,'utf8'));
      if(typeof session.userAgent!=='string'||!session.userAgent||/[\r\n]/.test(session.userAgent))throw Error();
      this.userAgent=session.userAgent;
      if(session.jar)this.jar=await CookieJar.deserialize(session.jar);
      else if(session.cookie && !/[\r\n]/.test(session.cookie)){
        this.jar=new CookieJar();
        for(const piece of session.cookie.split(/;\s*/)){if(!piece.includes('='))throw Error();await this.jar.setCookie(piece+'; Path=/; Secure',origin);}
      }else throw Error();
      if(!(await this.jar.getCookieString(origin)))throw new SafeError('CellarTracker session is empty or expired. Import a fresh session.');
    }catch(e){if(e instanceof SafeError)throw e;throw new SafeError('Session file is missing or invalid. Import a local authenticated HAR or provide session.json.');}
    return this;
  }
  async request(request:BrowserRequest){
    const r=buildRequest(request);const url=origin+r.path;
    const cookie=await this.jar.getCookieString(url);
    if(!cookie)throw new SafeError('Session expired. Import a fresh CellarTracker session.');
    let response:Response;
    try{response=await this.fetcher(url,{method:r.method,body:r.body,redirect:'error',signal:AbortSignal.timeout(25000),headers:{Cookie:cookie,'User-Agent':this.userAgent,Referer:origin+'/list.asp?table=Inventory',...(r.method==='POST'?{Origin:origin,'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest'}:{})}});}
    catch{throw new SafeError('Direct request failed or redirected. Session may need refreshing. A submitted write may have succeeded; check operation status.');}
    // Never forward a session across origins, and retain server-issued refresh cookies.
    for(const value of response.headers.getSetCookie())await this.jar.setCookie(value,url,{ignoreError:true});
    await saveSession(this.path,{jar:await this.jar.serialize(),userAgent:this.userAgent});
    const bytes=await response.arrayBuffer();if(bytes.byteLength>12_000_000)throw new SafeError('Unexpectedly large response.');
    const charset=response.headers.get('content-type')?.match(/charset=([^;\s]+)/i)?.[1]??'windows-1252';
    return {status:response.status,url:response.url||url,text:new TextDecoder(charset).decode(bytes)};
  }
}
