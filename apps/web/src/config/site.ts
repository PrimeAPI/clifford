import type { LucideIcon } from 'lucide-react';
import { Bot, Rocket, Shield } from 'lucide-react';

export type NavLink = {
  href: string;
  label: string;
  variant: 'ghost' | 'default' | 'outline';
};

export type Feature = {
  title: string;
  description: string;
  icon: LucideIcon;
};

export const NAV_LINKS: NavLink[] = [
  { href: '/auth/signin', label: 'Sign In', variant: 'ghost' },
  { href: '/auth/signup', label: 'Get Started', variant: 'default' },
];

export const FEATURES: Feature[] = [
  {
    title: 'Built-in Safety',
    description:
      'Policy engine with allow/deny/confirm controls. Never worry about unsafe actions.',
    icon: Shield,
  },
  {
    title: 'Plugin System',
    description:
      'Extend capabilities with custom tools and plugins. Build once, reuse everywhere.',
    icon: Rocket,
  },
  {
    title: 'Multi-Tenant',
    description:
      'Production-ready architecture with isolated workspaces and granular permissions.',
    icon: Bot,
  },
];
