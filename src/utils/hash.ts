import { createHash } from 'node:crypto';

export function hashContent(html: string): string {
  // Strip volatile build artifacts to avoid false positives
  const cleaned = html
    .replace(/\/_astro\/[a-zA-Z0-9._-]+/g, '')
    .replace(/buildId":"[^"]+"/g, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\/cdn-cgi\/l\/email-protection#[a-f0-9]*/gi, '')
    .replace(/data-cfemail="[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(cleaned).digest('hex');
}
