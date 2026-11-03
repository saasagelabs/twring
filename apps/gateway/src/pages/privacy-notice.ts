import { renderMarkdown } from './markdown';

/** Where the public notice ends in docs/PRIVACY.md: what follows answers store forms. */
const NOTICE_END = '\n## Google Play Data safety answers';

/** The /privacy page body: docs/PRIVACY.md up to the store answers, rendered. */
export function renderPrivacyNotice(doc: string): string {
  const end = doc.indexOf(NOTICE_END);
  return renderMarkdown(end === -1 ? doc : doc.slice(0, end));
}
