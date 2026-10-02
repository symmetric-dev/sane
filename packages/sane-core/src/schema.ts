/** Relational domain. Upgrades are explicit; adapters use RepositoryDomain. */
export const SCHEMA_VERSION = 2 as const
// BEFORE INSERT runs even when REPLACE's implicit DELETE triggers are disabled.
// Cover every identity/unique conflict, including the partial active indexes.
const protectedInsertConflicts: Record<string, string> = {
  store_metadata: "id=NEW.id OR repository_id=NEW.repository_id",
  checkout_pins: "id=NEW.id OR (path=NEW.path AND common_dir=NEW.common_dir AND git_dir=NEW.git_dir AND device=NEW.device AND inode=NEW.inode AND common_device=NEW.common_device AND common_inode=NEW.common_inode AND git_device=NEW.git_device AND git_inode=NEW.git_inode)",
  native_authorities: "(harness=NEW.harness AND authority_id=NEW.authority_id) OR (harness=NEW.harness AND kind=NEW.kind AND locator=NEW.locator)",
  workstreams: "id=NEW.id",
  conversations: "id=NEW.id OR (harness=NEW.harness AND authority_id=NEW.authority_id AND native_id=NEW.native_id)",
  memberships: "id=NEW.id OR (conversation_id=NEW.conversation_id AND ended_at IS NULL AND NEW.ended_at IS NULL)",
  phase_assignments: "id=NEW.id OR (membership_id=NEW.membership_id AND phase=NEW.phase AND ended_at IS NULL AND NEW.ended_at IS NULL)",
  phase_states: "workstream_id=NEW.workstream_id AND phase=NEW.phase",
  approvals: "id=NEW.id",
  approval_files: "approval_id=NEW.approval_id AND relative_path=NEW.relative_path",
  audit_events: "id=NEW.id",
  jobs: "workstream_id=NEW.workstream_id AND (job_id=NEW.job_id OR spec_path=NEW.spec_path OR (report_path IS NOT NULL AND report_path=NEW.report_path))",
  handoffs: "id=NEW.id OR (sender_id=NEW.sender_id AND request_id=NEW.request_id)",
  handoff_attempts: "id=NEW.id OR native_command_id=NEW.native_command_id OR run_id=NEW.run_id",
}
/** Frozen v1 definition used to refuse altered/unsupported upgrade sources. */
export const SCHEMA_V1 = `
CREATE TABLE store_metadata (
 id INTEGER PRIMARY KEY CHECK(id=1), format TEXT NOT NULL CHECK(format='sane-domain'), version INTEGER NOT NULL CHECK(version=1),
 repository_id TEXT NOT NULL UNIQUE, primary_checkout TEXT NOT NULL, common_dir TEXT NOT NULL, primary_pin TEXT NOT NULL CHECK(json_valid(primary_pin)), created_at TEXT NOT NULL
) STRICT;
CREATE TABLE checkout_pins (
 id TEXT PRIMARY KEY, path TEXT NOT NULL, common_dir TEXT NOT NULL, git_dir TEXT NOT NULL,
 device INTEGER NOT NULL, inode INTEGER NOT NULL, common_device INTEGER NOT NULL, common_inode INTEGER NOT NULL, git_device INTEGER NOT NULL, git_inode INTEGER NOT NULL,
 UNIQUE(path,common_dir,git_dir,device,inode,common_device,common_inode,git_device,git_inode)
) STRICT;
CREATE TABLE native_authorities (
 harness TEXT NOT NULL CHECK(harness IN ('cc','oc')), authority_id TEXT NOT NULL, kind TEXT NOT NULL,
 locator TEXT NOT NULL, CHECK((harness='cc' AND kind='local-profile') OR (harness='oc' AND kind='local-registration')),
 PRIMARY KEY(harness,authority_id), UNIQUE(harness,kind,locator)
) STRICT;
CREATE TABLE workstreams (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 96 AND substr(id,1,1) GLOB '[a-z0-9]' AND id NOT GLOB '*[^a-z0-9_-]*'),
 title TEXT NOT NULL CHECK(length(trim(title))>0), type TEXT NOT NULL CHECK(type IN ('feature','foundation','issue','maintenance')),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','blocked','done','abandoned')), default_pin_id TEXT REFERENCES checkout_pins(id),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0)
) STRICT;
CREATE TABLE conversations (
 id TEXT PRIMARY KEY, harness TEXT NOT NULL, authority_id TEXT NOT NULL, native_id TEXT NOT NULL CHECK(length(native_id)>0),
 execution_pin_id TEXT NOT NULL REFERENCES checkout_pins(id), parent_id TEXT REFERENCES conversations(id), created_at TEXT NOT NULL,
 CHECK(parent_id IS NULL OR parent_id!=id), UNIQUE(harness,authority_id,native_id), FOREIGN KEY(harness,authority_id) REFERENCES native_authorities(harness,authority_id)
) STRICT;
CREATE TABLE memberships (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), workstream_id TEXT NOT NULL REFERENCES workstreams(id),
 started_at TEXT NOT NULL, ended_at TEXT, CHECK(ended_at IS NULL OR ended_at>=started_at)
) STRICT;
CREATE UNIQUE INDEX active_membership ON memberships(conversation_id) WHERE ended_at IS NULL;
CREATE INDEX membership_workstream ON memberships(workstream_id);
CREATE TABLE phase_assignments (
 id TEXT PRIMARY KEY, membership_id TEXT NOT NULL REFERENCES memberships(id), phase TEXT NOT NULL,
 started_at TEXT NOT NULL, ended_at TEXT, CHECK(ended_at IS NULL OR ended_at>=started_at),
 CHECK(phase IN ('design','engineering','planning','execution','research') OR (substr(phase,1,9)='research:' AND length(substr(phase,10)) BETWEEN 1 AND 96 AND substr(phase,10,1) GLOB '[a-z0-9]' AND substr(phase,10) NOT GLOB '*[^a-z0-9_-]*'))
) STRICT;
CREATE UNIQUE INDEX active_assignment ON phase_assignments(membership_id,phase) WHERE ended_at IS NULL;
CREATE TABLE audit_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, correlation_id TEXT NOT NULL CHECK(length(correlation_id)>0), actor_kind TEXT NOT NULL CHECK(actor_kind IN ('local','human','system','native')),
 actor_conversation_id TEXT REFERENCES conversations(id), operation TEXT NOT NULL, workstream_id TEXT, entity_id TEXT,
 details TEXT NOT NULL CHECK(json_valid(details) AND length(details)<=65536), timestamp TEXT NOT NULL,
 CHECK((actor_kind='native' AND actor_conversation_id IS NOT NULL) OR (actor_kind!='native' AND actor_conversation_id IS NULL))
) STRICT;
CREATE INDEX audit_workstream ON audit_events(workstream_id,id);
CREATE TABLE approvals (
 id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL REFERENCES workstreams(id), phase TEXT NOT NULL CHECK(phase IN ('design','engineering','planning','execution')),
 user_reference TEXT NOT NULL CHECK(length(trim(user_reference))>0), hash_version INTEGER NOT NULL CHECK(hash_version=1), snapshot_hash TEXT NOT NULL,
 created_at TEXT NOT NULL, actor_event_id INTEGER NOT NULL REFERENCES audit_events(id), git_commit TEXT,
 UNIQUE(id,workstream_id,phase)
) STRICT;
CREATE TABLE approval_files (
 approval_id TEXT NOT NULL REFERENCES approvals(id), relative_path TEXT NOT NULL, content_hash TEXT NOT NULL,
 PRIMARY KEY(approval_id,relative_path)
) STRICT;
CREATE TABLE phase_states (
 workstream_id TEXT NOT NULL REFERENCES workstreams(id), phase TEXT NOT NULL CHECK(phase IN ('design','engineering','planning','execution')),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','delivered','approved','blocked')),
 current_approval_id TEXT, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), PRIMARY KEY(workstream_id,phase),
 FOREIGN KEY(current_approval_id,workstream_id,phase) REFERENCES approvals(id,workstream_id,phase)
) STRICT;
CREATE TABLE jobs (
 workstream_id TEXT NOT NULL REFERENCES workstreams(id), job_id TEXT NOT NULL CHECK(length(job_id)>0), spec_path TEXT NOT NULL, report_path TEXT,
 status TEXT NOT NULL CHECK(status IN ('planned','running','completed')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), updated_at TEXT NOT NULL,
 planning_approval_id TEXT NOT NULL, approval_phase TEXT NOT NULL DEFAULT 'planning' CHECK(approval_phase='planning'),
 PRIMARY KEY(workstream_id,job_id), UNIQUE(workstream_id,spec_path), UNIQUE(workstream_id,report_path),
 FOREIGN KEY(planning_approval_id,workstream_id,approval_phase) REFERENCES approvals(id,workstream_id,phase)
) STRICT;
CREATE TABLE research_reports (
 workstream_id TEXT NOT NULL REFERENCES workstreams(id), topic TEXT NOT NULL CHECK(length(topic) BETWEEN 1 AND 96 AND substr(topic,1,1) GLOB '[a-z0-9]' AND topic NOT GLOB '*[^a-z0-9_-]*'),
 report_path TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, actor_event_id INTEGER NOT NULL REFERENCES audit_events(id),
 PRIMARY KEY(workstream_id,topic), UNIQUE(workstream_id,report_path)
) STRICT;
CREATE TABLE cli_preferences (id INTEGER PRIMARY KEY CHECK(id=1), selected_workstream_id TEXT REFERENCES workstreams(id)) STRICT;
CREATE TABLE handoffs (
 id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES conversations(id), request_id TEXT NOT NULL,
 workstream_id TEXT NOT NULL REFERENCES workstreams(id), input TEXT NOT NULL CHECK(json_valid(input)),
 recipient TEXT NOT NULL CHECK(json_valid(recipient)), status TEXT NOT NULL CHECK(status IN ('queued','acceptance_unknown','accepted','running','completed','failed')),
 revision INTEGER NOT NULL DEFAULT 0, attempt_id TEXT, native_command_id TEXT, run_id TEXT, evidence TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(sender_id,request_id)
) STRICT;
CREATE INDEX handoff_queue ON handoffs(status,created_at,id);
CREATE TABLE handoff_attempts (
 id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL REFERENCES handoffs(id), native_command_id TEXT NOT NULL UNIQUE,
 run_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER handoff_attempt_immutable BEFORE UPDATE ON handoff_attempts BEGIN SELECT RAISE(ABORT,'handoff attempt is immutable'); END;
CREATE TRIGGER handoff_attempt_no_delete BEFORE DELETE ON handoff_attempts BEGIN SELECT RAISE(ABORT,'handoff attempt history cannot be deleted'); END;
CREATE TRIGGER handoff_identity BEFORE UPDATE ON handoffs BEGIN
 SELECT RAISE(ABORT,'handoff identity is immutable') WHERE NEW.id!=OLD.id OR NEW.sender_id!=OLD.sender_id OR NEW.request_id!=OLD.request_id OR NEW.workstream_id!=OLD.workstream_id OR NEW.input!=OLD.input OR NEW.created_at!=OLD.created_at;
END;
CREATE TRIGGER handoff_no_delete BEFORE DELETE ON handoffs BEGIN SELECT RAISE(ABORT,'handoff history cannot be deleted'); END;
INSERT INTO cli_preferences VALUES(1,NULL);
CREATE TRIGGER assignment_insert_interval BEFORE INSERT ON phase_assignments BEGIN
 SELECT RAISE(ABORT,'assignment outside membership interval') WHERE NOT EXISTS (
 SELECT 1 FROM memberships m WHERE m.id=NEW.membership_id AND NEW.started_at>=m.started_at
 AND (m.ended_at IS NULL OR (NEW.ended_at IS NOT NULL AND NEW.ended_at<=m.ended_at)));
END;
CREATE TRIGGER assignment_update_interval BEFORE UPDATE ON phase_assignments BEGIN
 SELECT RAISE(ABORT,'assignment identity is immutable') WHERE NEW.id!=OLD.id OR NEW.membership_id!=OLD.membership_id OR NEW.phase!=OLD.phase OR NEW.started_at!=OLD.started_at OR OLD.ended_at IS NOT NULL;
 SELECT RAISE(ABORT,'assignment outside membership interval') WHERE NOT EXISTS (
 SELECT 1 FROM memberships m WHERE m.id=NEW.membership_id AND NEW.started_at>=m.started_at
 AND (m.ended_at IS NULL OR (NEW.ended_at IS NOT NULL AND NEW.ended_at<=m.ended_at)));
END;
CREATE TRIGGER membership_update_interval BEFORE UPDATE ON memberships BEGIN
 SELECT RAISE(ABORT,'membership identity is immutable') WHERE NEW.id!=OLD.id OR NEW.conversation_id!=OLD.conversation_id OR NEW.workstream_id!=OLD.workstream_id OR NEW.started_at!=OLD.started_at OR OLD.ended_at IS NOT NULL;
 SELECT RAISE(ABORT,'end assignments before membership') WHERE NEW.ended_at IS NOT NULL AND EXISTS (
 SELECT 1 FROM phase_assignments a WHERE a.membership_id=NEW.id AND (a.ended_at IS NULL OR a.ended_at>NEW.ended_at));
END;
CREATE TRIGGER jobs_forward BEFORE UPDATE ON jobs BEGIN
 SELECT RAISE(ABORT,'UNIQUE job report cannot replace another job') WHERE NEW.report_path IS NOT NULL AND EXISTS(SELECT 1 FROM jobs WHERE workstream_id=NEW.workstream_id AND report_path=NEW.report_path AND job_id!=OLD.job_id);
 SELECT RAISE(ABORT,'job identity is immutable') WHERE NEW.workstream_id!=OLD.workstream_id OR NEW.job_id!=OLD.job_id OR NEW.spec_path!=OLD.spec_path OR NEW.planning_approval_id!=OLD.planning_approval_id;
 SELECT RAISE(ABORT,'job status cannot go backward') WHERE (OLD.status='completed' AND NEW.status!='completed') OR (OLD.status='running' AND NEW.status='planned');
END;
CREATE TRIGGER workstream_identity BEFORE UPDATE ON workstreams BEGIN
 SELECT RAISE(ABORT,'workstream identity is immutable') WHERE NEW.id!=OLD.id OR NEW.type!=OLD.type OR NEW.created_at!=OLD.created_at;
END;
CREATE TRIGGER phase_state_identity BEFORE UPDATE ON phase_states BEGIN
 SELECT RAISE(ABORT,'phase state identity is immutable') WHERE NEW.workstream_id!=OLD.workstream_id OR NEW.phase!=OLD.phase;
END;
${["store_metadata", "checkout_pins", "native_authorities", "conversations", "approvals", "approval_files", "audit_events"].map(table => `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'${table} is immutable'); END;`).join("\n")}
${["store_metadata", "checkout_pins", "native_authorities", "conversations", "workstreams", "memberships", "phase_assignments", "phase_states", "approvals", "approval_files", "audit_events", "jobs"].map(table => `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'${table} history cannot be deleted'); END;`).join("\n")}
${Object.entries(protectedInsertConflicts).map(([table, predicate]) => `CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${predicate}) BEGIN SELECT RAISE(ABORT,'UNIQUE ${table} identity/history cannot be replaced'); END;`).join("\n")}
`
/** Only assignment capability and metadata version change in v2. */
export const SCHEMA = SCHEMA_V1
  .replace("CHECK(version=1)", "CHECK(version=2)")
  .replace("phase IN ('design','engineering','planning','execution','research')", "phase IN ('design','engineering','planning','execution','research','knowledge','prototype')")
