import type { TaskType } from './model-router.js';
export type { TaskType };

/**
 * Command types that indicate planning activity.
 */
const PLANNING_COMMANDS = new Set(['note', 'decision', 'set_run_limits']);

/**
 * Note categories that indicate verification.
 */
const VERIFICATION_CATEGORIES = new Set(['validation', 'artifact']);

/**
 * Classify the current task to determine which model should handle it.
 *
 * Planning phase:
 * - First few iterations (establishing requirements and plan)
 * - Notes with requirements/plan categories
 * - Decision commands
 *
 * Verification phase:
 * - Validation notes
 * - After tool results when verifying outcomes
 *
 * Execution phase:
 * - Tool calls
 * - Message sending
 * - Output updates
 */
export function classifyTask(
  iteration: number,
  hasToolCalls: boolean,
  command?: { type: string; category?: string },
  hasOutputText?: boolean
): TaskType {
  // First iteration is always planning
  if (iteration === 0) {
    return 'plan';
  }

  // If we have a command, use it to determine phase
  if (command) {
    // Planning commands
    if (PLANNING_COMMANDS.has(command.type)) {
      // Special case: validation notes are verification
      if (
        command.type === 'note' &&
        command.category &&
        VERIFICATION_CATEGORIES.has(command.category)
      ) {
        return 'verify';
      }
      return 'plan';
    }

    // Tool calls and execution
    if (command.type === 'tool_call') {
      return 'execute';
    }

    // Finishing with output
    if (command.type === 'finish' || command.type === 'set_output') {
      // If we have tool calls in history, this is verification of results
      return hasToolCalls ? 'verify' : 'execute';
    }

    // Messages are typically execution
    if (command.type === 'send_message') {
      return 'execute';
    }
  }

  // Without command context, use iteration and history
  if (iteration <= 2 && !hasToolCalls) {
    // Early iterations without tool calls are still planning
    return 'plan';
  }

  if (hasToolCalls && hasOutputText) {
    // We have results, likely verifying
    return 'verify';
  }

  // Default to execution
  return 'execute';
}

/**
 * Determine if we should switch models based on phase transition.
 */
export function shouldSwitchModel(
  previousTask: TaskType | null,
  currentTask: TaskType
): boolean {
  if (!previousTask) return false;
  return previousTask !== currentTask;
}

/**
 * Get a human-readable description of the current phase.
 */
export function getPhaseDescription(taskType: TaskType): string {
  switch (taskType) {
    case 'plan':
      return 'Planning and reasoning about the task';
    case 'execute':
      return 'Executing tools and actions';
    case 'verify':
      return 'Verifying results and validating outcomes';
  }
}
