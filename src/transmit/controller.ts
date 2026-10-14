import { RadioController, type RadioState, type RadioTransmitPermit } from '../radio/controller.ts';

export interface TransmitAcknowledgements {
  authorizedOperator: boolean;
  frequencyAuthorized: boolean;
  antennaOrDummyLoad: boolean;
  independentFailsafe: boolean;
  audioRouteVerified: boolean;
  physicalUnverified: boolean;
}

export interface ArmRequest {
  operatorCall: string;
  frequencyHz: number;
  mode: string;
  maxTransmitSeconds?: number;
  acknowledgements: TransmitAcknowledgements;
}

export type TransmitPhase = 'disarmed' | 'armed' | 'pending' | 'transmitting' | 'scheduled' | 'releasing' | 'fault';
export interface TxState {
  readonly armed: boolean;
  readonly status: TransmitPhase;
  readonly operatorCall: string;
  readonly frequencyHz: number;
  readonly mode: string;
  readonly maximumSeconds: number;
  readonly rxConfirmed: boolean | null;
  readonly scheduledAtUtcMs: number | null;
  readonly source: 'manual' | 'scheduled' | null;
  readonly elapsedMs: number;
  readonly error?: string;
  readonly simulated: boolean;
}

export interface ScheduledAudioTransmission {
  id: string;
  /** Absolute UTC boundary for starting audio, not for keying CAT. */
  startAtUtcMs: number;
  durationMs: number;
  startAudio(): void | Promise<void>;
  stopAudio(): void;
  leadMs?: number;
  tailMs?: number;
}

export interface TransmitControllerOptions {
  clock?: () => number;
  wallClock?: () => number;
  watchdogMs?: number;
  window?: EventTarget;
  document?: EventTarget & { hidden?: boolean };
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Explicit, volatile operator arming and bounded, one-shot transmit ownership. */
export class TransmitController {
  private radio: RadioController;
  private clock: () => number;
  private wallClock: () => number;
  private watchdogMs: number;
  private setTimer: NonNullable<TransmitControllerOptions['setTimeout']>;
  private clearTimer: NonNullable<TransmitControllerOptions['clearTimeout']>;
  private state: TxState;
  private listeners = new Set<(state: TxState) => void>();
  private operation = 0;
  private armingOperation: number | undefined;
  private permit: RadioTransmitPermit | undefined;
  private deadline = 0;
  private started = 0;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduleTimer: ReturnType<typeof setTimeout> | undefined;
  private keyTimer: ReturnType<typeof setTimeout> | undefined;
  private audioTimer: ReturnType<typeof setTimeout> | undefined;
  private tailTimer: ReturnType<typeof setTimeout> | undefined;
  private schedule: ScheduledAudioTransmission | undefined;
  private scheduleClock = 0;
  private scheduleWallClock = 0;
  private querying = false;
  private releaseInFlight: Promise<void> | undefined;
  private removeRadio: () => void;
  private cleanups: Array<() => void> = [];
  private document: TransmitControllerOptions['document'];
  private disposed = false;
  private armedIdentity = '';

  constructor(radio: RadioController, options: TransmitControllerOptions = {}) {
    this.radio = radio;
    this.clock = options.clock ?? (() => performance.now());
    this.wallClock = options.wallClock ?? (() => Date.now());
    this.watchdogMs = options.watchdogMs ?? 250;
    if (!Number.isFinite(this.watchdogMs) || this.watchdogMs < 20 || this.watchdogMs > 1000) throw new RangeError('Transmit watchdog must run every 20–1000 ms.');
    this.setTimer = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.document = options.document ?? (typeof document === 'undefined' ? undefined : document);
    this.state = { armed: false, status: 'disarmed', operatorCall: '', frequencyHz: 0, mode: '', maximumSeconds: 10, rxConfirmed: null, scheduledAtUtcMs: null, source: null, elapsedMs: 0, simulated: false };
    this.removeRadio = radio.subscribe((state) => this.observeRadio(state));
    const windowTarget = options.window ?? (typeof window === 'undefined' ? undefined : window);
    if (windowTarget) for (const event of ['blur', 'pagehide']) this.bind(windowTarget, event, () => { if (this.armingOperation !== undefined || this.state.armed || this.permit || this.schedule) void this.emergencyStop(`Transmit canceled on ${event}.`).catch(() => undefined); });
    if (this.document) this.bind(this.document, 'visibilitychange', () => { if (this.document?.hidden && (this.armingOperation !== undefined || this.state.armed || this.permit || this.schedule)) void this.emergencyStop('Transmit canceled because the page became hidden.').catch(() => undefined); });
  }

  getState(): TxState {
    const elapsedMs = this.deadline ? Math.max(0, this.clock() - this.started) : 0;
    return Object.freeze({ ...this.state, elapsedMs });
  }

  subscribe(listener: (state: TxState) => void): () => void {
    this.listeners.add(listener); listener(this.getState()); return () => this.listeners.delete(listener);
  }

  async arm(request: ArmRequest): Promise<void> {
    if (this.disposed) throw new Error('Transmit controller is disposed.');
    if (this.state.status !== 'disarmed' && this.state.status !== 'fault') throw new Error('Disarm the previous transmit session before arming again.');
    if (this.document?.hidden) throw new Error('Keep the RadioDesk page visible before arming.');
    const call = request.operatorCall.trim().toUpperCase();
    if (!/^[A-Z0-9/]{3,20}$/.test(call) || !/[A-Z]/.test(call) || !/\d/.test(call)) throw new Error('Enter the responsible operator callsign before arming.');
    const maximumSeconds = request.maxTransmitSeconds ?? 10;
    if (!Number.isSafeInteger(maximumSeconds) || maximumSeconds < 1 || maximumSeconds > 30) throw new RangeError('Maximum transmit duration must be a whole number between 1 and 30 seconds.');
    if (!Number.isSafeInteger(request.frequencyHz) || request.frequencyHz <= 0 || !request.mode) throw new Error('Choose the intended operating frequency and mode.');
    for (const key of ['authorizedOperator', 'frequencyAuthorized', 'antennaOrDummyLoad', 'independentFailsafe', 'audioRouteVerified', 'physicalUnverified'] as const) {
      if (request.acknowledgements?.[key] !== true) throw new Error(`Operator acknowledgement required: ${key}.`);
    }
    const capabilities = this.radio.getCapabilities();
    if (!capabilities.ptt || !capabilities.pttReadback) throw new Error('Connect a radio driver with PTT control and transmit-state readback before arming.');
    const operation = ++this.operation;
    this.armingOperation = operation;
    try {
      const actual = await this.radio.refresh();
      if (operation !== this.operation || this.disposed) throw new Error('Arming was canceled.');
      // Visibility can change without a delivered lifecycle event while CAT is pending.
      if (this.document?.hidden) throw new Error('Arming was canceled because the page became hidden.');
      const currentCapabilities = this.radio.getCapabilities();
      if (!actual.connected || (!actual.verified && !currentCapabilities.simulated) || !currentCapabilities.ptt || !currentCapabilities.pttReadback) throw new Error('A connected radio with current state readbacks and PTT/readback capabilities is required.');
      if (actual.ptt || actual.txStatus !== 'rx') throw new Error('Confirm receive and release external PTT/VOX/keying before arming.');
      if (currentCapabilities.splitReadback && actual.split !== false) throw new Error('Confirm simplex before arming; split transmit is not supported.');
      if (actual.frequency !== request.frequencyHz || actual.mode !== request.mode.toUpperCase()) throw new Error('The intended frequency/mode must match the current receiver readback.');
      this.armedIdentity = this.radioIdentity(actual);
      this.update({ armed: true, status: 'armed', operatorCall: call, frequencyHz: actual.frequency, mode: actual.mode, maximumSeconds, rxConfirmed: true, scheduledAtUtcMs: null, source: null, error: undefined, simulated: currentCapabilities.simulated });
      this.startWatchdog();
    } finally {
      if (this.armingOperation === operation) this.armingOperation = undefined;
    }
  }

  /** UI must call this on pointer/key down and releasePTT on every corresponding up/cancel. */
  async holdPTT(): Promise<void> {
    this.assertArmed();
    if (this.state.status !== 'armed') throw new Error('Only one manual hold or scheduled send may own PTT.');
    const operation = ++this.operation;
    this.startDeadline();
    this.update({ status: 'pending', source: 'manual', rxConfirmed: null, error: undefined });
    await this.key(operation);
  }

  async releasePTT(): Promise<void> { await this.release(false); }
  async emergencyStop(reason = 'Emergency receive requested.'): Promise<void> { await this.release(true, reason); }
  async disarm(reason = 'Operator disarmed transmit.'): Promise<void> { await this.release(true, reason); }
  async cancelScheduled(): Promise<void> { await this.release(true, 'Scheduled transmission canceled.'); }

  /** Queues exactly one operator-requested send; it never repeats or replies automatically. */
  async scheduleOnce(plan: ScheduledAudioTransmission): Promise<void> {
    this.assertArmed();
    if (this.state.status !== 'armed') throw new Error('A manual hold or scheduled transmission is already active.');
    if (!plan.id || !Number.isFinite(plan.startAtUtcMs) || !Number.isFinite(plan.durationMs) || plan.durationMs <= 0) throw new Error('A scheduled send needs an id, UTC audio boundary, and positive duration.');
    const leadMs = plan.leadMs ?? 350, tailMs = plan.tailMs ?? 150;
    if (!Number.isFinite(leadMs) || leadMs < 100 || leadMs > 2000 || !Number.isFinite(tailMs) || tailMs < 0 || tailMs > 1000) throw new RangeError('CAT lead must be 100–2000 ms and audio tail 0–1000 ms.');
    if (leadMs + plan.durationMs + tailMs > this.state.maximumSeconds * 1000) throw new Error('Scheduled audio plus CAT lead/tail exceeds the armed transmit time limit.');
    const digitalModes = this.radio.getCapabilities().digitalModes;
    if (!digitalModes.includes(this.state.mode)) throw new Error(`Confirm a digital audio mode supported by this driver (${digitalModes.join(', ') || 'none'}) before scheduling. No mode or radio menu is changed automatically.`);
    const untilKey = plan.startAtUtcMs - leadMs - this.wallClock();
    if (untilKey < 100 || untilKey > 120_000) throw new Error('Choose a future audio slot with enough CAT lead, within the next two minutes.');
    this.schedule = { ...plan, leadMs, tailMs };
    this.scheduleClock = this.clock(); this.scheduleWallClock = this.wallClock();
    const operation = ++this.operation;
    this.update({ status: 'scheduled', scheduledAtUtcMs: plan.startAtUtcMs, source: 'scheduled', rxConfirmed: true, error: undefined });
    this.scheduleTimer = this.setTimer(() => {
      this.scheduleTimer = undefined;
      void this.beginScheduled(operation).catch((error: unknown) => {
        if (operation === this.operation) void this.emergencyStop(error instanceof Error ? error.message : 'Scheduled transmission failed.').catch(() => undefined);
      });
    }, untilKey);
  }

  async dispose(): Promise<void> {
    await this.emergencyStop('Transmit controller stopped.').catch(() => undefined);
    this.disposed = true;
    this.removeRadio(); for (const cleanup of this.cleanups) cleanup(); this.cleanups = []; this.listeners.clear();
  }

  private assertArmed(): void {
    if (!this.state.armed || this.disposed || this.document?.hidden) throw new Error('Explicit operator arming is required before transmit.');
    const radio = this.radio.getState();
    const capabilities = this.radio.getCapabilities();
    if (!radio.connected || (!radio.verified && !capabilities.simulated) || !capabilities.ptt || !capabilities.pttReadback || (capabilities.splitReadback && radio.split !== false) || capabilities.simulated !== this.state.simulated || this.radioIdentity(radio) !== this.armedIdentity || radio.frequency !== this.state.frequencyHz || radio.mode !== this.state.mode) throw new Error('Connection, radio capabilities, frequency, mode, or split state changed. Arm again after checking the receiver.');
  }

  private startDeadline(): void {
    this.started = this.clock(); this.deadline = this.started + this.state.maximumSeconds * 1000;
    this.deadlineTimer = this.setTimer(() => { void this.emergencyStop('Maximum transmit duration reached.').catch(() => undefined); }, this.state.maximumSeconds * 1000);
  }

  private async key(operation: number): Promise<void> {
    this.assertArmed();
    const keyBeforeUtcMs = this.schedule ? this.schedule.startAtUtcMs - 75 : undefined;
    this.permit = this.radio.acquireTransmitPermit(() => {
      if (!this.state.armed || operation !== this.operation || this.document?.hidden || this.clock() >= this.deadline) return false;
      try { this.assertArmed(); } catch { return false; }
      if (this.schedule) {
        try { this.assertScheduleClock(); } catch { return false; }
        // Recheck at the actual serialized TX write, not merely when a slot was queued.
        if (keyBeforeUtcMs !== undefined && this.wallClock() >= keyBeforeUtcMs) return false;
      }
      return true;
    }, this.state.maximumSeconds, keyBeforeUtcMs);
    try {
      await this.radio.setPtt(true, this.permit);
      if (operation !== this.operation) return;
      if (this.clock() >= this.deadline) throw new Error('PTT acknowledgement arrived after the transmit deadline.');
      this.update({ status: 'transmitting', rxConfirmed: false });
    } catch (error) {
      if (operation === this.operation) await this.emergencyStop(error instanceof Error ? error.message : 'PTT request failed.').catch(() => undefined);
      throw error;
    }
  }

  private async beginScheduled(operation: number): Promise<void> {
    const plan = this.schedule;
    if (!plan || operation !== this.operation) return;
    this.assertScheduleClock(); this.assertArmed();
    if (this.wallClock() > plan.startAtUtcMs - 75) throw new Error('The scheduled CAT start was late; this slot was canceled.');
    this.startDeadline(); this.update({ status: 'pending', rxConfirmed: null });
    const keyTimer = this.setTimer(() => {
      if (this.keyTimer === keyTimer) this.keyTimer = undefined;
      if (operation === this.operation && this.state.status === 'pending') void this.emergencyStop('Transmit readback missed the key deadline; this slot was canceled.').catch(() => undefined);
    }, Math.max(0, plan.startAtUtcMs - 75 - this.wallClock()));
    this.keyTimer = keyTimer;
    await this.key(operation);
    if (this.keyTimer === keyTimer) { this.clearTimer(keyTimer); this.keyTimer = undefined; }
    if (operation !== this.operation || !this.schedule) return;
    this.assertScheduleClock();
    const untilAudio = plan.startAtUtcMs - this.wallClock();
    if (untilAudio < -100) throw new Error('CAT transmit readback missed the audio boundary; this slot was canceled.');
    this.audioTimer = this.setTimer(() => {
      this.audioTimer = undefined;
      if (operation !== this.operation || !this.schedule) return;
      try {
        this.assertScheduleClock();
        if (this.wallClock() - plan.startAtUtcMs > 100) throw new Error('The audio slot was late; transmission canceled.');
        const started = plan.startAudio();
        this.tailTimer = this.setTimer(() => { if (operation === this.operation) void this.release(true).catch(() => undefined); }, plan.durationMs + (plan.tailMs ?? 150));
        // A slow audio initialization must not resurrect playback after operator cancellation.
        void Promise.resolve(started).then(() => { if (operation !== this.operation) plan.stopAudio(); }).catch((error: unknown) => {
          if (operation === this.operation) void this.emergencyStop(error instanceof Error ? error.message : 'Scheduled audio failed.').catch(() => undefined);
        });
      } catch (error) {
        void this.emergencyStop(error instanceof Error ? error.message : 'Scheduled audio failed.').catch(() => undefined);
      }
    }, Math.max(0, untilAudio));
  }

  private assertScheduleClock(): void {
    const drift = (this.wallClock() - this.scheduleWallClock) - (this.clock() - this.scheduleClock);
    if (Math.abs(drift) > 200) throw new Error('UTC clock changed relative to the monotonic clock. Scheduled transmission canceled; choose a new slot.');
  }

  private async release(disarm: boolean, reason?: string): Promise<void> {
    ++this.operation;
    this.armingOperation = undefined;
    const actualStatus=this.radio.getState().txStatus;
    const mayHaveKeyed = !!this.permit || actualStatus === 'cat-tx' || actualStatus === 'external-tx';
    if (this.permit) this.radio.revokeTransmitPermit(this.permit);
    this.permit = undefined;
    const plan = this.schedule; this.schedule = undefined;
    try { plan?.stopAudio(); } catch { /* Continue radio release even if the audio owner's cleanup fails. */ }
    for (const timer of [this.deadlineTimer, this.scheduleTimer, this.keyTimer, this.audioTimer, this.tailTimer]) if (timer !== undefined) this.clearTimer(timer);
    this.deadlineTimer = this.scheduleTimer = this.keyTimer = this.audioTimer = this.tailTimer = undefined;
    this.started = this.deadline = 0;
    if (disarm) { if (this.watchdog !== undefined) this.clearTimer(this.watchdog); this.watchdog = undefined; }
    this.update({ armed: disarm ? false : this.state.armed, status: mayHaveKeyed ? 'releasing' : disarm ? 'disarmed' : this.state.armed ? 'armed' : 'disarmed', scheduledAtUtcMs: null, source: null, error: reason });
    if (this.releaseInFlight) return this.releaseInFlight;
    if (!mayHaveKeyed) return;
    this.releaseInFlight = (async () => {
      try {
        await this.radio.emergencyReceive();
        this.update({ status: this.state.armed ? 'armed' : 'disarmed', rxConfirmed: true });
      } catch (error) {
        this.update({ armed: false, status: 'fault', rxConfirmed: null, error: `${error instanceof Error ? error.message : 'RX release failed.'} Receive is unconfirmed; use the independent radio failsafe.` });
        throw error;
      } finally { this.releaseInFlight = undefined; }
    })();
    return this.releaseInFlight;
  }

  private observeRadio(radio: RadioState): void {
    if (!this.state.armed) return;
    const capabilities = this.radio.getCapabilities();
    if (!radio.connected || (!radio.verified && !capabilities.simulated) || !capabilities.ptt || !capabilities.pttReadback || (capabilities.splitReadback && radio.split !== false) || capabilities.simulated !== this.state.simulated || this.radioIdentity(radio) !== this.armedIdentity || radio.frequency !== this.state.frequencyHz || radio.mode !== this.state.mode) {
      void this.emergencyStop('Radio identity, capabilities, frequency, mode, or split state changed; transmit was disarmed.').catch(() => undefined);
    } else if (radio.txStatus === 'external-tx' || radio.txStatus === 'unknown') {
      void this.emergencyStop('External or unconfirmed transmit state detected. Release physical PTT/VOX/keying.').catch(() => undefined);
    } else if (radio.txStatus === 'cat-tx' && this.state.status === 'armed') {
      void this.emergencyStop('Unexpected CAT transmit detected while no hold was active.').catch(() => undefined);
    }
  }

  private radioIdentity(radio: RadioState): string {
    return JSON.stringify([radio.driver, radio.model, radio.identitySource]);
  }

  private startWatchdog(): void {
    if (this.watchdog !== undefined) this.clearTimer(this.watchdog);
    const check = () => {
      this.watchdog = undefined;
      if (!this.state.armed || this.disposed) return;
      if (this.document?.hidden || (this.deadline && this.clock() >= this.deadline)) {
        void this.emergencyStop(this.document?.hidden ? 'Page hidden; transmit canceled.' : 'Transmit watchdog deadline reached.').catch(() => undefined); return;
      }
      try { if (this.schedule) this.assertScheduleClock(); } catch (error) {
        void this.emergencyStop(error instanceof Error ? error.message : 'Schedule clock failed.').catch(() => undefined); return;
      }
      if (!this.querying && this.state.status !== 'releasing') {
        this.querying = true;
        const operation = this.operation;
        void this.radio.readTransmitStatus().then((status) => {
          if (operation === this.operation && this.state.status === 'transmitting' && status !== 'cat-tx') return this.emergencyStop('Transmit watchdog did not confirm CAT transmit.');
        }).catch((error: unknown) => {
          if (this.state.armed) return this.emergencyStop(error instanceof Error ? error.message : 'Transmit status readback failed.');
        }).finally(() => { this.querying = false; });
      }
      this.update({ elapsedMs: this.deadline ? Math.max(0, this.clock() - this.started) : 0 });
      if (this.state.armed) this.watchdog = this.setTimer(check, this.watchdogMs);
    };
    this.watchdog = this.setTimer(check, this.watchdogMs);
  }

  private bind(target: EventTarget, name: string, listener: EventListener): void {
    target.addEventListener(name, listener); this.cleanups.push(() => target.removeEventListener(name, listener));
  }

  private update(patch: Partial<TxState>): void {
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(this.getState());
  }
}

export { TransmitController as SafetyCoordinator };
