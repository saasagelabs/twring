/// <reference types="node" />
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IOSConfig } from 'expo/config-plugins.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  addExtensionTarget,
  appKeychainGroups,
  NSE_TARGET,
  nseBundleId,
  writeExtensionFiles,
} from './withNotificationService.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'twring-nse-'));
  dirs.push(dir);
  return dir;
}

/** A trimmed copy of the app's generated project: one app target, Debug and Release. */
interface TestProject {
  writeSync(): string;
  pbxNativeTargetSection(): Record<string, unknown>;
  pbxXCBuildConfigurationSection(): Record<string, unknown>;
}

function loadProject(): TestProject {
  const root = tempDir();
  mkdirSync(join(root, 'ios', 'Twring.xcodeproj'), { recursive: true });
  cpSync(
    join(import.meta.dirname, '__fixtures__', 'app.pbxproj'),
    join(root, 'ios', 'Twring.xcodeproj', 'project.pbxproj'),
  );
  const project: unknown = IOSConfig.XcodeUtils.getPbxproj(root);
  return project as TestProject;
}

type Settings = Record<string, string>;
const extensionSettings = (project: TestProject): Settings[] =>
  Object.values(project.pbxXCBuildConfigurationSection())
    .filter(
      (entry): entry is { buildSettings: Settings } =>
        typeof entry === 'object' &&
        (entry as { buildSettings?: Settings }).buildSettings?.PRODUCT_NAME === `"${NSE_TARGET}"`,
    )
    .map((entry) => entry.buildSettings);

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('addExtensionTarget', () => {
  it('adds the notification service once, embedded in the app with a dependency', () => {
    const project = loadProject();
    addExtensionTarget(project, 'com.twring.app');
    const once = project.writeSync();
    addExtensionTarget(project, 'com.twring.app');
    expect(project.writeSync()).toBe(once);

    const targets = Object.values(project.pbxNativeTargetSection()).filter(
      (t) =>
        typeof t === 'object' && (t as { name?: string }).name?.replaceAll('"', '') === NSE_TARGET,
    );
    expect(targets).toHaveLength(1);
    expect(once).toContain('com.apple.product-type.app-extension');
    expect(once).toContain(`${NSE_TARGET}.appex in Copy Files`);
    expect(once).toMatch(/PBXTargetDependency/);
    expect(once).toContain('NotificationService.swift in Sources');
    expect(once).toContain('CordSeal.swift in Sources');
  });

  it('matches the app target: bundle id, deployment target, Swift version and team', () => {
    const project = loadProject();
    addExtensionTarget(project, 'com.twring.app');
    const settings = extensionSettings(project);
    expect(settings).toHaveLength(2);
    for (const s of settings) {
      expect(s.PRODUCT_BUNDLE_IDENTIFIER).toContain('com.twring.app.NotificationService');
      expect(s.IPHONEOS_DEPLOYMENT_TARGET).toBe('16.4');
      expect(s.SWIFT_VERSION).toBe('5.0');
      expect(s.INFOPLIST_FILE).toBe(`${NSE_TARGET}/${NSE_TARGET}-Info.plist`);
      expect(s.CODE_SIGN_ENTITLEMENTS).toBe(`${NSE_TARGET}/${NSE_TARGET}.entitlements`);
    }
    expect(settings.map((s) => s.DEVELOPMENT_TEAM).sort()).toEqual(['TEAM123456', undefined]);
  });
});

describe('bundle ids and keychain groups', () => {
  it.each([
    ['com.twring.app', 'com.twring.app.NotificationService'],
    ['com.twring.app.staging', 'com.twring.app.staging.NotificationService'],
    ['com.twring.app.dev', 'com.twring.app.dev.NotificationService'],
  ])('%s gets extension %s', (app, extension) => {
    expect(nseBundleId(app)).toBe(extension);
  });

  it("puts the app's own group first, so every other keychain write keeps its place", () => {
    expect(appKeychainGroups('com.twring.app')).toEqual([
      '$(AppIdentifierPrefix)com.twring.app',
      '$(AppIdentifierPrefix)com.twring.app.shared',
    ]);
  });
});

describe('writeExtensionFiles', () => {
  it('copies the sources, CordSeal from the module, and fills the plists', () => {
    const ios = tempDir();
    writeExtensionFiles(ios, { appId: 'com.twring.app', version: '0.1.0', buildNumber: '42' });
    const dir = join(ios, NSE_TARGET);
    const read = (name: string) => readFileSync(join(dir, name), 'utf8');

    expect(read('CordSeal.swift')).toBe(
      readFileSync(
        join(import.meta.dirname, '..', 'modules', 'cord-call-service', 'ios', 'CordSeal.swift'),
        'utf8',
      ),
    );
    expect(read('NotificationService.swift')).toContain('class NotificationService');

    const info = read(`${NSE_TARGET}-Info.plist`);
    expect(info).toContain('com.apple.usernotifications.service');
    expect(info).toContain('<string>0.1.0</string>');
    expect(info).toContain('<string>42</string>');
    expect(info).toContain('<key>TwringKeychainGroup</key>');
    expect(info).toContain('$(AppIdentifierPrefix)com.twring.app.shared');
    expect(info).not.toContain('{{');

    const entitlements = read(`${NSE_TARGET}.entitlements`);
    expect(entitlements.match(/<string>/g)).toHaveLength(1);
    expect(entitlements).toContain('$(AppIdentifierPrefix)com.twring.app.shared');
  });
});

describe('CordSeal.swift compiles alone in the extension', () => {
  it('uses no module-only types', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'modules', 'cord-call-service', 'ios', 'CordSeal.swift'),
      'utf8',
    );
    const imports = source.match(/^import \w+/gm);
    expect(imports).toEqual(['import CryptoKit', 'import Foundation', 'import Security']);
    expect(source).not.toMatch(/CordRing\.|ExpoModulesCore|UIApplication/);
  });
});
