const text={type:'string'};
const nullableText={type:['string','null']};
const strings={type:'array',items:text};
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
export const NATIVE_SELECTOR=object({kind:{enum:['project','agent','profile']},name:text},['kind']);
export const NATIVE_USAGE=object({input_tokens:{type:['integer','null']},output_tokens:{type:['integer','null']},cache_read_tokens:{type:['integer','null']},cache_write_tokens:{type:['integer','null']},cost_usd:{type:['number','null']}});
export const NATIVE_TARGET=object({runtime:{enum:['claude-code','codex']},project:text,selector:NATIVE_SELECTOR,machine_id:text,version:nullableText,model:nullableText,fingerprint:text,configuration:{type:'array',items:object({path:text,sha256:text})},skills:strings,mcp_servers:strings,state:{enum:['needs_verification','needs_attention','ready']},issues:strings,capabilities:object({launch:{type:'boolean'},notes:{type:'boolean'},skills:{type:'boolean'},workflows:{const:false},approval:{enum:['native','unavailable']},usage:{type:'boolean'}})});
export const NATIVE_BINDING={...NATIVE_TARGET,properties:{...NATIVE_TARGET.properties,connected:{type:'boolean'},verified_at:text},required:[...NATIVE_TARGET.required,'connected'],'x-agentrun-serve':'native/1'};
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
