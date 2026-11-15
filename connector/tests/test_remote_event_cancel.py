"""Terminal source events precede completion; cancellation cannot block the worker."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
import queue
import threading
import time
import unittest
from unittest import mock

from agentrun_cli import remote
from agentrun_cli.state import State
import test_remote as fixtures
import test_remote_bridge_reader as reader_fixtures


class FinalEventDelivery(unittest.TestCase):
    setUp = fixtures.RemoteBoundary.setUp
    tearDown = fixtures.RemoteBoundary.tearDown
    cli = fixtures.RemoteBoundary.cli
    connect = fixtures.RemoteBoundary.connect
    command = fixtures.RemoteBoundary.command
    saved_command = fixtures.RemoteBoundary.saved_command
    run_controlled_worker = fixtures.RemoteBoundary.run_controlled_worker

    def finish_between_drain_and_done(self, events, reject_events=False):
        state = self.connect()
        command = self.command(next(iter(state['targets'])))
        self.peer.commands = [command]
        released = threading.Event()
        dispatched = []
        first_executor = True

        class FinishedAtCheck:
            def __init__(self, future): self.future = future
            def done(self):
                # The worker has already drained an empty incoming queue. Finish
                # the real dispatch and its synchronous callbacks at this boundary.
                released.set()
                self.future.result(timeout=3)
                return True
            def result(self): return self.future.result()
            def cancel(self): return self.future.cancel()

        class DispatchPool:
            def __init__(self, **options): self.pool = ThreadPoolExecutor(**options)
            def submit(self, *args): return FinishedAtCheck(self.pool.submit(*args))
            def shutdown(self, **options): self.pool.shutdown(**options)

        def executor(**options):
            nonlocal first_executor
            if first_executor:
                first_executor = False
                return DispatchPool(**options)
            return ThreadPoolExecutor(**options)

        def call(source, message):
            dispatched.append(message['id'])
            if not released.wait(3): raise ValueError('Test completion boundary was not reached')
            for event in events:
                source.on_event({'session_key': command['session_key'], 'event': event})
            return {'answer': 'Final answer'}

        if reject_events:
            self.peer.on_request = lambda path, _body: (413, {'error': {'code': 'event_capacity'}}) if path.endswith('/events') else None
        with mock.patch('agentrun_cli.remote.ThreadPoolExecutor', executor):
            result, _, cancelled, closed = self.run_controlled_worker(call)
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(dispatched, [command['command_id']])
        self.assertEqual(closed, [True])
        return command, cancelled

    def test_final_tool_and_usage_are_acknowledged_before_completion_and_cached_restart(self):
        events = [{'type': 'tool', 'name': 'fixture', 'input': {}},
                  {'type': 'tool_result', 'name': 'fixture', 'output': {'ok': True}},
                  {'type': 'usage', 'input_tokens': 7, 'output_tokens': 3}]
        command, cancelled = self.finish_between_drain_and_done(events)
        self.assertEqual([event for batch in self.peer.events for event in batch['events']], events)
        paths = [path for path, _, _ in self.peer.requests if path.endswith(('/events', '/complete'))]
        self.assertEqual([path.rsplit('/', 1)[-1] for path in paths], ['events', 'complete'])
        self.assertEqual([batch['sequence'] for batch in self.peer.events], [0])
        self.assertEqual(self.peer.completed, [{'lease_token': command['lease_token'], 'result': {'answer': 'Final answer'}}])
        self.assertEqual(self.saved_command(command), {'result': {'answer': 'Final answer'}})
        self.assertEqual(cancelled, [])
        self.peer.commands = [command]
        def no_replay(*_args): raise AssertionError('A cached completion must not redispatch source work')
        _, dispatched, _, _ = self.run_controlled_worker(no_replay)
        self.assertEqual(dispatched, [])
        self.assertEqual(len(self.peer.completed), 2)
        self.assertEqual(self.peer.completed[0], self.peer.completed[1])

    def test_final_drain_overflow_failure_wins_over_successful_future(self):
        command, cancelled = self.finish_between_drain_and_done([{'type': 'tool', 'output': 'x' * 200_001}])
        self.assertEqual(self.peer.events, [])
        self.assertEqual(cancelled, [command['command_id']])
        expected = {'error': 'Native event delivery exceeded the bounded source queue; execution stopped.'}
        self.assertEqual(self.saved_command(command), expected)
        self.assertEqual(self.peer.completed, [{'lease_token': command['lease_token'], **expected}])

    def test_final_drain_preserves_destination_capacity_failure(self):
        command, cancelled = self.finish_between_drain_and_done([{'type': 'usage', 'output_tokens': 3}], reject_events=True)
        self.assertEqual(cancelled, [command['command_id']])
        expected = {'error': 'Native event delivery exceeded the destination capacity; execution stopped and was not replayed.'}
        self.assertEqual(self.saved_command(command), expected)
        self.assertEqual(self.peer.completed, [{'lease_token': command['lease_token'], **expected}])


class BoundedBridgeCancellation(unittest.TestCase):
    dispatches = reader_fixtures.BridgeReaderBoundary.dispatches

    def setUp(self):
        reader_fixtures.BridgeReaderBoundary.setUp(self)
        # readline keeps prefetching while an async iterator body is parked. Read
        # exactly one frame synchronously so block-writes really stops pipe reads.
        self.script.write_text(r'''
import {readSync,appendFileSync} from 'node:fs';
const log=LOG_PATH,one=Buffer.alloc(1);
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
for(;;){
 let line='';while(readSync(0,one,0,1,null)){if(one[0]===10)break;line+=one.toString();}
 if(!line)break;
 const m=JSON.parse(line);appendFileSync(log,JSON.stringify({type:m.type})+'\n');
 if(m.type==='block-writes'){emit({id:m.id,result:{ok:true}});setInterval(()=>{},1000);await new Promise(()=>{});}
 if(m.type==='hold')continue;
 emit({id:m.id,result:{ok:true}});
}
'''.replace('LOG_PATH', json.dumps(str(self.log))))

    def cleanup_bridge(self, bridge, pool):
        # The unchanged negative control may still be waiting on its real pipe.
        if bridge.process.poll() is None:
            bridge.process.kill()
            bridge.process.wait(timeout=2)
        bridge.close()
        pool.shutdown(wait=True)

    def assert_stopped(self, bridge):
        self.assertTrue(bridge.stopped.is_set())
        self.assertIsNotNone(bridge.process.poll())
        with self.assertRaisesRegex(ValueError, 'source bridge stopped'):
            bridge.write({'type': 'late-write'})
        bridge.cancel('already-stopped')
        bridge.reader.join(timeout=2)
        self.assertFalse(bridge.reader.is_alive())
        self.assertEqual(bridge.pending, {})

    def test_cancel_bounds_mutex_wait_and_never_writes_after_release(self):
        bridge = remote.Bridge(self.script)
        pool = ThreadPoolExecutor(max_workers=1)
        bridge.write_lock.acquire()
        try:
            cancelled = pool.submit(bridge.cancel, 'held-command')
            cancelled.result(timeout=2)
            self.assert_stopped(bridge)
        finally:
            bridge.write_lock.release()
            self.cleanup_bridge(bridge, pool)
        self.assertFalse(self.log.exists(), 'no delayed cancellation frame can reach the source')
        self.assertFalse(any(t.name == f'agentrun-bridge-cancel-{id(bridge)}' for t in threading.enumerate()))

    def test_cancel_reaps_child_and_releases_an_actual_blocked_request_writer(self):
        bridge = remote.Bridge(self.script)
        pool = ThreadPoolExecutor(max_workers=2)
        try:
            self.assertEqual(bridge.call({'type': 'block-writes'}, timeout=2), {'ok': True})
            blocked = pool.submit(bridge.call, {'type': 'held-write', 'payload': 'x' * 3_500_000}, 2)
            deadline = time.monotonic() + 2
            while not bridge.write_lock.locked():
                self.assertLess(time.monotonic(), deadline)
                self.assertFalse(blocked.done())
                time.sleep(.01)
            pool.submit(bridge.cancel, 'held-command').result(timeout=2)
            with self.assertRaisesRegex(ValueError, 'source bridge stopped'):
                blocked.result(timeout=2)
            self.assert_stopped(bridge)
            self.assertEqual(self.dispatches(), ['block-writes'])
            self.assertFalse(any(t.name == f'agentrun-bridge-cancel-{id(bridge)}' for t in threading.enumerate()))
        finally:
            self.cleanup_bridge(bridge, pool)

    def fill_pipe(self, bridge):
        fd = bridge.process.stdin.fileno()
        os.set_blocking(fd, False)
        written = 0
        try:
            while True:
                written += os.write(fd, b'x' * 4096)
        except BlockingIOError:
            self.assertGreater(written, 0)
        finally:
            os.set_blocking(fd, True)

    def test_cancel_bounds_its_own_write_and_flush_on_a_full_pipe(self):
        bridge = remote.Bridge(self.script)
        pool = ThreadPoolExecutor(max_workers=1)
        try:
            self.assertEqual(bridge.call({'type': 'block-writes'}, timeout=2), {'ok': True})
            self.fill_pipe(bridge)
            pool.submit(bridge.cancel, 'held-command').result(timeout=2)
            self.assert_stopped(bridge)
            self.assertEqual(self.dispatches(), ['block-writes'])
            self.assertFalse(any(t.name == f'agentrun-bridge-cancel-{id(bridge)}' for t in threading.enumerate()))
        finally:
            self.cleanup_bridge(bridge, pool)

    def test_call_timeout_remains_terminal_when_its_cancel_cannot_acquire_mutex(self):
        bridge = remote.Bridge(self.script)
        pool = ThreadPoolExecutor(max_workers=1)
        held_lock = threading.Event()
        class TimedOut(queue.Queue):
            def get(self, timeout=None):
                # Exercise the actual timeout handler after dispatch, without a
                # wall-clock setup window before the child receives its request.
                bridge.write_lock.acquire()
                held_lock.set()
                raise queue.Empty
        try:
            with mock.patch('agentrun_cli.remote.queue.Queue', TimedOut):
                call = pool.submit(bridge.call, {'type': 'hold'}, .2)
                self.assertTrue(held_lock.wait(2))
                with self.assertRaisesRegex(ValueError, 'source bridge timed out'):
                    call.result(timeout=2)
            self.assert_stopped(bridge)
        finally:
            if held_lock.is_set(): bridge.write_lock.release()
            self.cleanup_bridge(bridge, pool)
        self.assertTrue(not self.log.exists() or self.dispatches() == ['hold'])

    def test_healthy_cancel_preserves_order_and_other_commands(self):
        bridge = remote.Bridge(self.script)
        try:
            bridge.write({'id': 'held-command', 'type': 'hold'})
            bridge.cancel('held-command')
            self.assertEqual(bridge.call({'type': 'later'}, timeout=2), {'ok': True})
            self.assertFalse(bridge.stopped.is_set())
            self.assertEqual(self.dispatches(), ['hold', 'cancel', 'later'])
        finally:
            bridge.close()


if __name__ == '__main__':
    unittest.main()
