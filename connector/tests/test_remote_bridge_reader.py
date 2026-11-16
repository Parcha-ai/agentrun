"""A broken source JSONL reader closes its subprocess and admits no later command."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import time
import unittest

from agentrun_cli.remote import Bridge


SOURCE = r'''
import {appendFileSync,closeSync,existsSync} from 'node:fs';
import readline from 'node:readline';
const log=LOG_PATH;
const trigger=TRIGGER_PATH;
let ended=false;
const emit=value=>{if(!ended)process.stdout.write(JSON.stringify(value)+'\n');};
for await(const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line);appendFileSync(log,JSON.stringify({type:m.type})+'\n');
 if(m.type==='block-writes'){
  emit({id:m.id,result:{ok:true}});
  const timer=setInterval(()=>{if(existsSync(trigger)){clearInterval(timer);process.stdout.write('{invalid json}\n');}},10);
  await new Promise(()=>{});
 }
 if(m.type==='hold')continue;
 if(m.type==='overflow'||m.type==='boundary'){
  const event={session_key:'fixture',event:{type:'tool',output:{text:''}}};
  const bytes=m.type==='overflow'?4_000_001:4_000_000;
  event.event.output.text='x'.repeat(bytes-Buffer.byteLength(JSON.stringify(event)+'\n'));
  emit(event);
 }else if(m.type==='unterminated'){process.stdout.write('x'.repeat(4_000_001));continue;}
 else if(m.type==='invalid-utf8'){process.stdout.write(Buffer.from([0xff,0x0a]));continue;}
 else if(m.type==='malformed'){process.stdout.write('{invalid json}\n');continue;}
 else if(m.type==='nonobject'){emit([]);continue;}
 else if(m.type==='eof'){ended=true;process.stdout.end(()=>closeSync(1));continue;}
 else if(m.type==='callback'){emit({session_key:'fixture',event:{type:'text',text:'fixture'}});}
 emit({id:m.id,result:{ok:true}});
}
'''


class BridgeReaderBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / 'dispatch.jsonl'
        self.trigger = self.root / 'fail-reader'
        script = self.root / 'bridge.mjs'
        script.write_text(SOURCE.replace('LOG_PATH', json.dumps(str(self.log))).replace('TRIGGER_PATH', json.dumps(str(self.trigger))))
        self.script = script

    def dispatches(self):
        return [json.loads(line)['type'] for line in self.log.read_text().splitlines()]

    def assert_terminal(self, mode, on_event=None):
        bridge = Bridge(self.script, on_event=on_event)
        try:
            with self.assertRaisesRegex(ValueError, 'source bridge stopped'):
                bridge.call({'type': mode}, timeout=2)
            # This call starts only after the reader notified the first waiter. It must never be written.
            with self.assertRaisesRegex(ValueError, 'source bridge stopped'):
                bridge.call({'type': 'later'}, timeout=0.2)
            with self.assertRaisesRegex(ValueError, 'source bridge stopped'):
                bridge.write({'type': 'unchecked-write'})
            bridge.cancel('old-command')
            bridge.reader.join(timeout=2)
            self.assertFalse(bridge.reader.is_alive())
            self.assertIsNotNone(bridge.process.poll(), 'the child cannot keep executing without its reader')
            self.assertEqual(self.dispatches(), [mode], 'no later/cancellation frame reaches the unusable source')
            self.assertEqual(bridge.pending, {})
        finally:
            bridge.close()

    def test_oversized_structured_event_stops_bridge_and_refuses_later_dispatch(self):
        self.assert_terminal('overflow')

    def test_malformed_json_stops_bridge_and_refuses_later_dispatch(self):
        self.assert_terminal('malformed')

    def test_nonobject_json_stops_bridge_and_refuses_later_dispatch(self):
        self.assert_terminal('nonobject')

    def test_oversized_unterminated_frame_stops_before_waiting_for_newline(self):
        self.assert_terminal('unterminated')

    def test_invalid_utf8_stops_bridge_and_refuses_later_dispatch(self):
        self.assert_terminal('invalid-utf8')

    def test_stdout_eof_stops_bridge_and_refuses_later_dispatch(self):
        self.assert_terminal('eof')

    def test_event_callback_failure_uses_the_same_terminal_path(self):
        def fail(_event):
            raise RuntimeError('fixture event sink stopped')
        self.assert_terminal('callback', on_event=fail)

    def test_existing_four_megabyte_frame_limit_remains_accepted(self):
        events = []
        bridge = Bridge(self.script, on_event=events.append)
        try:
            self.assertEqual(bridge.call({'type': 'boundary'}, timeout=2), {'ok': True})
            self.assertEqual(len(events), 1)
            self.assertEqual(len((json.dumps(events[0], separators=(',', ':')) + '\n').encode()), 4_000_000)
            self.assertEqual(bridge.call({'type': 'later'}, timeout=2), {'ok': True})
        finally:
            bridge.close()

    def test_event_callback_can_close_its_own_reader_without_joining_itself(self):
        holder, errors = {}, []
        def close_on_event(_event):
            try:
                holder['bridge'].close()
            except Exception as error:
                errors.append(type(error).__name__)
        bridge = holder['bridge'] = Bridge(self.script, on_event=close_on_event)
        try:
            with self.assertRaisesRegex(ValueError, 'source bridge stopped'):
                bridge.call({'type': 'callback'}, timeout=2)
            bridge.reader.join(timeout=2)
            self.assertFalse(bridge.reader.is_alive())
            self.assertEqual(errors, [], 'close must not join the reader from its own callback')
            self.assertIsNotNone(bridge.process.poll())
        finally:
            bridge.close()

    def test_reader_failure_wakes_every_existing_waiter(self):
        bridge = Bridge(self.script)
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                held = pool.submit(bridge.call, {'type': 'hold'}, 2)
                deadline = time.monotonic() + 2
                while not self.log.exists():
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.01)
                with self.assertRaisesRegex(ValueError, 'source bridge stopped'):
                    bridge.call({'type': 'overflow'}, timeout=2)
                with self.assertRaisesRegex(ValueError, 'source bridge stopped'):
                    held.result(timeout=2)
            bridge.reader.join(timeout=2)
            self.assertIsNotNone(bridge.process.poll())
            self.assertEqual(bridge.pending, {})
            self.assertEqual(self.dispatches(), ['hold', 'overflow'])
        finally:
            bridge.close()

    def test_explicit_close_is_idempotent_and_refuses_new_commands(self):
        bridge = Bridge(self.script)
        bridge.close()
        bridge.close()
        with self.assertRaisesRegex(ValueError, 'source bridge stopped'):
            bridge.call({'type': 'later'}, timeout=0.2)

    def assert_blocked_writer_is_released(self, fatal_reader):
        bridge = Bridge(self.script)
        pool = ThreadPoolExecutor(max_workers=2)
        try:
            self.assertEqual(bridge.call({'type': 'block-writes'}, timeout=2), {'ok': True})
            blocked = pool.submit(bridge.call, {'type': 'held-write', 'payload': 'x' * 3_500_000}, 2)
            deadline = time.monotonic() + 2
            while not bridge.write_lock.locked():
                self.assertLess(time.monotonic(), deadline)
                self.assertFalse(blocked.done(), 'the permitted request must be blocked in its actual pipe write')
                time.sleep(0.01)
            if fatal_reader:
                self.trigger.touch()
                closing = None
            else:
                closing = pool.submit(bridge.close)
            with self.assertRaisesRegex(ValueError, 'source bridge stopped'):
                blocked.result(timeout=2)
            if closing is not None:
                closing.result(timeout=2)
            bridge.reader.join(timeout=2)
            self.assertFalse(bridge.reader.is_alive())
            self.assertIsNotNone(bridge.process.poll())
            self.assertEqual(self.dispatches(), ['block-writes'])
            self.assertEqual(bridge.pending, {})
        finally:
            # A negative-control implementation must not leave its blocked writer
            # hanging in executor teardown after the assertion already failed.
            if bridge.process.poll() is None:
                bridge.process.kill()
                bridge.process.wait(timeout=2)
            bridge.close()
            pool.shutdown(wait=True)

    def test_fatal_reader_reaps_child_before_closing_a_blocked_writer(self):
        self.assert_blocked_writer_is_released(True)

    def test_explicit_close_reaps_child_when_a_writer_cannot_flush(self):
        self.assert_blocked_writer_is_released(False)


if __name__ == '__main__':
    unittest.main()
