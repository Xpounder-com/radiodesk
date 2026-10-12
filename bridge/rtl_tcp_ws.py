#!/usr/bin/env python3
"""RadioDesk rtl_tcp to WebSocket bridge. Python 3.10+ standard library only.

MIT licensed original implementation. No radio driver is bundled or invoked.
Upstream is always 127.0.0.1; downstream binds 127.0.0.1; one receiver client.
"""
import argparse
import asyncio
import base64
import hashlib
import hmac
import secrets
import struct
import urllib.parse

GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
MAX_HTTP = 8192
MAX_COMMAND_MESSAGE = 50
DEFAULT_ORIGINS = {'http://127.0.0.1:4173', 'http://localhost:4173'}


class ProtocolError(ValueError):
    pass


def websocket_frame(payload: bytes, opcode: int = 2) -> bytes:
    """Unmasked server frames; lengths use RFC 6455 network byte order."""
    length = len(payload)
    if length < 126:
        header = bytes([0x80 | opcode, length])
    elif length <= 65535:
        header = bytes([0x80 | opcode, 126]) + struct.pack('!H', length)
    else:
        header = bytes([0x80 | opcode, 127]) + struct.pack('!Q', length)
    return header + payload


def parse_upgrade(raw: bytes, origins: set[str], token: str, port: int) -> str:
    """Validate host, exact Origin, secret token and RFC 6455 upgrade."""
    if len(raw) > MAX_HTTP or not raw.endswith(b'\r\n\r\n'):
        raise ProtocolError('Invalid HTTP upgrade size')
    try:
        lines = raw.decode('ascii').split('\r\n')
        method, target, version = lines[0].split(' ')
    except (UnicodeDecodeError, ValueError) as exc:
        raise ProtocolError('Invalid HTTP request') from exc
    if method != 'GET' or version != 'HTTP/1.1':
        raise ProtocolError('Only WebSocket GET upgrades are accepted')
    headers = {}
    for line in lines[1:]:
        if not line:
            continue
        if ':' not in line:
            raise ProtocolError('Malformed HTTP header')
        key, value = line.split(':', 1)
        key = key.strip().lower()
        if key in headers:
            raise ProtocolError('Duplicate HTTP headers are not accepted')
        headers[key] = value.strip()
    allowed_hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
    if headers.get('host') not in allowed_hosts:
        raise ProtocolError('Host must be the local bridge address')
    if headers.get('origin') not in origins:
        raise ProtocolError('Origin is not explicitly allowed')
    parsed = urllib.parse.urlsplit(target)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if parsed.scheme or parsed.netloc or parsed.path != '/iq' or set(query) != {'token'} or len(query['token']) != 1 or not query['token'][0].isascii() or not hmac.compare_digest(query['token'][0], token):
        raise ProtocolError('Invalid bridge path or access token')
    if headers.get('upgrade', '').lower() != 'websocket' or 'upgrade' not in [p.strip().lower() for p in headers.get('connection', '').split(',')]:
        raise ProtocolError('Expected a WebSocket upgrade')
    if headers.get('sec-websocket-version') != '13':
        raise ProtocolError('WebSocket version 13 is required')
    key = headers.get('sec-websocket-key', '')
    try:
        if len(base64.b64decode(key, validate=True)) != 16:
            raise ValueError('Invalid key length')
    except ValueError as exc:
        raise ProtocolError('Invalid WebSocket key') from exc
    return base64.b64encode(hashlib.sha1((key + GUID).encode('ascii')).digest()).decode('ascii')


def validate_commands(payload: bytes) -> bytes:
    """Only receive controls 1..5; never arbitrary device/USB/bias-T commands."""
    if not payload or len(payload) > MAX_COMMAND_MESSAGE or len(payload) % 5:
        raise ProtocolError('Commands must be complete five-byte frames')
    for offset in range(0, len(payload), 5):
        opcode = payload[offset]
        value = struct.unpack_from('!I', payload, offset + 1)[0]
        signed = struct.unpack_from('!i', payload, offset + 1)[0]
        if opcode == 1:
            pass  # An rtl_tcp receiver validates its tuner's RF frequency range.
        elif opcode == 2:
            if not (225001 <= value <= 300000 or 900001 <= value <= 3200000):
                raise ProtocolError('IQ sample rate is outside the permitted bound')
        elif opcode == 3:
            if value not in (0, 1):
                raise ProtocolError('Invalid tuner gain mode')
        elif opcode == 4:
            if not -1000 <= signed <= 1000:
                raise ProtocolError('Tuner gain is outside ±100 dB')
        elif opcode == 5:
            if not -1000 <= signed <= 1000:
                raise ProtocolError('Frequency correction is outside ±1000 ppm')
        else:
            raise ProtocolError('Unsupported receive control opcode')
    return payload


async def read_client_frame(reader: asyncio.StreamReader) -> tuple[bool, int, bytes]:
    header = await reader.readexactly(2)
    fin, opcode = bool(header[0] & 0x80), header[0] & 0x0f
    if header[0] & 0x70 or opcode not in (0, 2, 8, 9, 10):
        raise ProtocolError('Unsupported WebSocket frame')
    if not header[1] & 0x80:
        raise ProtocolError('Client WebSocket frames must be masked')
    length = header[1] & 0x7f
    if length == 126:
        length = struct.unpack('!H', await reader.readexactly(2))[0]
        if length < 126:
            raise ProtocolError('Noncanonical WebSocket length')
    elif length == 127:
        length = struct.unpack('!Q', await reader.readexactly(8))[0]
        if length <= 65535 or length >> 63:
            raise ProtocolError('Invalid WebSocket length')
    if opcode >= 8 and (not fin or length > 125):
        raise ProtocolError('Invalid WebSocket control frame')
    if length > (125 if opcode >= 8 else MAX_COMMAND_MESSAGE):
        raise ProtocolError('WebSocket command frame is too large')
    mask = await reader.readexactly(4)
    data = await reader.readexactly(length)
    return fin, opcode, bytes(value ^ mask[i % 4] for i, value in enumerate(data))


class Bridge:
    def __init__(self, upstream_port: int, listen_port: int, origins: set[str], token: str):
        self.upstream_port = upstream_port
        self.listen_port = listen_port
        self.origins = origins
        self.token = token
        self.lock = asyncio.Lock()

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        upstream_writer = None
        acquired = False
        tasks = []
        upgraded = False
        send_lock = asyncio.Lock()

        async def send(payload: bytes, opcode: int = 2):
            async with send_lock:
                writer.write(websocket_frame(payload, opcode))
                await asyncio.wait_for(writer.drain(), timeout=3)

        try:
            raw = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), timeout=5)
            accept = parse_upgrade(raw, self.origins, self.token, self.listen_port)
            if self.lock.locked():
                writer.write(b'HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                await writer.drain()
                return
            await self.lock.acquire()
            acquired = True
            # Target is fixed at launch, loopback only, never supplied by a browser.
            upstream_reader, upstream_writer = await asyncio.wait_for(asyncio.open_connection('127.0.0.1', self.upstream_port), timeout=5)
            writer.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n').encode('ascii'))
            await writer.drain()
            upgraded = True
            writer.transport.set_write_buffer_limits(high=65536, low=16384)

            async def iq_to_browser():
                # Preserve byte stream order, including the original RTL0 header.
                while True:
                    data = await upstream_reader.read(65536)
                    if not data:
                        return
                    await send(data)

            async def controls_to_receiver():
                fragments = bytearray()
                fragmented = False
                while True:
                    fin, opcode, payload = await read_client_frame(reader)
                    if opcode == 8:
                        if len(payload) == 1:
                            raise ProtocolError('Invalid close frame')
                        await send(payload, 8)
                        return
                    if opcode == 9:
                        await send(payload, 10)
                        continue
                    if opcode == 10:
                        continue
                    if opcode == 2:
                        if fragmented:
                            raise ProtocolError('Unexpected binary frame during continuation')
                        fragments = bytearray(payload)
                    elif opcode == 0:
                        if not fragmented:
                            raise ProtocolError('Unexpected continuation frame')
                        fragments.extend(payload)
                    if len(fragments) > MAX_COMMAND_MESSAGE:
                        raise ProtocolError('Fragmented command message exceeds bound')
                    fragmented = not fin
                    if fin:
                        upstream_writer.write(validate_commands(bytes(fragments)))
                        await asyncio.wait_for(upstream_writer.drain(), timeout=3)
                        fragments.clear()

            tasks = [asyncio.create_task(iq_to_browser()), asyncio.create_task(controls_to_receiver())]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (ProtocolError, ValueError, asyncio.LimitOverrunError) as exc:
            if upgraded:
                try:
                    await send(struct.pack('!H', 1002) + b'Invalid receive control or frame', 8)
                except (ConnectionError, asyncio.TimeoutError):
                    pass
            else:
                writer.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                try:
                    await writer.drain()
                except ConnectionError:
                    pass
            print(f'Rejected bridge request: {exc}')
        except (asyncio.IncompleteReadError, ConnectionError, OSError, asyncio.TimeoutError):
            if not upgraded:
                writer.write(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                try:
                    await writer.drain()
                except ConnectionError:
                    pass
        finally:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            if upstream_writer:
                upstream_writer.close()
                try:
                    await upstream_writer.wait_closed()
                except ConnectionError:
                    pass
            if acquired:
                self.lock.release()
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionError:
                pass


async def main(args):
    origins = set(args.origin or DEFAULT_ORIGINS)
    if args.allow_file_origin:
        origins.add('null')
    token = args.token or secrets.token_urlsafe(24)
    if len(token) < 16 or not token.isascii():
        raise SystemExit('Bridge token must have at least 16 ASCII characters.')
    for origin in origins:
        parsed = urllib.parse.urlsplit(origin)
        if origin != 'null' and (parsed.scheme not in ('http', 'https') or parsed.path or parsed.query or parsed.fragment or parsed.username or not parsed.netloc):
            raise SystemExit('Every --origin must be an exact HTTP(S) origin, without a path.')
    bridge = Bridge(args.upstream_port, args.port, origins, token)
    server = await asyncio.start_server(bridge.handle, '127.0.0.1', args.port, limit=MAX_HTTP)
    print(f'RadioDesk IQ bridge: ws://127.0.0.1:{args.port}/iq?token={urllib.parse.quote(token, safe="")}')
    print(f'Upstream rtl_tcp: 127.0.0.1:{args.upstream_port}; exact allowed origins: {", ".join(sorted(origins))}')
    print('Copy the complete token-bearing endpoint into RadioDesk. Receive-only; Ctrl-C stops the bridge.')
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--upstream-port', type=int, default=1234)
    parser.add_argument('--origin', action='append', help='Exact permitted page origin; repeat to allow more than one. Defaults to localhost:4173.')
    parser.add_argument('--allow-file-origin', action='store_true', help='Permit opaque Origin:null for a local HTML file, still requiring the random URL token.')
    parser.add_argument('--token', help='Optional persistent access token, at least 16 characters. Default: a random token printed at startup.')
    arguments = parser.parse_args()
    if not 1 <= arguments.port <= 65535 or not 1 <= arguments.upstream_port <= 65535:
        parser.error('Ports must be between 1 and 65535.')
    try:
        asyncio.run(main(arguments))
    except KeyboardInterrupt:
        pass
