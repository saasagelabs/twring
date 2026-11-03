import { describe, expect, it } from 'vitest';

import { applyReleaseSigning, UPLOAD_KEY_VARIABLES } from './withReleaseSigning.ts';

// Trimmed copy of the Expo SDK 57 template's android/app/build.gradle around the parts we edit.
const TEMPLATE = `apply plugin: "com.android.application"

android {
    defaultConfig {
        versionCode 1
    }
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'
        }
    }
}

dependencies {
}
`;

describe('applyReleaseSigning', () => {
  const out = applyReleaseSigning(TEMPLATE);

  it('signs the release build type with the release config, keeps debug on debug', () => {
    expect(out).toMatch(
      /release \{\n\s+\/\/ Caution![^\n]*\n\s+signingConfig signingConfigs\.release/,
    );
    expect(out).toMatch(/debug \{\n\s+signingConfig signingConfigs\.debug/);
    expect(out.match(/signingConfig signingConfigs\.debug/g)).toHaveLength(1);
  });

  it('reads every upload key value from the environment by name only', () => {
    for (const name of UPLOAD_KEY_VARIABLES) expect(out).toContain(`'${name}'`);
    expect(out).toContain('System.getenv(name)');
  });

  it('fails closed when release tasks run without the key', () => {
    expect(out).toContain('gradle.taskGraph.whenReady');
    expect(out).toContain('throw new GradleException("CORD release signing: missing');
  });

  it('is idempotent', () => {
    expect(applyReleaseSigning(out)).toBe(out);
  });

  it('never embeds signing values, even when they are set while prebuild runs', () => {
    const sentinels: Record<string, string> = {
      CORD_UPLOAD_STORE_FILE: '/secret/path/upload.p12',
      CORD_UPLOAD_STORE_PASSWORD: "pw'); println('pwned",
      CORD_UPLOAD_KEY_ALIAS: 'alias-sentinel',
      CORD_UPLOAD_KEY_PASSWORD: '${System.exit(1)}',
    };
    const saved = { ...process.env };
    Object.assign(process.env, sentinels);
    try {
      const signed = applyReleaseSigning(TEMPLATE);
      for (const value of Object.values(sentinels)) expect(signed).not.toContain(value);
    } finally {
      process.env = saved;
    }
    // Only fixed, plain variable names reach the Groovy source.
    for (const name of UPLOAD_KEY_VARIABLES) expect(name).toMatch(/^CORD_UPLOAD_[A-Z_]+$/);
  });

  it('leaves no path from a release build to the debug key', () => {
    const buildTypes = out.slice(out.indexOf('buildTypes {'));
    const release = buildTypes.slice(buildTypes.indexOf('release {'));
    const releaseBlock = release.slice(0, release.indexOf('}'));
    expect(releaseBlock).toContain('signingConfig signingConfigs.release');
    expect(releaseBlock).not.toContain('debug');
    const releaseSigning = out.slice(
      out.indexOf('        release {\n            // Upload key'),
      out.indexOf('    buildTypes {'),
    );
    expect(releaseSigning).not.toMatch(/debug\.keystore|'android'|signingConfigs\.debug/);
    // The guard runs whenever any release task is scheduled, and checks every value.
    const guard = out.slice(out.indexOf('gradle.taskGraph.whenReady'));
    expect(guard).toContain("it.name.contains('Release')");
    expect(guard).toContain('twringUploadKeyVariables.findAll { !twringSigningValue(it) }');
    expect(guard).toContain('.isFile()');
    // Top level, after the android block (not inside a closure that might never run).
    expect(out.indexOf('gradle.taskGraph.whenReady')).toBeGreaterThan(
      out.indexOf('dependencies {'),
    );
  });

  it('works on the full Expo template, including its comment lines', () => {
    const full = TEMPLATE.replace(
      '// Caution! In production, you need to generate your own keystore file.',
      '// Caution! In production, you need to generate your own keystore file.\n' +
        '            // see https://reactnative.dev/docs/signed-apk-android.',
    ).replace(
      "def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'",
      "def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'\n" +
        '            shrinkResources enableShrinkResources.toBoolean()\n' +
        '            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"',
    );
    const signed = applyReleaseSigning(full);
    expect(signed.match(/signingConfig signingConfigs\.release/g)).toHaveLength(1);
    expect(signed.match(/signingConfig signingConfigs\.debug/g)).toHaveLength(1);
  });

  it('fails closed on a template it does not recognise instead of skipping signing', () => {
    // Windows line endings, or the release build type moved: never silently unsigned.
    expect(() => applyReleaseSigning(TEMPLATE.replace(/\n/g, '\r\n'))).toThrow(/Expo template/);
    expect(() =>
      applyReleaseSigning(
        TEMPLATE.replace('release {\n            // Caution!', 'staging {\n  //'),
      ),
    ).toThrow(/buildTypes/);
  });

  it('throws when the template no longer has the expected anchors', () => {
    expect(() => applyReleaseSigning('android {\n}\n')).toThrow(/signingConfigs/);
    expect(() =>
      applyReleaseSigning(
        TEMPLATE.replace('signingConfig signingConfigs.debug\n            def', 'def'),
      ),
    ).toThrow(/buildTypes/);
  });
});
