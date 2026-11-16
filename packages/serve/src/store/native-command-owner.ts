// Remote command payloads are JSON text. PostgreSQL JSON extraction decodes unrelated strings too and refuses a valid
// escaped NUL there, so the bounded owner is derived in JavaScript and indexed separately from the unchanged payload.
import type { StoreConnection, Statement } from './sqlite/connection.js';

export const NATIVE_COMMAND_PREFIX='native.remote.command.';
export const NATIVE_COMMAND_UPPER='native.remote.command/';
export const validConnectorId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\x00-\x1f]/.test(value)&&/^[\w.-]+$/.test(value);

export function nativeCommandOwner(key:string,encoded:string):string|null{
 if(!key.startsWith(NATIVE_COMMAND_PREFIX))return null;
 try{
  const value:unknown=JSON.parse(encoded);
  const owner=value!==null&&typeof value==='object'&&!Array.isArray(value)?(value as {connector_id?:unknown}).connector_id:undefined;
  return validConnectorId(owner)?owner:null;
 }catch{return null;}
}

type Row={key:string;value:string;connector_id:string|null};
const change=(row:Row):Statement=>({sql:'UPDATE settings SET connector_id = ? WHERE key = ? AND value = ? AND connector_id IS NULL',params:[nativeCommandOwner(row.key,row.value),row.key,row.value]});

/** A server's additive setup, in bounded pages. Never changes a value, timestamp, lease or receipt. A new writer derives
 * its owner atomically; a concurrent legacy update is reread after its raw-value CAS fails, never labelled from stale data.
 * Older native commands keep immutable owners; supported writers update metadata with their value.
 * Null-owner legacy rows remain readable by the filtered reader until a later server can index them. */
export async function backfillNativeCommandOwners(connection:StoreConnection):Promise<void>{
 let after='';
 for(;;){
  const page=await connection.all<Row>('SELECT key,value,connector_id FROM settings WHERE key >= ? AND key < ? AND key > ? AND connector_id IS NULL ORDER BY key LIMIT 8',NATIVE_COMMAND_PREFIX,NATIVE_COMMAND_UPPER,after);
  if(!page.length)return;
  const results=await connection.write(page.map(change));
  for(let i=0;i<page.length;i++)if(results[i]!.changes===0){
   let settled=false;
   for(let attempt=0;attempt<10;attempt++){
    const row=await connection.get<Row>('SELECT key,value,connector_id FROM settings WHERE key = ?',page[i]!.key);
    if(!row||row.connector_id!==null){settled=true;break;}
    if((await connection.write([change(row)]))[0]!.changes===1){settled=true;break;}
   }
   if(!settled)throw new Error('Native command ownership setup is busy. Stop older runners and start this build’s server again before its runners.');
  }
  after=page.at(-1)!.key;
 }
}
