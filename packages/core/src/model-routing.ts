export type CostLevel = 'low' | 'medium' | 'high';

export interface ModelCatalogEntry {
  id: string;
  name: string;
  costLevel: CostLevel;
  qualityLevel: 1 | 2 | 3;
  bestFor: string;
}

export interface RoutingModelSpec {
  model: string;
  fallbackModel?: string | null;
  instruction?: string;
}

export interface ModelRoutingConfig {
  planner: RoutingModelSpec;
  executor: RoutingModelSpec;
  verifier: RoutingModelSpec;
}

export interface ModelRoutingPolicy {
  version: 1;
  autoSelectLowestCost: boolean;
  enabledModelIds: string[];
  active: ModelRoutingConfig;
  draft: ModelRoutingConfig;
  activatedAt: string | null;
}

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: 'gpt-5-nano',
    name: 'GPT-5 Nano',
    costLevel: 'low',
    qualityLevel: 1,
    bestFor: 'Ultra-low-cost simple tasks and lightweight checks.',
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 Mini',
    costLevel: 'medium',
    qualityLevel: 2,
    bestFor: 'Balanced quality and cost for general execution.',
  },
  {
    id: 'gpt-5',
    name: 'GPT-5',
    costLevel: 'high',
    qualityLevel: 3,
    bestFor: 'Highest quality for complex planning and reasoning.',
  },
  {
    id: 'gpt-4.1-nano',
    name: 'GPT-4.1 Nano',
    costLevel: 'low',
    qualityLevel: 1,
    bestFor: 'Very cheap classification and lightweight checks.',
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    costLevel: 'low',
    qualityLevel: 2,
    bestFor: 'General execution at low cost.',
  },
  {
    id: 'gpt-4.1-mini',
    name: 'GPT-4.1 Mini',
    costLevel: 'low',
    qualityLevel: 2,
    bestFor: 'Low-cost tasks requiring better instruction following.',
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    costLevel: 'medium',
    qualityLevel: 3,
    bestFor: 'Strong planning and high-quality reasoning.',
  },
  {
    id: 'o3-mini',
    name: 'o3 Mini',
    costLevel: 'medium',
    qualityLevel: 3,
    bestFor: 'Reasoning-heavy tasks with moderate cost.',
  },
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    costLevel: 'high',
    qualityLevel: 3,
    bestFor: 'Complex tasks where maximum quality is preferred.',
  },
];

export const DEFAULT_MODEL_ROUTING_CONFIG: ModelRoutingConfig = {
  planner: {
    model: 'gpt-4o',
    fallbackModel: 'gpt-4o-mini',
    instruction: 'Use for task decomposition and difficult reasoning.',
  },
  executor: {
    model: 'gpt-4o-mini',
    fallbackModel: 'gpt-4.1-nano',
    instruction: 'Use for tool calls and action execution.',
  },
  verifier: {
    model: 'gpt-4o-mini',
    fallbackModel: 'gpt-4.1-nano',
    instruction: 'Use for checks, validation, and concise summaries.',
  },
};

const CATALOG_IDS = new Set(MODEL_CATALOG.map((model) => model.id));

export function getDefaultEnabledModelIds(): string[] {
  return MODEL_CATALOG.map((model) => model.id);
}

function sanitizeEnabledModelIds(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return getDefaultEnabledModelIds();
  }
  const unique = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || !CATALOG_IDS.has(id)) continue;
    unique.add(id);
  }
  const list = Array.from(unique);
  return list.length > 0 ? list : getDefaultEnabledModelIds();
}

function selectEnabledModel(preferred: string, enabledModelIds: string[]): string {
  return enabledModelIds.includes(preferred) ? preferred : enabledModelIds[0] ?? preferred;
}

function selectEnabledFallback(
  preferred: string | null | undefined,
  primary: string,
  enabledModelIds: string[]
): string | null {
  if (!preferred) return null;
  if (!enabledModelIds.includes(preferred)) return null;
  if (preferred === primary) return null;
  return preferred;
}

function alignConfigToEnabled(config: ModelRoutingConfig, enabledModelIds: string[]): ModelRoutingConfig {
  const alignSpec = (spec: RoutingModelSpec): RoutingModelSpec => {
    const model = selectEnabledModel(spec.model, enabledModelIds);
    return {
      ...spec,
      model,
      fallbackModel: selectEnabledFallback(spec.fallbackModel, model, enabledModelIds),
    };
  };
  return {
    planner: alignSpec(config.planner),
    executor: alignSpec(config.executor),
    verifier: alignSpec(config.verifier),
  };
}

function sanitizeSpec(input: unknown, fallback: RoutingModelSpec): RoutingModelSpec {
  if (!input || typeof input !== 'object') return { ...fallback };
  const raw = input as Record<string, unknown>;
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : fallback.model;
  const fallbackModel =
    typeof raw.fallbackModel === 'string' && raw.fallbackModel.trim()
      ? raw.fallbackModel.trim()
      : fallback.fallbackModel ?? null;
  const instruction =
    typeof raw.instruction === 'string' && raw.instruction.trim()
      ? raw.instruction.trim()
      : fallback.instruction ?? '';
  return {
    model,
    fallbackModel,
    instruction,
  };
}

function sanitizeConfig(input: unknown, defaults: ModelRoutingConfig): ModelRoutingConfig {
  if (!input || typeof input !== 'object') {
    return {
      planner: { ...defaults.planner },
      executor: { ...defaults.executor },
      verifier: { ...defaults.verifier },
    };
  }

  const raw = input as Record<string, unknown>;
  return {
    planner: sanitizeSpec(raw.planner, defaults.planner),
    executor: sanitizeSpec(raw.executor, defaults.executor),
    verifier: sanitizeSpec(raw.verifier, defaults.verifier),
  };
}

function hasActiveAndDraft(input: unknown): input is {
  active?: unknown;
  draft?: unknown;
  autoSelectLowestCost?: unknown;
  enabledModelIds?: unknown;
  activatedAt?: unknown;
} {
  if (!input || typeof input !== 'object') return false;
  const raw = input as Record<string, unknown>;
  return 'active' in raw || 'draft' in raw || 'autoSelectLowestCost' in raw || 'enabledModelIds' in raw;
}

export function normalizeModelRoutingPolicy(
  input: unknown,
  defaults: ModelRoutingConfig = DEFAULT_MODEL_ROUTING_CONFIG
): ModelRoutingPolicy {
  if (!input) {
    return {
      version: 1,
      autoSelectLowestCost: true,
      enabledModelIds: getDefaultEnabledModelIds(),
      active: alignConfigToEnabled(sanitizeConfig(undefined, defaults), getDefaultEnabledModelIds()),
      draft: alignConfigToEnabled(sanitizeConfig(undefined, defaults), getDefaultEnabledModelIds()),
      activatedAt: null,
    };
  }

  if (hasActiveAndDraft(input)) {
    const raw = input as Record<string, unknown>;
    const enabledModelIds = sanitizeEnabledModelIds(raw.enabledModelIds);
    const active = alignConfigToEnabled(sanitizeConfig(raw.active, defaults), enabledModelIds);
    const draft = alignConfigToEnabled(sanitizeConfig(raw.draft, active), enabledModelIds);
    return {
      version: 1,
      autoSelectLowestCost:
        typeof raw.autoSelectLowestCost === 'boolean' ? raw.autoSelectLowestCost : true,
      enabledModelIds,
      active,
      draft,
      activatedAt: typeof raw.activatedAt === 'string' ? raw.activatedAt : null,
    };
  }

  // Backward compatibility with legacy { planner, executor, verifier } shape.
  const legacy = sanitizeConfig(input, defaults);
  return {
    version: 1,
    autoSelectLowestCost: true,
    enabledModelIds: getDefaultEnabledModelIds(),
    active: alignConfigToEnabled(legacy, getDefaultEnabledModelIds()),
    draft: alignConfigToEnabled(legacy, getDefaultEnabledModelIds()),
    activatedAt: null,
  };
}
