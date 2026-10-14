#!/usr/bin/env python3
"""RadioDesk Hamlib WebSocket adapter. Python 3.10+ standard library, MIT.

Only operator-started, fixed-loopback rigctld is contacted. This adapter never
opens serial devices, launches Hamlib, or accepts arbitrary rigctld commands.
"""
import argparse
import asyncio
from collections import deque
import base64
import hashlib
import hmac
import json
import math
import re
import secrets
import struct
import time
import urllib.parse

GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
DEFAULT_ORIGINS = {'http://127.0.0.1:4173', 'http://localhost:4173'}
MAX_HTTP = 8192
MAX_MESSAGE = 4096
MAX_RESPONSE = 262144
MAX_LINE = 8192
COMMAND_TIMEOUT = 1.0
HEARTBEAT_TIMEOUT = 2.0
MAX_TRANSMIT_SECONDS = 30
MAX_INTEGER = 9007199254740991

# Hamlib tokens are mapped explicitly; no browser-provided backend token passes
# through to rigctld. RTTY reverse is retained as a reversal, not an invented BFO.
MODE_NAMES = {
    'USB': 'USB', 'LSB': 'LSB', 'CW': 'CW', 'CWR': 'CW-R',
    'AM': 'AM', 'FM': 'FM', 'WFM': 'WFM', 'AMS': 'AMS',
    'FMN': 'FM-N', 'AMN': 'AM-N', 'RTTY': 'RTTY', 'RTTYR': 'RTTY-R',
    'PKTUSB': 'DATA-USB', 'PKTLSB': 'DATA-LSB', 'PKTFM': 'DATA-FM',
    'DATAUSB': 'DATA-USB', 'DATALSB': 'DATA-LSB', 'DATAFM': 'DATA-FM',
    'ECSSUSB': 'ECSS-USB', 'ECSSLSB': 'ECSS-LSB', 'SAM': 'SAM',
    'SAL': 'SAL', 'SAH': 'SAH', 'DSB': 'DSB', 'FA': 'FA',
}


class ProtocolError(ValueError):
    pass


class RigError(RuntimeError):
    pass


def websocket_frame(payload: bytes, opcode: int = 1) -> bytes:
    size = len(payload)
    if size < 126:
        header = bytes([0x80 | opcode, size])
    elif size <= 65535:
        header = bytes([0x80 | opcode, 126]) + struct.pack('!H', size)
    else:
        header = bytes([0x80 | opcode, 127]) + struct.pack('!Q', size)
    return header + payload


def parse_upgrade(raw: bytes, origins: set[str], token: str, port: int) -> str:
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
    if headers.get('host') not in {f'127.0.0.1:{port}', f'localhost:{port}'}:
        raise ProtocolError('Host must be the local bridge address')
    if headers.get('origin') not in origins:
        raise ProtocolError('Origin is not explicitly allowed')
    parsed = urllib.parse.urlsplit(target)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if (parsed.scheme or parsed.netloc or parsed.fragment or parsed.path != '/radio'
            or set(query) != {'token'} or len(query['token']) != 1
            or not query['token'][0].isascii()
            or not hmac.compare_digest(query['token'][0], token)):
        raise ProtocolError('Invalid bridge path or access token')
    if (headers.get('upgrade', '').lower() != 'websocket'
            or 'upgrade' not in [p.strip().lower() for p in headers.get('connection', '').split(',')]
            or headers.get('sec-websocket-version') != '13'):
        raise ProtocolError('A version 13 WebSocket upgrade is required')
    key = headers.get('sec-websocket-key', '')
    try:
        if len(base64.b64decode(key, validate=True)) != 16:
            raise ValueError('Invalid key length')
    except ValueError as exc:
        raise ProtocolError('Invalid WebSocket key') from exc
    return base64.b64encode(hashlib.sha1((key + GUID).encode('ascii')).digest()).decode('ascii')


async def read_client_frame(reader: asyncio.StreamReader) -> tuple[bool, int, bytes]:
    header = await reader.readexactly(2)
    fin, opcode = bool(header[0] & 0x80), header[0] & 15
    if header[0] & 0x70 or opcode not in (0, 1, 8, 9, 10) or not header[1] & 0x80:
        raise ProtocolError('Unsupported or unmasked WebSocket frame')
    size = header[1] & 127
    if size == 126:
        size = struct.unpack('!H', await reader.readexactly(2))[0]
        if size < 126:
            raise ProtocolError('Noncanonical WebSocket length')
    elif size == 127:
        size = struct.unpack('!Q', await reader.readexactly(8))[0]
        if size <= 65535 or size >> 63:
            raise ProtocolError('Invalid WebSocket length')
    if opcode >= 8 and (not fin or size > 125):
        raise ProtocolError('Invalid WebSocket control frame')
    if size > (125 if opcode >= 8 else MAX_MESSAGE):
        raise ProtocolError('WebSocket message is too large')
    mask = await reader.readexactly(4)
    data = await reader.readexactly(size)
    return fin, opcode, bytes(v ^ mask[i % 4] for i, v in enumerate(data))


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError('Duplicate JSON keys are not accepted')
        result[key] = value
    return result


def parse_request(payload: bytes) -> dict:
    if not payload or len(payload) > MAX_MESSAGE:
        raise ProtocolError('Invalid request size')
    try:
        request = json.loads(payload.decode('utf-8'), object_pairs_hook=_unique_object,
                             parse_constant=lambda _: (_ for _ in ()).throw(ProtocolError('Invalid JSON number')))
    except (ValueError, UnicodeDecodeError, RecursionError) as exc:
        raise ProtocolError('Invalid JSON request') from exc
    if not isinstance(request, dict) or type(request.get('id')) is not int or not 1 <= request['id'] <= MAX_INTEGER:
        raise ProtocolError('A positive safe integer request id is required')
    return request


def integer(value, minimum=1, maximum=MAX_INTEGER):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ProtocolError('Value must be a bounded whole number')
    return value


def parse_caps(lines: list[str]) -> dict:
    """Read known dump_caps fields; absent or unfamiliar flags remain disabled."""
    text = '\n'.join(lines)
    fields = {}
    ranges = []
    tx_ranges = []
    tx_sections = False
    section = None
    for line in lines:
        match = re.match(r'^\s*(RX|TX) ranges\b', line)
        if match:
            section = match[1]
            if section == 'TX':
                tx_sections = True
        elif (line and not line[0].isspace() and ':' in line
              and line.split(':', 1)[0] not in {'VFO list', 'Mode list', 'Antenna list', 'Low power'}):
            section = None
        match = re.fullmatch(r'\s*(\d+) Hz\s*-\s*(\d+) Hz\s*', line)
        if match and section in {'RX', 'TX'}:
            low, high = map(int, match.groups())
            if 0 < low <= high <= MAX_INTEGER:
                (ranges if section == 'RX' else tx_ranges).append((low, high))
        if ':' in line and not line[0].isspace():
            key, value = line.split(':', 1)
            fields.setdefault(key.strip(), value.strip())
    model_id = fields.get('Caps dump for model', '')
    model_name = fields.get('Model name', '')
    manufacturer = fields.get('Mfg name', '')
    if not re.fullmatch(r'\d+', model_id) or not model_name or len(model_name) > 120 or len(manufacturer) > 120:
        raise RigError('Hamlib did not provide recognizable configured-model capabilities')
    simulated = model_id == '1' and model_name.casefold() == 'dummy'
    # RX ranges describe backend tuning support, never operator TX permission.
    merged = []
    for low, high in sorted(set(ranges)):
        if merged and low <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(high, merged[-1][1]))
        else:
            merged.append((low, high))
    flags = {key: fields.get(f'Can {key}', '') == 'Y'
             for key in ('set Frequency', 'get Frequency', 'set Mode', 'get Mode', 'set PTT', 'get PTT', 'get Split VFO')}
    rig_types = set(fields.get('Rig type', '').split())
    hardware_receive_only = ('Receiver' in rig_types and not rig_types.intersection({'Transceiver', 'Transmitter'})
                             and tx_sections and not tx_ranges and not flags['set PTT'])
    return {'fields': fields, 'flags': flags, 'ranges': merged, 'modelId': model_id,
            'modelName': model_name, 'manufacturer': manufacturer, 'simulated': simulated,
            'receiver': hardware_receive_only,
            'modeTokens': fields.get('Mode list', '').split(), 'raw': text}


def response_field(lines: list[str], name: str) -> str:
    values = [line[len(name) + 2:] for line in lines if line.startswith(name + ': ')]
    if len(values) != 1:
        raise RigError(f'Invalid Hamlib {name} readback')
    return values[0].strip()


class RigClient:
    """Serialized Hamlib ERP requests, each terminated by a verified RPRT line."""
    def __init__(self, port: int):
        self.port = port
        self.reader = None
        self.writer = None

    async def connect(self):
        self.reader, self.writer = await asyncio.wait_for(
            asyncio.open_connection('127.0.0.1', self.port, limit=MAX_LINE), COMMAND_TIMEOUT)

    def close(self):
        if self.writer:
            self.writer.close()
        self.reader = None
        self.writer = None

    async def command(self, name: str, arguments: str = '', guard=None) -> list[str]:
        # Only these internal calls can reach the backend. This API is not an RPC.
        if name not in {'dump_caps', 'get_freq', 'get_mode', 'get_ptt', 'get_split_vfo', 'get_conf', 'set_cache', 'set_freq', 'set_mode', 'set_ptt'}:
            raise RigError('Unsupported internal Hamlib command')
        if name == 'get_conf':
            valid = arguments in {'ptt_type', 'cache_timeout'}  # Fixed read-only safety checks, never arbitrary configuration.
        elif name == 'set_cache':
            valid = arguments == '0'  # Explicit startup TX opt-in may disable daemon caching only.
        elif name.startswith('get_') or name == 'dump_caps':
            valid = not arguments
        elif name == 'set_freq':
            valid = bool(re.fullmatch(r'[1-9]\d{0,15}', arguments))
        elif name == 'set_mode':
            valid = arguments == '?' or bool(re.fullmatch(r'[A-Z][A-Z0-9]{0,15} 0', arguments))
        else:
            valid = arguments in {'0', '1'}
        if not valid:
            raise RigError('Invalid internal Hamlib command arguments')
        if not self.writer or not self.reader:
            raise RigError('Hamlib connection is unavailable')

        async def exchange():
            if guard is not None and not guard():
                raise RigError('Operation was revoked before the backend write')
            self.writer.write(('+\\' + name + (' ' + arguments if arguments else '') + '\n').encode('ascii'))
            await self.writer.drain()
            lines = []
            total = 0
            while True:
                raw = await self.reader.readline()
                if not raw or not raw.endswith(b'\n') or len(raw) > MAX_LINE:
                    raise RigError('Truncated or oversized Hamlib response')
                total += len(raw)
                if total > MAX_RESPONSE or len(lines) > 4096:
                    raise RigError('Hamlib response exceeded its bound')
                try:
                    line = raw.decode('utf-8').rstrip('\r\n')
                except UnicodeDecodeError as exc:
                    raise RigError('Invalid Hamlib response encoding') from exc
                report = re.fullmatch(r'RPRT (-?\d+)', line)
                if report:
                    if int(report[1]) != 0:
                        raise RigError(f'Hamlib {name} failed with code {report[1]}')
                    if not lines or not lines[0].startswith(name + ':'):
                        raise RigError('Hamlib response did not match the requested command')
                    return lines[1:]
                lines.append(line)
        try:
            return await asyncio.wait_for(exchange(), COMMAND_TIMEOUT)
        except RigError:
            # A complete negative RPRT consumes the response; close anyway so a
            # subsequent emergency release starts with a fresh framing boundary.
            self.close()
            raise
        except (OSError, ValueError, asyncio.TimeoutError, asyncio.CancelledError) as exc:
            self.close()
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise RigError('Hamlib command timed out or disconnected') from exc


class RigSession:
    def __init__(self, port: int, allow_transmit=False):
        self.client = RigClient(port)
        self.port = port
        self.allow_transmit = allow_transmit
        self.caps = None
        self.capabilities = None
        self.mode_map = {}
        self.may_transmit = False
        self.deadline = 0.0
        self.heartbeat = 0.0
        self.revoked = False
        self.epoch = 0
        self.ptt_route = None
        self.cache_timeout = None
        self.cache_prepared = False
        self.observed_ptt_route = None

    def current(self, epoch):
        return not self.revoked and epoch == self.epoch

    def key_window(self, key_deadline=None, key_before_utc=None):
        return (key_deadline is None or (asyncio.get_running_loop().time() < key_deadline
                                        and time.time() * 1000 < key_before_utc))

    def key_current(self, epoch, key_deadline=None, key_before_utc=None):
        now = asyncio.get_running_loop().time()
        return (self.current(epoch) and self.may_transmit and now < self.deadline
                and now - self.heartbeat < HEARTBEAT_TIMEOUT
                and self.key_window(key_deadline, key_before_utc))

    async def _ensure_connection(self):
        if not self.client.writer:
            await self.client.connect()

    async def read_ptt_route(self):
        """Read actual PTTPORT through the fixed get_conf ptt_type query."""
        probe = RigClient(self.port)
        try:
            # Some daemon versions close a get_conf session after its complete
            # RPRT response. Isolate these fixed safety reads from the CAT stream.
            await probe.connect()
            lines = await probe.command('get_conf', 'ptt_type')
            if len(lines) != 1:
                raise RigError('Invalid Hamlib runtime PTT route')
            match = re.fullmatch(r'ptt_type=(RIG|RIGMICDATA|DTR|RTS|Parallel|CM108|GPIO|GPION|None)', lines[0])
            if not match:
                raise RigError('Invalid Hamlib runtime PTT route')
            return match[1].upper()
        except RigError:
            return None
        finally:
            probe.close()

    def safe_ptt_route(self, route):
        return route in ({'NONE', 'RIG', 'RIGMICDATA'} if self.caps['simulated'] else {'RIG', 'RIGMICDATA'})

    async def read_cache_timeout(self):
        """A zero frontend cache prevents cached state from authorizing CAT PTT."""
        probe = RigClient(self.port)
        try:
            await probe.connect()
            lines = await probe.command('get_conf', 'cache_timeout')
            if len(lines) != 1:
                return None
            match = re.fullmatch(r'cache_timeout=(0|[1-9]\d{0,9})', lines[0])
            return int(match[1]) if match else None
        except RigError:
            return None
        finally:
            probe.close()

    async def snapshot(self) -> dict:
        await self._ensure_connection()
        self.observed_ptt_route = await self.read_ptt_route()
        safe_route = self.safe_ptt_route(self.observed_ptt_route)
        if self.capabilities and not safe_route:
            self.capabilities.update(ptt=False, pttReadback=False, receiveOnly=True,
                                     frequency=self.caps['receiver'] and self.capabilities['frequency'],
                                     mode=self.caps['receiver'] and self.capabilities['mode'],
                                     pttRoute=self.observed_ptt_route,
                                     pttRouteVerified=self.observed_ptt_route is not None)
        if self.may_transmit and not safe_route:
            raise RigError('Runtime PTT route is no longer safe; release at the local radio')
        frequency_text = response_field(await self.client.command('get_freq'), 'Frequency')
        try:
            frequency_float = float(frequency_text)
        except ValueError as exc:
            raise RigError('Invalid Hamlib frequency readback') from exc
        if not math.isfinite(frequency_float) or frequency_float != int(frequency_float) or not 1 <= frequency_float <= MAX_INTEGER:
            raise RigError('Frequency readback is not a positive integer Hz value')
        mode_token = response_field(await self.client.command('get_mode'), 'Mode')
        if mode_token not in MODE_NAMES:
            raise RigError('The current Hamlib mode has no supported canonical mapping')
        ptt = False
        status = 'unknown'
        if self.caps and self.caps['flags']['get PTT'] and safe_route:
            try:
                ptt_text = response_field(await self.client.command('get_ptt'), 'PTT')
                if ptt_text not in {'0', '1', '2', '3'}:
                    raise RigError('Invalid Hamlib PTT readback')
                ptt = ptt_text != '0'
                status = ('cat-tx' if self.may_transmit else 'external-tx') if ptt else 'rx'
                if not ptt:
                    self.may_transmit = False
                    self.deadline = 0.0
            except RigError:
                if self.capabilities:
                    self.capabilities.update(ptt=False, pttReadback=False, receiveOnly=True,
                                             frequency=self.caps['receiver'] and self.capabilities['frequency'],
                                             mode=self.caps['receiver'] and self.capabilities['mode'])
        if status == 'unknown' and self.caps and self.caps['receiver']:
            status = 'rx'  # Backend capability inference; no PTT readback is invented.
        split = None
        if self.caps and self.caps['flags']['get Split VFO']:
            try:
                await self._ensure_connection()
                value = response_field(await self.client.command('get_split_vfo'), 'Split')
                if value not in {'0', '1'}:
                    raise RigError('Invalid Hamlib split readback')
                split = value == '1'
            except RigError:
                pass
        if self.capabilities and split is not False:
            self.capabilities.update(ptt=False, splitReadback=split is not None, receiveOnly=True)
        if self.may_transmit and split is not False:
            raise RigError('Simplex transmit state is no longer confirmed')
        return {'frequency': int(frequency_float), 'mode': MODE_NAMES[mode_token], 'ptt': ptt,
                'txStatus': status, 'split': split}

    async def hello(self):
        if self.caps is None:
            await self._ensure_connection()
            self.caps = parse_caps(await self.client.command('dump_caps'))
            try:
                tokens = ' '.join(await self.client.command('set_mode', '?')).split()
            except RigError:
                tokens = self.caps['modeTokens']
                await self._ensure_connection()
            for token in tokens:
                if token in MODE_NAMES:
                    self.mode_map.setdefault(MODE_NAMES[token], token)
            if self.allow_transmit:
                # Startup TX opt-in authorizes this one daemon-only cache
                # preparation. A later cache change is rejected, never reset.
                await self._ensure_connection()
                try:
                    await self.client.command('set_cache', '0')
                    self.cache_prepared = True
                except RigError:
                    pass
        self.cache_timeout = await self.read_cache_timeout()
        state = await self.snapshot()
        self.ptt_route = self.observed_ptt_route
        flags = self.caps['flags']
        ranges = self.caps['ranges']
        can_read_ptt = state['txStatus'] != 'unknown' and flags['get PTT'] and self.safe_ptt_route(self.ptt_route)
        # Serial RTS/DTR frontend state is not a radio PTT readback. Require the
        # configured backend's CAT type (or explicitly configured Dummy model).
        cat_ptt = self.caps['simulated'] or self.caps['fields'].get('PTT type', '').startswith('Rig capable')
        can_ptt = (self.allow_transmit and flags['set PTT'] and can_read_ptt and cat_ptt
                   and self.safe_ptt_route(self.ptt_route) and self.cache_prepared
                   and self.cache_timeout == 0 and state['split'] is False)
        can_change = can_read_ptt or self.caps['receiver']
        self.capabilities = {
            'frequency': bool(flags['set Frequency'] and flags['get Frequency'] and ranges and can_change),
            'mode': bool(flags['set Mode'] and flags['get Mode'] and self.mode_map and can_change),
            'ptt': bool(can_ptt), 'pttReadback': bool(can_read_ptt),
            'receiveOnly': not bool(can_ptt), 'simulated': self.caps['simulated'],
            'hardwareReceiveOnly': self.caps['receiver'], 'splitReadback': state['split'] is not None,
            'pttRoute': self.ptt_route, 'pttRouteVerified': self.ptt_route is not None,
            'cacheTimeoutMs': self.cache_timeout, 'freshReadback': self.cache_timeout == 0,
            'modes': list(self.mode_map),
            'minFrequency': ranges[0][0] if ranges else state['frequency'],
            'maxFrequency': ranges[-1][1] if ranges else state['frequency'],
            'frequencyRanges': [{'min': low, 'max': high} for low, high in ranges],
            'digitalModes': [m for m in ('DATA-USB', 'USB') if m in self.mode_map],
            'pttReadbackSource': 'hamlib-backend',
        }
        label = ' '.join(part for part in (self.caps['manufacturer'], self.caps['modelName']) if part)
        return {'protocol': 'radiodesk-hamlib-v1', 'name': 'Hamlib: ' + label,
                'model': self.caps['modelId'], 'configuredModelName': self.caps['modelName'],
                'identitySource': 'hamlib-configured', 'capabilities': dict(self.capabilities), 'snapshot': state}

    async def release(self):
        if self.caps is None:
            raise RigError('Read the configured backend before requesting release')
        flags = self.caps['flags']
        if self.may_transmit:
            if not (flags['set PTT'] and flags['get PTT']):
                raise RigError('This backend cannot release and confirm PTT')
            await self._ensure_connection()
            route = await self.read_ptt_route()
            if route != self.ptt_route or not self.safe_ptt_route(route):
                raise RigError('Receive release route is unknown or changed; check local radio PTT')
            await self.client.command('set_ptt', '0')
            if await self.read_cache_timeout() != 0:
                raise RigError('Receive release cannot be confirmed while readback caching is enabled or unknown')
        await self._ensure_connection()
        if not flags['get PTT']:
            raise RigError('This backend cannot confirm receive state')
        ptt = response_field(await self.client.command('get_ptt'), 'PTT')
        if ptt != '0':
            raise RigError('Receive release was not confirmed; check radio PTT locally')
        self.may_transmit = False
        self.deadline = 0.0
        return 'rx'

    def expired(self, now: float) -> bool:
        return self.may_transmit and (now >= self.deadline or now - self.heartbeat >= HEARTBEAT_TIMEOUT)

    async def request(self, request: dict, epoch=None):
        epoch = self.epoch if epoch is None else epoch
        op = request.get('op')
        allowed = {'hello': {'id', 'op'}, 'read': {'id', 'op'}, 'heartbeat': {'id', 'op'},
                   'frequency': {'id', 'op', 'value'}, 'mode': {'id', 'op', 'value'},
                   'ptt': {'id', 'op', 'active', 'expected', 'maximumSeconds'}, 'release': {'id', 'op'}}
        fields = set(request)
        if op == 'ptt':
            fields.discard('keyBeforeUtcMs')
        if type(op) is not str or op not in allowed or fields != allowed[op]:
            raise ProtocolError('Unsupported operation or request fields')
        key_deadline = None
        key_before_utc = None
        if op == 'ptt' and 'keyBeforeUtcMs' in request:
            key_before_utc = integer(request['keyBeforeUtcMs'])
            remaining = (key_before_utc - time.time() * 1000) / 1000
            if not 0 < remaining <= MAX_TRANSMIT_SECONDS:
                raise ProtocolError('Scheduled keying deadline is past or more than 30 seconds away')
            # Capture once, before any backend await. Wall-clock rollback cannot
            # extend this budget; a clock jump forward still cancels the write.
            key_deadline = asyncio.get_running_loop().time() + remaining
        if not self.current(epoch) and op != 'release':
            raise RigError('This operation has been revoked')
        if op == 'hello':
            return await self.hello()
        if self.capabilities is None:
            raise RigError('Send hello before station operations')
        if op == 'heartbeat':
            self.heartbeat = asyncio.get_running_loop().time()
            return {'alive': True}
        if op == 'release':
            return await self.release()
        if op == 'read':
            return await self.snapshot()
        if op == 'ptt':
            if request['active'] is not True:
                raise ProtocolError('Use release to request receive state')
            duration = integer(request['maximumSeconds'], 1, MAX_TRANSMIT_SECONDS)
            expected = request['expected']
            if not isinstance(expected, dict) or set(expected) != {'frequency', 'mode'}:
                raise ProtocolError('PTT requires expected frequency and mode')
            integer(expected['frequency'])
            if type(expected['mode']) is not str or expected['mode'] not in self.mode_map:
                raise ProtocolError('Invalid expected mode')
            if not self.capabilities['ptt'] or self.may_transmit:
                raise RigError('PTT is disabled or a transmit lease is already active')
            route = await self.read_ptt_route()
            cache_timeout = await self.read_cache_timeout()
            if not self.current(epoch):
                raise RigError('Transmit request was revoked during its safety configuration checks')
            if route != self.ptt_route or not self.safe_ptt_route(route) or cache_timeout != 0:
                self.capabilities.update(ptt=False, receiveOnly=True, pttRoute=route,
                                         pttRouteVerified=route is not None, cacheTimeoutMs=cache_timeout,
                                         freshReadback=cache_timeout == 0)
                raise RigError('Runtime PTT route changed or is unsafe, or readback cache is enabled/unknown')
            state = await self.snapshot()
            if not self.current(epoch) or not self.key_window(key_deadline, key_before_utc):
                raise RigError('Transmit request was revoked during its readbacks')
            if (state['txStatus'] != 'rx' or state['split'] is not False or state['frequency'] != expected['frequency']
                    or state['mode'] != expected['mode'] or not self.capabilities['ptt']):
                raise RigError('Fresh receive frequency/mode/PTT does not match the transmit request')
            now = asyncio.get_running_loop().time()
            self.may_transmit = True  # A timeout after writing may still have keyed hardware.
            self.deadline = now + duration
            self.heartbeat = now
            await self._ensure_connection()
            if not self.key_current(epoch, key_deadline, key_before_utc):
                raise RigError('Transmit request was revoked before keying')
            await self.client.command('set_ptt', '1',
                                      guard=lambda: self.key_current(epoch, key_deadline, key_before_utc))
            value = response_field(await self.client.command('get_ptt'), 'PTT')
            if value not in {'1', '2', '3'}:
                raise RigError('Transmit PTT was not confirmed')
            return 'cat-tx'
        value = request['value']
        if op == 'frequency':
            integer(value)
            if not self.capabilities['frequency'] or not any(low <= value <= high for low, high in self.caps['ranges']):
                raise ProtocolError('Frequency is outside configured backend receive ranges')
        elif type(value) is not str or not self.capabilities['mode'] or value not in self.mode_map:
            raise ProtocolError('Mode is not supported by the configured backend')
        state = await self.snapshot()
        if not self.current(epoch):
            raise RigError('Setting was revoked during its readbacks')
        if state['txStatus'] != 'rx' and not (state['txStatus'] == 'unknown' and self.caps['receiver']):
            raise RigError('Frequency and mode changes require confirmed receive state')
        await self._ensure_connection()
        await self.client.command('set_freq' if op == 'frequency' else 'set_mode',
                                  str(value) if op == 'frequency' else self.mode_map[value] + ' 0',
                                  guard=lambda: self.current(epoch))
        state = await self.snapshot()
        if state[op] != value:
            raise RigError('Hamlib setting was not confirmed by fresh readback')
        return state


class Bridge:
    def __init__(self, upstream_port: int, listen_port: int, origins: set[str], token: str, allow_transmit=False):
        self.upstream_port = upstream_port
        self.listen_port = listen_port
        self.origins = origins
        self.token = token
        self.allow_transmit = allow_transmit
        self.lock = asyncio.Lock()
        self.connections = {}

    async def shutdown(self):
        """Stop sessions before exiting the event loop, allowing bounded RX release."""
        for writer in list(self.connections.values()):
            writer.close()
        if self.connections:
            done, pending = await asyncio.wait(list(self.connections), timeout=5)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        handle_task = asyncio.current_task()
        self.connections[handle_task] = writer
        acquired = False
        upgraded = False
        tasks = []
        session = RigSession(self.upstream_port, self.allow_transmit)
        send_lock = asyncio.Lock()
        pending = deque()
        priority = deque()
        request_ready = asyncio.Event()
        current_operation = None

        async def send(payload, opcode=1):
            async with send_lock:
                writer.write(websocket_frame(payload, opcode))
                await asyncio.wait_for(writer.drain(), COMMAND_TIMEOUT)

        async def receive():
            fragments = bytearray()
            fragmented = False
            while True:
                fin, opcode, payload = await read_client_frame(reader)
                if opcode == 8:
                    if len(payload) == 1:
                        raise ProtocolError('Invalid close frame')
                    return
                if opcode == 9:
                    await send(payload, 10)
                    continue
                if opcode == 10:
                    continue
                if opcode == 1:
                    if fragmented:
                        raise ProtocolError('Unexpected text frame during continuation')
                    fragments = bytearray(payload)
                elif opcode == 0:
                    if not fragmented:
                        raise ProtocolError('Unexpected continuation frame')
                    fragments.extend(payload)
                if len(fragments) > MAX_MESSAGE:
                    raise ProtocolError('Fragmented request exceeds its bound')
                fragmented = not fin
                if not fin:
                    continue
                request = parse_request(bytes(fragments))
                fragments.clear()
                if request.get('op') == 'release' and set(request) == {'id', 'op'}:
                    # The reader never waits for rigctld. Revoke before another
                    # pre-key read finishes, then interrupt its framing boundary.
                    session.epoch += 1
                    if current_operation is not None:
                        current_operation.cancel()
                    priority.append((request, session.epoch))
                elif request.get('op') == 'heartbeat' and set(request) == {'id', 'op'}:
                    # Keepalive remains independent of slow backend readbacks.
                    try:
                        result = await session.request(request)
                        reply = {'id': request['id'], 'ok': True, 'result': result}
                    except (ProtocolError, RigError) as exc:
                        reply = {'id': request['id'], 'ok': False, 'error': str(exc)[:240]}
                    await send(json.dumps(reply, separators=(',', ':'), allow_nan=False).encode('utf-8'))
                    continue
                else:
                    pending.append((request, session.epoch))
                if len(pending) + len(priority) > 16:
                    raise ProtocolError('Too many pending station requests')
                request_ready.set()

        async def execute():
            nonlocal current_operation
            while True:
                await request_ready.wait()
                request, epoch = priority.popleft() if priority else pending.popleft()
                if not priority and not pending:
                    request_ready.clear()
                try:
                    current_operation = asyncio.create_task(session.request(request, epoch))
                    result = await current_operation
                    reply = {'id': request['id'], 'ok': True, 'result': result}
                except asyncio.CancelledError:
                    if asyncio.current_task().cancelling():
                        raise
                    reply = {'id': request['id'], 'ok': False, 'error': 'Operation revoked by receive release'}
                except (ProtocolError, RigError, OSError, asyncio.TimeoutError) as exc:
                    reply = {'id': request['id'], 'ok': False, 'error': str(exc)[:240]}
                    if session.may_transmit:
                        # Revoke before another queued browser request can key.
                        session.revoked = True
                        try:
                            await session.release()
                        except (RigError, OSError, asyncio.TimeoutError):
                            reply['error'] += '; receive release unconfirmed, check the radio locally'
                finally:
                    current_operation = None
                await send(json.dumps(reply, separators=(',', ':'), allow_nan=False).encode('utf-8'))
                if session.revoked:
                    return

        async def watchdog():
            while True:
                await asyncio.sleep(0.05)
                if session.expired(asyncio.get_running_loop().time()):
                    session.revoked = True
                    return

        try:
            raw = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 5)
            accept = parse_upgrade(raw, self.origins, self.token, self.listen_port)
            if self.lock.locked():
                writer.write(b'HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                await writer.drain()
                return
            await self.lock.acquire()
            acquired = True
            writer.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n').encode('ascii'))
            await writer.drain()
            upgraded = True
            writer.transport.set_write_buffer_limits(high=16384, low=4096)
            tasks = [asyncio.create_task(receive()), asyncio.create_task(execute()), asyncio.create_task(watchdog())]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (ProtocolError, ValueError, asyncio.LimitOverrunError):
            if not upgraded:
                writer.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                try:
                    await writer.drain()
                except OSError:
                    pass
        except (asyncio.IncompleteReadError, OSError, asyncio.TimeoutError):
            pass
        finally:
            session.revoked = True
            session.epoch += 1
            if current_operation is not None:
                current_operation.cancel()
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            if session.may_transmit:
                try:
                    await session.release()
                except (RigError, OSError, asyncio.TimeoutError):
                    # A failed release gets one fresh fixed-upstream attempt.
                    session.client.close()
                    try:
                        await session.release()
                    except (RigError, OSError, asyncio.TimeoutError):
                        print('Hamlib receive release UNCONFIRMED: check local radio PTT immediately.')
            session.client.close()
            if upgraded:
                try:
                    await send(struct.pack('!H', 1008 if session.deadline else 1000), 8)
                except (OSError, asyncio.TimeoutError):
                    pass
            if acquired:
                self.lock.release()
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass
            self.connections.pop(handle_task, None)


async def main(args):
    origins = set(args.origin or DEFAULT_ORIGINS)
    if args.allow_file_origin:
        origins.add('null')
    token = args.token or secrets.token_urlsafe(24)
    if not re.fullmatch(r'[A-Za-z0-9_-]{16,256}', token):
        raise SystemExit('Bridge token must contain 16–256 letters, digits, underscores or hyphens.')
    for origin in origins:
        parsed = urllib.parse.urlsplit(origin)
        if origin != 'null' and (parsed.scheme not in ('http', 'https') or parsed.path or parsed.query or parsed.fragment or parsed.username or not parsed.netloc):
            raise SystemExit('Every --origin must be an exact HTTP(S) origin, without a path.')
    instance = Bridge(args.upstream_port, args.port, origins, token, args.allow_transmit)
    server = await asyncio.start_server(instance.handle, '127.0.0.1', args.port, limit=MAX_HTTP)
    print(f'RadioDesk Hamlib bridge: ws://127.0.0.1:{args.port}/radio?token={urllib.parse.quote(token, safe="")}')
    print(f'Fixed rigctld upstream: 127.0.0.1:{args.upstream_port}; allowed origins: {", ".join(sorted(origins))}')
    print('Transmit opt-in enabled; prepares daemon cache=0 and requires verified CAT PTT/readback.' if args.allow_transmit else 'Transmit disabled. Add --allow-transmit only after checking your radio setup.')
    try:
        async with server:
            await server.serve_forever()
    finally:
        await instance.shutdown()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--upstream-port', type=int, default=4532)
    parser.add_argument('--origin', action='append', help='Exact allowed page origin; repeats replace the localhost:4173 defaults.')
    parser.add_argument('--allow-file-origin', action='store_true', help='Explicitly allow local HTML Origin:null, still requiring the token.')
    parser.add_argument('--token', help='Optional 16–256 character token: letters, digits, underscore or hyphen; otherwise random.')
    parser.add_argument('--allow-transmit', action='store_true', help='Authorize one daemon cache-disable operation and eligible bounded CAT PTT with verified readbacks.')
    arguments = parser.parse_args()
    if not 1 <= arguments.port <= 65535 or not 1 <= arguments.upstream_port <= 65535:
        parser.error('Ports must be between 1 and 65535.')
    try:
        asyncio.run(main(arguments))
    except KeyboardInterrupt:
        pass
