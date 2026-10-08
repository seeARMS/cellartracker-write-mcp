import {responseDiagnostics,type ResponseDiagnostics} from './diagnostics.js';
import {CookieJar} from 'tough-cookie';
import {SafeError,type BrowserRequest,type Environment,type ProviderGate,type Transport} from './types.js';
import {validateConsumption} from './validation.js';
import {backoffMs,cooldownSource,realClock,readRetryPolicy,retryAfterMs,retryFailure,type RetryClock} from './backoff.js';
class TransientResponse extends Error {constructor(readonly code:string,readonly status:number,readonly delayMs:number|undefined,readonly metadata:ResponseDiagnostics){super(code);}}
const origin='https://www.cellartracker.com';
const latin=(value:string)=>{
 let encoded='';for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);encoded+=code>255&&code!==381?'&#'+code+';':value[i];}
 return escape(encoded).replace(/\+/g,'%2B').replace(/%20/g,'+');
};
export function buildRequest(r:BrowserRequest){
 if(r.kind==='inventory'||r.kind==='consumed'){
  if(!Number.isInteger(r.page)||r.page<1||r.page>100)throw new SafeError('Inventory or history exceeds the bounded page limit.');
  return {path:`/list.asp?table=${r.kind==='inventory'?'Inventory':'Consumed'}&Page=${r.page}`,method:'GET'};
 }
 if(r.kind==='consumptionDetails'){
  if(!/^\d+$/.test(r.wineId)||!/^\d+$/.test(r.consumedId))throw new SafeError('Invalid consumption identifiers.');
  return {path:`/editconsumed.asp?iWine=${r.wineId}&iConsumed=${r.consumedId}`,method:'GET'};
 }
 if(r.kind==='consumptionForm')return {path:'/popup/consume_form.asp',method:'GET'};
 if(r.kind!=='consume')throw new SafeError('This cloud adapter does not support that operation.');
 validateConsumption(r.details);
 if(!Array.isArray(r.ids)||!r.ids.length||r.ids.length>25||r.ids.some(id=>!/^\d+$/.test(id))||new Set(r.ids).size!==r.ids.length||! /^[A-Z]{3}$/.test(r.currency))throw new SafeError('Invalid consumption request.');
 const [year,month,day]=r.details.date.split('-');
 return {path:`/bulkconsume.asp?Consumed=${Number(month)}%2F${Number(day)}%2F${year}&iConsumptionType=1&ConsumptionNote=${latin(r.details.note)}&Revenue=&RevenueCurrency=${r.currency}`,method:'POST',body:'BulkAction=&'+r.ids.map(id=>'iInventory='+id).join('&')};
}
export class CloudCookieTransport implements Transport {
 private requests=0;private successfulReads=0;private jar!:CookieJar;private userAgent='';private deadline=0;
 constructor(private env:Environment,private fetcher:typeof fetch=fetch,private clock:RetryClock=realClock,private gate?:ProviderGate){}
 async init(){
  const deadline=Date.parse(this.env.CELLARTRACKER_SESSION_EXPIRES_AT??'');
  if(!Number.isFinite(deadline)||deadline<=this.clock.now())throw new SafeError('Cloud session is not activated or its approved expiry has passed. Renew it through the supported secure setup flow.');
  this.deadline=this.clock.now()+readRetryPolicy.operationTimeoutMs;
  let session:unknown;
  try{session=JSON.parse(this.env.CELLARTRACKER_SESSION_JSON??'');}
  catch{throw new SafeError('[SESSION_INVALID_JSON] Enter valid JSON in the native session-secret settings, without code fences. Do not send credentials in chat.');}
  if(!session||typeof session!=='object'||Array.isArray(session))throw new SafeError('[SESSION_WRONG_ROOT_SHAPE] Enter one JSON object with cookie and userAgent fields; do not wrap the object in quotation marks.');
  const rawCookieConfigured=this.env.CELLARTRACKER_COOKIE!==undefined;
  if(!rawCookieConfigured&&!Object.hasOwn(session,'cookie'))throw new SafeError('[SESSION_COOKIE_MISSING] Add the exact case-sensitive cookie field to the session JSON in native secret settings.');
  if(!Object.hasOwn(session,'userAgent'))throw new SafeError('[SESSION_USER_AGENT_MISSING] Add the exact case-sensitive userAgent field to the session JSON in native secret settings.');
  const {userAgent}=session as {userAgent:unknown};
  const cookie:unknown=rawCookieConfigured?this.env.CELLARTRACKER_COOKIE:(session as {cookie:unknown}).cookie;
  if(rawCookieConfigured&&(typeof cookie!=='string'||!cookie.trim()||cookie.length>32768||cookie.split(/;\s*/).some(piece=>! /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^\r\n\0;]*$/.test(piece)||/^(?:Path|Domain|Expires|Max-Age|SameSite)=/i.test(piece))))throw new SafeError('[SESSION_RAW_COOKIE_INVALID] CELLARTRACKER_COOKIE must contain only the full single-line Cookie request-header value, without Cookie:, JSON, quotes or Set-Cookie attributes. Fix or remove it in native secret settings; no fallback to the older cookie is allowed.');
  if(typeof cookie!=='string'||cookie.length>32768)throw new SafeError('[SESSION_COOKIE_FORMAT] The cookie field must be the full Cookie request-header value as a supported JSON string, without the header name.');
  if(typeof userAgent!=='string'||userAgent.length>512)throw new SafeError('[SESSION_USER_AGENT_FORMAT] The userAgent field must be the User-Agent request-header value as a supported JSON string, without the header name.');
  if(!cookie.trim())throw new SafeError('[SESSION_COOKIE_BLANK] Fill the cookie field yourself in native secret settings. Do not send credentials in chat.');
  if(!userAgent.trim())throw new SafeError('[SESSION_USER_AGENT_BLANK] Fill the userAgent field yourself in native secret settings. Do not send credentials in chat.');
  if(/[\r\n\0]/.test(cookie))throw new SafeError('[SESSION_COOKIE_FORBIDDEN_CHARACTERS] The cookie field must contain only the single-line Cookie request-header value, without line breaks or null characters.');
  if(/[\r\n\0]/.test(userAgent))throw new SafeError('[SESSION_USER_AGENT_FORBIDDEN_CHARACTERS] The userAgent field must contain only the single-line User-Agent request-header value, without line breaks or null characters.');
  this.jar=new CookieJar();this.userAgent=userAgent;
  try{
   for(const piece of cookie.split(/;\s*/)){if(!piece.includes('='))throw Error();await this.jar.setCookie(piece+'; Path=/; Secure',origin);}
  }catch{throw new SafeError('[SESSION_COOKIE_FORMAT] The cookie field must be the full Cookie request-header value as a supported JSON string, without the header name.');}
  return this;
 }
 async request(request:BrowserRequest){
  const read=buildRequest(request).method==='GET';
  const deadline=Math.min(this.deadline,this.clock.now()+readRetryPolicy.maxElapsedMs);
  for(let attempt=1;;attempt++){
   if(Date.parse(this.env.CELLARTRACKER_SESSION_EXPIRES_AT??'')<=this.clock.now())throw new SafeError('The approved session cutoff passed. No further upstream request is permitted.');
   let remaining=deadline-this.clock.now();
   if(remaining<=0)throw retryFailure('CELLARTRACKER_READ_DEADLINE',undefined,attempt-1,this.clock.now()+60000,this.clock.now());
   let lease:string|undefined;
   try{
   lease=await this.gate?.acquire?.(deadline);
   // Every attempt, including form/history reads and the sole POST, obeys the shared gate.
   // A pre-existing cooldown returns immediately; only this call's own safe retries may wait.
   await this.gate?.assertAvailable();
   await this.gate?.pace?.(deadline);
   await this.gate?.assertAvailable();
   if(Date.parse(this.env.CELLARTRACKER_SESSION_EXPIRES_AT??'')<=this.clock.now())throw new SafeError('The approved session cutoff passed. No further upstream request is permitted.');
   remaining=deadline-this.clock.now();
   if(remaining<=0)throw retryFailure('CELLARTRACKER_READ_DEADLINE',undefined,attempt-1,this.clock.now()+60000,this.clock.now());
    if(request.kind==='consume'&&request.expiresAt!==undefined&&request.expiresAt<=this.clock.now())throw new SafeError('[CELLARTRACKER_PLAN_EXPIRED] The plan expired while waiting for its provider slot. No POST was sent. Inspect the saved operation; do not resubmit it.');
    const result=await this.attempt(request,Math.min(readRetryPolicy.attemptTimeoutMs,remaining));
    if(read&&this.clock.now()>deadline)throw retryFailure('CELLARTRACKER_READ_DEADLINE',undefined,attempt,this.clock.now()+60000,this.clock.now());
    if(read)this.successfulReads++;
    return result;
   }
   catch(error){
    const transient=error instanceof TransientResponse;
    const network=error instanceof SafeError&&/^\[CELLARTRACKER_(FETCH_FAILED|REQUEST_TIMEOUT|RESPONSE_READ_FAILED)\]/.test(error.message);
    if(!transient&&!network)throw error;
    const code=transient?error.code:(error as Error).message.match(/^\[([^\]]+)\]/)![1];
    const status=transient?error.status:undefined;
    const delay=backoffMs(attempt,transient?error.delayMs:undefined,this.clock.random());
    // A 429 opens the durable circuit. Resume on a later invocation, never before Retry-After.
    const exhausted=status===429||!read||attempt>=readRetryPolicy.maxAttempts||this.clock.now()+delay+1>=deadline;
    const wait=status===429?(transient?error.delayMs:undefined)??15*60000:exhausted?Math.max(60000,delay):delay;
    let retryAt=this.clock.now()+wait;
    let source=status===429?(transient&&error.delayMs!==undefined?'provider_retry_after':'fallback'):cooldownSource(attempt,transient?error.delayMs:undefined,exhausted);
    let streak:number|undefined;
    if(status===429){
     const circuit=await this.gate?.rateLimited?.(transient?error.delayMs:undefined,transient?error.metadata.retry_after_present:false);
     if(circuit){retryAt=circuit.retryAt;source=circuit.source;streak=circuit.streak;}
     else await this.gate?.record(retryAt,source);
    }else if(exhausted)await this.gate?.record(retryAt,source,code);
    if(!read){
     if(transient)throw new SafeError(`[${error.code}] The single consumption submission received an unsuccessful response. Its outcome may be uncertain; inspect the saved status. It will never be replayed.`);
     throw error;
    }
    if(exhausted){
     // A cooldown prevents fresh calls from immediately restarting an exhausted read.
     throw retryFailure(code,status,attempt,retryAt,this.clock.now(),source,{error_origin:transient?'upstream_http':'read_failure',response_classification:status===429?'http_rate_limit':transient?'service_error':'network_failure',...(transient?{response_metadata:error.metadata}:{}),...(streak?{rate_limit_streak:streak}:{}),request_kind:request.kind,...('page'in request?{upstream_page:request.page}:{}),total_upstream_attempts:this.requests,successful_upstream_reads:this.successfulReads});
    }
    await this.clock.sleep(delay);
   }finally{if(lease)await this.gate?.release?.(lease);}
  }
 }
 private async attempt(request:BrowserRequest,timeoutMs:number){
  if(++this.requests>300)throw new SafeError('[CELLARTRACKER_REQUEST_BUDGET] The bounded request budget was exceeded; no automatic retry is allowed.');
  const r=buildRequest(request);const url=origin+r.path;
  const cookie=await this.jar.getCookieString(url);
  if(!cookie)throw new SafeError('The cloud session expired. Renew it through the supported secure setup flow.');
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),timeoutMs);
  try{
  let response:Response;
  try{response=await this.fetcher.call(globalThis,url,{method:r.method,body:r.body,redirect:'manual',signal:controller.signal,headers:{Cookie:cookie,'User-Agent':this.userAgent,Referer:origin+'/list.asp?table=Inventory',...(r.method==='POST'?{Origin:origin,'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest'}:{})}});}
  catch(error){
   if(controller.signal.aborted||(error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError')))throw new SafeError('[CELLARTRACKER_REQUEST_TIMEOUT] The bounded upstream request timed out. No automatic retry is allowed; inspect saved status if consumption was submitted.');
   if(error instanceof Error){
    if(error.message.startsWith('Illegal invocation'))throw new SafeError('[CELLARTRACKER_RUNTIME_INVOCATION] The hosted runtime rejected the fetch invocation before an HTTP response. Review the runtime integration; session replacement is not indicated by this error.');
    if(/ByteString|Invalid character in header|invalid header value/i.test(error.message))throw new SafeError('[CELLARTRACKER_HEADER_FORMAT] The runtime rejected a request-header format. Recheck the single-line Cookie and User-Agent values yourself in native secret settings.');
    if(error.message.startsWith('Unsupported redirect mode'))throw new SafeError('[CELLARTRACKER_RUNTIME_REDIRECT] The hosted runtime rejected its redirect configuration before an HTTP response. Review runtime support; session replacement is not indicated by this error.');
    if(error.message.startsWith('Cannot perform I/O'))throw new SafeError('[CELLARTRACKER_RUNTIME_CONTEXT] The hosted runtime rejected the request context before an HTTP response. Review the runtime integration; session replacement is not indicated by this error.');
   }
   throw new SafeError('[CELLARTRACKER_FETCH_FAILED] The upstream request failed before an HTTP response was available. No automatic retry is allowed; inspect saved status if consumption was submitted.');
  }
  // Close rejected/challenge response streams without inspecting their bodies.
  if(response.status!==200||response.headers.get('cf-mitigated')==='challenge'){try{await response.body?.cancel();}catch{}}
  // Never follow redirects or expose their destinations, nor accept their cookies/body.
  if(response.status>=300&&response.status<400){
   let signIn=false;
   try{const destination=new URL(response.headers.get('location')??'',url);signIn=destination.origin===origin&&destination.pathname.toLowerCase()==='/login.asp';}catch{}
   if(signIn){await this.gate?.block?.('CELLARTRACKER_AUTHENTICATION_REQUIRED');throw new SafeError('[CELLARTRACKER_AUTHENTICATION_REQUIRED] CellarTracker redirected this request to its sign-in page. It was not followed. Renew the session only through the approved user-only secure flow.');}
   throw new SafeError('[CELLARTRACKER_UNEXPECTED_REDIRECT] CellarTracker returned a redirect. It was not followed. Authentication or the fixed endpoint may require review.');
  }
  if(response.redirected||(response.url&&response.url!==url))throw new SafeError('[CELLARTRACKER_ENDPOINT_CHANGED] The response did not remain on the exact approved endpoint. It was rejected.');
  if(response.headers.get('cf-mitigated')==='challenge'){
   if(response.status===429){const delay=retryAfterMs(response.headers.get('retry-after'),this.clock.now());if(this.gate?.rateLimited)await this.gate.rateLimited(delay,response.headers.has('retry-after'));else await this.gate?.record(this.clock.now()+(delay??15*60000),delay===undefined?'fallback':'provider_retry_after');}
   await this.gate?.block?.('CELLARTRACKER_BROWSER_CHALLENGE');
   throw new SafeError('[CELLARTRACKER_BROWSER_CHALLENGE] The upstream service requires a browser challenge for this cloud request. No challenge bypass or automatic retry is attempted.');
  }
  if(response.status===401){await this.gate?.block?.('CELLARTRACKER_AUTHENTICATION_REQUIRED');throw new SafeError('[CELLARTRACKER_AUTHENTICATION_REQUIRED] CellarTracker rejected this request as unauthenticated. Renew the session only through the approved user-only secure flow.');}
  if(response.status===403){await this.gate?.block?.('CELLARTRACKER_ACCESS_DENIED');throw new SafeError('[CELLARTRACKER_ACCESS_DENIED] CellarTracker denied the cloud request. The response does not establish whether the account session or cloud access was rejected.');}
  if(response.status===429||(response.status>=500&&response.status<=599)){
   const delay=retryAfterMs(response.headers.get('retry-after'),this.clock.now());
   // Error bodies and refresh cookies are never consumed or accepted on failed attempts.
   try{await response.body?.cancel();}catch{}
   throw new TransientResponse(response.status===429?'CELLARTRACKER_RATE_LIMITED':'CELLARTRACKER_SERVICE_ERROR',response.status,delay,responseDiagnostics(response.headers,delay));
  }
  if(response.status!==200)throw new SafeError('[CELLARTRACKER_HTTP_ERROR] CellarTracker returned an unexpected HTTP response. It was rejected.');
  for(const value of response.headers.getSetCookie?.()??[])await this.jar.setCookie(value,url,{ignoreError:true});
  // Refresh cookies stay in memory for this call. No credential is stored in D1 or exposed through tools.
  const reader=response.body?.getReader();const parts:Uint8Array[]=[];let length=0;
  try{if(reader)while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>2_000_000){await reader.cancel();throw new SafeError('CellarTracker response exceeds the supported size.');}parts.push(value);}}
  catch(error){if(error instanceof SafeError)throw error;if(controller.signal.aborted)throw new SafeError('[CELLARTRACKER_REQUEST_TIMEOUT] The bounded upstream response timed out. No automatic retry is allowed.');throw new SafeError('[CELLARTRACKER_RESPONSE_READ_FAILED] The upstream response could not be read completely. No automatic retry is allowed.');}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  let text:string;try{text=new TextDecoder(response.headers.get('content-type')?.match(/charset=([^;\s]+)/i)?.[1]??'windows-1252').decode(bytes);}catch{throw new SafeError('CellarTracker returned an unsupported encoding.');}
  return {status:response.status,url:response.url||url,text};
  }finally{clearTimeout(timeout);}
 }
}
