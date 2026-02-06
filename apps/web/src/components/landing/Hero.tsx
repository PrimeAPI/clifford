import Link from 'next/link';
import { Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type HeroProps = {};

export function Hero(_: HeroProps): JSX.Element {
  return (
    <section className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center text-center">
      <div className="mb-8 inline-flex items-center rounded-full border border-border bg-card px-4 py-1.5 text-sm">
        <Zap className="mr-2 h-4 w-4 text-yellow-500" />
        <span className="text-muted-foreground">Powered by Advanced AI</span>
      </div>

      <h1 className="mb-6 max-w-4xl text-5xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
        Build Autonomous AI Agents
        <span className="block text-primary">That Actually Work</span>
      </h1>

      <p className="mb-10 max-w-2xl text-lg text-muted-foreground">
        Clifford is an open-source platform for building, deploying, and managing autonomous AI
        agents. Create intelligent workflows with built-in safety, monitoring, and control.
      </p>

      <div className="flex gap-4">
        <Link href="/auth/signup">
          <Button size="lg" className="h-12 px-8">
            Start Building
          </Button>
        </Link>
        <Link href="/docs">
          <Button size="lg" variant="outline" className="h-12 px-8">
            Documentation
          </Button>
        </Link>
      </div>
    </section>
  );
}
