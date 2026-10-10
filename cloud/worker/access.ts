import {SafeError,type Environment} from './types.js';
// Ongoing access requires an explicit owner-approved opt-in. Missing dates never opt in.
export function accessPolicy(env:Environment){
 const mode=env.CELLARTRACKER_ACCESS_MODE??'timed';
 if(mode!=='timed'&&mode!=='ongoing')throw new SafeError('[CELLARTRACKER_ACCESS_MODE_INVALID] Access mode must be timed or explicitly owner-approved ongoing. No provider request is permitted.');
 const expiresAt=mode==='ongoing'?Infinity:Date.parse(env.CELLARTRACKER_SESSION_EXPIRES_AT??'');
 return {mode,expiresAt};
}
export function assertAccess(env:Environment,now:number,initial=false){
 const policy=accessPolicy(env);
 if(policy.mode==='timed'&&(!Number.isFinite(policy.expiresAt)||policy.expiresAt<=now))throw new SafeError(initial?'Cloud session is not activated or its approved expiry has passed. Renew it through the supported secure setup flow.':'The approved session cutoff passed. No further upstream request is permitted.');
 return policy;
}
