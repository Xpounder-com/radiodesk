import { CATSession, type CATCommands, type CATTransmitScope } from './session.ts';
import { encodeFT891Frequency, encodeFT891Mode, parseFT891Frequency, parseFT891Mode, parseFT891ModeCode, parseFT891TransmitStatus, type FT891TransmitStatus } from './protocol.ts';
import type { RadioSnapshot } from './driver.ts';
export type { RadioSnapshot } from './driver.ts';

async function readMode(commands: CATCommands): Promise<string> {
  const frame = await commands.query('MD0;', (reply) => /^MD0[1-9BCD];$/.test(reply));
  const code = parseFT891ModeCode(frame);
  const nominal = parseFT891Mode(frame);
  // FT-891 MD codes use menu-selected BFO. Do not silently claim the wrong sideband.
  const menu = ['1', '2'].includes(code) ? '1107' : ['6', '9'].includes(code) ? '1011' : ['8', 'C'].includes(code) ? '0812' : undefined;
  if (!menu) return nominal;
  const bfo = await commands.query(`EX${menu};`, (reply) => new RegExp(`^EX${menu}[012];$`).test(reply));
  const value = Number(bfo.slice(6, 7));
  if (menu === '1107') return value === 0 ? 'USB' : value === 1 ? 'LSB' : nominal;
  if (value > 1) throw new Error(`Invalid ${menu} BFO menu reply.`);
  const family = menu === '1011' ? 'RTTY' : 'DATA';
  return `${family}-${value === 0 ? 'USB' : 'LSB'}`;
}

async function readSnapshot(commands: CATCommands): Promise<RadioSnapshot> {
  const frequency = parseFT891Frequency(await commands.query('FA;', (reply) => /^FA\d{9};$/.test(reply)));
  const mode = await readMode(commands);
  const txStatus = parseFT891TransmitStatus(await commands.query('TX;', (reply) => /^TX[012];$/.test(reply)));
  return { frequency, mode, ptt: txStatus !== 'rx', txStatus };
}

async function requireReceive(commands: CATCommands): Promise<void> {
  const status = await commands.query('TX;', (reply) => /^TX[012];$/.test(reply));
  if (status !== 'TX0;') throw new Error('Frequency and mode changes are blocked while the radio is transmitting.');
}

export class FT891Driver {
  private session: CATSession;
  private identified = false;

  constructor(session: CATSession) {
    this.session = session;
  }

  async identify(): Promise<RadioSnapshot> {
    return this.session.transact(async (commands) => {
      const identity = await commands.query('ID;', (reply) => /^ID\d{4};$/.test(reply));
      if (identity !== 'ID0650;') throw new Error(`Selected port is not an FT-891 (reply ${identity}). No radio settings were changed.`);
      const snapshot = await readSnapshot(commands);
      this.identified = true;
      return snapshot;
    });
  }

  read(): Promise<RadioSnapshot> {
    this.requireIdentity();
    return this.session.transact(readSnapshot);
  }

  setFrequency(hz: number): Promise<RadioSnapshot> {
    this.requireIdentity();
    const command = encodeFT891Frequency(hz);
    return this.session.transact(async (commands) => {
      await requireReceive(commands);
      await commands.write(command);
      // Set commands have no success reply. Only a fresh readback updates station state.
      return readSnapshot(commands);
    });
  }

  setMode(mode: string): Promise<RadioSnapshot> {
    this.requireIdentity();
    const canonical = mode.toUpperCase();
    const command = encodeFT891Mode(canonical);
    return this.session.transact(async (commands) => {
      await requireReceive(commands);
      if (canonical === 'LSB' || canonical === 'USB') {
        const frame = await commands.query('EX1107;', (reply) => /^EX1107[012];$/.test(reply));
        const bfo = Number(frame.slice(6, 7));
        if ((canonical === 'LSB' && bfo === 0) || (canonical === 'USB' && bfo === 1)) {
          throw new Error(`The radio's SSB BFO menu overrides ${canonical}. Set menu 11-07 to AUTO or ${canonical} on the radio, then retry.`);
        }
      }
      if (['DATA-LSB', 'DATA-USB', 'RTTY-LSB', 'RTTY-USB'].includes(canonical)) {
        const menu = canonical.startsWith('DATA') ? '0812' : '1011';
        const frame = await commands.query(`EX${menu};`, (reply) => new RegExp(`^EX${menu}[01];$`).test(reply));
        const expected = canonical.endsWith('USB') ? 0 : 1;
        if (Number(frame.slice(6, 7)) !== expected) throw new Error(`The radio's ${canonical.startsWith('DATA') ? 'DATA' : 'RTTY'} BFO menu overrides ${canonical}. Change the BFO on the radio, then retry.`);
      }
      await commands.write(command);
      return readSnapshot(commands);
    });
  }

  readTransmitStatus(): Promise<FT891TransmitStatus> {
    this.requireIdentity();
    return this.session.transact(async (commands) => {
      const status = parseFT891TransmitStatus(await commands.query('TX;', (reply) => /^TX[012];$/.test(reply)));
      if (status === 'rx') this.session.confirmReceive();
      return status;
    });
  }

  setPtt(active: boolean, scope: CATTransmitScope, expected?: { frequency: number; mode: string }): Promise<FT891TransmitStatus> {
    this.requireIdentity();
    return this.session.transact(async (commands) => {
      if (active) {
        if (!expected) throw new Error('PTT requires an explicitly selected frequency and mode.');
        const actual = await readSnapshot(commands);
        if (actual.ptt) throw new Error('The radio is already transmitting; release external PTT/VOX/keying.');
        if (actual.frequency !== expected.frequency || actual.mode !== expected.mode) throw new Error('Frequency or mode changed on the physical radio after arming. Refresh and arm again.');
      }
      await commands.write(active ? 'TX1;' : 'TX0;');
      const status = parseFT891TransmitStatus(await commands.query('TX;', (reply) => /^TX[012];$/.test(reply)));
      if (status === 'rx') this.session.confirmReceive();
      if (active && status !== 'cat-tx') throw new Error('FT-891 did not confirm CAT transmit. No audio should be sent.');
      if (!active && status !== 'rx') throw new Error('FT-891 did not confirm receive. Check physical PTT, VOX, or keying.');
      return status;
    }, scope);
  }

  private requireIdentity(): void {
    if (!this.identified) throw new Error('Identify the selected FT-891 before reading or changing radio settings.');
  }
}
