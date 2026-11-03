/**
 * The small Markdown subset docs/PRIVACY.md uses, rendered to HTML at build time for the public
 * /privacy page: headings, paragraphs (a trailing `\` is a line break), `>` quotes, `-` lists,
 * pipe tables, `**bold**`, and `` `code` ``. Everything else is escaped text; no raw HTML passes.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

function paragraph(lines: readonly string[]): string {
  const html = lines
    .map((line, i) => {
      const hardBreak = line.endsWith('\\') && i < lines.length - 1;
      return inline(hardBreak ? line.slice(0, -1) : line) + (hardBreak ? '<br>' : '');
    })
    .join('\n');
  return `<p>${html}</p>`;
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  const take = (test: (line: string) => boolean): string[] => {
    const block: string[] = [];
    while (i < lines.length && test(lines[i]!)) block.push(lines[i++]!);
    return block;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (line.trim() === '') {
      i++;
    } else if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i++;
    } else if (line.startsWith('>')) {
      const quote = take((l) => l.startsWith('>')).map((l) => l.replace(/^> ?/, ''));
      out.push(`<blockquote>${paragraph(quote)}</blockquote>`);
    } else if (line.startsWith('- ')) {
      const items = take((l) => l.startsWith('- ')).map((l) => `<li>${inline(l.slice(2))}</li>`);
      out.push(`<ul>\n${items.join('\n')}\n</ul>`);
    } else if (line.startsWith('|')) {
      const rows = take((l) => l.startsWith('|'));
      const [head, , ...body] = rows;
      const th = cells(head!)
        .map((c) => `<th scope="col">${inline(c)}</th>`)
        .join('');
      const trs = body.map(
        (r) =>
          `<tr>${cells(r)
            .map((c) => `<td>${inline(c)}</td>`)
            .join('')}</tr>`,
      );
      out.push(
        `<div class="table"><table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${trs.join('\n')}\n</tbody>\n</table></div>`,
      );
    } else {
      // The first line always belongs to this paragraph (e.g. `#tag`, which is not a heading).
      i++;
      const rest = take((l) => l.trim() !== '' && !/^(#{1,3} |>|- |\|)/.test(l));
      out.push(paragraph([line, ...rest]));
    }
  }
  return `${out.join('\n')}\n`;
}
