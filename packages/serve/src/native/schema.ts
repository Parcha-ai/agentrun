const text={type:'string'};
const nullableText={type:['string','null']};
const strings={type:'array',items:text};
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
export const NATIVE_SELECTOR=object({kind:{enum:['project','agent','profile']},name:text},['kind']);
export const NATIVE_USAGE=object({input_tokens:{type:['integer','null']},output_tokens:{type:['integer','null']},cache_read_tokens:{type:['integer','null']},cache_write_tokens:{type:['integer','null']},cost_usd:{type:['number','null']}});
export const NATIVE_TARGET=object({runtime:{enum:['claude-code','codex']},project:text,selector:NATIVE_SELECTOR,machine_id:text,version:nullableText,model:nullableText,fingerprint:text,configuration:{type:'array',items:object({path:text,sha256:text})},skills:strings,mcp_servers:strings,state:{enum:['needs_verification','needs_attention','ready']},issues:strings,capabilities:object({launch:{type:'boolean'},notes:{type:'boolean'},skills:{type:'boolean'},workflows:{const:false},approval:{enum:['native','unavailable']},usage:{type:'boolean'}})});
export const NATIVE_BINDING={...NATIVE_TARGET,properties:{...NATIVE_TARGET.properties,connected:{type:'boolean'},verified_at:text,remote:object({connector_id:text,target_id:text})},required:[...NATIVE_TARGET.required,'connected'],'x-agentrun-serve':'native/1'};
export const NATIVE_RUN={...object({runtime:text,project:text,selector:NATIVE_SELECTOR,machine_id:text,fingerprint:text,session_id:nullableText,model:nullableText,learning_revision:nullableText,usage:object({task:{oneOf:[NATIVE_USAGE,{type:'null'}]},reflection:{type:'array',items:NATIVE_USAGE}}),model_requests:{type:'null'}}),'x-agentrun-serve':'native/1'};
const response=(schema:unknown)=>({description:'Native connection on the source machine.',content:{'application/json':{schema}}});
const body=(schema:unknown)=>({required:true,content:{'application/json':{schema}}});
const mark={'x-agentrun-serve':'native/1',security:[{bearer:[]},{ownerSession:[]}],tags:['agents']};
const id={$ref:'#/components/parameters/AgentId'};
export const NATIVE_PATHS:Record<string,Record<string,unknown>>={
 '/native/discover':{post:{...mark,operationId:'discoverNative',summary:'Discover existing native projects on this source machine without running a model',requestBody:body(object({project:text,runtime:{enum:['claude-code','codex']}},['project'])),responses:{'200':response(object({machine_id:text,targets:{type:'array',items:NATIVE_TARGET}}))}}},
 '/native/connect':{post:{...mark,operationId:'connectNative',summary:'Connect a native project using ordinary agent and revision storage',requestBody:body(object({project:text,runtime:{enum:['claude-code','codex']},selector:NATIVE_SELECTOR},['project','runtime'])),responses:{'200':response(object({agent:{$ref:'#/components/schemas/Agent'},native:NATIVE_BINDING}))}}},
 '/agents/{agent_id}/native':{get:{...mark,operationId:'getNative',summary:'Read a native connection',parameters:[id],responses:{'200':response(object({native:{oneOf:[NATIVE_BINDING,{type:'null'}]}}))}}},
 '/agents/{agent_id}/native/verify':{post:{...mark,operationId:'verifyNative',summary:'Check native CLI and sign-in without a paid model call',parameters:[id],responses:{'200':response(object({native:NATIVE_BINDING}))}}},
 '/agents/{agent_id}/native/disconnect':{post:{...mark,operationId:'disconnectNative',summary:'Disconnect future native jobs while retaining source configuration and history',parameters:[id],responses:{'200':response(object({native:NATIVE_BINDING}))}}},
};

const scopes=object({native_execution:{type:'boolean'}},[]);
const connectorId={name:'connector_id',in:'path',required:true,schema:text};
const commandId={name:'command_id',in:'path',required:true,schema:text};
const opaqueObject={type:'object',additionalProperties:true};
const connector=object({id:text,connector_id:text,label:text,created_at:text,last_seen_at:nullableText,status:{enum:['online','offline','revoked']},capabilities:object({observe:{const:true},native_execution:{type:'boolean'}}),targets:{type:'array',items:opaqueObject}});
const remoteMark={...mark,tags:['connectors'],'x-agentrun-serve':'connectors/1'};
const workerMark={...remoteMark,security:[{bearer:[]}]};
Object.assign(NATIVE_PATHS,{
 '/connectors':{
  get:{...remoteMark,operationId:'listRemoteConnectors',summary:'List remote source machines and imported agent targets',responses:{'200':response(object({connectors:{type:'array',items:connector}}))}},
  post:{...workerMark,operationId:'registerRemoteConnector',summary:'Exchange a one-use enrollment code for a connector-scoped credential',requestBody:body(object({installation_id:text,operation_id:text,label:text,capabilities:object({native_execution:{type:'boolean'}},['native_execution'])},['installation_id','operation_id','capabilities'])),responses:{'200':response(object({connector,credential:text,credential_expires_at:text}))}}
 },
 '/connectors/enrollment':{post:{...remoteMark,operationId:'enrollRemoteConnector',summary:'Create a ten-minute one-use connection code',requestBody:body(object({label:text,capabilities:scopes},[])),responses:{'200':response(object({enrollment_token:text,expires_at:text,workspace_id:{const:'local'}}))}}},
 '/connectors/{connector_id}':{delete:{...remoteMark,operationId:'revokeRemoteConnector',summary:'Revoke a source connector and stop its outstanding commands',parameters:[connectorId],responses:{'200':response(object({connector}))}}},
 '/connectors/{connector_id}/import':{post:{...workerMark,operationId:'importRemoteTarget',summary:'Import an explicitly selected source-native agent reference',parameters:[connectorId],requestBody:body(object({target_id:text,name:text,target:NATIVE_BINDING},['target_id','target'])),responses:{'200':response(object({agent_id:text,native:NATIVE_BINDING}))}}},
 '/connectors/{connector_id}/poll':{post:{...workerMark,operationId:'pollRemoteConnector',summary:'Renew active source leases and claim one command without replay',parameters:[connectorId],requestBody:body(object({worker_id:text,active:{type:'array',items:object({command_id:text,lease_token:text})}},['worker_id'])),responses:{'200':response(object({commands:{type:'array',items:opaqueObject},cancelled:strings,server_time:{type:'number'},lease_ttl_ms:{type:'number'}}))}}},
 '/connectors/{connector_id}/commands/{command_id}/events':{post:{...workerMark,operationId:'remoteCommandEvents',summary:'Append an ordered idempotent native event batch for a valid command lease',parameters:[connectorId,commandId],requestBody:body(object({lease_token:text,sequence:{type:'integer',minimum:0},events:{type:'array',items:opaqueObject}})),responses:{'200':response(object({accepted:{const:true}}))}}},
 '/connectors/{connector_id}/commands/{command_id}/complete':{post:{...workerMark,operationId:'completeRemoteCommand',summary:'Complete a source command once under its valid lease',parameters:[connectorId,commandId],requestBody:body(object({lease_token:text,result:{},error:text},['lease_token'])),responses:{'200':response(object({accepted:{const:true}}))}}}
});
