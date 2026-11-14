"""Remote commands preserve source consent and refuse uncertain execution replay."""
import contextlib
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from agentrun_cli.cli import main


class RemoteCLI(unittest.TestCase):
    def test_remote_help_exposes_explicit_project_selection(self):
        output=io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as exit:
            main(['remote','connect','--help'])
        self.assertEqual(exit.exception.code,0)
        self.assertIn('--project',output.getvalue())
        self.assertIn('--credential-file',output.getvalue())
        self.assertNotIn('--token ',output.getvalue())

import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from agentrun_cli.remote import Bridge, Journal, request, epoch, safe_message, worker
from agentrun_cli.state import State
from agentrun_cli.network import APIError

ROOT=Path(__file__).resolve().parents[1]
FAKE_BRIDGE=r'''
import readline from 'node:readline';
import fs from 'node:fs';
const target={runtime:'codex',project:'/fixture/project',selector:{kind:'project'},machine_id:'source-machine',version:'0.167.2',model:'fixture-model',fingerprint:'source-fingerprint',configuration:[],skills:[],mcp_servers:[],state:'ready',connected:true,capabilities:{launch:true,notes:true,skills:true,workflows:false,approval:'unavailable',usage:true}};
const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
for await (const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line);fs.appendFileSync(process.env.REMOTE_TEST_LOG,JSON.stringify(m)+'\n');
 if(m.type==='discover')emit({id:m.id,result:{targets:[{...target,project:m.payload.project}]}});
 else if(m.type==='prepare')emit({id:m.id,result:{target:m.target,instructions:{text:'Standing policy',files:[],truncated:false}}});
 else if(m.type==='history-preview'){const previews=fs.readFileSync(process.env.REMOTE_TEST_LOG,'utf8').trim().split('\n').map(JSON.parse).filter(row=>row.type==='history-preview').length;const changed=process.env.REMOTE_TEST_HISTORY_AFTER_PREVIEW;emit({id:m.id,result:{sessions:[],skipped:[],total:changed&&previews===1?1:2,next_cursor:null,inventory:changed&&previews>1?'b'.repeat(64):'a'.repeat(64)}});}
 else if(m.type==='history-export'){const i=m.payload.cursor,inventory=process.env.REMOTE_TEST_HISTORY_AFTER_PREVIEW?'b'.repeat(64):'a'.repeat(64);if(m.payload.inventory!==inventory){emit({id:m.id,error:'History inventory missing or changed; restart import.'});continue;}const item={source:'codex',id:`fixture-${i}`,startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:01:00Z',state:'completed',firstPrompt:'Selected project only',activeMs:60000,turns:[]};if(process.env.REMOTE_TEST_HISTORY_OVERSIZE)item.firstPrompt='x'.repeat(2000000);emit({id:m.id,result:{sessions:[item],skipped:[],total:2,next_cursor:i===0?1:null,...(i>0&&process.env.REMOTE_TEST_HISTORY_INVENTORY==='missing'?{}:{inventory:i>0&&process.env.REMOTE_TEST_HISTORY_INVENTORY==='changed'?'b'.repeat(64):inventory})}});}
 else if(m.type==='send') {emit({session_key:m.session_key,event:{type:'text',text:'Remote answer'}});emit({id:m.id,result:{sessionId:'native-session',answer:'Remote answer',usage:{input_tokens:8,output_tokens:3,cache_read_tokens:1,cache_write_tokens:0,cost_usd:null}}});}
 else emit({id:m.id,result:{}});
}
'''

class Peer:
    def __init__(self):
        self.requests=[];self.commands=[];self.completed=[];self.events=[];self.redirect=None;self.target=None;self.history=[]
        self.event_attempts=[];self.event_batches={};self.lose_event_reply=False;self.before_lost_event_reply=None
        self.on_request=None
        peer=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or b'{}')
                peer.requests.append((self.path,self.headers.get('Authorization'),body))
                if peer.on_request:
                    response=peer.on_request(self.path,body)
                    if response is not None:
                        status,result=response
                        if status is None:
                            self.close_connection=True
                        else:
                            self.respond(status,result)
                        return
                if peer.redirect:
                    self.send_response(302);self.send_header('Location',peer.redirect);self.end_headers();return
                if self.path=='/v2/connectors':
                    result={'connector':{'id':'connector-1'},'credential':'narrow-test-credential','credential_expires_at':'2099-01-01T00:00:00Z'}
                elif self.path.endswith('/import'):
                    peer.target=body;result={'agent_id':'remote-agent'}
                elif self.path.endswith('/history'):
                    peer.history.extend(body['sessions']);result={'agent_id':'remote-agent','runs':[{'session_id':s['id'],'run_id':'run-'+s['id'],'already':False} for s in body['sessions']],'imported':len(body['sessions']),'already':0}
                elif self.path.endswith('/poll'):
                    result={'commands':peer.commands,'cancelled':[],'server_time':time.time()};peer.commands=[]
                elif self.path.endswith('/events'):
                    peer.event_attempts.append(body)
                    key=(self.path,body['sequence'])
                    if key in peer.event_batches and peer.event_batches[key]!=body:
                        data=json.dumps({'error':{'code':'idempotency_mismatch'}}).encode()
                        self.send_response(409);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return
                    if key not in peer.event_batches:
                        peer.event_batches[key]=body;peer.events.append(body)
                    if peer.lose_event_reply:
                        peer.lose_event_reply=False
                        if peer.before_lost_event_reply:peer.before_lost_event_reply()
                        self.close_connection=True
                        return
                    result={'accepted':True}
                elif self.path.endswith('/complete'):
                    peer.completed.append(body);result={'accepted':True}
                else:
                    self.send_error(404);return
                self.respond(200,result)
            def respond(self,status,result):
                data=json.dumps(result).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.origin=f'http://127.0.0.1:{self.server.server_port}'
    def close(self):self.server.shutdown();self.server.server_close();self.thread.join()


class RemoteBoundary(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.peer=Peer();self.bridge=self.root/'bridge.mjs';self.bridge.write_text(FAKE_BRIDGE)
        self.log=self.root/'bridge.jsonl';self.project=self.root/'project';self.project.mkdir()
        self.state=self.root/'state';self.credential=self.root/'enrollment.json'
        self.credential.write_text(json.dumps({'origin':self.peer.origin,'api_key':'-'.join(['broad','enrollment','test'])}));self.credential.chmod(0o600)
        self.env={**os.environ,'PYTHONPATH':str(ROOT/'src'),'REMOTE_TEST_LOG':str(self.log)}
    def tearDown(self):self.peer.close();self.temp.cleanup()
    def cli(self,*arguments):
        return subprocess.run([sys.executable,'-m','agentrun_cli','remote',*arguments],env=self.env,text=True,capture_output=True,timeout=20)
    def connect(self,*extra):
        result=self.cli('connect','--origin',self.peer.origin,'--project',str(self.project),'--runtime','codex','--credential-file',str(self.credential),'--bridge',str(self.bridge),'--state-dir',str(self.state),'--yes','--no-start',*extra)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        return json.loads((self.state/'config.json').read_text())
    def command(self,target_id,command_id='command-1'):
        return {'command_id':command_id,'lease_token':'lease-fixture','lease_expires_at':time.time()+30,'deadline_at':time.time()+60,'type':'send','target_id':target_id,'session_key':'native-fixture','payload':{'prompt':'One selected task','timeout_ms':3000}}
    def test_connect_imports_only_selected_target_and_persists_only_scoped_credential(self):
        state=self.connect()
        self.assertEqual(self.peer.target['target']['project'],str(self.project))
        self.assertEqual(len(state['targets']),1)
        self.assertEqual(state['credential'],'narrow-test-credential')
        self.assertNotIn('broad-enrollment-test',(self.state/'config.json').read_text())
        self.assertEqual((self.state/'config.json').stat().st_mode & 0o777,0o600)
        self.assertEqual(self.peer.requests[0][1],'Bearer broad-enrollment-test')
        self.assertEqual(self.peer.requests[1][1],'Bearer narrow-test-credential')
        calls=[json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual([row['type'] for row in calls],['discover','prepare'])
    def test_slow_event_upload_cannot_delay_source_lease_expiry(self):
        state=self.connect();command=self.command(next(iter(state['targets'])))
        started=time.monotonic();command['lease_expires_at']=time.time()+1
        self.peer.commands=[command]
        released=threading.Event();cancelled=threading.Event();cancelled_at=[];uploads=[]
        timer=threading.Timer(2.5,released.set);timer.start()
        self.addCleanup(timer.cancel)
        self.addCleanup(released.set)
        class NativeSource:
            def __init__(self,path,on_event):self.on_event=on_event
            def call(self,message,**_options):
                self.on_event({'session_key':command['session_key'],'event':{'type':'text','text':'Pending output'}})
                cancelled.wait(5)
                return {'answer':'Late answer must never be replayed'}
            def cancel(self,command_id):
                cancelled_at.append(time.monotonic());cancelled.set()
            def close(self):cancelled.set()
        def reply(path,body):
            if path.endswith('/events'):
                uploads.append(body)
                released.wait(5)
                return 200,{'accepted':True}
            if path.endswith('/poll') and body['active']:
                return 503,{'error':{'code':'temporarily_unavailable'}}
        self.peer.on_request=reply
        with mock.patch('agentrun_cli.remote.Bridge',NativeSource):
            with self.assertRaisesRegex(ValueError,'source lease expired'):
                worker(State(self.state),once=True)
        self.assertTrue(uploads,'the test must block actual HTTP delivery')
        self.assertTrue(cancelled_at)
        self.assertLess(cancelled_at[0]-started,2,'the one-second lease expires independently of a 2.5-second HTTP upload')
        self.assertEqual(self.peer.completed,[],'no late result is sent after source cancellation')

    def test_worker_delivers_native_result_and_events_for_local_allowlisted_target(self):
        state=self.connect();self.peer.commands=[self.command(next(iter(state['targets'])))]
        result=self.cli('worker','--state-dir',str(self.state),'--foreground','--once')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(self.peer.completed[0]['result']['answer'],'Remote answer')
        self.assertEqual(self.peer.events[0]['events'][0]['text'],'Remote answer')
        self.assertEqual(self.peer.events[0]['sequence'],0)
    def event_delivery_with_lost_reply(self,first,later):
        state=self.connect();command=self.command(next(iter(state['targets'])))
        self.peer.commands=[command]
        dispatched=[];cancelled=[];closed=[];sources=[]
        class NativeSource:
            def __init__(self,path,on_event):
                self.on_event=on_event;sources.append(self)
            def call(self,message,**_options):
                dispatched.append(message)
                self.on_event({'session_key':command['session_key'],'event':first})
                return {'answer':'Native task completed'}
            def cancel(self,command_id):cancelled.append(command_id)
            def close(self):closed.append(True)
        # Accept sequence zero, inject a new native event before dropping its HTTP reply,
        # then enforce the server's identical-payload rule when the worker retries it.
        self.peer.lose_event_reply=True
        self.peer.before_lost_event_reply=lambda:sources[0].on_event({'session_key':command['session_key'],'event':later})
        with mock.patch('agentrun_cli.remote.Bridge',NativeSource):
            result=worker(State(self.state),once=True)
        return result,command,dispatched,cancelled,closed

    def test_worker_retries_an_accepted_event_batch_unchanged_before_sending_new_events(self):
        first={'type':'text','text':'First native event'}
        later={'type':'text','text':'New event after the accepted batch'}
        result,command,dispatched,cancelled,closed=self.event_delivery_with_lost_reply(first,later)
        self.assertEqual(result['status'],'stopped')
        attempts=self.peer.event_attempts
        self.assertEqual([body['sequence'] for body in attempts],[0,0,1])
        self.assertEqual(attempts[0],attempts[1],'a lost reply must replay the exact accepted batch')
        self.assertEqual(attempts[0]['events'],[first])
        self.assertEqual(attempts[2]['events'],[later],'new events wait for the next acknowledged sequence')
        self.assertEqual(self.peer.events,[attempts[0],attempts[2]])
        self.assertEqual(self.peer.completed,[{'lease_token':command['lease_token'],'result':{'answer':'Native task completed'}}])
        self.assertEqual(len(dispatched),1,'delivery retries must never re-execute the native task')
        self.assertEqual(cancelled,[])
        self.assertEqual(closed,[True])

    def test_worker_counts_unacknowledged_events_toward_the_source_queue_limit(self):
        first={'type':'text','text':'a'*190_000}
        later={'type':'text','text':'b'*1_820_000}
        self.assertLess(len(json.dumps(later).encode()),2_000_000,'new events alone fit the queue')
        result,command,dispatched,cancelled,closed=self.event_delivery_with_lost_reply(first,later)
        self.assertEqual(result['status'],'stopped')
        attempts=self.peer.event_attempts
        self.assertEqual([body['sequence'] for body in attempts],[0,0])
        self.assertEqual(attempts[0],attempts[1],'overflow must not alter an accepted pending sequence')
        self.assertEqual(sum(len(event['text']) for event in attempts[0]['events']),len(first['text']))
        self.assertEqual(self.peer.events,[attempts[0]])
        self.assertEqual(self.peer.completed,[{'lease_token':command['lease_token'],'error':'Native event delivery exceeded the bounded source queue; execution stopped.'}])
        self.assertEqual(cancelled,[command['command_id']])
        self.assertEqual(len(dispatched),1)
        self.assertEqual(closed,[True])

    def run_controlled_worker(self,call,cancel=lambda _command_id:None):
        dispatched=[];cancelled=[];closed=[]
        class NativeSource:
            def __init__(self,path,on_event):self.on_event=on_event
            def call(self,message,**_options):
                dispatched.append(message)
                return call(self,message)
            def cancel(self,command_id):
                cancelled.append(command_id)
                cancel(command_id)
            def close(self):
                closed.append(True)
                cancel(None)
        with mock.patch('agentrun_cli.remote.Bridge',NativeSource):
            result=worker(State(self.state),once=True)
        return result,dispatched,cancelled,closed

    def saved_command(self,command):
        journal=Journal(self.state)
        try:return journal.begin(command)
        finally:journal.close()

    def test_worker_retires_polled_cancellation_before_upload_and_runs_next_command(self):
        state=self.connect();target=next(iter(state['targets']))
        first=self.command(target);second=self.command(target,'command-2');second['session_key']='next-session'
        self.peer.commands=[first]
        released=threading.Event();sources=[];cancellation_poll=[]
        def call(source,message):
            sources.append(source)
            if message['id']==first['command_id']:
                if not released.wait(5):raise ValueError('Test source was not stopped')
                return {'answer':'Late cancelled answer'}
            source.on_event({'session_key':second['session_key'],'event':{'type':'text','text':'Next task'}})
            return {'answer':'Next task'}
        def reply(path,body):
            if path.endswith('/poll') and body['active']:
                cancellation_poll.append(body)
                # Output queued just before the poll reply must not be delivered after cancellation.
                sources[0].on_event({'session_key':first['session_key'],'event':{'type':'text','text':'Cancelled output'}})
                return 200,{'commands':[second],'cancelled':[first['command_id']]}
        self.peer.on_request=reply
        result,dispatched,cancelled,closed=self.run_controlled_worker(call,lambda _id:released.set())
        self.assertEqual(result['status'],'stopped')
        self.assertEqual([message['id'] for message in dispatched],[first['command_id'],second['command_id']])
        self.assertEqual(cancelled,[first['command_id']])
        self.assertEqual(closed,[True])
        self.assertEqual(len(cancellation_poll),1)
        self.assertEqual(self.peer.completed,[{'lease_token':second['lease_token'],'result':{'answer':'Next task'}}])
        self.assertEqual([event['text'] for batch in self.peer.events for event in batch['events']],['Next task'])
        self.assertIn('cancelled',self.saved_command(first)['error'])
        self.assertFalse(any(first['command_id'] in path and path.endswith(('/events','/complete')) for path,_,_ in self.peer.requests))

    def test_worker_cancels_queued_dispatch_before_retiring_it(self):
        state=self.connect();target=next(iter(state['targets']))
        first=self.command(target);queued=self.command(target,'queued-command');last=self.command(target,'last-command')
        self.peer.commands=[first,queued]
        released=threading.Event()
        def call(_source,message):
            if message['id']==first['command_id']:
                if not released.wait(5):raise ValueError('Test source was not stopped')
            return {'answer':message['id']}
        def reply(path,body):
            if path.endswith('/poll') and body['active']:
                # Cancel the queued future before releasing the only executor thread.
                return 200,{'commands':[last],'cancelled':[queued['command_id'],first['command_id']]}
        self.peer.on_request=reply
        with mock.patch('agentrun_cli.remote.ThreadPoolExecutor',lambda **_options:ThreadPoolExecutor(max_workers=1)):
            result,dispatched,cancelled,closed=self.run_controlled_worker(call,lambda _id:released.set())
        self.assertEqual(result['status'],'stopped')
        self.assertEqual([message['id'] for message in dispatched],[first['command_id'],last['command_id']])
        self.assertEqual(cancelled,[queued['command_id'],first['command_id']])
        self.assertIn('cancelled',self.saved_command(queued)['error'])
        self.assertIn('cancelled',self.saved_command(first)['error'])
        self.assertEqual(self.peer.completed,[{'lease_token':last['lease_token'],'result':{'answer':last['command_id']}}])

    def test_worker_cancellation_prevents_a_running_dispatch_from_writing_later(self):
        state=self.connect();target=next(iter(state['targets']))
        first=self.command(target);second=self.command(target,'command-2');second['session_key']='next-session'
        self.peer.commands=[first]
        paused=threading.Event();released=threading.Event();attempted=threading.Event();pending_at_cancel=[]
        class PausedBridge(Bridge):
            def write(self,value,*args,**kwargs):
                if value.get('id')==first['command_id'] and value.get('type')=='send':
                    paused.set()
                    if not released.wait(5):raise ValueError('Test dispatch was not released')
                    try:return super().write(value,*args,**kwargs)
                    finally:attempted.set()
                return super().write(value,*args,**kwargs)
            def cancel(self,command_id):
                if command_id==first['command_id']:
                    with self.lock:pending_at_cancel.append(command_id in self.pending)
                super().cancel(command_id)
                if command_id==first['command_id']:
                    released.set()
                    if not attempted.wait(5):raise ValueError('Test write did not finish')
            def close(self):
                released.set()
                super().close()
        def reply(path,body):
            if path.endswith('/poll') and body['active']:
                if not paused.wait(5):return 503,{'error':{'code':'test_dispatch_not_paused'}}
                return 200,{'commands':[second],'cancelled':[first['command_id']]}
        self.peer.on_request=reply
        with mock.patch.dict(os.environ,{'REMOTE_TEST_LOG':str(self.log)}),mock.patch('agentrun_cli.remote.Bridge',PausedBridge):
            result=worker(State(self.state),once=True)
        self.assertEqual(result['status'],'stopped')
        self.assertTrue(paused.is_set())
        self.assertTrue(attempted.is_set())
        self.assertEqual(pending_at_cancel,[True],'dispatch must already be running inside the actual Bridge.call')
        calls=[json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual([row['id'] for row in calls if row['type']=='send'],[second['command_id']],
                         'a cancel written before registration must prevent the later command write')
        self.assertEqual([row['command_id'] for row in calls if row['type']=='cancel'],[first['command_id']])
        self.assertEqual(len(self.peer.completed),1)
        self.assertEqual(self.saved_command(first),{'error':'The destination cancelled this native operation.'})

    def cancellation_during_upload(self,endpoint,reconciliation_failure=False):
        state=self.connect();target=next(iter(state['targets']))
        first=self.command(target);second=self.command(target,'command-2');second['session_key']='next-session'
        self.peer.commands=[first]
        stopped=threading.Event();upload=[];polls=[];first_rejected=False
        def call(source,message):
            if message['id']==first['command_id']:
                if endpoint=='events':
                    source.on_event({'session_key':first['session_key'],'event':{'type':'text','text':'Pending answer'}})
                    if not stopped.wait(5):raise ValueError('Test source was not stopped')
                return {'answer':'First durable answer'}
            return {'answer':'Next task'}
        def reply(path,body):
            nonlocal first_rejected
            if first['command_id'] in path and path.endswith('/'+endpoint):
                upload.append(body);first_rejected=True
                return 412,{'error':{'code':'precondition_failed'}}
            if path.endswith('/poll') and first_rejected:
                polls.append((body,stopped.is_set()))
                if reconciliation_failure is not False and len(polls)==1:
                    return reconciliation_failure,{'error':{'code':'temporarily_unavailable'}}
                return 200,{'commands':[second],'cancelled':[first['command_id']]}
        self.peer.on_request=reply
        result,dispatched,cancelled,closed=self.run_controlled_worker(call,lambda _id:stopped.set())
        return result,first,second,dispatched,cancelled,closed,upload,polls

    def stale_heartbeat_after_rejected_delivery(self,endpoint):
        state=self.connect();target=next(iter(state['targets']))
        first=self.command(target);other=self.command(target,'other-command');following=self.command(target,'following-command')
        other['session_key']='other-session';following['session_key']='following-session'
        self.peer.commands=[first,other]
        stale_started=threading.Event();first_stopped=threading.Event();other_released=threading.Event();other_stopped=threading.Event()
        uploads=[];heartbeats=[]
        def call(source,message):
            if message['id']==first['command_id']:
                if not stale_started.wait(5):raise ValueError('Test heartbeat did not start')
                if endpoint=='events':
                    source.on_event({'session_key':first['session_key'],'event':{'type':'text','text':'Rejected output'}})
                    if not first_stopped.wait(5):raise ValueError('Rejected source was not stopped')
                return {'answer':'First durable answer'}
            if message['id']==other['command_id'] and not other_released.wait(5):
                raise ValueError('Unrelated source was not released')
            return {'answer':message['id']}
        def cancel(command_id):
            if command_id==first['command_id']:first_stopped.set()
            else:
                if command_id==other['command_id']:other_stopped.set()
                other_released.set()
        def reply(path,body):
            if first['command_id'] in path and path.endswith('/'+endpoint):
                uploads.append(body)
                return 412,{'error':{'code':'precondition_failed'}}
            if path.endswith('/poll') and body['active']:
                if not stale_started.is_set():
                    stale_started.set()
                    # This reply was decided before cancellation. Keep it in flight until
                    # the worker consumes the concurrent 412 and stops only that source.
                    stopped=first_stopped.wait(5)
                    heartbeats.append(('stale',body,stopped,other_stopped.is_set()))
                    return 200,{'commands':[],'cancelled':[]}
                if not any(kind=='fresh' for kind,*_rest in heartbeats):
                    heartbeats.append(('fresh',body,first_stopped.is_set(),other_stopped.is_set()))
                    other_released.set()
                    return 200,{'commands':[following],'cancelled':[first['command_id']]}
                return 200,{'commands':[],'cancelled':[]}
        self.peer.on_request=reply
        try:
            result,dispatched,cancelled,closed=self.run_controlled_worker(call,cancel)
        finally:
            self.assertTrue(stale_started.is_set(),'a heartbeat must already be in flight before rejection')
            self.assertTrue(first_stopped.is_set(),'the 412 must stop source execution before that stale reply lands')
        self.assertEqual(result['status'],'stopped')
        self.assertEqual([kind for kind,*_rest in heartbeats],['stale','fresh'])
        self.assertTrue(all(stopped and not unrelated_stopped for _kind,_body,stopped,unrelated_stopped in heartbeats))
        expected=[{'command_id':c['command_id'],'lease_token':c['lease_token']} for c in [first,other]]
        self.assertTrue(all(body['active']==expected for _kind,body,*_rest in heartbeats))
        self.assertCountEqual([message['id'] for message in dispatched],[first['command_id'],other['command_id'],following['command_id']])
        self.assertEqual(cancelled,[first['command_id']],'neither another active command nor future work is cancelled')
        self.assertEqual(closed,[True])
        self.assertEqual(len(uploads),1,'no rejected payload is retried while reconciliation is pending')
        self.assertEqual(self.peer.events,[],'the rejected native output is never accepted')
        self.assertCountEqual(self.peer.completed,[{'lease_token':c['lease_token'],'result':{'answer':c['command_id']}} for c in [other,following]])
        expected_result={'error':'The destination cancelled this native operation.'} if endpoint=='events' else {'result':{'answer':'First durable answer'}}
        self.assertEqual(self.saved_command(first),expected_result,'a completion already persisted before 412 remains immutable')

    def test_stale_heartbeat_cannot_reject_cancellation_of_pending_events(self):
        self.stale_heartbeat_after_rejected_delivery('events')

    def test_stale_heartbeat_cannot_reject_cancellation_of_durable_completion(self):
        self.stale_heartbeat_after_rejected_delivery('complete')

    def test_worker_reconciles_cancellation_racing_pending_events_and_runs_next_command(self):
        result,first,second,dispatched,cancelled,closed,upload,polls=self.cancellation_during_upload('events')
        self.assertEqual(result['status'],'stopped')
        self.assertEqual([message['id'] for message in dispatched],[first['command_id'],second['command_id']])
        self.assertEqual(cancelled,[first['command_id']])
        self.assertEqual(closed,[True])
        self.assertEqual(len(upload),1,'a cancelled pending batch must not be retried')
        self.assertEqual(len(polls),1)
        self.assertEqual(self.peer.completed,[{'lease_token':second['lease_token'],'result':{'answer':'Next task'}}])
        self.assertIn('cancelled',self.saved_command(first)['error'])

    def test_worker_preserves_durable_result_when_cancellation_races_completion(self):
        result,first,second,dispatched,cancelled,closed,upload,polls=self.cancellation_during_upload('complete')
        self.assertEqual(result['status'],'stopped')
        self.assertEqual(len(upload),1)
        self.assertEqual(upload[0],{'lease_token':first['lease_token'],'result':{'answer':'First durable answer'}})
        self.assertEqual(self.saved_command(first),{'result':{'answer':'First durable answer'}})
        self.assertEqual([message['id'] for message in dispatched],[first['command_id'],second['command_id']])
        self.assertEqual(cancelled,[first['command_id']])
        self.assertEqual(self.peer.completed,[{'lease_token':second['lease_token'],'result':{'answer':'Next task'}}])

    def test_worker_blocks_rejected_delivery_during_transient_cancellation_reconciliation(self):
        for failure in (None,429,503):
            # None drops the actual HTTP connection; each case uses a fresh journal.
            with self.subTest(failure=failure):
                self.state=self.root/('state-'+str(failure))
                result,first,second,dispatched,cancelled,closed,upload,polls=self.cancellation_during_upload('events',failure)
                self.assertEqual(result['status'],'stopped')
                self.assertEqual(len(upload),1,'reconciliation must not resume a rejected upload')
                self.assertEqual(len(polls),2)
                self.assertTrue(all(source_stopped for _body,source_stopped in polls))
                self.assertTrue(all(body['active']==[{'command_id':first['command_id'],'lease_token':first['lease_token']}] for body,_stopped in polls))
                self.assertEqual(cancelled,[first['command_id']])
                self.peer.completed.clear();self.peer.events.clear()

    def test_worker_bounds_unresolved_cancellation_by_the_original_lease(self):
        state=self.connect();command=self.command(next(iter(state['targets'])))
        base=time.time();clock=[base];command['lease_expires_at']=base+3;self.peer.commands=[command]
        uploads=[];reconciliations=[];stopped=[];dispatched=[]
        def reply(path,body):
            if path.endswith('/complete'):
                uploads.append(body);clock[0]=base+1
                return 412,{'error':{'code':'precondition_failed'}}
            if path.endswith('/poll') and uploads:
                reconciliations.append(body);clock[0]+=1
                return 503,{'error':{'code':'temporarily_unavailable'}}
        self.peer.on_request=reply
        def call(_source,message):
            dispatched.append(message)
            return {'answer':'Durable answer'}
        with mock.patch('agentrun_cli.remote.time',mock.Mock(time=lambda:clock[0])):
            with self.assertRaisesRegex(ValueError,'source lease expired'):
                self.run_controlled_worker(call,lambda command_id:stopped.append(command_id))
        self.assertEqual(len(uploads),1,'an unresolved rejection must never retry delivery')
        self.assertEqual(len(reconciliations),2)
        self.assertEqual(len(dispatched),1)
        self.assertIn(command['command_id'],stopped)
        self.assertEqual(self.saved_command(command),{'result':{'answer':'Durable answer'}})

    def test_worker_stops_when_cancellation_reconciliation_rejects_connector_credential(self):
        for status in (401,403):
            with self.subTest(status=status):
                self.state=self.root/('state-'+str(status));state=self.connect()
                command=self.command(next(iter(state['targets'])));self.peer.commands=[command];rejected=[]
                def reply(path,body):
                    if path.endswith('/complete'):
                        rejected.append(body)
                        return 412,{'error':{'code':'precondition_failed'}}
                    if path.endswith('/poll') and rejected:
                        return status,{'error':{'code':'unauthorized'}}
                self.peer.on_request=reply
                with self.assertRaisesRegex(ValueError,'revoked or rejected this connector'):
                    self.run_controlled_worker(lambda _source,_message:{'answer':'Durable answer'})
                self.assertEqual(len(rejected),1)
                self.assertFalse(self.peer.completed)

    def test_worker_rejects_non_cancellation_lease_and_auth_errors(self):
        for status in (401,403,404,409,412):
            with self.subTest(status=status):
                self.state=self.root/('state-'+str(status));state=self.connect()
                command=self.command(next(iter(state['targets'])));self.peer.commands=[command]
                self.peer.on_request=lambda path,body:(status,{'error':{'code':'rejected'}}) if path.endswith('/complete') else None
                with self.assertRaisesRegex(ValueError,'rejected the active command lease'):
                    self.run_controlled_worker(lambda _source,_message:{'answer':'Durable answer'})
                self.assertEqual(self.saved_command(command),{'result':{'answer':'Durable answer'}})
                self.assertFalse(self.peer.completed)

    def test_worker_retries_accepted_completion_unchanged_after_lost_reply(self):
        state=self.connect();command=self.command(next(iter(state['targets'])));self.peer.commands=[command]
        attempts=[];completion_renewals=[]
        def reply(path,body):
            if path.endswith('/poll') and attempts:
                completion_renewals.append(body)
            if path.endswith('/complete'):
                attempts.append(body)
                if len(attempts)==1:return None,{}
                # The server renews an already completed command instead of cancelling
                # it, allowing its exact durable result to be acknowledged after a poll.
                return (200,{'accepted':True}) if completion_renewals else (503,{'error':{'code':'temporarily_unavailable'}})
        self.peer.on_request=reply
        result,dispatched,cancelled,closed=self.run_controlled_worker(lambda _source,_message:{'answer':'Durable answer'})
        self.assertEqual(result['status'],'stopped')
        self.assertGreaterEqual(len(attempts),2)
        self.assertTrue(all(body==attempts[0] for body in attempts))
        self.assertEqual(len(completion_renewals),1)
        self.assertEqual(completion_renewals[0]['active'],[{'command_id':command['command_id'],'lease_token':command['lease_token']}])
        self.assertEqual(len(dispatched),1)
        self.assertEqual(cancelled,[])
        self.assertEqual(self.saved_command(command),{'result':{'answer':'Durable answer'}})

    def test_server_cannot_select_an_unapproved_source_target(self):
        self.connect();self.peer.commands=[self.command('unapproved')]
        result=self.cli('worker','--state-dir',str(self.state),'--foreground','--once')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('not approved locally',self.peer.completed[0]['error'])
        calls=[json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertNotIn('send',[row['type'] for row in calls])
    def test_redirect_never_forwards_enrollment_credential(self):
        destination=Peer()
        try:
            self.peer.redirect=destination.origin+'/v2/connectors'
            with self.assertRaises(APIError) as caught:request(self.peer.origin,'private-token','POST','/v2/connectors',{})
            self.assertEqual(caught.exception.status,302)
            self.assertEqual(destination.requests,[])
        finally:destination.close()
    def test_journal_refuses_uncertain_dispatch_and_reuses_completed_result_without_execution(self):
        command=self.command('selected');directory=self.root/'journal';directory.mkdir()
        journal=Journal(directory,'destination-one');self.assertIsNone(journal.begin(command));journal.close()
        journal=Journal(directory,'destination-one');self.assertIn('outcome unknown',journal.begin(command)['error'])
        journal.finish(command['command_id'],{'result':{'answer':'Recorded result'}});journal.close()
        journal=Journal(directory,'destination-one');self.assertEqual(journal.begin(command),{'result':{'answer':'Recorded result'}})
        changed={**command,'payload':{'prompt':'Different side effect'}}
        with self.assertRaisesRegex(ValueError,'different content'):journal.begin(changed)
        journal.close()
        with self.assertRaisesRegex(ValueError,'different connector destination'):Journal(directory,'destination-two')
    def test_source_rejects_nonfinite_expiry_and_unbounded_command_lease(self):
        for value in (float('nan'),float('inf'),-1,'2026-01-01T00:00:00'):
            with self.subTest(expiry=value),self.assertRaises(ValueError):epoch(value)
        state=self.connect();command=self.command(next(iter(state['targets'])))
        command['lease_expires_at']=time.time()+3600;self.peer.commands=[command]
        result=self.cli('worker','--state-dir',str(self.state),'--foreground','--once')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('lease limit',result.stdout)
        self.assertFalse(self.peer.completed)
    def test_source_errors_fit_the_completion_envelope_without_terminal_controls(self):
        message=safe_message(ValueError('First line\nSecond line\x1b[2J\t'+'x'*5000))
        self.assertEqual(len(message),4000)
        self.assertFalse(any(ord(character)<32 or ord(character)==127 for character in message))
        self.assertIn('First line Second line',message)

    def test_history_preview_does_not_enroll_upload_or_verify_native_auth(self):
        result=self.cli('history-preview','--project',str(self.project),'--runtime','codex','--bridge',str(self.bridge),'--state-dir',str(self.state))
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(json.loads(result.stdout)['history']['candidate_sessions'],2)
        self.assertFalse(self.peer.requests)
        self.assertFalse(self.state.exists())
        self.assertEqual([json.loads(line)['type'] for line in self.log.read_text().splitlines()],['discover','history-preview'])
    def test_history_only_imports_selected_pages_without_native_auth_or_worker(self):
        state=self.connect('--history-only')
        self.assertEqual(self.peer.requests[0][2]['capabilities'],{'native_execution':False,'history_import':True})
        self.assertTrue(self.peer.target['history_only'])
        self.assertFalse(state['native_execution'])
        self.assertTrue(state['history_import'])
        self.assertEqual([session['id'] for session in self.peer.history],['fixture-0','fixture-1'])
        self.assertNotIn('prepare',[json.loads(line)['type'] for line in self.log.read_text().splitlines()])
        result=self.cli('worker','--state-dir',str(self.state),'--once')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('history-only',result.stdout)
        self.assertFalse(any(path.endswith('/poll') for path,_,_ in self.peer.requests))
        again=self.cli('import-history','--state-dir',str(self.state),'--yes')
        self.assertEqual(again.returncode,0,again.stdout+again.stderr)
        self.assertEqual([session['id'] for session in self.peer.history],['fixture-0','fixture-1']*2)
    def test_connect_does_not_replace_the_approved_history_preview_before_export(self):
        self.env['REMOTE_TEST_HISTORY_AFTER_PREVIEW']='1'
        result=self.cli('connect','--origin',self.peer.origin,'--project',str(self.project),'--runtime','codex','--credential-file',str(self.credential),'--bridge',str(self.bridge),'--state-dir',str(self.state),'--yes','--history-only')
        self.assertNotEqual(result.returncode,0,'newly eligible conversations require a new approval, even after enrollment')
        self.assertIn('History inventory',result.stdout)
        self.assertFalse(self.peer.history)
        calls=[json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual(sum(call['type']=='history-preview' for call in calls),1)
        self.assertEqual([call['payload']['inventory'] for call in calls if call['type']=='history-export'],['a'*64])
        resumed=self.cli('import-history','--state-dir',str(self.state),'--yes')
        self.assertEqual(resumed.returncode,0,resumed.stdout+resumed.stderr)
        self.assertEqual([session['id'] for session in self.peer.history],['fixture-0','fixture-1'])
    def test_pending_connection_requires_consent_for_its_new_history_preview(self):
        self.env['REMOTE_TEST_HISTORY_AFTER_PREVIEW']='1'
        failed=[]
        def reply(path,_body):
            if path.endswith('/import') and not failed:
                failed.append(True)
                return 503,{'error':{'code':'unavailable'}}
        self.peer.on_request=reply
        first=self.cli('connect','--origin',self.peer.origin,'--project',str(self.project),'--runtime','codex','--credential-file',str(self.credential),'--bridge',str(self.bridge),'--state-dir',str(self.state),'--yes','--history-only')
        self.assertNotEqual(first.returncode,0)
        self.assertNotIn('agent_id',json.loads((self.state/'config.json').read_text()))
        before=len(self.peer.requests)
        declined=subprocess.run([sys.executable,'-m','agentrun_cli','remote','connect','--origin',self.peer.origin,'--project',str(self.project),'--runtime','codex','--bridge',str(self.bridge),'--state-dir',str(self.state),'--history-only'],input='n\n',env=self.env,text=True,capture_output=True,timeout=20)
        self.assertEqual(declined.returncode,0,declined.stdout+declined.stderr)
        self.assertIn('"status": "cancelled"',declined.stdout)
        self.assertIn('"inventory": "'+'b'*64+'"',declined.stdout)
        self.assertEqual(len(self.peer.requests),before,'declining the new preview sends no import or history request')
        self.assertFalse(self.peer.history)
    def test_both_mode_keeps_execution_opt_in_and_uses_scoped_history_credential(self):
        state=self.connect('--history')
        self.assertTrue(state['native_execution'])
        self.assertFalse(self.peer.target['history_only'])
        self.assertEqual(self.peer.requests[0][2]['capabilities'],{'native_execution':True,'history_import':True})
        self.assertIn('prepare',[json.loads(line)['type'] for line in self.log.read_text().splitlines()])
        self.assertTrue(all(auth=='Bearer narrow-test-credential' for path,auth,_ in self.peer.requests if path.endswith('/history')))
    def test_live_only_connection_cannot_import_history_or_dispatch_history_from_server(self):
        state=self.connect();before=len(self.peer.requests)
        result=self.cli('import-history','--state-dir',str(self.state),'--yes')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('not enabled',result.stdout)
        self.assertEqual(len(self.peer.requests),before)
        command=self.command(next(iter(state['targets'])));command['type']='history-export';self.peer.commands=[command]
        result=self.cli('worker','--state-dir',str(self.state),'--once')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('Unsupported source operation',self.peer.completed[0]['error'])
        self.assertNotIn('history-export',[json.loads(line)['type'] for line in self.log.read_text().splitlines()])
    def test_history_rejects_named_profile_attribution_before_any_transfer(self):
        result=self.cli('connect','--origin',self.peer.origin,'--project',str(self.project),'--runtime','codex','--selector-kind','profile','--selector-name','selected','--history-only','--yes')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('--selector-kind project',result.stdout)
        self.assertFalse(self.peer.requests)
    def test_history_refuses_oversized_session_without_partial_upload(self):
        self.env['REMOTE_TEST_HISTORY_OVERSIZE']='1'
        result=self.cli('connect','--origin',self.peer.origin,'--project',str(self.project),'--runtime','codex','--credential-file',str(self.credential),'--bridge',str(self.bridge),'--state-dir',str(self.state),'--yes','--history-only')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('exceeds the upload limit',result.stdout)
        self.assertFalse(self.peer.history)
        self.assertIn('Resume with remote import-history',result.stdout)
        del self.env['REMOTE_TEST_HISTORY_OVERSIZE']
        resumed=self.cli('import-history','--state-dir',str(self.state),'--yes')
        self.assertEqual(resumed.returncode,0,resumed.stdout+resumed.stderr)
        self.assertEqual(len(self.peer.history),2)
        self.assertEqual(sum(path=='/v2/connectors' for path,_,_ in self.peer.requests),1)
    def test_replacement_connection_requires_a_fresh_journal_directory(self):
        state=self.connect();state['disconnected']=True
        (self.state/'config.json').write_text(json.dumps(state))
        before=len(self.peer.requests)
        result=self.cli('connect','--origin',self.peer.origin,'--project',str(self.project),'--runtime','codex','--credential-file',str(self.credential),'--bridge',str(self.bridge),'--state-dir',str(self.state),'--yes','--no-start')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('new private --state-dir',result.stdout)
        self.assertEqual(len(self.peer.requests),before)

    def test_history_inventory_missing_or_changed_never_uploads_the_next_page(self):
        for mode in ('missing','changed'):
            with self.subTest(mode=mode):
                self.env['REMOTE_TEST_HISTORY_INVENTORY']=mode
                state=self.root/('state-'+mode);before=len(self.peer.history)
                result=self.cli('connect','--origin',self.peer.origin,'--project',str(self.project),'--runtime','codex','--credential-file',str(self.credential),'--bridge',str(self.bridge),'--state-dir',str(state),'--yes','--history-only')
                self.assertNotEqual(result.returncode,0)
                self.assertIn('history inventory',result.stdout)
                self.assertIn('deduplicated',result.stdout)
                self.assertEqual(len(self.peer.history)-before,1)
                calls=[json.loads(line) for line in self.log.read_text().splitlines() if json.loads(line)['type']=='history-export']
                self.assertTrue(all(call['payload']['inventory']=='a'*64 for call in calls))
                self.assertTrue(all('inventory' not in body for path,_,body in self.peer.requests if path.endswith('/history')))

if __name__=='__main__': unittest.main()
