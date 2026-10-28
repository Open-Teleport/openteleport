-- Two agents, as OpenBot stores them after the schema of schema.sql. Made up for the tests; no
-- real OpenBot database was read. agent_json has the fields of AgentSummary
-- (packages/contracts/src/ipc-agents.ts, read on 2026-10-28), and the shapes in schedule_json are
-- those of RoutineSchedule (packages/contracts/src/ipc-routines.ts).

INSERT INTO projection_agents(agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
VALUES
  ('ada', NULL, 'claude-opus-5-5', '2026-10-20T10:00:00.000Z', 0,
   '{"id":"ada","name":"Ada","title":"Research assistant","description":"Read the papers first.\nThen summarise them in five lines.","notifications":true,"provider":"claude","model":"claude-opus-5-5","reasoningEffort":"high","threadId":null,"workspacePath":"/home/user/OpenBot/Agents/ada","preview":"","updatedAt":"2026-10-20T10:00:00.000Z","avatarSeed":"ada-seed","avatarHue":210,"avatarUrl":null}',
   10),
  ('min', NULL, 'gpt-5.5', NULL, 1,
   '{"id":"min","name":"Min","title":"","description":"","notifications":false,"provider":"codex","model":"gpt-5.5","reasoningEffort":"medium","threadId":null,"workspacePath":"/home/user/OpenBot/Agents/min","preview":"","updatedAt":null,"avatarSeed":"min","avatarHue":null,"avatarUrl":null}',
   11);

-- Three memories of ada; the third has 600 characters, which is over the limit of a fact.
INSERT INTO projection_agent_memories(memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence)
VALUES
  ('mem-ada-1', 'ada', 'Prefers short answers.', 'prefers short answers.', 'manual', NULL,
   '2026-10-10T09:00:00.000Z', '2026-10-10T09:00:00.000Z', 12),
  ('mem-ada-2', 'ada', 'Works in the Europe/Warsaw time zone.', 'works in the europe/warsaw time zone.', 'automatic', NULL,
   '2026-10-11T09:00:00.000Z', '2026-10-11T09:00:00.000Z', 13);
INSERT INTO projection_agent_memories(memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at, updated_at, last_event_sequence)
SELECT 'mem-ada-3', 'ada', note, lower(note), 'automatic', NULL,
       '2026-10-12T09:00:00.000Z', '2026-10-12T09:00:00.000Z', 14
FROM (SELECT substr('Atlas review notes. ' || replace(hex(zeroblob(600)), '00', 'x'), 1, 600) AS note);

-- Four routines of ada, one of each of four schedule shapes. The last is off and carries
-- non-default policies.
INSERT INTO projection_agent_routines(routine_id, agent_id, name, instruction, active, timezone, created_at, updated_at, last_event_sequence, limit_policy, missed_policy)
VALUES
  ('routine-daily', 'ada', 'Morning digest', 'Summarise the news.', 1, 'Europe/Warsaw',
   '2026-10-13T09:00:00.000Z', '2026-10-13T09:00:00.000Z', 15, 'wait', 'skip'),
  ('routine-weekly', 'ada', 'Weekly review', 'List what changed this week.', 1, 'Europe/Warsaw',
   '2026-10-13T09:01:00.000Z', '2026-10-13T09:01:00.000Z', 16, 'wait', 'skip'),
  ('routine-interval', 'ada', 'Poll the inbox', 'Check the inbox for new papers.', 1, 'UTC',
   '2026-10-13T09:02:00.000Z', '2026-10-13T09:02:00.000Z', 17, 'wait', 'skip'),
  ('routine-monthly', 'ada', 'Month end', 'Write the month end report.', 0, 'America/New_York',
   '2026-10-13T09:03:00.000Z', '2026-10-13T09:03:00.000Z', 18, 'skip', 'run-once');

INSERT INTO projection_routine_triggers(trigger_id, routine_id, schedule_json, next_run_at, created_at, updated_at, last_event_sequence)
VALUES
  ('trigger-daily', 'routine-daily', '{"kind":"daily","time":"08:30"}', '2026-10-29T07:30:00.000Z',
   '2026-10-13T09:00:00.000Z', '2026-10-13T09:00:00.000Z', 15),
  ('trigger-weekly', 'routine-weekly', '{"kind":"weekly","weekday":1,"time":"09:00"}', '2026-11-02T08:00:00.000Z',
   '2026-10-13T09:01:00.000Z', '2026-10-13T09:01:00.000Z', 16),
  ('trigger-interval', 'routine-interval', '{"kind":"interval","amount":2,"unit":"hours","anchorAt":"2026-10-01T06:00:00.000Z"}', '2026-10-28T12:00:00.000Z',
   '2026-10-13T09:02:00.000Z', '2026-10-13T09:02:00.000Z', 17),
  ('trigger-monthly', 'routine-monthly', '{"kind":"monthly","day":28,"time":"17:00"}', '2026-11-28T22:00:00.000Z',
   '2026-10-13T09:03:00.000Z', '2026-10-13T09:03:00.000Z', 18);
