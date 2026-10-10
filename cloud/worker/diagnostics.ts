// Diagnostics are categories and known cookie names, never credential values or body excerpts.
const knownCookieNames=new Set(['PWHash','User','ajs_group_id','ajs_user_id','LastTable','KP_UIDz-ssn','KP_UIDz','aws-waf-token','cf_clearance','__cf_bm','__cflb','__cfruid']);
const version='\\d{1,4}(?:\\.\\d{1,4}){0,3}';
const platform='(?:Macintosh; Intel Mac OS X \\d{1,2}(?:_\\d{1,2}){0,2}|Windows NT \\d{1,2}\\.\\d{1,2}; Win64; x64|X11; Linux x86_64)';
// Only a conventional desktop browser UA can be echoed; arbitrary comments/tokens are redacted.
const browserUA=new RegExp(`^Mozilla/5\\.0 \\(${platform}\\) AppleWebKit/${version} \\(KHTML, like Gecko\\) (?:Chrome/${version} Safari/${version}(?: Edg/${version})?|Version/${version} Safari/${version})$`);
export function sessionDiagnostics(raw:string|undefined,rawCookie?:string){
 const unavailable={configured_user_agent:null,user_agent_class:'unavailable',cookie_names:[]as string[],other_cookie_names_redacted:0,session_source:'hosted_secret_snapshot',cookie_source:rawCookie===undefined?'legacy_session_json':'raw_cookie_secret',capture_time_known:false};
 let session:any;try{session=JSON.parse(raw??'');}catch{return unavailable;}
 if(!session||typeof session!=='object'||Array.isArray(session))return unavailable;
 const ua=typeof session.userAgent==='string'&&session.userAgent.length<=512?session.userAgent:undefined;
 const cookie=rawCookie===undefined?session.cookie:rawCookie;
 const pairs=typeof cookie==='string'&&cookie.length<=32768?cookie.split(/;\s*/).filter((s:string)=>s.includes('=')):[];
 const names=[...new Set<string>(pairs.map((s:string)=>s.slice(0,s.indexOf('='))).filter((n:string)=>knownCookieNames.has(n)))].sort();
 const others=pairs.filter((s:string)=>{const n=s.slice(0,s.indexOf('='));return !knownCookieNames.has(n);}).length;
 return {...unavailable,configured_user_agent:ua&&browserUA.test(ua)?ua:null,user_agent_class:ua?(browserUA.test(ua)?'recognized_browser':'redacted_nonstandard'):'unavailable',cookie_names:names,other_cookie_names_redacted:Math.min(others,128)};
}
export interface ResponseDiagnostics {content_type:'html'|'json'|'text'|'other'|'absent';challenge_signal:'cloudflare_challenge'|'aws_waf_challenge'|'aws_waf_captcha'|'none';cloudflare_header_present:boolean;retry_after_present:boolean;provider_retry_after_seconds?:number;set_cookie_present:boolean;location_present:boolean;body_retained:boolean;error_details_id?:string;error_details_unavailable?:boolean}
export function responseDiagnostics(headers:Headers,delayMs:number|undefined):ResponseDiagnostics{
 const content=headers.get('content-type');const mime=content&&content.length<=256?content.split(';',1)[0].trim().toLowerCase():undefined;
 const waf=headers.get('x-amzn-waf-action');
 return {content_type:content===null?'absent':mime==='text/html'?'html':mime==='application/json'?'json':mime==='text/plain'?'text':'other',challenge_signal:headers.get('cf-mitigated')==='challenge'?'cloudflare_challenge':waf==='challenge'?'aws_waf_challenge':waf==='captcha'?'aws_waf_captcha':'none',cloudflare_header_present:headers.has('cf-ray')||headers.has('cf-mitigated'),retry_after_present:headers.has('retry-after'),...(delayMs===undefined?{}:{provider_retry_after_seconds:Math.ceil(delayMs/1000)}),set_cookie_present:headers.has('set-cookie'),location_present:headers.has('location'),body_retained:false};
}
