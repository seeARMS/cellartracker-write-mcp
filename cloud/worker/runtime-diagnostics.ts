import {SafeError} from './types.js';

type Step='operation_lookup'|'pending_lookup'|'operation_status'|'reconciliation'|'reconciliation_provider_read'|'reconciliation_checkpoint_save'|'reconciliation_checkpoint_read'|'reconciliation_checkpoint_restart'|'reconciliation_checkpoint_acquire';
// Only fixed categories leave the Worker. Native messages/stacks can contain
// SQL, private cellar data or credentials and must never be returned or logged.
export function runtimeFailureKind(error:unknown){
 if(error instanceof SyntaxError)return 'syntax';
 if(error instanceof RangeError)return 'range';
 if(error instanceof TypeError)return 'type';
 const messages:string[]=[];let current=error;
 for(let i=0;i<3&&current instanceof Error;i++,current=current.cause)messages.push(current.message);
 const message=messages.join(' ');
 if(/\b(?:D1_[A-Z_]+|SQLITE_[A-Z_]+)\b/.test(message)){
  if(/too many.*(?:requests|queries|subrequests)|query.*limit|exceeded.*(?:requests|queries)/i.test(message))return 'database_request_limit';
  if(/too many SQL variables/i.test(message))return 'database_parameter_limit';
  if(/string or blob too big|SQLITE_TOOBIG/i.test(message))return 'database_size_limit';
  if(/no such (?:table|column)/i.test(message))return 'database_schema';
  if(/D1_TYPE_ERROR|not supported.*type|type.*not supported|bind.*(?:type|parameter)/i.test(message))return 'database_binding';
  if(/syntax error/i.test(message))return 'database_syntax';
  if(/constraint|SQLITE_CONSTRAINT/i.test(message))return 'database_constraint';
  if(/overload|timed? ?out|network|reset|unavailable|SQLITE_BUSY|SQLITE_LOCKED/i.test(message))return 'database_availability';
  if(/not authorized|permission denied/i.test(message))return 'database_access';
  if(/daily.*(?:read|write).*limit/i.test(message))return 'database_daily_limit';
  if(/maximum.*(?:storage|DB size)|storage limit/i.test(message))return 'database_storage_limit';
  if(/database.*(?:not found|deleted)|cannot find.*database|no such database/i.test(message))return 'database_missing';
  if(/parse|JSON/i.test(message))return 'database_response_format';
  if(/transaction|rollback|commit/i.test(message))return 'database_transaction';
  if(/internal error/i.test(message))return 'database_internal';
  return 'database';
 }
 return 'unknown';
}
export async function runtimeStep<T>(step:Step,action:()=>Promise<T>):Promise<T>{
 try{return await action();}catch(error){
  if(error instanceof SafeError)throw error;
  throw new SafeError(`[CELLARTRACKER_RUNTIME_${step.toUpperCase()}_${runtimeFailureKind(error).toUpperCase()}] Operation could not complete. No automatic retries are allowed. Inspect the saved state; never replay a submitted consumption.`);
 }
}
