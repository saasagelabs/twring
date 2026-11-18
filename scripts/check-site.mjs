// Checks the static site's search data. Every page's structured data must parse, and a page's
// structured FAQ must say exactly what its visible FAQ says (search and answer engines quote it).
// Every page in the sitemap must exist.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SITE = 'apps/site';
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

let failed = false;
const fail = (message) => {
  console.error(`check-site: ${message}`);
  failed = true;
};

function pages(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return pages(full);
    return name.endsWith('.html') ? [full] : [];
  });
}

let checked = 0;
for (const file of pages(SITE)) {
  const html = readFileSync(file, 'utf8');
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (blocks.length === 0) continue;
  if (blocks.length > 1) fail(`${file}: more than one structured data block.`);
  let data;
  try {
    data = JSON.parse(blocks[0][1]);
  } catch (error) {
    fail(`${file}: the structured data is not valid JSON: ${error.message}`);
    continue;
  }
  const visible = [
    ...html.matchAll(
      /<details><summary>([^<]*)<svg[\s\S]*?<\/summary><div>([\s\S]*?)<\/div><\/details>/g,
    ),
  ].map(([, question, answer]) => ({ question: unent(question.trim()), answer: plain(answer) }));
  const faqPage = (data['@graph'] ?? [data]).find((node) => node['@type'] === 'FAQPage');
  if (!faqPage) {
    if (visible.length > 0) fail(`${file}: has a visible FAQ but no FAQPage structured data.`);
    continue;
  }
  const listed = faqPage.mainEntity.map((q) => ({
    question: q.name,
    answer: q.acceptedAnswer.text,
  }));
  if (visible.length === 0) fail(`${file}: has FAQPage structured data but no visible FAQ.`);
  for (let i = 0; i < Math.max(visible.length, listed.length); i++) {
    if (JSON.stringify(visible[i]) !== JSON.stringify(listed[i])) {
      fail(
        `${file}: FAQ ${i + 1} differs.\n  page: ${JSON.stringify(visible[i])}\n  data: ${JSON.stringify(listed[i])}`,
      );
      break;
    }
  }
  checked++;
}

const sitemap = readFileSync(path.join(SITE, 'sitemap.xml'), 'utf8');
for (const [, loc] of sitemap.matchAll(/<loc>https:\/\/twring\.com\/([^<]*)<\/loc>/g)) {
  // The gateway serves the privacy notice; every other page is a file here.
  if (loc === 'privacy') continue;
  const file = path.join(SITE, loc, loc === '' || loc.endsWith('/') ? 'index.html' : '');
  if (!existsSync(file)) fail(`the sitemap lists /${loc}, but ${file} does not exist.`);
}

if (failed) process.exit(1);
console.log(`check-site: structured data matches the visible FAQ on ${checked} page(s).`);
