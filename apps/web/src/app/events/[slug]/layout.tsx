import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SITE_NAME } from '@/lib/site';
import { resolveEvent } from '@/lib/events';
import { getSiteContent, getSponsors } from '@/lib/site-content';
import { SiteContentProvider } from '@/components/site/SiteContentProvider';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const event = await resolveEvent(slug);
  if (!event) notFound();

  const eventName = event.title;
  const description = `${eventName}: categories, rules, schedule, registered teams and live scoring for the GCDIS championship.`;
  const url = `/events/${event.slug}`;
  return {
    title: eventName,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      locale: 'en_IN',
      title: `${eventName} | GCDIS`,
      description,
      url,
      images: [{ url: '/images/gcdis-logo.png', width: 512, height: 512, alt: 'GCDIS, Galgotias University' }]
    },
    twitter: {
      card: 'summary',
      title: `${eventName} | GCDIS`,
      description,
      images: ['/images/gcdis-logo.png']
    }
  };
}

export default async function EventLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  // The championship page is a client component: validate the slug here so unknown events return a real 404.
  const { slug } = await params;
  const event = await resolveEvent(slug);
  if (!event) notFound();

  // EVENT-placement sponsors for the "Sponsors & Partners" tab (managed from the staff console, cached for 30 s).
  const { sponsorsSection } = await getSiteContent();
  const sponsors = sponsorsSection.enabled && sponsorsSection.showOn.event ? await getSponsors('EVENT') : [];
  return <SiteContentProvider sponsors={{ EVENT: sponsors }}>{children}</SiteContentProvider>;
}
