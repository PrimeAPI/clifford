export type FooterProps = {};

export function Footer(_: FooterProps) {
  return (
    <footer className="border-t border-border py-8">
      <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
        <p>&copy; 2026 Clifford. Open source under MIT License.</p>
      </div>
    </footer>
  );
}
