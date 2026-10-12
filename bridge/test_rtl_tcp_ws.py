import asyncio
import base64
import importlib.util
import pathlib
import struct
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bridge', pathlib.Path(__file__).with_name('rtl_tcp_ws.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def upgrade(origin='http://127.0.0.1:4173', host='127.0.0.1:8765', token='abcdefghijklmnop'):
    return (f'GET /iq?token={token} HTTP/1.1\r\nHost: {host}\r\nOrigin: {origin}\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n').encode()


def masked(payload, opcode=2, fin=True):
    mask = b'\x01\x02\x03\x04'
    return bytes([(0x80 if fin else 0) | opcode, 0x80 | len(payload)]) + mask + bytes(v ^ mask[i % 4] for i, v in enumerate(payload))


class SecurityTests(unittest.TestCase):
    def test_upgrade_accept_and_exact_origin_token_host(self):
        self.assertEqual(bridge.parse_upgrade(upgrade(), bridge.DEFAULT_ORIGINS, 'abcdefghijklmnop', 8765), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
        for request in [upgrade(origin='https://evil.example'), upgrade(origin='http://127.0.0.1:4173.evil.example'), upgrade(host='evil.example:8765'), upgrade(token='bad'), upgrade(origin='null')]:
            with self.assertRaises(bridge.ProtocolError):
                bridge.parse_upgrade(request, bridge.DEFAULT_ORIGINS, 'abcdefghijklmnop', 8765)
        self.assertTrue(bridge.parse_upgrade(upgrade(origin='null'), {'null'}, 'abcdefghijklmnop', 8765))

    def test_duplicate_header_and_upgrade_errors(self):
        for request in [upgrade().replace(b'Origin:', b'Origin: x\r\nOrigin:'), upgrade().replace(b'GET ', b'POST '), upgrade().replace(b'/iq?', b'/proxy?'), upgrade().replace(b'Version: 13', b'Version: 12')]:
            with self.assertRaises(bridge.ProtocolError):
                bridge.parse_upgrade(request, bridge.DEFAULT_ORIGINS, 'abcdefghijklmnop', 8765)

    def test_receive_control_allowlist(self):
        for opcode, value in [(1, 100000000), (2, 2048000), (3, 1), (4, 250), (5, -10)]:
            command = bytes([opcode]) + struct.pack('!i', value)
            self.assertEqual(bridge.validate_commands(command), command)
        for command in [b'', b'\x01', b'\x09\x00\x00\x00\x01', b'\x0e\x00\x00\x00\x01', b'\x03\x00\x00\x00\x02', b'\x02\x00\x00\x00\x01', b'\x04' + struct.pack('!i', 1001)]:
            with self.assertRaises(bridge.ProtocolError):
                bridge.validate_commands(command)

    def test_server_frame_lengths(self):
        self.assertEqual(bridge.websocket_frame(b'abc'), b'\x82\x03abc')
        self.assertEqual(bridge.websocket_frame(bytes(126))[:4], b'\x82\x7e\x00\x7e')
        self.assertEqual(bridge.websocket_frame(bytes(65536))[:10], b'\x82\x7f' + struct.pack('!Q', 65536))


class FrameTests(unittest.IsolatedAsyncioTestCase):
    async def test_masked_fragmented_commands(self):
        reader = asyncio.StreamReader()
        reader.feed_data(masked(b'\x01\x05', fin=False) + masked(b'\xf5\xe1\x00', opcode=0))
        first = await bridge.read_client_frame(reader)
        second = await bridge.read_client_frame(reader)
        self.assertEqual(first, (False, 2, b'\x01\x05'))
        self.assertEqual(second, (True, 0, b'\xf5\xe1\x00'))
        self.assertEqual(bridge.validate_commands(first[2] + second[2]), b'\x01\x05\xf5\xe1\x00')

    async def test_reject_unmasked_text_reserved_and_oversized(self):
        for data in [b'\x82\x05abcde', masked(b'abc', opcode=1), b'\xc2\x80', b'\x82\xfe\x01\x00', b'\x09\x80', masked(bytes(51))]:
            reader = asyncio.StreamReader()
            reader.feed_data(data)
            reader.feed_eof()
            with self.assertRaises(bridge.ProtocolError):
                await bridge.read_client_frame(reader)

    async def test_full_bridge_fixture_transfers_header_iq_and_receive_commands(self):
        class FakeTransport:
            def set_write_buffer_limits(self, **kwargs):
                self.limits = kwargs

        class FakeWriter:
            def __init__(self, reset_on_close=False):
                self.data = bytearray()
                self.transport = FakeTransport()
                self.closed = False
                self.reset_on_close = reset_on_close

            def write(self, data):
                self.data.extend(data)

            async def drain(self):
                await asyncio.sleep(0)

            def close(self):
                self.closed = True

            async def wait_closed(self):
                if self.reset_on_close:
                    raise ConnectionResetError('simulated disconnect')

        receiver = asyncio.StreamReader()
        rtl_bytes = b'RTL0' + struct.pack('!II', 5, 29) + b'\x00\xff\x80\x7f'
        receiver.feed_data(rtl_bytes)
        command = b'\x01' + struct.pack('!I', 100000000)
        client = asyncio.StreamReader()
        client.feed_data(upgrade() + masked(command[:2], fin=False) + masked(command[2:], opcode=0) + masked(struct.pack('!H', 1000), opcode=8))
        downstream = FakeWriter()
        upstream = FakeWriter(reset_on_close=True)

        async def open_connection(host, port):
            self.assertEqual(host, '127.0.0.1')
            self.assertEqual(port, 1234)
            return receiver, upstream

        instance = bridge.Bridge(1234, 8765, bridge.DEFAULT_ORIGINS, 'abcdefghijklmnop')
        with patch.object(bridge.asyncio, 'open_connection', open_connection):
            await asyncio.wait_for(instance.handle(client, downstream), 2)
        self.assertIn(b'101 Switching Protocols', downstream.data)
        self.assertIn(bridge.websocket_frame(rtl_bytes), downstream.data)
        self.assertEqual(upstream.data, command)
        self.assertTrue(upstream.closed)
        self.assertTrue(downstream.closed)
        self.assertFalse(instance.lock.locked())


if __name__ == '__main__':
    unittest.main()
