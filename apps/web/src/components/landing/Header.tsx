import Link from 'next/link';
import { Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import type { NavLink } from '@/config/site';

export type HeaderProps = {
  links: NavLink[];
};

export function Header({ links }: HeaderProps) {
  return (
    <header className="border-b border-border">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <Bot className="h-8 w-8" />
          <span className="text-xl font-bold">Clifford</span>
        </div>
        <div className="flex items-center gap-4">
          <ThemeToggle />
          {links.map((link) => (
            <Link key={link.href} href={link.href}>
              <Button variant={link.variant}>{link.label}</Button>
            </Link>
          ))}
        </div>
      </div>
    </header>
  );
}
