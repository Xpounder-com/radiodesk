/** Yaesu FT-891 CAT reference book 1909-C, pages 7–11 and 18. */
export const FT891_MIN_FREQUENCY = 30_000;
export const FT891_MAX_FREQUENCY = 56_000_000;
export const FT891_BAUD_RATES = [4800, 9600, 19200, 38400] as const;

export const FT891_MODE_CODES: Readonly<Record<string, string>> = Object.freeze({
  LSB: '1', USB: '2', CW: '3', FM: '4', AM: '5', RTTY: '6', 'CW-R': '7', DATA: '8',
  'RTTY-USB': '9', 'FM-N': 'B', 'DATA-USB': 'C', 'AM-N': 'D', 'RTTY-LSB': '6', 'DATA-LSB': '8',
});

export function validateFrequency(hz: number): number {
  if (!Number.isSafeInteger(hz) || hz < FT891_MIN_FREQUENCY || hz > FT891_MAX_FREQUENCY) {
    throw new RangeError('Frequency must be a whole number of Hz between 30 kHz and 56 MHz.');
  }
  return hz;
}

export function encodeFT891Frequency(hz: number): string {
  return `FA${validateFrequency(hz).toString().padStart(9, '0')};`;
}

export function parseFT891Frequency(frame: string): number {
  const match = /^FA(\d{9});$/.exec(frame);
  if (!match) throw new Error(`Invalid FT-891 frequency reply: ${frame}`);
  return validateFrequency(Number(match[1]));
}

export function encodeFT891Mode(mode: string): string {
  const code = FT891_MODE_CODES[mode.toUpperCase()];
  if (!code) throw new RangeError(`Unsupported FT-891 mode: ${mode}`);
  return `MD0${code};`;
}

export function parseFT891ModeCode(frame: string): string {
  const match = /^MD0([1-9BCD]);$/.exec(frame);
  if (!match) throw new Error(`Invalid FT-891 mode reply: ${frame}`);
  return match[1]!;
}

export function parseFT891Mode(frame: string): string {
  const code = parseFT891ModeCode(frame);
  return Object.keys(FT891_MODE_CODES).find((mode) => FT891_MODE_CODES[mode] === code)!;
}

export function parseFT891TransmitState(frame: string): boolean {
  return parseFT891TransmitStatus(frame) !== 'rx';
}

export type FT891TransmitStatus = 'rx' | 'cat-tx' | 'external-tx';

/** TX2 is an answer for radio-local TX, not a command to send. */
export function parseFT891TransmitStatus(frame: string): FT891TransmitStatus {
  const match = /^TX([012]);$/.exec(frame);
  if (!match) throw new Error(`Invalid FT-891 transmit-state reply: ${frame}`);
  return match[1] === '0' ? 'rx' : match[1] === '1' ? 'cat-tx' : 'external-tx';
}

export function assertScopedCATCommand(command: string, transmitAuthorized: boolean): void {
  if (command === 'TX0;' || command === 'TX1;') {
    if (!transmitAuthorized) throw new Error('CAT PTT requires a current operator transmit scope.');
    return;
  }
  assertReceiveOnlyCommand(command);
}

/** Narrow allowlist: no CAT PTT, tuner, power, VOX, keyer, or arbitrary menu writes. */
export function assertReceiveOnlyCommand(command: string): void {
  if (['ID;', 'FA;', 'MD0;', 'TX;', 'EX1107;', 'EX0707;', 'EX0812;', 'EX1011;'].includes(command)) return;
  if (/^FA\d{9};$/.test(command)) {
    parseFT891Frequency(command);
    return;
  }
  if (/^MD0[1-9BCD];$/.test(command)) return;
  throw new Error('Command blocked by the receive-only CAT allowlist.');
}

/** Handles fragmented and coalesced UART reads, with bounded corrupt-frame storage. */
export class CATFrameParser {
  private buffer = '';

  push(chunk: string): string[] {
    if (/[^\x20-\x7e\r\n]/.test(chunk)) throw new Error('CAT stream contained non-ASCII data. Check the selected port and baud rate.');
    this.buffer += chunk.replace(/[\r\n]/g, '');
    const frames: string[] = [];
    let end: number;
    while ((end = this.buffer.indexOf(';')) !== -1) {
      if (end > 128) throw new Error('CAT reply exceeded the frame-size limit.');
      frames.push(this.buffer.slice(0, end + 1));
      this.buffer = this.buffer.slice(end + 1);
    }
    if (this.buffer.length > 128) throw new Error('CAT reply exceeded the frame-size limit.');
    return frames;
  }
}
