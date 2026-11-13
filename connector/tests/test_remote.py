"""Remote commands preserve source consent and refuse uncertain execution replay."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

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

if __name__=='__main__': unittest.main()

import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from agentrun_cli.remote import Journal, request, epoch, safe_message
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
 else if(m.type==='send') {emit({session_key:m.session_key,event:{type:'text',text:'Remote answer'}});emit({id:m.id,result:{sessionId:'native-session',answer:'Remote answer',usage:{input_tokens:8,output_tokens:3,cache_read_tokens:1,cache_write_tokens:0,cost_usd:null}}});}
 else emit({id:m.id,result:{}});
}
'''

class Peer:
    def __init__(self):
        self.requests=[];self.commands=[];self.completed=[];self.events=[];self.redirect=None;self.target=None
        peer=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or b'{}')
                peer.requests.append((self.path,self.headers.get('Authorization'),body))
                if peer.redirect:
                    self.send_response(302);self.send_header('Location',peer.redirect);self.end_headers();return
                if self.path=='/v2/connectors':
                    result={'connector':{'id':'connector-1'},'credential':'narrow-test-credential','credential_expires_at':'2099-01-01T00:00:00Z'}
                elif self.path.endswith('/import'):
                    peer.target=body;result={'agent_id':'remote-agent'}
                elif self.path.endswith('/poll'):
                    result={'commands':peer.commands,'cancelled':[],'server_time':time.time()};peer.commands=[]
                elif self.path.endswith('/events'):
                    peer.events.append(body);result={'accepted':True}
                elif self.path.endswith('/complete'):
                    peer.completed.append(body);result={'accepted':True}
                else:
                    self.send_error(404);return
                data=json.dumps(result).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
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
    def connect(self):
        result=self.cli('connect','--origin',self.peer.origin,'--project',str(self.project),'--runtime','codex','--credential-file',str(self.credential),'--bridge',str(self.bridge),'--state-dir',str(self.state),'--yes','--no-start')
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
    def test_worker_delivers_native_result_and_events_for_local_allowlisted_target(self):
        state=self.connect();self.peer.commands=[self.command(next(iter(state['targets'])))]
        result=self.cli('worker','--state-dir',str(self.state),'--foreground','--once')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(self.peer.completed[0]['result']['answer'],'Remote answer')
        self.assertEqual(self.peer.events[0]['events'][0]['text'],'Remote answer')
        self.assertEqual(self.peer.events[0]['sequence'],0)
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
