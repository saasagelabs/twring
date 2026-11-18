// Checks the static site's search data: the home page's structured data must parse, and its FAQ
// must say exactly what the visible FAQ says (search and answer engines quote it).
import { readFileSync } from 'node:fs';

const home = readFileSync('apps/site/index.html', 'utf8');
const unent = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const plain = (html) =>
  unent(
    html
      .replace(/<\/(p|li)>/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );

const fail = (message) => {
  console.error(`check-site: ${message}`);
  process.exit(1);
};

const blocks = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
if (blocks.length !== 1)
  fail(`expected one structured data block on the home page, found ${blocks.length}.`);
let data;
try {
  data = JSON.parse(blocks[0][1]);
} catch (error) {
  fail(`the home page structured data is not valid JSON: ${error.message}`);
}
const faqPage = (data['@graph'] ?? []).find((node) => node['@type'] === 'FAQPage');
if (!faqPage) fail('the home page structured data has no FAQPage.');

const visible = [
  ...home.matchAll(
    /<details><summary>([^<]*)<svg[\s\S]*?<\/summary><div>([\s\S]*?)<\/div><\/details>/g,
  ),
].map(([, question, answer]) => ({ question: unent(question.trim()), answer: plain(answer) }));
const listed = faqPage.mainEntity.map((q) => ({ question: q.name, answer: q.acceptedAnswer.text }));
if (visible.length === 0) fail('found no FAQ on the home page.');
if (JSON.stringify(visible) !== JSON.stringify(listed)) {
  for (let i = 0; i < Math.max(visible.length, listed.length); i++) {
    if (JSON.stringify(visible[i]) !== JSON.stringify(listed[i])) {
      fail(
        `FAQ ${i + 1} differs.\n  page: ${JSON.stringify(visible[i])}\n  data: ${JSON.stringify(listed[i])}`,
      );
    }
  }
}
console.log(`check-site: structured data matches the ${visible.length} FAQ answers.`);
