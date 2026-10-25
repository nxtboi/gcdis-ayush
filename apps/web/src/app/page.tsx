import { PublicHomePage } from '@/components/home/PublicHomePage';
import { resolveHomeContent, showPlaceholderContent } from '@/lib/home-content';
import { getHomePage } from '@/lib/home-sections';
import { getGalleryImages, getSiteContent, getSponsors } from '@/lib/site-content';

/**
 * Home page. Every section (hero details, ticker, body sections in their order, footer), the gallery images
 * and the HOME-placement sponsors are managed from the staff console and loaded on the server (cached for
 * 30 s, see lib/site-content.ts and lib/home-sections.ts); the bundled content in lib/home-content.ts is the
 * fallback when the API is unreachable. Placeholder entries are removed here in production. The page itself
 * renders client-side.
 */
export default async function HomePage() {
  const [{ sponsorsSection, gallerySection }, home] = await Promise.all([getSiteContent(), getHomePage()]);
  const showSponsors = sponsorsSection.enabled && sponsorsSection.showOn.home && home.order.includes('partners');
  const showMosaic = home.order.includes('awards');
  const [sponsors, gallery] = await Promise.all([
    showSponsors ? getSponsors('HOME') : Promise.resolve(null),
    gallerySection.enabled && showMosaic ? getGalleryImages() : Promise.resolve(null)
  ]);
  const content = resolveHomeContent(showPlaceholderContent(), home.content);

  return (
    <PublicHomePage
      sponsors={sponsors}
      gallery={gallery}
      gallerySection={gallerySection}
      content={content}
      order={home.order}
      showTicker={home.showTicker}
      hiddenAnchors={home.hiddenAnchors}
    />
  );
}
