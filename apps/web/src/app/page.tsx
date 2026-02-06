import { Footer } from '@/components/landing/Footer';
import { Header } from '@/components/landing/Header';
import { Hero } from '@/components/landing/Hero';
import { Features } from '@/components/landing/Features';
import { FEATURES, NAV_LINKS } from '@/config/site';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted">
      <Header links={NAV_LINKS} />

      <main className="container mx-auto px-4">
        <Hero />
        <Features features={FEATURES} />
      </main>

      <Footer />
    </div>
  );
}
