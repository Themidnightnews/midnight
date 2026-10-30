import { describe, expect, it } from 'vitest';
import { articles, articlesInSection, canonicalStory, getArticle, relatedArticles, sortSectionArticles, topNews, type Article } from '@/data/news';

describe('editorial browsing rules', () => {
  it('business contains business stories alone', () => {
    const business = articlesInSection('business');
    expect(business.length).toBeGreaterThan(0);
    expect(business.every((article) => article.tag === 'Business' || (article.sections ?? []).includes('business'))).toBe(true);
  });
  it('opinion contains only opinion pieces', () => {
    expect(articlesInSection('opinion').every((article) => article.tag === 'Opinion')).toBe(true);
  });
  it('Africa shows only Africa-section stories', () => {
    expect(articlesInSection('africa').every((a) => a.section === 'africa' || (a.sections ?? []).includes('africa'))).toBe(true);
  });
  it('keep reading stays within the viewed category and excludes the current story', () => {
    for (const article of articles) {
      expect(relatedArticles(article).every((other) => (other.section === article.section || (other.sections ?? []).includes(article.section)) && other.slug !== article.slug)).toBe(true);
    }
    const article = articlesInSection('business')[0];
    expect(article && relatedArticles(article).length).toBeGreaterThan(0);
  });
  it('listing images use the same image as the opened article', () => {
    const article = getArticle(articles[0]?.slug ?? '');
    expect(article).toBeDefined();
    if (!article) throw new Error('Missing fixture');
    expect(canonicalStory({ ...article, img: 'incorrect-image' }).img).toBe(article.img);
  });
  const base = articles[0];
  if (!base) throw new Error('Missing fixture');
  const fixtures: Article[] = [
    { ...base, slug: 'a', publishedAt: '2026-10-25T12:00:00Z', views: 100, shares: 60 },
    { ...base, slug: 'b', publishedAt: '2026-10-26T12:00:00Z', views: 500, shares: 10 },
    { ...base, slug: 'c', publishedAt: '2026-10-24T12:00:00Z', views: 200, shares: 90 },
  ];
  it('latest sorts newest first', () => expect(sortSectionArticles(fixtures, 'latest').map((a) => a.slug)).toEqual(['b', 'a', 'c']));
  it('oldest sorts oldest first', () => expect(sortSectionArticles(fixtures, 'oldest').map((a) => a.slug)).toEqual(['c', 'a', 'b']));
  it('most popular uses readership counts', () => expect(sortSectionArticles(fixtures, 'popular').map((a) => a.slug)).toEqual(['b', 'c', 'a']));
  it('trending uses views per minute since publication, not shares', () => {
    const now = Date.parse('2026-10-26T12:00:00Z');
    const t: Article[] = [
      { ...base, slug: 'old-big', publishedAt: '2026-10-23T12:00:00Z', views: 4320, shares: 999 }, // 1/min
      { ...base, slug: 'new-small', publishedAt: '2026-10-26T11:00:00Z', views: 600, shares: 1 }, // 10/min
    ];
    expect(sortSectionArticles(t, 'trending', now).map((a) => a.slug)).toEqual(['new-small', 'old-big']);
  });
  it('top news is ordered by headline weight', () => {
    const top = topNews();
    expect(top.length).toBeGreaterThan(0);
    for (let i = 1; i < top.length; i++) expect(top[i - 1]!.headlineWeight).toBeGreaterThanOrEqual(top[i]!.headlineWeight);
  });
  it('every article carries the full schema and no writer', () => {
    for (const a of articles) {
      for (const key of ['id', 'slug', 'title', 'subtitle', 'excerpt', 'section', 'tag', 'desk', 'img', 'imageAlt', 'time', 'publishedAt', 'updatedAt'] as const) expect(a[key]).toBeTruthy();
      expect(Number.isFinite(Date.parse(a.publishedAt))).toBe(true);
      expect(a.views === null || a.views >= 0).toBe(true);
      expect(a.shares === null || a.shares >= 0).toBe(true);
      expect('author' in a).toBe(false);
    }
  });
  it('real section sort: latest is newest first by publication date', () => {
    const sorted = sortSectionArticles(articlesInSection('business'), 'latest');
    for (let i = 1; i < sorted.length; i++) expect(Date.parse(sorted[i - 1]!.publishedAt)).toBeGreaterThanOrEqual(Date.parse(sorted[i]!.publishedAt));
  });
  it('at most six top-news stories are featured', () => expect(articles.filter((a) => a.featured).length).toBeLessThanOrEqual(6));
});