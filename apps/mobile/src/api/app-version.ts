/** The parts of the app config that name a build (expo-constants `expoConfig`). */
export interface VersionConfig {
  version?: string;
  android?: { versionCode?: number };
  ios?: { buildNumber?: string };
}

/**
 * "0.1.0 (12) android": sent as `x-app-version` so ratings and notes say which build they came
 * from. The build number is left out when the config does not carry it.
 */
export function appVersionLabel(config: VersionConfig | null | undefined, os: string): string {
  const build = os === 'android' ? config?.android?.versionCode : config?.ios?.buildNumber;
  const version = config?.version ?? 'unknown';
  return build !== undefined ? `${version} (${String(build)}) ${os}` : `${version} ${os}`;
}
