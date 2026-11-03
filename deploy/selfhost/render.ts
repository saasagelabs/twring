/**
 * Fills the installer's `{{NAME}}` placeholders, the same substitution `install.sh` does with sed.
 * Values must be single tokens (an address, a URL, a port, an image reference): anything with
 * whitespace or a quote could break out of its YAML or Caddyfile line, so it is refused.
 */
export function render(template: string, values: Readonly<Record<string, string>>): string {
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Za-z0-9._:/@,-]+$/.test(value)) throw new Error(`unsafe value for ${name}`);
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`no value for {{${name}}}`);
    return value;
  });
}

/**
 * Twring call audio behind Caddy: drops every block from a line that is only `# own-audio:begin`
 * to the next line that is only `# own-audio:end` (the LiveKit service and address), as `install.sh` does with
 * `sed '/^[[:space:]]*# own-audio:begin$/,/^[[:space:]]*# own-audio:end$/d'`.
 */
export function stripOwnAudio(template: string): string {
  return template.replace(/^[ \t]*# own-audio:begin\n[\s\S]*?^[ \t]*# own-audio:end\n/gm, '');
}
