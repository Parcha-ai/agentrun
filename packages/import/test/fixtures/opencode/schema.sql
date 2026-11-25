-- The tables of OpenCode's opencode.db the reader reads, as its migrations create them (anomalyco/opencode
-- packages/core/src/database/migration: 20260127222353_familiar_lady_ursula for session, message and part;
-- 20260804233008_loose_psylocke for session_v2 and session_message; 20261029002625_session_part). Columns the reader
-- does not read are left out. A 1.x database has the first three; a 2.x one all six, its 1.x history kept in the first.
CREATE TABLE `project` (`id` text PRIMARY KEY, `worktree` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `sandboxes` text NOT NULL);
CREATE TABLE `session` (
  `id` text PRIMARY KEY, `project_id` text NOT NULL, `parent_id` text, `slug` text NOT NULL, `directory` text NOT NULL,
  `title` text NOT NULL, `version` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL,
  CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
CREATE TABLE `message` (
  `id` text PRIMARY KEY, `session_id` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL,
  CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
CREATE TABLE `part` (
  `id` text PRIMARY KEY, `message_id` text NOT NULL, `session_id` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL,
  CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
);
CREATE INDEX `message_session_idx` ON `message` (`session_id`);
CREATE INDEX `part_session_idx` ON `part` (`session_id`);
-- 2.x only from here.
CREATE TABLE `session_v2` (
  `id` text PRIMARY KEY, `project_id` text NOT NULL, `parent_id` text, `fork_session_id` text, `fork_boundary` text,
  `slug` text NOT NULL, `directory` text NOT NULL, `title` text, `version` text NOT NULL, `model` text,
  `time_created` integer NOT NULL, `time_updated` integer NOT NULL,
  CONSTRAINT `fk_session_v2_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
CREATE TABLE `session_message` (
  `id` text PRIMARY KEY, `session_id` text NOT NULL, `type` text NOT NULL, `seq` integer NOT NULL,
  `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL,
  CONSTRAINT `fk_session_message_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);
CREATE TABLE `session_part` (
  `message_id` text NOT NULL, `session_id` text NOT NULL, `ordinal` integer NOT NULL, `type` text NOT NULL, `call_id` text,
  `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL,
  CONSTRAINT `session_part_pk` PRIMARY KEY(`message_id`, `ordinal`),
  CONSTRAINT `fk_session_part_message_id_session_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `session_message`(`id`) ON DELETE CASCADE
);
