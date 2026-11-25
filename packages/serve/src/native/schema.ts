const text={type:'string'};
const nullableText={type:['string','null']};
const strings={type:'array',items:text};
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
export const SOURCE_LOCAL_CONSENT=object({version:{const:1},scope:{type:'string',pattern:'^[a-f0-9]{64}$'}});
export const NATIVE_SELECTOR=object({kind:{enum:['project','agent','profile']},name:text},['kind']);
export const NATIVE_USAGE=object({input_tokens:{type:['integer','null']},output_tokens:{type:['integer','null']},cache_read_tokens:{type:['integer','null']},cache_write_tokens:{type:['integer','null']},cost_usd:{type:['number','null']}});
export const NATIVE_TARGET=object({runtime:{enum:['claude-code','codex']},project:text,selector:NATIVE_SELECTOR,machine_id:text,version:nullableText,model:nullableText,fingerprint:text,configuration:{type:'array',items:object({path:text,sha256:text})},skills:strings,mcp_servers:strings,state:{enum:['needs_verification','needs_attention','ready']},issues:strings,capabilities:object({launch:{type:'boolean'},learning:{type:'boolean'},workflows:{const:false},approval:{enum:['native','unavailable']},usage:{type:'boolean'}})});
export const NATIVE_BINDING={...NATIVE_TARGET,properties:{...NATIVE_TARGET.properties,connected:{type:'boolean'},verified_at:text,remote:object({connector_id:text,target_id:text})},required:[...NATIVE_TARGET.required,'connected'],'x-agentrun-serve':'native/1'};
const SOURCE_TARGET={...NATIVE_TARGET,properties:{...NATIVE_TARGET.properties,runtime:{enum:['claude-code','codex','pi']}}};
const SOURCE_DEPLOYMENT_TARGET={...SOURCE_TARGET,properties:{...SOURCE_TARGET.properties,sync_only:{const:true},connected:{type:'boolean'}},required:[...SOURCE_TARGET.required,'sync_only']};
export const NATIVE_RUN={...object({runtime:text,project:text,selector:NATIVE_SELECTOR,machine_id:text,fingerprint:text,session_id:nullableText,model:nullableText,learning_revision:nullableText,usage:object({task:{oneOf:[NATIVE_USAGE,{type:'null'}]},reflection:{type:'array',items:NATIVE_USAGE}}),model_requests:{type:'null'}}),'x-agentrun-serve':'native/1'};
const response=(schema:unknown)=>({description:'Native connection on the source machine.',content:{'application/json':{schema}}});
const body=(schema:unknown)=>({required:true,content:{'application/json':{schema}}});
const mark={'x-agentrun-serve':'native/1',security:[{bearer:[]},{ownerSession:[]}],tags:['agents']};
const id={$ref:'#/components/parameters/AgentId'};
export const NATIVE_PATHS:Record<string,Record<string,unknown>>={
 '/native/discover':{post:{...mark,operationId:'discoverNative',summary:'Discover existing native projects on this source machine without running a model',requestBody:body(object({project:text,runtime:{enum:['claude-code','codex']}},['project'])),responses:{'200':response(object({machine_id:text,targets:{type:'array',items:NATIVE_TARGET}}))}}},
 '/native/connect':{post:{...mark,operationId:'connectNative',summary:'Connect a native project using ordinary agent and revision storage',requestBody:body(object({project:text,runtime:{enum:['claude-code','codex']},selector:NATIVE_SELECTOR,source_sync:SOURCE_LOCAL_CONSENT},['project','runtime'])),responses:{'200':response(object({agent:{$ref:'#/components/schemas/Agent'},native:NATIVE_BINDING}))}}},
 '/agents/{agent_id}/native':{get:{...mark,operationId:'getNative',summary:'Read a native connection',parameters:[id],responses:{'200':response(object({native:{oneOf:[NATIVE_BINDING,{type:'null'}]}}))}}},
 '/agents/{agent_id}/native/verify':{post:{...mark,operationId:'verifyNative',summary:'Check native CLI and sign-in without a paid model call',parameters:[id],responses:{'200':response(object({native:NATIVE_BINDING}))}}},
 '/agents/{agent_id}/native/disconnect':{post:{...mark,operationId:'disconnectNative',summary:'Disconnect future native jobs while retaining source configuration and history',parameters:[id],responses:{'200':response(object({native:NATIVE_BINDING}))}}},
};

const targetId={name:'target_id',in:'path',required:true,schema:text};
const scopes=object({native_execution:{type:'boolean'},history_import:{type:'boolean'},config_sync:{type:'boolean'}},[]);
const connectorId={name:'connector_id',in:'path',required:true,schema:text};
const commandId={name:'command_id',in:'path',required:true,schema:text};
const opaqueObject={type:'object',additionalProperties:true};
const connector=object({id:text,connector_id:text,label:text,created_at:text,last_seen_at:nullableText,status:{enum:['online','offline','revoked']},capabilities:object({observe:{const:true},native_execution:{type:'boolean'},history_import:{type:'boolean'},config_sync:{type:'boolean'}}),targets:{type:'array',items:opaqueObject}});
const remoteMark={...mark,tags:['connectors'],'x-agentrun-serve':'connectors/1'};
const workerMark={...remoteMark,security:[{bearer:[]}]};
Object.assign(NATIVE_PATHS,{
 '/connectors':{
  get:{...remoteMark,operationId:'listRemoteConnectors',summary:'List remote source machines and imported agent targets',responses:{'200':response(object({connectors:{type:'array',items:connector}}))}},
  post:{...workerMark,operationId:'registerRemoteConnector',summary:'Exchange a one-use enrollment code for a connector-scoped credential',requestBody:body(object({installation_id:text,operation_id:text,label:text,capabilities:object({native_execution:{type:'boolean'},history_import:{type:'boolean'},config_sync:{type:'boolean'}},['native_execution'])},['installation_id','operation_id','capabilities'])),responses:{'200':response(object({connector,credential:text,credential_expires_at:text}))}}
 },
 '/connectors/enrollment':{post:{...remoteMark,operationId:'enrollRemoteConnector',summary:'Create a ten-minute one-use connection code',requestBody:body(object({label:text,capabilities:scopes,connector_id:text},[])),responses:{'200':response(object({enrollment_token:text,expires_at:text,workspace_id:{const:'local'}}))}}},
 '/connectors/{connector_id}':{delete:{...remoteMark,operationId:'revokeRemoteConnector',summary:'Revoke a source connector and stop its outstanding commands',parameters:[connectorId],responses:{'200':response(object({connector}))}}},
 '/connectors/{connector_id}/import':{post:{...workerMark,operationId:'importRemoteTarget',summary:'Import a selected source reference or reserve a setup-only deployment without native execution',parameters:[connectorId],requestBody:body({oneOf:[object({target_id:text,name:text,target:NATIVE_BINDING,history_only:{type:'boolean'},deployment:{const:false},cli_adoption:object({connection_id:text,credential_epoch:text,proof:text})},['target_id','target']),object({target_id:text,name:text,target:SOURCE_DEPLOYMENT_TARGET,deployment:{const:true}},['target_id','target','deployment'])]}),responses:{'200':response({oneOf:[object({agent_id:text,native:NATIVE_BINDING}),object({agent_id:text,target:SOURCE_TARGET})]})}}},
 '/connectors/{connector_id}/targets/{target_id}/history':{post:{...workerMark,operationId:'importRemoteHistory',summary:'Import explicitly selected, redacted past sessions without running or learning from them',parameters:[connectorId,targetId],requestBody:body(object({sessions:{type:'array',minItems:1,maxItems:20,items:opaqueObject}})),responses:{'200':response(object({agent_id:text,runs:{type:'array',items:object({session_id:text,run_id:text,already:{type:'boolean'}})},imported:{type:'integer'},already:{type:'integer'}}))}}},
 '/connectors/{connector_id}/poll':{post:{...workerMark,operationId:'pollRemoteConnector',summary:'Renew active source leases and claim one command without replay',parameters:[connectorId],requestBody:body(object({worker_id:text,active:{type:'array',items:object({command_id:text,lease_token:text})}},['worker_id'])),responses:{'200':response(object({commands:{type:'array',items:opaqueObject},cancelled:strings,server_time:{type:'number'},lease_ttl_ms:{type:'number'}}))}}},
 '/connectors/{connector_id}/commands/{command_id}/events':{post:{...workerMark,operationId:'remoteCommandEvents',summary:'Append an ordered idempotent native event batch for a valid command lease',parameters:[connectorId,commandId],requestBody:body(object({lease_token:text,sequence:{type:'integer',minimum:0},events:{type:'array',items:opaqueObject}})),responses:{'200':response(object({accepted:{const:true}}))}}},
 '/connectors/{connector_id}/commands/{command_id}/complete':{post:{...workerMark,operationId:'completeRemoteCommand',summary:'Complete a source command once under its valid lease',parameters:[connectorId,commandId],requestBody:body(object({lease_token:text,result:{},error:text},['lease_token'])),responses:{'200':response(object({accepted:{const:true}}))}}}
});

const sourceProjectIdentities = [
 object({run_id:text,entry_id:{type:'integer',minimum:1}}),
 object({run_id:text,entry_id:{type:'null'},attempt_epoch:{type:'integer',minimum:1}}),
];
const sourceProjectReceipt = {oneOf:sourceProjectIdentities};
const sourceProjectIssue = {oneOf:sourceProjectIdentities.map(identity => object({...identity.properties,status:{enum:['pending','conflict','uncertain']},reason:text},[...identity.required,'status']))};
const sourceStatus=object({project_issues:{type:'array',items:sourceProjectIssue},enabled:{type:'boolean'},moved:{type:'boolean'},state:{enum:['needs_connection','paused','syncing','needs_attention','ready','moved','conflict']},blockers:{type:'array',items:object({code:text,message:text,path:text},['code','message'])},snapshot:text,current_snapshot:text,connection:object({connector_id:text,target_id:text}),files:{type:'integer'},bytes:{type:'integer'},skills:{type:'integer'},tools:{type:'integer'},tool_connections:{type:'array',items:object({name:text,ready:{type:'boolean'},selected:text,candidates:{type:'array',items:object({name:text,auth:text})}},['name','ready','candidates'])}},['enabled','moved','state','blockers']);
Object.assign(NATIVE_PATHS,{
 '/connectors/{connector_id}/targets/{target_id}/sync/grant':{post:{...workerMark,operationId:'grantSourceSync',summary:'Read or establish this explicitly authorized source sync grant without re-enabling a paused grant',parameters:[connectorId,targetId],requestBody:body(object({})),responses:{'200':response(opaqueObject)}}},
 '/connectors/{connector_id}/targets/{target_id}/sync':{post:{...workerMark,operationId:'publishSourceSync',summary:'Publish a bounded source snapshot under its grant and sequence',parameters:[connectorId,targetId],requestBody:body(object({generation:text,sequence:{type:'integer',minimum:0},snapshot:opaqueObject})),responses:{'200':response(opaqueObject)}}},
 '/connectors/{connector_id}/targets/{target_id}/sync/status':{post:{...workerMark,operationId:'sourceSyncFailure',summary:'Record a fixed source failure while preserving its last complete snapshot',parameters:[connectorId,targetId],requestBody:body(object({generation:text,sequence:{type:'integer',minimum:0},code:{enum:['unsupported_platform','source_changed','source_unavailable','snapshot_too_large']}})),responses:{'200':response(opaqueObject)}}},
 '/agents/{agent_id}/source':{
  get:{...mark,operationId:'getSourceSync',summary:'Read source sync and managed Move readiness',parameters:[id],responses:{'200':response(sourceStatus)}},
  patch:{...mark,operationId:'setSourceSync',summary:'Enable or pause this agent’s source sync',parameters:[id],requestBody:body(object({enabled:{type:'boolean'}})),responses:{'200':response(sourceStatus)}}
 },
 '/agents/{agent_id}/source/move':{post:{...mark,operationId:'moveSourceAgent',summary:'Move the same agent to server-managed execution from its complete synchronized setup',parameters:[id],requestBody:body(object({snapshot:{type:'string',pattern:'^[a-f0-9]{64}$',description:'When supplied, Move refuses unless this reviewed snapshot is still current.'}},[])),responses:{'200':response(object({agent:{$ref:'#/components/schemas/Agent'},source:sourceStatus}))}}},
 '/agents/{agent_id}/source/tools':{post:{...mark,operationId:'bindSourceTool',summary:'Choose the existing destination account for a required source tool',parameters:[id],requestBody:body(object({tool:text,server:text})),responses:{'200':response(sourceStatus)}}}
});

Object.assign(NATIVE_PATHS, {
 '/agents/{agent_id}/source/resolve': { post: { ...mark, operationId:'resolveSourceSync', summary:'Use an explicitly reviewed source snapshot while retaining the prior managed revision in history', parameters:[id], requestBody:body(object({revision:text,snapshot:text})), responses:{'200':response(object({agent:{$ref:'#/components/schemas/Agent'},source:sourceStatus}))} } }
});

Object.assign(NATIVE_PATHS, {
 '/agents/{agent_id}/source/project-review': { post: { ...mark, operationId:'reviewSourceProject', summary:'Acknowledge exact unresolved run receipts and allow later runs to use the saved project', parameters:[id], requestBody:body(object({receipts:{type:'array',minItems:1,maxItems:1000,items:sourceProjectReceipt}})), responses:{'200':response(sourceStatus)} } }
});
