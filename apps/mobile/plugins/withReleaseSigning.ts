import { withAppBuildGradle, type ConfigPlugin } from 'expo/config-plugins.js'; // .js: Node loads this file natively (type stripping)

/**
 * Signs production release builds with Twring's upload key (Twring's operations notes, private), read from the
 * environment (or `-P` Gradle properties) at build time. Values are never written into the
 * generated android/ files; only the variable names are.
 *
 * Fails closed: if any release task is scheduled while a value is missing, or the keystore file
 * does not exist, Gradle stops with the names of what is missing. It never falls back to the
 * debug key. Only applied for APP_VARIANT=production; staging and dev keep debug signing.
 */
export const UPLOAD_KEY_VARIABLES = [
  'CORD_UPLOAD_STORE_FILE',
  'CORD_UPLOAD_STORE_PASSWORD',
  'CORD_UPLOAD_KEY_ALIAS',
  'CORD_UPLOAD_KEY_PASSWORD',
] as const;

const MARKER = '// CORD release signing (plugins/withReleaseSigning.ts)';

const HELPER = `${MARKER}
def twringSigningValue = { String name -> System.getenv(name) ?: project.findProperty(name) }
def twringUploadKeyVariables = [${UPLOAD_KEY_VARIABLES.map((v) => `'${v}'`).join(', ')}]

`;

const RELEASE_SIGNING_CONFIG = `
        release {
            // Upload key from the environment; see Twring's operations notes (private). Never commit values here.
            if (twringSigningValue('CORD_UPLOAD_STORE_FILE')) {
                storeFile file(twringSigningValue('CORD_UPLOAD_STORE_FILE'))
                storePassword twringSigningValue('CORD_UPLOAD_STORE_PASSWORD')
                keyAlias twringSigningValue('CORD_UPLOAD_KEY_ALIAS')
                keyPassword twringSigningValue('CORD_UPLOAD_KEY_PASSWORD')
            }
        }`;

const FAIL_CLOSED_CHECK = `
${MARKER}: a release build must never fall back to the debug key.
gradle.taskGraph.whenReady { graph ->
    def releaseScheduled = graph.allTasks.any { it.project == project && it.name.contains('Release') }
    if (!releaseScheduled) return
    def missing = twringUploadKeyVariables.findAll { !twringSigningValue(it) }
    if (!missing.isEmpty()) {
        throw new GradleException("CORD release signing: missing \${missing.join(', ')}. " +
            "Set them to the upload keystore and its passwords (Twring's operations notes, private). " +
            "Production release builds never use the debug key.")
    }
    if (!file(twringSigningValue('CORD_UPLOAD_STORE_FILE')).isFile()) {
        throw new GradleException("CORD release signing: CORD_UPLOAD_STORE_FILE does not point to a file.")
    }
}
`;

/** Pure transform of android/app/build.gradle; exported for tests. Throws if the template moved. */
export function applyReleaseSigning(contents: string): string {
  if (contents.includes(MARKER)) return contents;

  const androidBlock = /^android \{/m;
  if (!androidBlock.test(contents)) throw anchorError('android {');
  let out = contents.replace(androidBlock, `${HELPER}android {`);

  const debugSigning = /(signingConfigs \{\n\s+debug \{[^}]*\})/;
  if (!debugSigning.test(out)) throw anchorError('signingConfigs { debug { ... } }');
  out = out.replace(debugSigning, `$1${RELEASE_SIGNING_CONFIG}`);

  const releaseBuildType = /(\n\s+release \{[^}]*?signingConfig )signingConfigs\.debug/;
  if (!releaseBuildType.test(out))
    throw anchorError('buildTypes { release { signingConfig ... } }');
  out = out.replace(releaseBuildType, '$1signingConfigs.release');

  return `${out.trimEnd()}\n${FAIL_CLOSED_CHECK}`;
}

function anchorError(anchor: string): Error {
  return new Error(
    `withReleaseSigning: could not find "${anchor}" in android/app/build.gradle. ` +
      'The Expo template changed; update plugins/withReleaseSigning.ts.',
  );
}

const withReleaseSigning: ConfigPlugin = (config) =>
  withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') {
      throw new Error('withReleaseSigning: expected a Groovy android/app/build.gradle.');
    }
    mod.modResults.contents = applyReleaseSigning(mod.modResults.contents);
    return mod;
  });

export default withReleaseSigning;
