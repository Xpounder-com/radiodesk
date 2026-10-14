"""Original protocol fixtures plus real loopback TCP/WebSocket integration tests.

No physical radio is opened. The synthetic backend implements a small rigctld
ERP subset checked against Hamlib's manual and tests/rigctl_parse.c.
"""
import asyncio
import importlib.util
import json
import pathlib
import struct
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('hamlib_bridge', pathlib.Path(__file__).with_name('hamlib_ws.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
TOKEN = 'abcdefghijklmnopq'

# Values describe an invented test transceiver, not a physically verified model.
CAPS = '''Caps dump for model: 99999
Model name:\tFixture Radio
Mfg name:\tTest
Rig type:\tTransceiver
PTT type:\tRig capable
Mode list: AM CW USB LSB CWR PKTUSB PKTLSB
TX ranges #1 for Test:
14000000 Hz - 14350000 Hz
VFO list: VFOA
Mode list: USB LSB
RX ranges #1 for Test:
30000 Hz - 56000000 Hz
VFO list: VFOA
Mode list: AM CW USB LSB
Antenna list: ANT1
100000000 Hz - 150000000 Hz
VFO list: VFOA
Mode list: FM
Tuning steps:
1 Hz: USB
Can set Frequency:\tY
Can get Frequency:\tY
Can set Mode:\tY
Can get Mode:\tY
Can set PTT:\tY
Can get PTT:\tY
Can get Split VFO:\tY'''


def upgrade(port=8766, origin='http://127.0.0.1:4173', host=None, token=TOKEN):
    return (f'GET /radio?token={token} HTTP/1.1\r\nHost: {host or f"127.0.0.1:{port}"}\r\n'
            f'Origin: {origin}\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n'
            'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n').encode()


def masked(payload, opcode=1, fin=True):
    size = len(payload)
    prefix = bytes([(0x80 if fin else 0) | opcode])
    if size < 126:
        prefix += bytes([0x80 | size])
    elif size <= 65535:
        prefix += b'\xfe' + struct.pack('!H', size)
    else:
        prefix += b'\xff' + struct.pack('!Q', size)
    mask = b'\x01\x02\x03\x04'
    return prefix + mask + bytes(v ^ mask[i % 4] for i, v in enumerate(payload))


async def server_frame(reader):
    header = await asyncio.wait_for(reader.readexactly(2), 5)
    if header[1] & 0x80:
        raise AssertionError('Server frames must not be masked')
    size = header[1] & 127
    if size == 126:
        size = struct.unpack('!H', await reader.readexactly(2))[0]
    elif size == 127:
        size = struct.unpack('!Q', await reader.readexactly(8))[0]
    return header[0] & 15, await reader.readexactly(size)


class RigFixture:
    def __init__(self):
        self.frequency = 14074000
        self.mode = 'USB'
        self.ptt = 0
        self.caps = CAPS
        self.commands = []
        self.writers = set()
        self.fail_ptt_read = False
        self.ignore_setting = False
        self.ignore_release = False
        self.stall_key = False
        self.split = 0
        self.fail_split_read = False
        self.ptt_route = 'RIG'
        self.fail_route_read = False
        self.cache_timeout = 0
        self.fail_cache_read = False
        self.ignore_cache_prepare = False

    async def handle(self, reader, writer):
        self.writers.add(writer)
        try:
            while True:
                raw = await reader.readline()
                if not raw:
                    return
                command = raw.decode().strip()
                self.commands.append(command)
                name, _, args = command[2:].partition(' ')
                response = name + ': ' + args + '\n'
                error = 0
                if name == 'dump_caps':
                    response += self.caps + '\n'
                elif name == 'set_mode' and args == '?':
                    response += 'AM CW USB LSB CWR PKTUSB PKTLSB\n'
                elif name == 'get_freq':
                    response += f'Frequency: {self.frequency}\n'
                elif name == 'get_mode':
                    response += f'Mode: {self.mode}\nPassband: 2400\n'
                elif name == 'get_ptt':
                    if self.fail_ptt_read:
                        error = -1
                    else:
                        response += f'PTT: {self.ptt}\n'
                elif name == 'get_split_vfo':
                    if self.fail_split_read:
                        error = -1
                    else:
                        response += f'Split: {self.split}\nTX VFO: VFOB\n'
                elif name == 'get_conf' and args == 'ptt_type':
                    if self.fail_route_read:
                        error = -1
                    else:
                        response += f'ptt_type={self.ptt_route}\n'
                elif name == 'get_conf' and args == 'cache_timeout':
                    if self.fail_cache_read:
                        error = -1
                    else:
                        response += f'cache_timeout={self.cache_timeout}\n'
                elif name == 'set_freq':
                    if not self.ignore_setting:
                        self.frequency = int(args)
                elif name == 'set_mode':
                    if not self.ignore_setting:
                        self.mode = args.split()[0]
                elif name == 'set_ptt':
                    if not (self.ignore_release and args == '0'):
                        self.ptt = int(args)
                    if self.stall_key and args == '1':
                        await reader.read()
                        return
                elif name == 'set_cache' and args == '0':
                    if not self.ignore_cache_prepare:
                        self.cache_timeout = 0
                else:
                    error = -4
                # Deliberately fragment ERP records across TCP writes.
                wire = (response + f'RPRT {error}\n').encode()
                writer.write(wire[:7])
                await writer.drain()
                writer.write(wire[7:])
                await writer.drain()
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            self.writers.discard(writer)
            writer.close()
            await writer.wait_closed()


class ParsingTests(unittest.TestCase):
    def test_caps_ranges_and_flags_from_nested_labels(self):
        caps = bridge.parse_caps(CAPS.splitlines())
        self.assertEqual(caps['ranges'], [(30000, 56000000), (100000000, 150000000)])
        self.assertEqual(caps['modelId'], '99999')
        self.assertFalse(caps['simulated'])
        self.assertTrue(caps['flags']['get PTT'])
        self.assertEqual(caps['modeTokens'], ['AM', 'CW', 'USB', 'LSB', 'CWR', 'PKTUSB', 'PKTLSB'])
        self.assertEqual(bridge.parse_caps(CAPS.replace('Can set PTT:\tY', 'Can set PTT:\tN').splitlines())['flags']['set PTT'], False)
        dummy = CAPS.replace('99999', '1').replace('Fixture Radio', 'Dummy')
        self.assertTrue(bridge.parse_caps(dummy.splitlines())['simulated'])
        self.assertFalse(bridge.parse_caps(dummy.replace('model: 1', 'model: 2').splitlines())['simulated'])

    def test_exact_upgrade_authentication_and_rfc_accept(self):
        self.assertEqual(bridge.parse_upgrade(upgrade(), bridge.DEFAULT_ORIGINS, TOKEN, 8766), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
        invalid = [upgrade(origin='https://evil.example'), upgrade(origin='null'), upgrade(host='evil.example:8766'),
                   upgrade(token='wrong'), upgrade().replace(b'/radio?', b'/raw?'),
                   upgrade().replace(b'Origin:', b'Origin: x\r\nOrigin:'), upgrade().replace(b'GET ', b'POST '),
                   upgrade().replace(b'Version: 13', b'Version: 12'), upgrade().replace(b'?token=', b'?upstream=8&token=')]
        for raw in invalid:
            with self.assertRaises(bridge.ProtocolError):
                bridge.parse_upgrade(raw, bridge.DEFAULT_ORIGINS, TOKEN, 8766)

    def test_json_rejects_duplicate_keys_unsafe_ids_and_nonfinite(self):
        self.assertEqual(bridge.parse_request(b'{"id":1,"op":"read"}'), {'id': 1, 'op': 'read'})
        for raw in (b'{"id":1,"id":2}', b'{"id":true}', b'{"id":0}', b'{"id":9007199254740992}',
                    b'{"id":1,"x":NaN}', b'[]', b'\xff', b'x' * 4097):
            with self.assertRaises(bridge.ProtocolError):
                bridge.parse_request(raw)


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.rig = RigFixture()
        self.rig_server = await asyncio.start_server(self.rig.handle, '127.0.0.1', 0)
        rig_port = self.rig_server.sockets[0].getsockname()[1]
        self.bridge = bridge.Bridge(rig_port, 0, bridge.DEFAULT_ORIGINS, TOKEN, True)
        self.server = await asyncio.start_server(self.bridge.handle, '127.0.0.1', 0, limit=bridge.MAX_HTTP)
        self.port = self.server.sockets[0].getsockname()[1]
        self.bridge.listen_port = self.port
        self.clients = []

    async def asyncTearDown(self):
        for writer in self.clients:
            writer.close()
            await writer.wait_closed()
        self.server.close()
        await self.server.wait_closed()
        await self.bridge.shutdown()
        self.rig_server.close()
        await self.rig_server.wait_closed()
        for writer in list(self.rig.writers):
            writer.close()
            await writer.wait_closed()
        await asyncio.sleep(0)

    async def connect(self, **kwargs):
        reader, writer = await asyncio.open_connection('127.0.0.1', self.port)
        self.clients.append(writer)
        writer.write(upgrade(self.port, **kwargs))
        await writer.drain()
        response = await reader.readuntil(b'\r\n\r\n')
        return reader, writer, response

    async def rpc(self, reader, writer, request, fragmented=False):
        payload = json.dumps(request).encode()
        if fragmented:
            writer.write(masked(payload[:5], fin=False) + masked(b'check', opcode=9) + masked(payload[5:], opcode=0))
        else:
            writer.write(masked(payload))
        await writer.drain()
        while True:
            opcode, payload = await server_frame(reader)
            if opcode == 10:
                self.assertEqual(payload, b'check')
                continue
            self.assertEqual(opcode, 1)
            return json.loads(payload)

    async def ready(self):
        reader, writer, response = await self.connect()
        self.assertIn(b'101 Switching Protocols', response)
        reply = await self.rpc(reader, writer, {'id': 1, 'op': 'hello'}, True)
        self.assertTrue(reply['ok'], reply)
        return reader, writer, reply['result']

    async def key(self, reader, writer, duration=30, request_id=2):
        return await self.rpc(reader, writer, {'id': request_id, 'op': 'ptt', 'active': True,
            'expected': {'frequency': self.rig.frequency, 'mode': bridge.MODE_NAMES[self.rig.mode]}, 'maximumSeconds': duration})

    async def test_hello_discovers_without_writes_and_maps_modes(self):
        _, _, hello = await self.ready()
        self.assertEqual(hello['protocol'], 'radiodesk-hamlib-v1')
        self.assertEqual(hello['model'], '99999')
        self.assertEqual(hello['identitySource'], 'hamlib-configured')
        self.assertEqual(hello['snapshot'], {'frequency': 14074000, 'mode': 'USB', 'ptt': False, 'txStatus': 'rx', 'split': False})
        self.assertTrue(hello['capabilities']['ptt'])
        self.assertEqual(hello['capabilities']['digitalModes'], ['DATA-USB', 'USB'])
        self.assertIn('CW-R', hello['capabilities']['modes'])
        self.assertEqual(self.rig.commands, ['+\\dump_caps', '+\\set_mode ?', '+\\set_cache 0', '+\\get_conf cache_timeout', '+\\get_conf ptt_type', '+\\get_freq', '+\\get_mode', '+\\get_ptt', '+\\get_split_vfo'])
        self.assertEqual(hello['capabilities']['pttRoute'], 'RIG')
        self.assertTrue(hello['capabilities']['pttRouteVerified'])
        self.assertTrue(hello['capabilities']['freshReadback'])
        self.assertEqual(hello['capabilities']['cacheTimeoutMs'], 0)

    async def test_runtime_external_ptt_override_blocks_advertised_cat_backend(self):
        self.rig.ptt_route = 'RTS'
        reader, writer, hello = await self.ready()
        self.assertFalse(hello['capabilities']['ptt'])
        self.assertEqual(hello['capabilities']['pttRoute'], 'RTS')
        self.assertFalse(hello['capabilities']['pttReadback'])
        self.assertFalse(hello['capabilities']['frequency'])
        self.assertFalse(hello['capabilities']['mode'])
        self.assertEqual(hello['snapshot']['txStatus'], 'unknown')
        self.assertFalse((await self.key(reader, writer))['ok'])
        self.assertNotIn('+\\set_ptt 1', self.rig.commands)

    async def test_dummy_external_ptt_route_is_never_treated_as_silent_keying(self):
        self.rig.caps = CAPS.replace('model: 99999', 'model: 1').replace('Fixture Radio', 'Dummy').replace('PTT type:\tRig capable', 'PTT type:\tNone')
        self.rig.ptt_route = 'DTR'
        reader, writer, hello = await self.ready()
        self.assertTrue(hello['capabilities']['simulated'])
        self.assertFalse(hello['capabilities']['ptt'])
        self.assertEqual(hello['snapshot']['txStatus'], 'unknown')
        self.assertFalse((await self.key(reader, writer))['ok'])
        self.assertNotIn('+\\set_ptt 1', self.rig.commands)

    async def test_dummy_none_ptt_route_is_allowed_without_external_device(self):
        self.rig.caps = CAPS.replace('model: 99999', 'model: 1').replace('Fixture Radio', 'Dummy').replace('PTT type:\tRig capable', 'PTT type:\tNone')
        self.rig.ptt_route = 'None'
        reader, writer, hello = await self.ready()
        self.assertTrue(hello['capabilities']['simulated'])
        self.assertTrue(hello['capabilities']['ptt'])
        self.assertEqual(hello['capabilities']['pttRoute'], 'NONE')
        self.assertTrue((await self.key(reader, writer))['ok'])
        self.assertEqual((await self.rpc(reader, writer, {'id': 3, 'op': 'release'}))['result'], 'rx')

    async def test_unreadable_runtime_route_disables_keying_but_retains_receive_controls(self):
        self.rig.fail_route_read = True
        reader, writer, hello = await self.ready()
        self.assertFalse(hello['capabilities']['ptt'])
        self.assertFalse(hello['capabilities']['pttRouteVerified'])
        self.assertIsNone(hello['capabilities']['pttRoute'])
        self.assertFalse(hello['capabilities']['frequency'])
        self.assertFalse(hello['capabilities']['pttReadback'])
        self.assertEqual(hello['snapshot']['txStatus'], 'unknown')
        self.assertFalse((await self.rpc(reader, writer, {'id': 2, 'op': 'frequency', 'value': 14075000}))['ok'])

    async def test_fresh_runtime_route_check_rejects_changed_or_external_route(self):
        reader, writer, hello = await self.ready()
        self.assertTrue(hello['capabilities']['ptt'])
        self.rig.ptt_route = 'GPIO'
        reply = await self.key(reader, writer)
        self.assertFalse(reply['ok'])
        self.assertIn('route', reply['error'])
        self.assertNotIn('+\\set_ptt 1', self.rig.commands)

    async def test_runtime_route_change_makes_reads_unknown_and_blocks_tuning(self):
        reader, writer, _ = await self.ready()
        self.rig.ptt_route = 'DTR'
        reply = await self.rpc(reader, writer, {'id': 2, 'op': 'read'})
        self.assertTrue(reply['ok'])
        self.assertEqual(reply['result']['txStatus'], 'unknown')
        self.assertFalse((await self.rpc(reader, writer, {'id': 3, 'op': 'frequency', 'value': 14075000}))['ok'])
        self.assertNotIn('+\\set_freq 14075000', self.rig.commands)

    async def test_nonzero_frontend_cache_disables_transmit_without_blocking_receive(self):
        self.rig.cache_timeout = 500
        self.rig.ignore_cache_prepare = True
        reader, writer, hello = await self.ready()
        self.assertFalse(hello['capabilities']['ptt'])
        self.assertFalse(hello['capabilities']['freshReadback'])
        self.assertEqual(hello['capabilities']['cacheTimeoutMs'], 500)
        self.assertTrue((await self.rpc(reader, writer, {'id': 2, 'op': 'frequency', 'value': 14075000}))['ok'])
        self.assertFalse((await self.key(reader, writer, request_id=3))['ok'])
        self.assertNotIn('+\\set_ptt 1', self.rig.commands)

    async def test_transmit_opt_in_prepares_daemon_cache_once_only(self):
        self.rig.cache_timeout = 1000
        reader, writer, hello = await self.ready()
        self.assertTrue(hello['capabilities']['ptt'])
        self.assertEqual(self.rig.commands.count('+\\set_cache 0'), 1)
        self.rig.cache_timeout = 500
        self.assertFalse((await self.key(reader, writer))['ok'])
        self.assertEqual(self.rig.commands.count('+\\set_cache 0'), 1)
        self.assertEqual(self.rig.cache_timeout, 500)

    async def test_unreadable_frontend_cache_disables_transmit(self):
        self.rig.fail_cache_read = True
        reader, writer, hello = await self.ready()
        self.assertFalse(hello['capabilities']['ptt'])
        self.assertIsNone(hello['capabilities']['cacheTimeoutMs'])
        self.assertFalse((await self.key(reader, writer))['ok'])
        self.assertNotIn('+\\set_ptt 1', self.rig.commands)

    async def test_cache_reenabled_after_hello_cannot_authorize_keying(self):
        reader, writer, hello = await self.ready()
        self.assertTrue(hello['capabilities']['ptt'])
        self.rig.cache_timeout = 100
        reply = await self.key(reader, writer)
        self.assertFalse(reply['ok'])
        self.assertIn('cache', reply['error'])
        self.assertNotIn('+\\set_ptt 1', self.rig.commands)

    async def test_default_receive_only_and_missing_get_ptt_disable_transmit(self):
        self.bridge.allow_transmit = False
        reader, writer, hello = await self.ready()
        self.assertFalse(hello['capabilities']['ptt'])
        self.assertTrue(hello['capabilities']['receiveOnly'])
        self.assertNotIn('+\\set_cache 0', self.rig.commands)
        reply = await self.key(reader, writer)
        self.assertFalse(reply['ok'])
        self.assertNotIn('+\\set_ptt 1', self.rig.commands)

    async def test_negative_get_ptt_blocks_unknown_transceiver_mutation(self):
        self.rig.fail_ptt_read = True
        reader, writer, hello = await self.ready()
        self.assertFalse(hello['capabilities']['ptt'])
        self.assertFalse(hello['capabilities']['pttReadback'])
        self.assertFalse(hello['capabilities']['frequency'])
        self.assertFalse(hello['capabilities']['mode'])
        self.assertEqual(hello['snapshot']['txStatus'], 'unknown')
        reply = await self.rpc(reader, writer, {'id': 2, 'op': 'frequency', 'value': 14075000})
        self.assertFalse(reply['ok'])
        self.assertNotIn('+\\set_freq 14075000', self.rig.commands)

    async def test_split_active_or_unreadable_disables_transmit(self):
        self.rig.split = 1
        reader, writer, hello = await self.ready()
        self.assertFalse(hello['capabilities']['ptt'])
        self.assertTrue(hello['snapshot']['split'])
        self.assertFalse((await self.key(reader, writer))['ok'])
        self.assertNotIn('+\\set_ptt 1', self.rig.commands)

    async def test_fresh_split_readback_blocks_changed_tx_vfo(self):
        reader, writer, hello = await self.ready()
        self.assertTrue(hello['capabilities']['ptt'])
        self.rig.split = 1
        self.assertFalse((await self.key(reader, writer))['ok'])
        self.assertNotIn('+\\set_ptt 1', self.rig.commands)

    async def test_missing_split_readback_disables_transmit(self):
        self.rig.fail_split_read = True
        _, _, hello = await self.ready()
        self.assertFalse(hello['capabilities']['ptt'])
        self.assertFalse(hello['capabilities']['splitReadback'])
        self.assertIsNone(hello['snapshot']['split'])

    async def test_positive_receive_only_backend_can_tune_without_ptt(self):
        self.rig.caps = CAPS.replace('Rig type:\tTransceiver', 'Rig type:\tOther Receiver')
        self.rig.caps = self.rig.caps.replace('14000000 Hz - 14350000 Hz\n', '')
        self.rig.caps = self.rig.caps.replace('Can set PTT:\tY', 'Can set PTT:\tN').replace('Can get PTT:\tY', 'Can get PTT:\tN')
        reader, writer, hello = await self.ready()
        self.assertTrue(hello['capabilities']['hardwareReceiveOnly'])
        self.assertFalse(hello['capabilities']['pttReadback'])
        self.assertTrue(hello['capabilities']['frequency'])
        self.assertEqual(hello['snapshot']['txStatus'], 'rx')
        self.assertTrue((await self.rpc(reader, writer, {'id': 2, 'op': 'frequency', 'value': 14075000}))['ok'])

    async def test_authentication_happens_before_upstream_access_and_one_client(self):
        _, _, denied = await self.connect(origin='https://evil.example')
        self.assertIn(b'403 Forbidden', denied)
        self.assertEqual(self.rig.commands, [])
        first, writer, _ = await self.connect()
        _, _, conflict = await self.connect()
        self.assertIn(b'409 Conflict', conflict)
        writer.write(masked(b'', opcode=8))
        await writer.drain()
        opcode, _ = await server_frame(first)
        self.assertEqual(opcode, 8)

    async def test_allowlisted_mutation_and_fresh_readback(self):
        reader, writer, _ = await self.ready()
        reply = await self.rpc(reader, writer, {'id': 2, 'op': 'frequency', 'value': 14075000})
        self.assertTrue(reply['ok'], reply)
        self.assertEqual(reply['result']['frequency'], 14075000)
        reply = await self.rpc(reader, writer, {'id': 3, 'op': 'mode', 'value': 'DATA-USB'})
        self.assertTrue(reply['ok'], reply)
        self.assertEqual(reply['result']['mode'], 'DATA-USB')
        self.assertIn('+\\set_mode PKTUSB 0', self.rig.commands)
        for request in ({'id': 4, 'op': 'raw', 'value': 'T 1'}, {'id': 5, 'op': 'mode', 'value': 'USB\nT 1'},
                        {'id': 6, 'op': 'frequency', 'value': 80000000}, {'id': 7, 'op': 'frequency', 'value': 14074000, 'command': 'reset'}):
            reply = await self.rpc(reader, writer, request)
            self.assertFalse(reply['ok'])
        self.assertNotIn('+\\set_ptt 1', self.rig.commands)

    async def test_backend_ignored_setting_returns_error(self):
        reader, writer, _ = await self.ready()
        self.rig.ignore_setting = True
        reply = await self.rpc(reader, writer, {'id': 2, 'op': 'frequency', 'value': 14075000})
        self.assertFalse(reply['ok'])
        self.assertIn('readback', reply['error'])

    async def test_ptt_requires_fresh_expected_settings_and_bounded_duration(self):
        reader, writer, _ = await self.ready()
        for duration in (0, 31, True, '10', 1.2):
            reply = await self.key(reader, writer, duration)
            self.assertFalse(reply['ok'])
        reply = await self.rpc(reader, writer, {'id': 3, 'op': 'ptt', 'active': True,
            'expected': {'frequency': 14075000, 'mode': 'USB'}, 'maximumSeconds': 1})
        self.assertFalse(reply['ok'])
        self.assertNotIn('+\\set_ptt 1', self.rig.commands)
        reply = await self.key(reader, writer, 1, 4)
        self.assertEqual(reply, {'id': 4, 'ok': True, 'result': 'cat-tx'})
        reply = await self.rpc(reader, writer, {'id': 5, 'op': 'release'})
        self.assertEqual(reply['result'], 'rx')
        self.assertEqual(self.rig.ptt, 0)

    async def test_transmit_mutation_is_blocked_and_session_revoked(self):
        reader, writer, _ = await self.ready()
        self.assertTrue((await self.key(reader, writer))['ok'])
        reply = await self.rpc(reader, writer, {'id': 3, 'op': 'mode', 'value': 'LSB'})
        self.assertFalse(reply['ok'])
        self.assertNotIn('+\\set_mode LSB 0', self.rig.commands)
        self.assertEqual(self.rig.ptt, 0)
        self.assertEqual((await server_frame(reader))[0], 8)

    async def test_max_duration_cannot_be_extended_by_heartbeat(self):
        reader, writer, _ = await self.ready()
        started = asyncio.get_running_loop().time()
        self.assertTrue((await self.key(reader, writer, 1))['ok'])
        for i in range(3, 6):
            await asyncio.sleep(0.2)
            reply = await self.rpc(reader, writer, {'id': i, 'op': 'heartbeat'})
            self.assertEqual(reply['result'], {'alive': True})
        self.assertEqual((await server_frame(reader))[0], 8)
        self.assertLess(asyncio.get_running_loop().time() - started, 1.7)
        self.assertEqual(self.rig.ptt, 0)
        self.assertIn('+\\set_ptt 0', self.rig.commands)

    async def test_missing_heartbeat_releases_before_thirty_second_limit(self):
        reader, writer, _ = await self.ready()
        started = asyncio.get_running_loop().time()
        self.assertTrue((await self.key(reader, writer, 30))['ok'])
        self.assertEqual((await server_frame(reader))[0], 8)
        elapsed = asyncio.get_running_loop().time() - started
        self.assertGreaterEqual(elapsed, 1.9)
        self.assertLess(elapsed, 2.8)
        self.assertEqual(self.rig.ptt, 0)

    async def test_socket_loss_releases_and_confirms_receive(self):
        reader, writer, _ = await self.ready()
        self.assertTrue((await self.key(reader, writer))['ok'])
        writer.close()
        await writer.wait_closed()
        for _ in range(40):
            if self.rig.ptt == 0 and not self.bridge.lock.locked():
                break
            await asyncio.sleep(0.01)
        self.assertEqual(self.rig.ptt, 0)
        self.assertFalse(self.bridge.lock.locked())
        self.assertEqual(self.rig.commands[-3:], ['+\\set_ptt 0', '+\\get_conf cache_timeout', '+\\get_ptt'])

    async def test_key_timeout_reconnects_to_release_unknown_command_result(self):
        reader, writer, _ = await self.ready()
        self.rig.stall_key = True
        reply = await self.key(reader, writer)
        self.assertFalse(reply['ok'])
        self.assertEqual(self.rig.ptt, 0)
        self.assertIn('+\\set_ptt 0', self.rig.commands)
        self.assertEqual((await server_frame(reader))[0], 8)

    async def test_release_readback_error_is_never_reported_as_rx(self):
        reader, writer, _ = await self.ready()
        self.assertTrue((await self.key(reader, writer))['ok'])
        self.rig.ignore_release = True
        reply = await self.rpc(reader, writer, {'id': 3, 'op': 'release'})
        self.assertFalse(reply['ok'])
        self.assertIn('unconfirmed', reply['error'])
        self.assertNotIn('result', reply)
        await server_frame(reader)
        self.assertEqual(self.rig.ptt, 1)
        self.rig.ptt = 0  # Test-only backend cleanup, no actual radio exists.

    async def test_route_changed_while_keyed_does_not_drive_external_release_output(self):
        reader, writer, _ = await self.ready()
        self.assertTrue((await self.key(reader, writer))['ok'])
        self.rig.ptt_route = 'RTS'
        reply = await self.rpc(reader, writer, {'id': 3, 'op': 'release'})
        self.assertFalse(reply['ok'])
        self.assertNotIn('+\\set_ptt 0', self.rig.commands)
        self.assertNotIn('result', reply)
        await server_frame(reader)
        self.rig.ptt = 0

    async def test_cache_reenabled_while_keyed_cannot_fake_confirmed_receive(self):
        reader, writer, _ = await self.ready()
        self.assertTrue((await self.key(reader, writer))['ok'])
        self.rig.cache_timeout = 500
        reply = await self.rpc(reader, writer, {'id': 3, 'op': 'release'})
        self.assertFalse(reply['ok'])
        self.assertNotIn('result', reply)
        self.assertIn('+\\set_ptt 0', self.rig.commands)
        self.assertEqual(self.rig.ptt, 0)
        await server_frame(reader)

    async def test_priority_release_revokes_delayed_prekey_read_before_keying(self):
        reader, writer, _ = await self.ready()
        entered, unblock = asyncio.Event(), asyncio.Event()
        original = bridge.RigSession.snapshot

        async def delayed(session):
            entered.set()
            await unblock.wait()
            return await original(session)

        with patch.object(bridge.RigSession, 'snapshot', delayed):
            request = {'id': 2, 'op': 'ptt', 'active': True,
                'expected': {'frequency': 14074000, 'mode': 'USB'}, 'maximumSeconds': 30}
            writer.write(masked(json.dumps(request).encode()))
            await writer.drain()
            await asyncio.wait_for(entered.wait(), 1)
            writer.write(masked(b'{"id":3,"op":"release"}'))
            await writer.drain()
            replies = [json.loads((await server_frame(reader))[1]) for _ in range(2)]
            self.assertEqual(replies[0]['id'], 2)
            self.assertFalse(replies[0]['ok'])
            self.assertEqual(replies[1], {'id': 3, 'ok': True, 'result': 'rx'})
            unblock.set()
            await asyncio.sleep(0.02)
            self.assertNotIn('+\\set_ptt 1', self.rig.commands)
            self.assertEqual(self.rig.ptt, 0)

    async def test_disconnect_revokes_delayed_prekey_read_before_keying(self):
        reader, writer, _ = await self.ready()
        entered, unblock = asyncio.Event(), asyncio.Event()
        original = bridge.RigSession.snapshot

        async def delayed(session):
            entered.set()
            await unblock.wait()
            return await original(session)

        with patch.object(bridge.RigSession, 'snapshot', delayed):
            writer.write(masked(json.dumps({'id': 2, 'op': 'ptt', 'active': True,
                'expected': {'frequency': 14074000, 'mode': 'USB'}, 'maximumSeconds': 30}).encode()))
            await writer.drain()
            await asyncio.wait_for(entered.wait(), 1)
            writer.write(masked(b'', opcode=8))
            await writer.drain()
            self.assertEqual((await server_frame(reader))[0], 8)
            unblock.set()
            await asyncio.sleep(0.02)
            self.assertNotIn('+\\set_ptt 1', self.rig.commands)
            self.assertEqual(self.rig.ptt, 0)

    async def test_heartbeat_is_processed_while_backend_read_is_blocked(self):
        reader, writer, _ = await self.ready()
        self.assertTrue((await self.key(reader, writer))['ok'])
        entered, unblock = asyncio.Event(), asyncio.Event()
        original = bridge.RigSession.snapshot

        async def delayed(session):
            entered.set()
            await unblock.wait()
            return await original(session)

        with patch.object(bridge.RigSession, 'snapshot', delayed):
            writer.write(masked(b'{"id":3,"op":"read"}'))
            await writer.drain()
            await asyncio.wait_for(entered.wait(), 1)
            reply = await asyncio.wait_for(self.rpc(reader, writer, {'id': 4, 'op': 'heartbeat'}), 0.3)
            self.assertEqual(reply, {'id': 4, 'ok': True, 'result': {'alive': True}})
            self.assertEqual(self.rig.ptt, 1)
            unblock.set()
            self.assertEqual(json.loads((await server_frame(reader))[1])['id'], 3)
        self.assertEqual((await self.rpc(reader, writer, {'id': 5, 'op': 'release'}))['result'], 'rx')

    async def test_prewrite_guard_rejects_lease_that_expired_during_async_wait(self):
        # Exercise the exact backend-write guard without the periodic watchdog:
        # a scheduler delay must not key in the gap before its next timer tick.
        session = bridge.RigSession(self.bridge.upstream_port, True)
        await session.request({'id': 1, 'op': 'hello'})
        original = bridge.RigClient.command

        async def delayed(client, name, arguments='', guard=None):
            if name == 'set_ptt' and arguments == '1':
                await asyncio.sleep(1.02)
            return await original(client, name, arguments, guard)

        try:
            with patch.object(bridge.RigClient, 'command', delayed):
                with self.assertRaises(bridge.RigError):
                    await session.request({'id': 2, 'op': 'ptt', 'active': True,
                        'expected': {'frequency': 14074000, 'mode': 'USB'}, 'maximumSeconds': 1})
            self.assertNotIn('+\\set_ptt 1', self.rig.commands)
            self.assertEqual(self.rig.ptt, 0)
            self.assertEqual(await session.release(), 'rx')
        finally:
            session.client.close()

    async def test_absolute_key_deadline_expires_during_prekey_read_without_keying(self):
        session = bridge.RigSession(self.bridge.upstream_port, True)
        await session.request({'id': 1, 'op': 'hello'})
        original = bridge.RigSession.snapshot

        async def delayed(instance):
            await asyncio.sleep(0.2)
            return await original(instance)

        try:
            with patch.object(bridge.RigSession, 'snapshot', delayed):
                with self.assertRaises(bridge.RigError):
                    await session.request({'id': 2, 'op': 'ptt', 'active': True,
                        'expected': {'frequency': 14074000, 'mode': 'USB'}, 'maximumSeconds': 30,
                        'keyBeforeUtcMs': int(time.time() * 1000) + 120})
            self.assertNotIn('+\\set_ptt 1', self.rig.commands)
            self.assertFalse(session.may_transmit)
        finally:
            session.client.close()

    async def test_absolute_key_deadline_rejects_past_far_future_or_unsafe_values(self):
        reader, writer, _ = await self.ready()
        now = int(time.time() * 1000)
        for deadline in (now - 10, now + 31000, True, 'soon', now + 0.5):
            reply = await self.rpc(reader, writer, {'id': 2, 'op': 'ptt', 'active': True,
                'expected': {'frequency': 14074000, 'mode': 'USB'}, 'maximumSeconds': 30,
                'keyBeforeUtcMs': deadline})
            self.assertFalse(reply['ok'])
        self.assertNotIn('+\\set_ptt 1', self.rig.commands)

    async def test_absolute_key_deadline_within_budget_can_key_and_release(self):
        reader, writer, _ = await self.ready()
        reply = await self.rpc(reader, writer, {'id': 2, 'op': 'ptt', 'active': True,
            'expected': {'frequency': 14074000, 'mode': 'USB'}, 'maximumSeconds': 1,
            'keyBeforeUtcMs': int(time.time() * 1000) + 1000})
        self.assertEqual(reply['result'], 'cat-tx')
        self.assertEqual((await self.rpc(reader, writer, {'id': 3, 'op': 'release'}))['result'], 'rx')


class FrameTests(unittest.IsolatedAsyncioTestCase):
    async def test_reject_binary_unmasked_reserved_large_and_bad_control(self):
        for wire in (masked(b'{}', opcode=2), b'\x81\x02{}', b'\xc1\x80',
                     b'\x81\xfe\x20\x00', masked(b'ping', opcode=9, fin=False)):
            reader = asyncio.StreamReader()
            reader.feed_data(wire)
            reader.feed_eof()
            with self.assertRaises(bridge.ProtocolError):
                await bridge.read_client_frame(reader)


if __name__ == '__main__':
    unittest.main()
