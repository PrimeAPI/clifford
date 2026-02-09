import type { Feature } from '@/config/site';

export type FeaturesProps = {
  features: Feature[];
};

export function Features({ features }: FeaturesProps) {
  return (
    <section className="mt-24 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
      {features.map((feature) => {
        const Icon = feature.icon;
        return (
          <div key={feature.title} className="landing-feature-card">
            <Icon className="mb-4 h-10 w-10 text-primary" />
            <h3 className="mb-2 text-xl font-semibold">{feature.title}</h3>
            <p className="text-muted-foreground">{feature.description}</p>
          </div>
        );
      })}
    </section>
  );
}
