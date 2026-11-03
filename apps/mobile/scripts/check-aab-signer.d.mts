/** Why the signer in `keytool -printcert` output is not acceptable; undefined when it is. */
export function signerProblem(printcert: string, expectedSha256?: string): string | undefined;
