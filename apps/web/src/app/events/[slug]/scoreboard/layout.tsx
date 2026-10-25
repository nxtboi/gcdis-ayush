import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { resolveEvent } from '@/lib/events';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const event = await resolveEvent(slug);
  if (!event) notFound();
  return {
    title: { absolute: 'Live Scoreboard | GCDIS' },
    description: `Live scoreboard for ${event.title}.`,
    alternates: { canonical: `/events/${event.slug}/scoreboard` },
    openGraph: {
      title: 'Live Scoreboard | GCDIS',
      url: `/events/${event.slug}/scoreboard`
    },
    // Broadcast view duplicates the championship page's live scores: keep it out of search indexes.
    robots: { index: false, follow: false }
  };
}

export default async function EventScoreboardLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const event = await resolveEvent(slug);
  if (!event) notFound();
  return children;
}
