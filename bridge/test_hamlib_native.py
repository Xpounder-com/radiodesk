"""Optional integration against an installed Hamlib Dummy daemon; never a radio port."""
import asyncio
import os
import socket
import unittest

from hamlib_ws import RigSession


@unittest.skipUnless(os.environ.get('RADIODESK_HAMLIB_TEST_BINARY'), 'Set RADIODESK_HAMLIB_TEST_BINARY to an installed rigctld')
class NativeDummyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            self.port = reservation.getsockname()[1]
        # Model 1 is Hamlib's in-memory Dummy. No CAT device is passed or opened.
        self.process = await asyncio.create_subprocess_exec(
            os.environ['RADIODESK_HAMLIB_TEST_BINARY'], '-m', '1', '-P', 'RIG',
            '-C', 'cache_timeout=0', '-T', '127.0.0.1', '-t', str(self.port),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        self.session = RigSession(self.port, allow_transmit=True)
        for attempt in range(50):
            try:
                await self.session.client.connect()
                break
            except (ConnectionError, OSError):
                if self.process.returncode is not None:
                    self.fail('The Hamlib Dummy process exited before accepting connections')
                if attempt == 49:
                    raise
                await asyncio.sleep(0.1)

    async def asyncTearDown(self):
        if self.session.may_transmit:
            await self.session.release()
        self.session.client.close()
        if self.process.returncode is None:
            self.process.terminate()
        await asyncio.wait_for(self.process.wait(), 5)

    async def test_actual_backend_discovery_readbacks_and_bounded_dummy_ptt(self):
        hello = await self.session.request({'id': 1, 'op': 'hello'})
        self.assertEqual(hello['protocol'], 'radiodesk-hamlib-v1')
        self.assertEqual(hello['model'], '1')
        self.assertTrue(hello['capabilities']['simulated'])
        self.assertTrue(hello['capabilities']['frequency'])
        self.assertTrue(hello['capabilities']['ptt'])
        self.assertIn('USB', hello['capabilities']['digitalModes'])
        tuned = await self.session.request({'id': 2, 'op': 'frequency', 'value': 14074000})
        self.assertEqual(tuned['frequency'], 14074000)
        changed = await self.session.request({'id': 3, 'op': 'mode', 'value': 'USB'})
        self.assertEqual(changed['mode'], 'USB')
        self.assertEqual(changed['txStatus'], 'rx')
        tx = await self.session.request({'id': 4, 'op': 'ptt', 'active': True,
                                         'expected': {'frequency': 14074000, 'mode': 'USB'},
                                         'maximumSeconds': 1})
        self.assertEqual(tx, 'cat-tx')
        self.assertTrue(self.session.deadline)
        active = await self.session.request({'id': 5, 'op': 'read'})
        self.assertEqual(active['txStatus'], 'cat-tx')
        released = await self.session.request({'id': 6, 'op': 'release'})
        self.assertEqual(released, 'rx')
        self.assertFalse(self.session.may_transmit)
        final = await self.session.request({'id': 7, 'op': 'read'})
        self.assertEqual(final['txStatus'], 'rx')


if __name__ == '__main__':
    unittest.main()
