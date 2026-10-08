import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
test('upgrade from deployed v6 preserves operation history, reservations, and provider cooldowns',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('PRAGMA foreign_keys=ON');const migrations=readdirSync('drizzle').filter(n=>n.endsWith('.sql')).sort();
  for(const name of migrations.slice(0,3))db.exec(readFileSync('drizzle/'+name,'utf8'));
  db.exec("INSERT INTO operations(id,owner,request_key,fingerprint,account_id,body,status,created_at,expires_at,submitted_at,observation) VALUES('operation','owner','request','fingerprint','123','{}','complete',1,2,1,'{}'); INSERT INTO bottle_claims(owner,account_id,bottle_id,operation_id) VALUES('owner','123','1','operation'); INSERT INTO provider_cooldowns(owner,account_id,retry_at,source) VALUES('owner','123',9999999999999,'provider_retry_after');");
  for(const name of migrations.slice(3))db.exec(readFileSync('drizzle/'+name,'utf8'));
  const operation=db.prepare('SELECT * FROM operations').get()!;assert.equal(operation.status,'complete');assert.equal(operation.submitted_at,1);assert.equal(operation.checking_until,null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM bottle_claims').get()!.n,1);
  const cooldown=db.prepare('SELECT * FROM provider_cooldowns').get()!;assert.equal(cooldown.retry_at,9999999999999);assert.equal(cooldown.retry_code,'CELLARTRACKER_RATE_LIMITED');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});
test('upgrade from v9 adds read checkpoints without changing an unresolved submission or its locks',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('PRAGMA foreign_keys=ON');const migrations=readdirSync('drizzle').filter(n=>n.endsWith('.sql')).sort();
  for(const name of migrations.slice(0,6))db.exec(readFileSync('drizzle/'+name,'utf8'));
  db.exec("INSERT INTO operations(id,owner,request_key,fingerprint,account_id,body,status,created_at,expires_at,submitted_at) VALUES('submitted','owner','request','fingerprint','123','{}','submitted',1,2,1); INSERT INTO account_locks(owner,operation_id) VALUES('owner','submitted'); INSERT INTO bottle_claims(owner,account_id,bottle_id,operation_id) VALUES('owner','123','1','submitted'); INSERT INTO provider_cooldowns(owner,account_id,retry_at,source) VALUES('owner','123',9999999999999,'fallback');");
  const before=JSON.stringify(db.prepare('SELECT * FROM operations').all());for(const name of migrations.slice(6))db.exec(readFileSync('drizzle/'+name,'utf8'));
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM operations').all()),before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM account_locks').get()!.n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM bottle_claims').get()!.n,1);
  assert.equal(db.prepare('SELECT retry_at FROM provider_cooldowns').get()!.retry_at,9999999999999);
  assert.deepEqual(db.prepare('SELECT * FROM reconciliation_reads').all(),[]);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});
test('diagnostic migration preserves v10 operation, cooldown and checkpoint evidence exactly',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('PRAGMA foreign_keys=ON');const migrations=readdirSync('drizzle').filter(n=>n.endsWith('.sql')).sort();for(const name of migrations.slice(0,8))db.exec(readFileSync('drizzle/'+name,'utf8'));
  db.exec("INSERT INTO operations(id,owner,request_key,fingerprint,account_id,body,status,created_at,expires_at,submitted_at) VALUES('submitted','owner','request','fingerprint','123','{}','submitted',1,2,1); INSERT INTO account_locks(owner,operation_id) VALUES('owner','submitted'); INSERT INTO bottle_claims(owner,account_id,bottle_id,operation_id) VALUES('owner','123','1','submitted'); INSERT INTO provider_cooldowns(owner,account_id,retry_at,source,retry_after_until) VALUES('owner','123',9999999999999,'provider_retry_after',9999999999999); INSERT INTO reconciliation_reads(owner,operation_id,scope,generation_id,body,started_at,expires_at) VALUES('owner','submitted','scope','generation','{}',1,2);");
  const tables=['operations','account_locks','bottle_claims','provider_cooldowns','reconciliation_reads'];const before=tables.map(table=>JSON.stringify(db.prepare('SELECT * FROM '+table).all()));for(const name of migrations.slice(8))db.exec(readFileSync('drizzle/'+name,'utf8'));
  assert.deepEqual(tables.map(table=>JSON.stringify(db.prepare('SELECT * FROM '+table).all())),before);assert.deepEqual(db.prepare('SELECT * FROM provider_error_details').all(),[]);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});
