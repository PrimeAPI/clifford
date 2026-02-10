import {
  callOpenAIWithFallback,
  callOpenAIStructuredWithFallback,
  supportsStructuredOutputs,
  type OpenAIMessage,
  type JsonSchema,
} from './openai-client.js';
import { MODEL_CATALOG, DEFAULT_MODEL_ROUTING_CONFIG } from '@clifford/core';

/**
 * Task types for routing to different models.
 */
export type TaskType = 'plan' | 'execute' | 'verify';

/**
 * Configuration for a specific task type's model.
 */
export interface ModelSpec {
  model: string;
  fallbackModel?: string;
  temperature?: number;
}

/**
 * Full routing configuration with specs for each task type.
 */
export interface RoutingConfig {
  planner: ModelSpec; // For initial planning and reasoning (e.g., o3, claude)
  executor: ModelSpec; // For execution and tool calls (e.g., gpt-4o-mini)
  verifier: ModelSpec; // For validation and checking (e.g., gpt-4o-mini)
}

/**
 * Default routing configuration.
 */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  planner: {
    model: DEFAULT_MODEL_ROUTING_CONFIG.planner.model,
    fallbackModel: DEFAULT_MODEL_ROUTING_CONFIG.planner.fallbackModel ?? undefined,
    temperature: 0.1,
  },
  executor: {
    model: DEFAULT_MODEL_ROUTING_CONFIG.executor.model,
    fallbackModel: DEFAULT_MODEL_ROUTING_CONFIG.executor.fallbackModel ?? undefined,
    temperature: 0,
  },
  verifier: {
    model: DEFAULT_MODEL_ROUTING_CONFIG.verifier.model,
    fallbackModel: DEFAULT_MODEL_ROUTING_CONFIG.verifier.fallbackModel ?? undefined,
    temperature: 0,
  },
};

const COST_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

const QUALITY_FLOOR: Record<TaskType, number> = {
  plan: 3,
  execute: 2,
  verify: 1,
};

const MODEL_META = new Map(
  MODEL_CATALOG.map((entry) => [
    entry.id,
    { costLevel: entry.costLevel as 'low' | 'medium' | 'high', qualityLevel: entry.qualityLevel },
  ])
);

function dedupeModels(models: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const model of models) {
    const normalized = model?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function pickLowestCost(taskType: TaskType, primary: string, fallback?: string) {
  const candidates = dedupeModels([primary, fallback]);
  const floor = QUALITY_FLOOR[taskType];
  const known: Array<{
    model: string;
    meta: { costLevel: 'low' | 'medium' | 'high'; qualityLevel: 1 | 2 | 3 };
  }> = [];
  for (const candidate of candidates) {
    const meta = MODEL_META.get(candidate);
    if (meta) {
      known.push({ model: candidate, meta });
    }
  }

  // If one or more models are unknown, keep user-selected order to avoid unsafe assumptions.
  if (known.length !== candidates.length) {
    return { model: primary, fallbackModel: fallback };
  }

  const eligible = known.filter((entry) => entry.meta.qualityLevel >= floor);
  const pool = eligible.length > 0 ? eligible : known;
  pool.sort((a, b) => {
    const costDiff =
      (COST_RANK[a.meta.costLevel] ?? Number.MAX_SAFE_INTEGER) -
      (COST_RANK[b.meta.costLevel] ?? Number.MAX_SAFE_INTEGER);
    if (costDiff !== 0) return costDiff;
    return b.meta.qualityLevel - a.meta.qualityLevel;
  });

  const nextModel = pool[0]?.model ?? primary;
  const nextFallback = pool.find((entry) => entry.model !== nextModel)?.model;
  return { model: nextModel, fallbackModel: nextFallback };
}

/**
 * Model router that selects the appropriate model based on task type.
 */
export class ModelRouter {
  private config: RoutingConfig;
  private apiKey: string;
  private autoSelectLowestCost: boolean;
  private enabledModelIds: Set<string>;

  constructor(
    apiKey: string,
    config?: Partial<RoutingConfig>,
    autoSelectLowestCost = true,
    enabledModelIds?: string[]
  ) {
    this.apiKey = apiKey;
    this.autoSelectLowestCost = autoSelectLowestCost;
    this.enabledModelIds = new Set(
      (enabledModelIds && enabledModelIds.length > 0
        ? enabledModelIds
        : MODEL_CATALOG.map((model) => model.id)
      ).filter((id) => MODEL_META.has(id))
    );
    this.config = {
      planner: config?.planner ?? DEFAULT_ROUTING_CONFIG.planner,
      executor: config?.executor ?? DEFAULT_ROUTING_CONFIG.executor,
      verifier: config?.verifier ?? DEFAULT_ROUTING_CONFIG.verifier,
    };
  }

  /**
   * Get the model spec for a given task type.
   */
  getSpec(taskType: TaskType): ModelSpec {
    const baseSpec =
      taskType === 'plan'
        ? this.config.planner
        : taskType === 'verify'
          ? this.config.verifier
          : this.config.executor;
    const enabledCandidates = dedupeModels(
      [baseSpec.model, baseSpec.fallbackModel].filter((id) => this.enabledModelIds.has(id ?? ''))
    );
    const anyEnabledModel = Array.from(this.enabledModelIds.values())[0] ?? baseSpec.model;
    const primaryModel = enabledCandidates[0] ?? anyEnabledModel;
    const fallbackModel = enabledCandidates.find((id) => id !== primaryModel);
    const normalizedSpec = {
      ...baseSpec,
      model: primaryModel,
      fallbackModel,
    };
    if (!this.autoSelectLowestCost) {
      return normalizedSpec;
    }
    const selection = pickLowestCost(taskType, normalizedSpec.model, normalizedSpec.fallbackModel);
    return {
      ...normalizedSpec,
      model: selection.model,
      fallbackModel: selection.fallbackModel,
    };
  }

  /**
   * Route a request to the appropriate model based on task type.
   */
  async route(taskType: TaskType, messages: OpenAIMessage[]): Promise<string> {
    const spec = this.getSpec(taskType);
    return callOpenAIWithFallback(
      this.apiKey,
      spec.model,
      spec.fallbackModel ?? null,
      messages,
      { temperature: spec.temperature ?? 0 }
    );
  }

  /**
   * Route a structured output request to the appropriate model.
   */
  async routeStructured<T>(
    taskType: TaskType,
    messages: OpenAIMessage[],
    jsonSchema: JsonSchema
  ): Promise<T> {
    const spec = this.getSpec(taskType);

    // Check if primary model supports structured outputs
    if (supportsStructuredOutputs(spec.model)) {
      return callOpenAIStructuredWithFallback<T>(
        this.apiKey,
        spec.model,
        spec.fallbackModel ?? null,
        messages,
        jsonSchema,
        { temperature: spec.temperature ?? 0 }
      );
    }

    // Fall back to regular call and parse
    const response = await callOpenAIWithFallback(
      this.apiKey,
      spec.model,
      spec.fallbackModel ?? null,
      messages,
      { temperature: spec.temperature ?? 0 }
    );

    return JSON.parse(response) as T;
  }

  /**
   * Get info about which model will be used for a task type.
   */
  getModelInfo(taskType: TaskType): { model: string; supportsStructured: boolean } {
    const spec = this.getSpec(taskType);
    return {
      model: spec.model,
      supportsStructured: supportsStructuredOutputs(spec.model),
    };
  }
}

/**
 * Create a routing config from database settings.
 */
export function createRoutingConfig(settings: {
  plannerModel?: string;
  plannerFallback?: string;
  executorModel?: string;
  executorFallback?: string;
  verifierModel?: string;
  verifierFallback?: string;
}): RoutingConfig {
  return {
    planner: {
      model: settings.plannerModel ?? DEFAULT_ROUTING_CONFIG.planner.model,
      fallbackModel: settings.plannerFallback ?? DEFAULT_ROUTING_CONFIG.planner.fallbackModel,
      temperature: DEFAULT_ROUTING_CONFIG.planner.temperature,
    },
    executor: {
      model: settings.executorModel ?? DEFAULT_ROUTING_CONFIG.executor.model,
      fallbackModel: settings.executorFallback ?? DEFAULT_ROUTING_CONFIG.executor.fallbackModel,
      temperature: DEFAULT_ROUTING_CONFIG.executor.temperature,
    },
    verifier: {
      model: settings.verifierModel ?? DEFAULT_ROUTING_CONFIG.verifier.model,
      fallbackModel: settings.verifierFallback ?? DEFAULT_ROUTING_CONFIG.verifier.fallbackModel,
      temperature: DEFAULT_ROUTING_CONFIG.verifier.temperature,
    },
  };
}
