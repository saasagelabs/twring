/**
 * Downlink (gateway → phone) audio quality from WebRTC receiver stats. Pure so it is testable;
 * the transport samples cumulative counters and this turns two samples into one window.
 */
export interface ReceiverSample {
  at: number;
  /** React Native WebRTC reports bytes but not packets received. */
  bytesReceived?: number;
  packetsLost?: number;
  jitter?: number;
  /** Cumulative sum of squared normalized sample amplitude × duration (WebRTC totalAudioEnergy). */
  totalAudioEnergy?: number;
  totalSamplesDuration?: number;
  concealedSamples?: number;
}

export interface DownlinkWindow {
  window_ms: number;
  bytes_received: number;
  packets_lost: number;
  jitter_ms: number;
  /** Mean level of audio actually played from the gateway track; -120 when silent. */
  level_dbfs: number;
}

const SILENT_DBFS = -120;

function delta(current: number | undefined, previous: number | undefined): number {
  return Math.max(0, (current ?? 0) - (previous ?? 0));
}

export function downlinkWindow(previous: ReceiverSample, current: ReceiverSample): DownlinkWindow {
  const energy = delta(current.totalAudioEnergy, previous.totalAudioEnergy);
  const duration = delta(current.totalSamplesDuration, previous.totalSamplesDuration);
  const meanPower = duration > 0 ? energy / duration : 0;
  const level = meanPower > 0 ? Math.max(SILENT_DBFS, 10 * Math.log10(meanPower)) : SILENT_DBFS;
  return {
    window_ms: Math.round(current.at - previous.at),
    bytes_received: delta(current.bytesReceived, previous.bytesReceived),
    packets_lost: delta(current.packetsLost, previous.packetsLost),
    jitter_ms: Math.round((current.jitter ?? 0) * 1000),
    level_dbfs: Math.round(level * 10) / 10,
  };
}
