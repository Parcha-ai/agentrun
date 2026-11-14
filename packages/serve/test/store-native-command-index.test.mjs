import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { openSqliteStore, openPostgresStore, migrate, migrationsIn, PgConnection } from '../dist/store/index.js';
import { Connection } from '../dist/store/sqlite/connection.js';
import { backfillNativeCommandOwners } from '../dist/store/native-command-owner.js';
import { client, freshSchema, dropSchema, onPostgres, PG_URL, schemaOf, raw } from "./store-target.mjs";
import { storeOn } from "./store-helpers.mjs";

const prefix='native.remote.command.', upper='native.remote.command/';
const parameters=[prefix,upper,prefix,prefix,'chosen',prefix,upper,prefix,prefix];
const sqliteQuery='SELECT key,value,updated_at FROM settings WHERE key >= ? AND key < ? AND substr(key,1,length(?)) = ? AND connector_id = ? UNION ALL SELECT key,value,updated_at FROM settings WHERE key >= ? AND key < ? AND substr(key,1,length(?)) = ? AND connector_id IS NULL ORDER BY key';
const filter={prefix,connectorId:'chosen'};

test('an earlier same-version SQLite store gains command metadata on server reopen; a runner refuses it before setup',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'native-index-')),file=join(directory,'store.sqlite');
 let store;t.after(async()=>{await store?.close();await rm(directory,{recursive:true,force:true});});
 store=await openSqliteStore({file});
 const own={connector_id:'chosen',payload:'before\u0000after'};
 for(const [name,value] of [['one',own],['other',{connector_id:'other'}],['null',null],['array',[]],['scalar','not-an-object']])await store.settings.put(prefix+name,value);
 await store.close();store=undefined;
 let db=new DatabaseSync(file);
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='settings_native_commands'").get().n,1,'fresh databases have the index');
 db.exec('DROP INDEX settings_native_commands');db.exec('ALTER TABLE settings DROP COLUMN connector_id');
 const before=db.prepare('SELECT key,value,updated_at FROM settings ORDER BY key').all();db.close();
 await assert.rejects(openSqliteStore({file,role:'runner'}),/Start this build’s server before its runners/);
 db=new DatabaseSync(file);assert.equal(db.prepare('PRAGMA table_info(settings)').all().some(column=>column.name==='connector_id'),false,'a runner installs nothing');db.close();
 store=await openSqliteStore({file});
 assert.deepEqual((await store.settings.all(filter)).map(row=>row.value),[own]);
 await store.close();store=undefined;
 db=new DatabaseSync(file);db.exec('DROP INDEX settings_native_commands');
 // Once the column exists, an unrelated raw corrupt value is never parsed during index recreation/backfill.
 db.exec('PRAGMA ignore_check_constraints=ON');db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,0)').run('unrelated.malformed','{bad json');db.close();
 store=await openSqliteStore({file});await store.close();store=undefined;
 db=new DatabaseSync(file);
 try{
  const indexed=db.prepare('EXPLAIN QUERY PLAN '+sqliteQuery).all(...parameters);
  assert.ok(indexed.some(row=>row.detail.includes('settings_native_commands')));
  assert.deepEqual(db.prepare("SELECT key,value,updated_at FROM settings WHERE key <> 'unrelated.malformed' ORDER BY key").all(),before,'setup preserves payload bytes and timestamps');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='unrelated.malformed'").get().value,'{bad json');
  t.diagnostic(JSON.stringify({indexed}));
 }finally{db.close();}
});

test('an existing PostgreSQL schema backfills command metadata without interpreting escaped payload bytes',{skip:!onPostgres&&'PostgreSQL requires AGENTRUN_TEST_PG_URL'},async t=>{
 const schema=await freshSchema(),sql=await client();let store;
 t.after(async()=>{await store?.close();await sql.end();await dropSchema(schema);});
 const migrations=migrationsIn(),at=migrations.findIndex(migration=>migration.name==='native_command_owner');assert.ok(at>0);
 await migrate(sql,schema,Date.now(),migrations.slice(0,at));await sql.query('SET search_path TO '+schema);
 await sql.query("INSERT INTO settings(key,value,updated_at) SELECT 'native.remote.command.other-'||i,json_build_object('connector_id','other','payload',repeat('x',1024))::text,0 FROM generate_series(1,3000) i");
 const encoded='{"connector_id":"cho\\u0073en","payload":"before\\u0000after"}';
 await sql.query('INSERT INTO settings(key,value,updated_at) VALUES($1,$2,0)',[prefix+'one',encoded]);
 await sql.query("INSERT INTO settings(key,value,updated_at) VALUES('native.remote.command.nil','null',0),('native.remote.command.array','[]',0),('native.remote.command.scalar','\"not-an-object\"',0)");
 await assert.rejects(sql.query("INSERT INTO settings(key,value,updated_at) VALUES('native.remote.command.malformed','{bad json',0)"),error=>error.code==='22P02');
 store=await openPostgresStore({url:PG_URL,schema});
 assert.deepEqual((await store.settings.all(filter)).map(row=>row.value),[JSON.parse(encoded)]);
 assert.equal((await sql.query('SELECT value FROM settings WHERE key=$1',[prefix+'one'])).rows[0].value,encoded);
 const query='SELECT key,value,updated_at FROM settings WHERE key >= $1 AND key < $2 AND substr(key,1,length($3)) = $4 AND connector_id = $5 UNION ALL SELECT key,value,updated_at FROM settings WHERE key >= $6 AND key < $7 AND substr(key,1,length($8)) = $9 AND connector_id IS NULL ORDER BY key';
 await sql.query('ANALYZE settings');
 const indexed=(await sql.query('EXPLAIN (ANALYZE,FORMAT JSON) '+query,parameters)).rows;
 assert.ok(JSON.stringify(indexed).includes('settings_native_commands'),'the ordinary planner uses the index for the actual nullable-legacy query');
 assert.equal(Number((await sql.query('SELECT count(*) n FROM settings')).rows[0].n),3004);
 const scans=[];const visit=node=>{if(node['Relation Name']==='settings')scans.push(node);for(const child of node.Plans??[])visit(child);};visit(indexed[0]['QUERY PLAN'][0].Plan);
 assert.ok(scans.every(scan=>scan['Actual Rows']<=4),'the heartbeat never reads the 3000 other connectors’ indexed payloads');
 await sql.query('UPDATE settings SET connector_id=NULL WHERE key=$1',[prefix+'one']);
 assert.deepEqual((await store.settings.all(filter)).map(row=>row.value),[JSON.parse(encoded)],'a racing legacy writer remains visible through strict JS ownership');
 t.diagnostic(JSON.stringify({indexed}));
});

test('command owner backfill rereads a concurrent value after failed raw-value CAS and changes no payload',async t=>{
 const {store,file}=await storeOn(t),key=prefix+'race',rawStore=await raw(file);
 const before={connector_id:'first',payload:'old'},after={connector_id:'second',payload:'before\u0000after'};
 await store.settings.put(key,before);await rawStore.run('UPDATE settings SET connector_id=NULL WHERE key=?',key);await store.close();
 const connection=onPostgres?await PgConnection.open({url:PG_URL,schema:schemaOf(file),owner:true}):await Connection.open(file,{owner:true});
 let raced=false;
 const wrapped=new Proxy(connection,{get(target,property){
  const value=Reflect.get(target,property,target);
  if(property==='all')return async(...args)=>{
   const rows=await value.apply(target,args);
   if(!raced&&rows.some(row=>row.key===key)){raced=true;await rawStore.run('UPDATE settings SET value=?,connector_id=NULL WHERE key=?',JSON.stringify(after),key);}
   return rows;
  };
  return typeof value==='function'?value.bind(target):value;
 }});
 try{
  await backfillNativeCommandOwners(wrapped);assert.ok(raced);
  assert.deepEqual(await rawStore.get('SELECT value,connector_id FROM settings WHERE key=?',key),{value:JSON.stringify(after),connector_id:'second'});
 }finally{await connection.close();await rawStore.close();}
});


test('an old SQLite schema with raw CHECK-violating bytes refuses column setup without changing its data',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'native-index-corrupt-')),file=join(directory,'store.sqlite');
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=await openSqliteStore({file});await store.close();
 let db=new DatabaseSync(file);db.exec('DROP INDEX settings_native_commands');db.exec('ALTER TABLE settings DROP COLUMN connector_id');
 db.exec('PRAGMA ignore_check_constraints=ON');db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,0)').run('unrelated.malformed','{bad json');db.close();
 await assert.rejects(openSqliteStore({file}),/CHECK constraint failed/);
 db=new DatabaseSync(file);
 try{
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='unrelated.malformed'").get().value,'{bad json');
  assert.equal(db.prepare('PRAGMA table_info(settings)').all().some(column=>column.name==='connector_id'),false);
 }finally{db.close();}
});
