/// <reference types="node" />
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
  type ConfigPlugin,
} from 'expo/config-plugins.js'; // .js: Node loads this file natively (type stripping)

/**
 * Sealed message previews on iPhone (C3 #10 B2): a Notification Service Extension opens the
 * sealed push and shows the agent's name and first line; Apple carries only ciphertext. The
 * extension and the app share one keychain group for the seal keys. Target creation follows
 * OneSignal's onesignal-expo-plugin (MIT), without depending on it.
 */
export const NSE_TARGET = 'TwringNotificationService';
export const NSE_SWIFT = ['NotificationService.swift', 'CordSeal.swift'] as const;
const NSE_INFO_PLIST = `${NSE_TARGET}-Info.plist`;
const NSE_ENTITLEMENTS = `${NSE_TARGET}.entitlements`;
/** Read by CordSealKeys (modules/cord-call-service/ios/CordSeal.swift). */
export const KEYCHAIN_GROUP_KEY = 'TwringKeychainGroup';

const SOURCES = join(import.meta.dirname, 'notification-service');
const CORD_SEAL = join(
  import.meta.dirname,
  '..',
  'modules',
  'cord-call-service',
  'ios',
  'CordSeal.swift',
);

export const nseBundleId = (appId: string) => `${appId}.NotificationService`;
export const sharedGroup = (appId: string) => `${appId}.shared`;

/**
 * The app's own group stays first: it is the default for every other keychain write
 * (expo-secure-store, the sign-in session), so those keep their current place.
 */
export function appKeychainGroups(appId: string): string[] {
  return [`$(AppIdentifierPrefix)${appId}`, `$(AppIdentifierPrefix)${sharedGroup(appId)}`];
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`withNotificationService: no value for ${match}`);
    return value;
  });
}

/** Writes the extension's sources into ios/<target>/ (CordSeal.swift from the module: one source). */
export function writeExtensionFiles(
  iosRoot: string,
  values: { appId: string; version: string; buildNumber: string },
): void {
  const dir = join(iosRoot, NSE_TARGET);
  mkdirSync(dir, { recursive: true });
  const fields = {
    VERSION: values.version,
    BUILD_NUMBER: values.buildNumber,
    KEYCHAIN_GROUP: sharedGroup(values.appId),
  };
  copyFileSync(join(SOURCES, 'NotificationService.swift'), join(dir, 'NotificationService.swift'));
  copyFileSync(CORD_SEAL, join(dir, 'CordSeal.swift'));
  writeFileSync(
    join(dir, NSE_INFO_PLIST),
    fill(readFileSync(join(SOURCES, 'Info.plist'), 'utf8'), fields),
  );
  writeFileSync(
    join(dir, NSE_ENTITLEMENTS),
    fill(readFileSync(join(SOURCES, 'NotificationService.entitlements'), 'utf8'), fields),
  );
}

type BuildSettings = Record<string, string | undefined>;
type Section = Record<string, { buildSettings?: BuildSettings; name?: string } | string>;

/** The parts of the xcode library's project this plugin uses (its own types are not shipped). */
interface Pbx {
  hash: { project: { objects: Record<string, unknown> } };
  getFirstTarget(): { firstTarget: unknown };
  pbxXCConfigurationList(): unknown;
  pbxXCBuildConfigurationSection(): unknown;
  pbxTargetByName(name: string): unknown;
  addPbxGroup(files: string[], name: string, path: string): { uuid: string };
  addToPbxGroup(groupKey: string, parentKey: string): void;
  addTarget(name: string, type: string, subfolder: string, bundleId: string): { uuid: string };
  addBuildPhase(files: string[], type: string, comment: string, target: string): unknown;
}

/** The app target's settings for one configuration name (Debug, Release). */
function appSettings(project: Pbx, configName: string | undefined): BuildSettings {
  const app = project.getFirstTarget().firstTarget as { buildConfigurationList: string };
  const lists = project.pbxXCConfigurationList() as Record<
    string,
    { buildConfigurations?: { value: string }[] }
  >;
  const section = project.pbxXCBuildConfigurationSection() as Section;
  for (const { value } of lists[app.buildConfigurationList]?.buildConfigurations ?? []) {
    const entry = section[value];
    if (typeof entry === 'object' && entry.name === configName) return entry.buildSettings ?? {};
  }
  return {};
}

/** Adds the extension target once: embedded in the app, with a target dependency. */
export function addExtensionTarget(xcodeProject: object, appId: string): void {
  const project = xcodeProject as unknown as Pbx;
  // addTarget stores the name quoted.
  if (project.pbxTargetByName(NSE_TARGET) ?? project.pbxTargetByName(`"${NSE_TARGET}"`)) return;
  const files = [...NSE_SWIFT, NSE_INFO_PLIST, NSE_ENTITLEMENTS];
  const group = project.addPbxGroup(files, NSE_TARGET, NSE_TARGET);
  const objects = project.hash.project.objects;
  const groups = objects.PBXGroup as Record<string, unknown>;
  for (const [key, value] of Object.entries(groups)) {
    const entry = value as { name?: string; path?: string };
    // The main group: the only one with neither a name nor a path.
    if (typeof value === 'object' && entry.name === undefined && entry.path === undefined) {
      project.addToPbxGroup(group.uuid, key);
    }
  }
  // The xcode library's addTarget fails on projects without these sections (OneSignal's fix).
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};

  const target = project.addTarget(NSE_TARGET, 'app_extension', NSE_TARGET, nseBundleId(appId));
  project.addBuildPhase([...NSE_SWIFT], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
  project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);

  const section = project.pbxXCBuildConfigurationSection() as Section;
  for (const entry of Object.values(section)) {
    if (typeof entry !== 'object' || entry.buildSettings?.PRODUCT_NAME !== `"${NSE_TARGET}"`)
      continue;
    const app = appSettings(project, entry.name);
    const settings = entry.buildSettings;
    settings.INFOPLIST_FILE = `${NSE_TARGET}/${NSE_INFO_PLIST}`;
    settings.CODE_SIGN_ENTITLEMENTS = `${NSE_TARGET}/${NSE_ENTITLEMENTS}`;
    settings.CODE_SIGN_STYLE = 'Automatic';
    settings.GENERATE_INFOPLIST_FILE = 'NO';
    settings.SKIP_INSTALL = 'YES';
    settings.TARGETED_DEVICE_FAMILY = app.TARGETED_DEVICE_FAMILY ?? '1';
    settings.SWIFT_VERSION = app.SWIFT_VERSION ?? '5.0';
    if (app.IPHONEOS_DEPLOYMENT_TARGET !== undefined) {
      settings.IPHONEOS_DEPLOYMENT_TARGET = app.IPHONEOS_DEPLOYMENT_TARGET;
    }
    if (app.DEVELOPMENT_TEAM !== undefined) settings.DEVELOPMENT_TEAM = app.DEVELOPMENT_TEAM;
  }
}

const withNotificationService: ConfigPlugin = (config) => {
  const appId = config.ios?.bundleIdentifier;
  if (appId === undefined)
    throw new Error('withNotificationService: ios.bundleIdentifier is required');
  let next = withInfoPlist(config, (mod) => {
    mod.modResults[KEYCHAIN_GROUP_KEY] = `$(AppIdentifierPrefix)${sharedGroup(appId)}`;
    return mod;
  });
  next = withEntitlementsPlist(next, (mod) => {
    const existing = (mod.modResults['keychain-access-groups'] as string[] | undefined) ?? [];
    const groups = appKeychainGroups(appId);
    mod.modResults['keychain-access-groups'] = [
      ...groups,
      ...existing.filter((group) => !groups.includes(group)),
    ];
    return mod;
  });
  next = withDangerousMod(next, [
    'ios',
    (mod) => {
      writeExtensionFiles(mod.modRequest.platformProjectRoot, {
        appId,
        version: mod.version ?? '1.0.0',
        buildNumber: mod.ios?.buildNumber ?? '1',
      });
      return mod;
    },
  ]);
  return withXcodeProject(next, (mod) => {
    addExtensionTarget(mod.modResults as object, appId);
    return mod;
  });
};

export default withNotificationService;
