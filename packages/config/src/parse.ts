import type { z } from 'zod';

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Invalid configuration. Carries variable names and reasons only, never values, which may be secrets. */
export class ConfigError extends Error {
  readonly code = 'config_invalid';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Treat unset and empty-string variables the same, so `FOO=` in a .env file means "not provided". */
export function withoutEmptyValues(source: EnvSource): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') {
      result[key] = value;
    }
  }
  return result;
}

export function parseEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  source: EnvSource,
): z.infer<TSchema> {
  const result = schema.safeParse(withoutEmptyValues(source));
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${key}: ${issue.message}`;
      }),
    );
  }
  return result.data;
}
