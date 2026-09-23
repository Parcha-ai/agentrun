import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import Ajv from 'ajv';
import {supportTriage} from '../dist/demo.js';

const bytes=await readFile(new URL('../schema/workflow.schema.json',import.meta.url),'utf8');
const schema=JSON.parse(bytes);
const check=new Ajv({strict:false,allErrors:true}).compile(schema);

test('generated editor schema accepts the actual example and rejects broken grammar',()=>{
  assert.equal(check(supportTriage),true,JSON.stringify(check.errors));
  const candidate=structuredClone(supportTriage);candidate.root={node:'imaginary'};
  assert.equal(check(candidate),false);
  candidate.root={node:'agent',label:'missing instructions',out:'x'};
  assert.equal(check(candidate),false);
});
test('generated dictionary fields validate branch bodies and allow custom schema keywords',()=>{
  const candidate=structuredClone(supportTriage);
  candidate.schemas.Custom={type:'object','x-custom-keyword':{arbitrary:[1,true,null]}};
  assert.equal(check(candidate),true,JSON.stringify(check.errors));
  candidate.schemas.Custom='not a schema object';assert.equal(check(candidate),false);
  candidate.schemas.Custom={};
  candidate.root={node:'route',label:'route',state:{value:'example'},instructions:'Choose',branches:{a:{body:{node:'code',label:'return',code:'s => s'}},b:{body:{node:'imaginary'}}}};
  assert.equal(check(candidate),false);
});
test('generated schema contains no machine paths or TypeScript import identifiers',()=>{
  assert.doesNotMatch(bytes,/\/home\/|\/tmp\/|import\(\\"/);
});
