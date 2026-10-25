import type { Metadata } from 'next';

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code: rawCode } = await params;
  let code: string;
  try {
    code = decodeURIComponent(rawCode).toUpperCase();
  } catch {
    code = rawCode.toUpperCase();
  }
  const title = `Verify Certificate ${code}`;
  const description = `Verify the authenticity of GCDIS certificate ${code} against the GCDIS certificate register.`;
  const url = `/verify/${encodeURIComponent(code)}`;
  return {
    title,
    description,
    // Do not inherit the home page canonical from the root layout.
    alternates: { canonical: null },
    openGraph: { title: `${title} | GCDIS`, description, url },
    twitter: { title: `${title} | GCDIS`, description },
    // Verification pages are per-recipient: keep them out of search indexes.
    robots: { index: false, follow: false }
  };
}

export default function VerifyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
