import { getSerialApi, type BrowserCapability, type DeviceDescriptor } from './types.ts';

export type { DeviceDescriptor, BrowserCapability } from './types.ts';

/** Feature detection only. This never asks permission, opens, or probes a device. */
export function detectCapabilities(): BrowserCapability[] {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const secure = typeof isSecureContext !== 'undefined' && isSecureContext;
  const scope = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  return [
    { id: 'serial', label: 'Web Serial · CAT', supported: secure && !!getSerialApi(), detail: 'Choose one CAT port in a supporting browser on localhost or HTTPS. No device is opened automatically.' },
    { id: 'audio', label: 'Audio input', supported: secure && !!nav?.mediaDevices?.getUserMedia, detail: 'Microphone or USB audio permission is requested only when you select live input.' },
    { id: 'web-audio', label: 'Web Audio · DSP', supported: !!(scope.AudioContext || scope.webkitAudioContext), detail: 'Local FFT analysis, receive filtering, and practice tones.' },
    { id: 'hid', label: 'WebHID', supported: secure && !!nav && 'hid' in nav, detail: 'Browser API detected. RadioDesk has no verified HID radio driver.' },
    { id: 'usb', label: 'WebUSB', supported: secure && !!nav && 'usb' in nav, detail: 'Browser API detected; direct USB capture is not implemented. RTL-SDR reception uses the local rtl_tcp bridge in the SDR workspace.' },
    { id: 'bluetooth', label: 'Web Bluetooth', supported: secure && !!nav && 'bluetooth' in nav, detail: 'Browser API detected. No Bluetooth radio profile is implemented.' },
    { id: 'storage', label: 'Local station storage', supported: hasStorage(), detail: 'Station data remains in this browser; export a backup for portability.' },
  ];
}

function hasStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

/** Lists browser-visible audio devices. Does not trigger getUserMedia or start capture. */
export async function discoverAudioDevices(): Promise<DeviceDescriptor[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'audioinput' || device.kind === 'audiooutput').map((device, index) => ({
    id: device.deviceId,
    label: device.label || `${device.kind === 'audioinput' ? 'Audio input' : 'Audio output'} ${index + 1} · permission required for name`,
    kind: device.kind as 'audioinput' | 'audiooutput',
    groupId: device.groupId,
    permission: device.label ? 'granted' : 'unknown',
    detail: device.label ? 'Visible to this browser. Select explicitly before capture.' : 'The browser hides names until audio permission is granted.',
  }));
}

/** Previously authorized ports only; no requests, opening, or identification probes. */
export async function discoverAuthorizedSerialDevices(): Promise<DeviceDescriptor[]> {
  const serial = getSerialApi();
  if (!serial) return [];
  return (await serial.getPorts()).map((port, index) => {
    const info = port.getInfo();
    const vendor = info.usbVendorId?.toString(16).padStart(4, '0');
    const product = info.usbProductId?.toString(16).padStart(4, '0');
    return {
      id: `authorized-serial-${index}`,
      label: `Authorized serial port ${index + 1}${vendor ? ` · USB ${vendor}:${product || 'unknown'}` : ''}`,
      kind: 'serial',
      permission: 'granted',
      detail: 'USB identifiers do not prove radio model or CAT interface. Use the browser chooser and verify with the selected driver.',
    };
  });
}
