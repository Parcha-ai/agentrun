import assert from 'node:assert/strict';
import test from 'node:test';
import {runWorkflow, WorkflowVerificationError, validateAnswers, answersToValue, answersSidecar, synthesizeAnswers, compileQuestions, dryRunWorkflow} from '../dist/index.js';

const schemas = {
  result: {type:'object', additionalProperties:false, required:['text'], properties:{text:{type:'string'}}},
  review: {type:'object', required:['complete'], properties:{complete:{type:'boolean',description:'Does the draft answer the request?'}}},
};
const draftWorkflow = {
  v:2,name:'reviewed-draft',schemas,output:{schemaId:'result',path:'draft'},
  root:{node:'agent',label:'write',instructions:'Write a short answer.',out:'result',as:'draft',verify:{out:'review',maxDrives:2}},
};
const judgment = p => ({answers:{complete:{type:'noul',noul:p}}});

test('ignored review callbacks cannot deliver an unverified candidate', async()=>{
  let calls=0;
  await assert.rejects(runWorkflow(draftWorkflow,{}, {
    runNode:async()=>({text:'incomplete'}),runJudge:async()=>{calls++;return judgment(.1);},
  }),error=>error instanceof WorkflowVerificationError && error.candidate.text==='incomplete' && error.drives[0].sidecar.answers.complete.noul===.1);
  assert.equal(calls,1);
});
test('verification exhaustion refuses unmet criteria and retains both drives',async()=>{
  let reviews=0;
  await assert.rejects(runWorkflow(draftWorkflow,{}, {
    runNode:async({review})=>{await review({text:'first'});await review({text:'second'});return {text:'second'};},
    runJudge:async()=>{reviews++;return judgment(.1);},
  }),error=>error.code==='WORKFLOW_VERIFICATION_FAILED'&&error.drives.length===2&&error.drives.every(d=>!d.accepted));
  assert.equal(reviews,2);
});
test('accepted review is reused only for its exact candidate',async()=>{
  let reviews=0;
  const good=await runWorkflow(draftWorkflow,{}, {
    runNode:async({review})=>{const value={text:'complete'};await review(value);return value;},
    runJudge:async()=>{reviews++;return judgment(.9);},
  });
  assert.equal(good.status,'complete');assert.equal(reviews,1);
  await assert.rejects(runWorkflow(draftWorkflow,{}, {
    runNode:async({review})=>{await review({text:'complete'});return {text:'changed'};},
    runJudge:async({state})=>judgment(state.submission.text==='complete'?.9:.1),
  }),WorkflowVerificationError);
});
test('missing downstream capabilities fail before earlier model or effect calls',async()=>{
  let effects=0;
  const workflow={...draftWorkflow,root:{node:'chain',steps:[
    {node:'agent',label:'first',instructions:'Write.',out:'result',as:'draft'},
    {node:'judge',label:'judge',state:{draft:'{draft}'},out:'review',as:'judgment'},
  ]}};
  await assert.rejects(runWorkflow(workflow,{}, {runNode:async()=>{effects++;return {text:'done'};}}),/requires runJudge/);
  assert.equal(effects,0);
});
test('judge-only workflows require no generative runner and preserve raw probability',async()=>{
  const workflow={v:2,name:'decision',schemas:{review:schemas.review},output:{schemaId:'review',path:'decision'},root:{node:'judge',label:'judge',state:{request:'example'},out:'review',as:'decision'}};
  const result=await runWorkflow(workflow,{}, {runJudge:async()=>judgment(.83)});
  assert.deepEqual(result.output,{complete:true});assert.equal(result.state['decision$answers'].answers.complete.noul,.83);
  assert.equal(result.state['decision$answers'].confidence.complete,.66);
});
test('every System One decision rejects invalid adapter answers before continuation', async () => {
  const nodes = [
    { node: 'judge', label: 'decision', state: { request: 'Review the request.' }, out: 'review', as: 'decision' },
    { node: 'pick', label: 'decision', itemsPath: 'items', describe: '{item}', instructions: 'Choose the matching item.', as: 'decision' },
    { node: 'sift', label: 'decision', itemsPath: 'items', out: 'review', as: 'decision' },
    { node: 'route', label: 'decision', state: { request: 'Review the request.' }, instructions: 'Choose a branch.', branches: {
      accept: { body: { node: 'code', label: 'accept', code: 's => ({})' } },
      review: { body: { node: 'code', label: 'review', code: 's => ({})' } },
    } },
    { node: 'escalate', label: 'decision', when: { predicate: 'ask', instructions: 'Does this need review?' }, kind: 'review', stage: 'decision', summary: 'Needs review.' },
    { node: 'loop', label: 'decision', body: { node: 'code', label: 'attempt', code: 's => ({})' }, maxIters: 2, until: { predicate: 'ask', instructions: 'Is the work complete?' } },
    draftWorkflow.root,
  ];
  for (const node of nodes) {
    let continuations = 0, decisions = 0;
    const workflow = { ...draftWorkflow, root: { node: 'chain', steps: [node,
      { node: 'agent', label: 'continuation', instructions: 'Write the result.', out: 'result', as: 'draft' },
    ] } };
    await assert.rejects(runWorkflow(workflow, { items: ['first', 'second'] }, {
      runNode: async ({ label }) => { if (label === 'continuation') continuations++; return { text: 'candidate' }; },
      runJudge: async ({ questions }) => {
        decisions++;
        const answers = synthesizeAnswers(questions);
        const answer = Object.values(answers)[0];
        if (answer.type === 'noul') answer.noul = 2;
        else answer.confidence = 2;
        return { answers };
      },
    }), /not a probability|confidence is not in/, node.node);
    assert.equal(decisions, 1, node.node);
    assert.equal(continuations, 0, node.node);
  }
});

const questions={choice:{type:'choice',instructions:'Choose a queue.',criteria:{support:'Support',sales:'Sales'}},score:{type:'score',instructions:'How useful?',criteria:['none','some','high']},yes:{type:'noul',instructions:'Relevant?'}};
const valid=()=>({choice:{type:'choice',choice:'support',probabilities:{support:.8,sales:.2},confidence:.7},score:{type:'score',score:1.6,legend:{0:'none',1:'some',2:'high'},probabilities:{0:.1,1:.2,2:.7},confidence:.6},yes:{type:'noul',noul:.73}});
test('raw weighted score and Noul retained beside documented derived values',()=>{
  const answers=valid();validateAnswers(questions,answers);
  assert.deepEqual(answersToValue(answers,questions),{choice:'support',score:2,yes:true});
  assert.equal(answersSidecar(answers).answers.score.score,1.6);
  validateAnswers(questions,synthesizeAnswers(questions));
});
test('partial, extra, nonnormalized, infinite, inconsistent and mislabeled distributions reject',()=>{
  const mutations=[a=>delete a.yes,a=>a.extra={type:'noul',noul:.8},a=>delete a.choice.probabilities.sales,a=>a.choice.probabilities.extra=0,a=>a.choice.probabilities.support=.9,a=>a.choice.probabilities.support=Infinity,a=>a.choice.confidence=NaN,a=>a.score.legend[1]='wrong',a=>a.score.score=2,a=>a.yes.noul=-.1];
  for(const mutate of mutations){const answers=valid();mutate(answers);assert.throws(()=>validateAnswers(questions,answers));}
});
test('terminal schema is exactly user owned, including formerly reserved names',async()=>{
  const schema={type:'object',required:['report_field_claims','downstream_concern'],properties:{report_field_claims:{type:'string'},downstream_concern:{type:'string'}}};
  const workflow={v:2,name:'user-fields',schemas:{schema},output:{schemaId:'schema',path:'output'},root:{node:'agent',label:'make',instructions:'Make.',out:'schema',as:'output'}};
  const value={report_field_claims:'user value',downstream_concern:'user value'};
  assert.deepEqual((await runWorkflow(workflow,{}, {runNode:async({schema:actual})=>{assert.deepEqual(actual,schema);return value;}})).output,value);
});
test('SOP reference requires actual SOP text before a model session',async()=>{
  let calls=0;
  const workflow={...draftWorkflow,root:{...draftWorkflow.root,sopSection:['POLICY'],verify:undefined}};
  await assert.rejects(runWorkflow(workflow,{}, {runNode:async()=>{calls++;return {text:'x'};}}),/SOP/);
  assert.equal(calls,0);
});

test('abort reaches a top-level adapter and prevents delivery after ignored cancellation',async()=>{
  const controller=new AbortController();
  const abortReason=new Error('test stopped');
  const workflow={...draftWorkflow,root:{...draftWorkflow.root,verify:undefined}};
  await assert.rejects(runWorkflow(workflow,{}, {signal:controller.signal,runNode:async({signal})=>{
    assert.equal(signal,controller.signal);controller.abort(abortReason);return {text:'late result'};
  }}),error=>error===abortReason);
});
test('verification delegates large evidence unchanged to the host without guessing a provider byte limit',async()=>{
  let calls=0;
  const controller=new AbortController();
  const evidence={original:'Fictional complete source: '+ 'é'.repeat(30000),qualifier:'Retain this final exception verbatim.'};
  const workflow={...draftWorkflow,root:{...draftWorkflow.root,verify:{out:'review',state:{evidence:'{evidence}'}}}};
  const result=await runWorkflow(workflow,{evidence}, {signal:controller.signal,runNode:async()=>({text:'candidate'}),runJudge:async request=>{
    calls++;assert.deepEqual(request.state,{evidence,submission:{text:'candidate'}});
    assert(Buffer.byteLength(JSON.stringify(request.state),'utf8')>48*1024);
    assert.deepEqual(request.questions,{complete:{type:'noul',instructions:schemas.review.properties.complete.description}});
    assert.equal(request.signal,controller.signal);return judgment(.9);
  }});
  assert.equal(calls,1);assert.deepEqual(result.output,{text:'candidate'});
});
test('large verification still propagates an explicit host refusal without rewriting or retrying',async()=>{
  let calls=0;const failure=new Error('Fictional host-owned resource limit');
  const workflow={...draftWorkflow,root:{...draftWorkflow.root,verify:{out:'review',state:{evidence:'{evidence}'}}}};
  await assert.rejects(runWorkflow(workflow,{evidence:'x'.repeat(60000)}, {runNode:async()=>({text:'candidate'}),runJudge:async request=>{
    calls++;assert.equal(request.state.evidence.length,60000);throw failure;
  }}),error=>error===failure);
  assert.equal(calls,1);
});

test('parallel sibling failure aborts and awaits remaining adapters before returning',async()=>{
  let settled=false;
  const failure=new Error('first branch failed');
  const workflow={...draftWorkflow,output:{schemaId:'result',path:'left'},root:{node:'parallel',label:'both',branches:[
    {node:'agent',label:'left',instructions:'Write.',out:'result',as:'left'},
    {node:'agent',label:'right',instructions:'Write.',out:'result',as:'right'},
  ]}};
  await assert.rejects(runWorkflow(workflow,{}, {runNode:async({label,signal})=>{
    if(label==='left'){await new Promise(resolve=>setTimeout(resolve,10));throw failure;}
    await new Promise(resolve=>signal.addEventListener('abort',()=>setTimeout(resolve,10),{once:true}));
    settled=true;return {text:'late'};
  }}),error=>error===failure);
  assert.equal(settled,true);
});
test('effect retry backoff aborts promptly without another effect attempt',async()=>{
  const {EffectFailure}=await import('../dist/index.js');
  const controller=new AbortController();const reason=new Error('stop retry');let attempts=0;
  const workflow={v:2,name:'retry',schemas:{result:schemas.result},output:{schemaId:'result',path:'result'},root:{
    node:'call',label:'write',via:'tool',tool:'example.action',args:{},out:'result',as:'result',deadline_s:2,retry:{attempts:2,on:['http_5xx'],backoff_s:5},
  }};
  const started=Date.now();
  await assert.rejects(runWorkflow(workflow,{}, {signal:controller.signal,runEffect:async()=>{
    attempts++;setTimeout(()=>controller.abort(reason),10);throw new EffectFailure('temporary', 'http_5xx');
  }}),error=>error===reason);
  assert.equal(attempts,1);assert.ok(Date.now()-started<1000);
});

test('declared root input schema rejects before an adapter is invoked',async()=>{
  let calls=0;
  const workflow={...draftWorkflow,input:{schemaId:'result'},root:{...draftWorkflow.root,verify:undefined}};
  for(const input of [{},{text:1}]) await assert.rejects(runWorkflow(workflow,input,{runNode:async()=>{calls++;return {text:'x'};}}),error=>error.code==='input_invalid');
  assert.equal(calls,0);
  assert.equal((await runWorkflow(workflow,{text:'valid'},{runNode:async()=>({text:'output'})})).status,'complete');
});
test('map concurrency refuses zero, negative, fractional and nonfinite values before work',async()=>{
  const {validateWorkflow,runWorkflowSlice}=await import('../dist/index.js');
  let calls=0;
  for(const maxConcurrency of [0,-1,.5,Infinity,NaN]) {
    const workflow={...draftWorkflow,root:{node:'map',label:'items',itemsPath:'items',as:'draft',maxConcurrency,body:{...draftWorkflow.root,verify:undefined}}};
    assert.equal(validateWorkflow(workflow).ok,false);
    await assert.rejects(runWorkflow(workflow,{items:[1]}, {runNode:async()=>{calls++;return {text:'x'};}}),/maxConcurrency/);
    await assert.rejects(runWorkflowSlice(workflow,{items:[1]},{from:'items'}, {runNode:async()=>{calls++;return {text:'x'};}}),/maxConcurrency/);
  }
  assert.equal(calls,0);
});
test('late effect resolution is refused with its evidence and never automatically retried',async()=>{
  let calls=0;
  const workflow={v:2,name:'deadline',schemas:{result:schemas.result},output:{schemaId:'result',path:'result'},root:{node:'call',label:'write',via:'tool',tool:'example.action',args:{},out:'result',as:'result',deadline_s:.01,retry:{attempts:2,on:['timeout'],backoff_s:.01}}};
  let failure;
  await assert.rejects(runWorkflow(workflow,{}, {runEffect:async({signal})=>{
    calls++;await new Promise(resolve=>setTimeout(resolve,30));assert.equal(signal.aborted,true);return {text:'late completion'};
  }}),error=>{failure=error;return ['effect_deadline_exceeded','effect_outcome_unknown'].includes(error.code);});
  const lateResult=failure.code==='effect_outcome_unknown' ? (await failure.settlement).value : failure.lateResult;
  assert.equal(lateResult.text,'late completion');
  assert.equal(calls,1);
});

test('report adapter failures propagate even when a valid output record already exists',async()=>{
  const failures=[new Error('writer failed'),Object.assign(new Error('writer timed out'),{reason:'timeout'})];
  for(const failure of failures) {
    const workflow={v:2,name:'report',schemas:{result:{type:'object'}},output:{schemaId:'result'},root:{node:'report',label:'report',instructions:'Write the report.'}};
    await assert.rejects(runWorkflow(workflow,{record:{ok:true}}, {runNode:async()=>{throw failure;}}),error=>error===failure);
  }
});

test('reserved JSON keys remain questions, choice options, answers and sidecar entries',()=>{
  const schema=JSON.parse('{"type":"object","properties":{"__proto__":{"type":"boolean","description":"Relevant?"},"constructor":{"type":"string","description":"Choose","enum":["__proto__","other"]}}}');
  const compiled=compileQuestions(schema);
  assert.equal(compiled.ok,true);
  assert.deepEqual(Object.keys(compiled.questions),['__proto__','constructor']);
  assert.deepEqual(Object.keys(compiled.questions.constructor.criteria),['__proto__','other']);
  const answers=synthesizeAnswers(compiled.questions);
  validateAnswers(compiled.questions,answers);
  const value=answersToValue(answers,compiled.questions);
  assert.deepEqual(Object.keys(value),['__proto__','constructor']);
  assert.equal(value.__proto__,true);
  assert.equal(value.constructor,'__proto__');
  assert.equal(Object.getPrototypeOf(value),Object.prototype);
  const sidecar=answersSidecar(answers);
  assert.equal(Object.hasOwn(sidecar.confidence,'__proto__'),true);
  assert.equal(sidecar.confidence.__proto__,0);
  assert.equal(Object.getPrototypeOf(sidecar.confidence),Object.prototype);
});
test('dry-run schema synthesis preserves arbitrary JSON field names',async()=>{
  const {synthesizeInstance}=await import('../dist/index.js');
  const value=synthesizeInstance(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"boolean"}}}'));
  assert.deepEqual(Object.keys(value),['__proto__','constructor']);
  assert.equal(value.__proto__,'x');
  assert.equal(Object.getPrototypeOf(value),Object.prototype);
});
