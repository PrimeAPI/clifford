# Agent Authoring Guide (Coordinator + Subagent)

This guide describes how to write prompts and workflows for the coordinator/subagent model in Clifford.

## Roles at a Glance
- **Coordinator (main agent)**: orchestration only. It should analyze the request, plan, and delegate. It must not call tools or generate final output.
- **Subagent**: executes tasks, calls tools, and produces final output for the coordinator.

## Core Rules
- The coordinator **never** calls tools.
- The coordinator **never** produces final output directly. It must use `deliver_subagent_output`.
- Subagents **never** message the user.
- Subagents **never** spawn subagents. If more delegation is needed, use `request_parent`.
- The coordinator maintains a task queue in `state.queue`.
- The coordinator can only `sleep` when `state.queue` is empty and at least one subagent is still running.
- A subagent can only `sleep` when `state.waitingForParent` is true (set by `request_parent`).
- Duplicate coordinator progress messages are blocked.

## New Command Summary
- `deliver_subagent_output`: coordinator sends a completed subagent’s output to the user.
- `request_parent`: subagent asks the coordinator a question and waits.
- `reply_subagent`: coordinator replies to a subagent’s inbox.
- `retry_subagent`: coordinator reruns a subagent with feedback in context.
- `queue_op`: coordinator manages the queue (`push`, `shift`, `clear`, `set`).

## Suggested Workflow (Coordinator)
1. Write a requirements note (output spec).
2. Write a concrete plan note.
3. Populate `state.queue` using `queue_op` (one item per subtask).
4. Spawn subagents for each queue item.
5. While subagents run, optionally send short progress updates (do not repeat).
6. Once a subagent finishes, review and either:
   - `deliver_subagent_output` for final user response, or
   - `reply_subagent` / `retry_subagent` to refine.
7. If queue is empty and subagents are still running, `sleep`.

## Suggested Workflow (Subagent)
1. Use tools as needed.
2. Produce output via `finish` (for coordinator consumption).
3. If blocked on missing input, use `request_parent` and wait.

## Example (Coordinator)
```json
{"type":"queue_op","action":"set","items":["Find the latest policy details","Summarize impact for user"]}
```

```json
{"type":"spawn_subagents","subagents":[
  {"profile":"research","task":"Find the latest policy details","tools":["web.search"],"context":[],"agentLevel":1},
  {"profile":"analysis","task":"Summarize impact for user","tools":[],"context":[],"agentLevel":1}
]}
```

## Example (Subagent Asking Parent)
```json
{"type":"request_parent","message":"Which jurisdiction should I prioritize for this policy?"}
```

## Example (Coordinator Delivering Output)
```json
{"type":"deliver_subagent_output","runId":"<subagent-run-id>"}
```
