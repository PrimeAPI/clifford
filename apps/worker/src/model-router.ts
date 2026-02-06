import {
  callOpenAIWithFallback,
  callOpenAIStructuredWithFallback,
  supportsStructuredOutputs,
  type OpenAIMessage,
  type JsonSchema,
} from './openai-client.js';

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
    model: 'gpt-4o', // Better reasoning for planning
    fallbackModel: 'gpt-4o-mini',
    temperature: 0.1,
  },
  executor: {
    model: 'gpt-4o-mini', // Fast and cost-effective for execution
    temperature: 0,
  },
  verifier: {
    model: 'gpt-4o-mini', // Fast validation
    temperature: 0,
  },
};

/**
 * Model router that selects the appropriate model based on task type.
 */
export class ModelRouter {
  private config: RoutingConfig;
  private apiKey: string;

  constructor(apiKey: string, config?: Partial<RoutingConfig>) {
    this.apiKey = apiKey;
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
    switch (taskType) {
      case 'plan':
        return this.config.planner;
      case 'execute':
        return this.config.executor;
      case 'verify':
        return this.config.verifier;
      default:
        return this.config.executor;
    }
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
