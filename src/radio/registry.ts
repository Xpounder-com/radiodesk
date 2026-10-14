import type { RadioDriver, RadioIdentitySource, RadioSnapshot } from './driver.ts';
import { FT891RadioDriver, SimulatorRadioDriver } from './adapters.ts';
import { HamlibRadioDriver, type HamlibDriverOptions } from './hamlib.ts';
import type { CATSession } from './session.ts';

export interface RadioDriverDescriptor {
  readonly id: 'simulator' | 'ft891' | 'hamlib';
  readonly label: string;
  readonly transport: 'local' | 'serial' | 'websocket';
  readonly identitySource: Exclude<RadioIdentitySource, 'none'>;
  readonly detail: string;
}

/** Explicit compiled-in choices; this registry never discovers or opens hardware. */
const drivers: readonly RadioDriverDescriptor[] = Object.freeze([
  Object.freeze({ id: 'simulator', label: 'RadioDesk simulator', transport: 'local', identitySource: 'simulator', detail: 'Local state and silent transmit simulation; no physical audio or RF.' }),
  Object.freeze({ id: 'ft891', label: 'Yaesu FT-891 · direct CAT', transport: 'serial', identitySource: 'protocol', detail: 'ID0650 protocol identity and CAT readbacks; physical integration unverified.' }),
  Object.freeze({ id: 'hamlib', label: 'Hamlib · local radio bridge', transport: 'websocket', identitySource: 'hamlib-configured', detail: 'Operator-configured backend identity and fresh readbacks; model and audio routing require physical verification.' }),
]);

export function getRadioDrivers(): readonly RadioDriverDescriptor[] { return drivers.map((driver) => Object.freeze({ ...driver })); }

export interface RadioDriverConfiguration { session?: CATSession; initial?: Partial<RadioSnapshot>; endpoint?: string; hamlib?: HamlibDriverOptions; }

const factories: Record<RadioDriverDescriptor['id'], (configuration: RadioDriverConfiguration) => RadioDriver> = {
  simulator: (configuration) => new SimulatorRadioDriver(configuration.initial),
  ft891: (configuration) => { if (!configuration.session) throw new Error('FT-891 requires an explicitly selected serial session.'); return new FT891RadioDriver(configuration.session); },
  hamlib: (configuration) => { if (!configuration.endpoint) throw new Error('Hamlib requires an explicit local bridge endpoint.'); return new HamlibRadioDriver(configuration.endpoint, configuration.hamlib); },
};

/** Only registered factories can become a connection; metadata and implementation share IDs. */
export function createRadioDriver(id: RadioDriverDescriptor['id'], configuration: RadioDriverConfiguration = {}): RadioDriver { if (!Object.hasOwn(factories, id)) throw new Error('Unknown radio driver registration.'); return factories[id](configuration); }
