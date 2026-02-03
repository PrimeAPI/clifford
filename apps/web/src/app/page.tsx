import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { Bot, Zap, Shield, Rocket } from 'lucide-react';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted">
      {/* Header */}
      <header className="border-b border-border">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Bot className="h-8 w-8" />
            <span className="text-xl font-bold">Clifford</span>
          </div>
          <div className="flex items-center gap-4">
            <ThemeToggle />
            <Link href="/auth/signin">
              <Button variant="ghost">Sign In</Button>
            </Link>
            <Link href="/auth/signup">
              <Button>Get Started</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="container mx-auto px-4">
        <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center text-center">
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

          {/* Features */}
          <div className="mt-24 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-6 text-left shadow-sm">
              <Shield className="mb-4 h-10 w-10 text-primary" />
              <h3 className="mb-2 text-xl font-semibold">Built-in Safety</h3>
              <p className="text-muted-foreground">
                Policy engine with allow/deny/confirm controls. Never worry about unsafe actions.
              </p>
            </div>

            <div className="rounded-lg border border-border bg-card p-6 text-left shadow-sm">
              <Rocket className="mb-4 h-10 w-10 text-primary" />
              <h3 className="mb-2 text-xl font-semibold">Plugin System</h3>
              <p className="text-muted-foreground">
                Extend capabilities with custom tools and plugins. Build once, reuse everywhere.
              </p>
            </div>

            <div className="rounded-lg border border-border bg-card p-6 text-left shadow-sm">
              <Bot className="mb-4 h-10 w-10 text-primary" />
              <h3 className="mb-2 text-xl font-semibold">Multi-Tenant</h3>
              <p className="text-muted-foreground">
                Production-ready architecture with isolated workspaces and granular permissions.
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-8">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          <p>&copy; 2026 Clifford. Open source under MIT License.</p>
        </div>
      </footer>
    </div>
  );
}
