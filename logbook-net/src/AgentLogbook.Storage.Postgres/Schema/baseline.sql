-- Agent Logbook final schema, baseline `agent-logbook-baseline-1`.
-- Tables are created in the current schema (the connection's default). Every tenant table
-- forces row-level security on app.tenant_id. Role grants are applied by the schema
-- initializer, not here, because role names are deployment configuration.

--
-- Name: completion_observations; Type: TABLE
--

CREATE TABLE completion_observations (
    tenant_id text NOT NULL,
    id uuid NOT NULL,
    issue_id uuid NOT NULL,
    completion_ordinal integer NOT NULL,
    repository_identity text,
    commit_sha text,
    branch text,
    dirty boolean,
    captured_at text NOT NULL,
    calculated_version text,
    diagnostics text NOT NULL,
    calculated_version_state text DEFAULT 'unknown'::text NOT NULL,
    CONSTRAINT completion_observations_calculated_version_state_check CHECK ((calculated_version_state = ANY (ARRAY['available'::text, 'unknown'::text]))),
    CONSTRAINT completion_observations_completion_ordinal_check CHECK ((completion_ordinal > 0))
);

ALTER TABLE ONLY completion_observations FORCE ROW LEVEL SECURITY;

--
-- Name: context_terms; Type: TABLE
--

CREATE TABLE context_terms (
    tenant_id text NOT NULL,
    id uuid NOT NULL,
    context_key text NOT NULL,
    term text NOT NULL,
    definition text NOT NULL,
    avoid_terms text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    tombstone boolean DEFAULT false NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    created_by uuid,
    updated_by uuid,
    short_reference text
);

ALTER TABLE ONLY context_terms FORCE ROW LEVEL SECURITY;

--
-- Name: contexts; Type: TABLE
--

CREATE TABLE contexts (
    tenant_id text NOT NULL,
    id uuid NOT NULL,
    reference text NOT NULL,
    key text NOT NULL,
    scope_entity_id uuid,
    title text NOT NULL,
    summary text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    created_by uuid,
    updated_by uuid,
    short_reference text
);

ALTER TABLE ONLY contexts FORCE ROW LEVEL SECURITY;

--
-- Name: counters; Type: TABLE
--

CREATE TABLE counters (
    tenant_id text NOT NULL,
    kind text NOT NULL,
    next_value integer NOT NULL
);

ALTER TABLE ONLY counters FORCE ROW LEVEL SECURITY;

--
-- Name: entities; Type: TABLE
--

CREATE TABLE entities (
    tenant_id text NOT NULL,
    id uuid NOT NULL,
    reference text NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    status text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    body_source text DEFAULT 'authored'::text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    tombstone boolean DEFAULT false NOT NULL,
    project_id uuid,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    created_by uuid,
    updated_by uuid,
    category text,
    priority text,
    type text,
    short_reference text
);

ALTER TABLE ONLY entities FORCE ROW LEVEL SECURITY;

--
-- Name: instruction_bundles; Type: TABLE
--

CREATE TABLE instruction_bundles (
    version text NOT NULL,
    content_hash text NOT NULL
);

--
-- Name: instruction_defaults; Type: TABLE
--

CREATE TABLE instruction_defaults (
    version text NOT NULL,
    item_key text NOT NULL,
    kind text NOT NULL,
    body text NOT NULL,
    revision integer NOT NULL,
    content_hash text NOT NULL,
    CONSTRAINT instruction_defaults_kind_check CHECK ((kind = ANY (ARRAY['agent'::text, 'skill'::text, 'fragment'::text]))),
    CONSTRAINT instruction_defaults_revision_check CHECK ((revision > 0))
);

--
-- Name: instruction_history; Type: TABLE
--

CREATE TABLE instruction_history (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    item_key text NOT NULL,
    revision integer NOT NULL,
    kind text NOT NULL,
    body text NOT NULL,
    content_hash text NOT NULL,
    default_version text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    CONSTRAINT instruction_history_kind_check CHECK ((kind = ANY (ARRAY['agent'::text, 'skill'::text, 'fragment'::text]))),
    CONSTRAINT instruction_history_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY instruction_history FORCE ROW LEVEL SECURITY;

--
-- Name: instruction_overrides; Type: TABLE
--

CREATE TABLE instruction_overrides (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    item_key text NOT NULL,
    kind text NOT NULL,
    body text NOT NULL,
    revision integer NOT NULL,
    content_hash text NOT NULL,
    default_version text NOT NULL,
    CONSTRAINT instruction_overrides_kind_check CHECK ((kind = ANY (ARRAY['agent'::text, 'skill'::text, 'fragment'::text]))),
    CONSTRAINT instruction_overrides_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY instruction_overrides FORCE ROW LEVEL SECURITY;

--
-- Name: instruction_personal_fragments; Type: TABLE
--

CREATE TABLE instruction_personal_fragments (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    item_key text NOT NULL,
    revision integer NOT NULL,
    body text NOT NULL,
    content_hash text NOT NULL,
    removed boolean DEFAULT false NOT NULL,
    CONSTRAINT instruction_personal_fragments_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY instruction_personal_fragments FORCE ROW LEVEL SECURITY;

--
-- Name: issue_breakdown_drafts; Type: TABLE
--

CREATE TABLE issue_breakdown_drafts (
    tenant_id text NOT NULL,
    id uuid NOT NULL,
    target_id uuid NOT NULL,
    status text NOT NULL,
    snapshot_json text NOT NULL,
    snapshot_digest text NOT NULL,
    approved_at text,
    created_issue_references text DEFAULT '[]'::text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);

ALTER TABLE ONLY issue_breakdown_drafts FORCE ROW LEVEL SECURITY;

--
-- Name: issue_comment_references; Type: TABLE
--

CREATE TABLE issue_comment_references (
    tenant_id text NOT NULL,
    comment_id uuid NOT NULL,
    issue_id uuid NOT NULL,
    "position" integer NOT NULL
);

ALTER TABLE ONLY issue_comment_references FORCE ROW LEVEL SECURITY;

--
-- Name: issue_comments; Type: TABLE
--

CREATE TABLE issue_comments (
    tenant_id text NOT NULL,
    id uuid NOT NULL,
    reference text NOT NULL,
    issue_id uuid NOT NULL,
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    body text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    tombstone boolean DEFAULT false NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    short_reference text
);

ALTER TABLE ONLY issue_comments FORCE ROW LEVEL SECURITY;

--
-- Name: plan_entries; Type: TABLE
--

CREATE TABLE plan_entries (
    tenant_id text NOT NULL,
    id uuid NOT NULL,
    reference text NOT NULL,
    short_reference text NOT NULL,
    plan_id uuid NOT NULL,
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    role text NOT NULL,
    body text NOT NULL,
    scope_direction text,
    revision integer DEFAULT 1 NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    tombstone boolean DEFAULT false NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);

ALTER TABLE ONLY plan_entries FORCE ROW LEVEL SECURITY;

--
-- Name: plan_entry_references; Type: TABLE
--

CREATE TABLE plan_entry_references (
    tenant_id text NOT NULL,
    plan_entry_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    "position" integer NOT NULL
);

ALTER TABLE ONLY plan_entry_references FORCE ROW LEVEL SECURITY;

--
-- Name: plan_entry_supersessions; Type: TABLE
--

CREATE TABLE plan_entry_supersessions (
    tenant_id text NOT NULL,
    plan_entry_id uuid NOT NULL,
    superseded_entry_id uuid NOT NULL,
    "position" integer NOT NULL
);

ALTER TABLE ONLY plan_entry_supersessions FORCE ROW LEVEL SECURITY;

--
-- Name: project_settings; Type: TABLE
--

CREATE TABLE project_settings (
    tenant_id text NOT NULL,
    project_id uuid NOT NULL,
    prospector_settings text DEFAULT '{}'::text NOT NULL
);

ALTER TABLE ONLY project_settings FORCE ROW LEVEL SECURITY;

--
-- Name: relations; Type: TABLE
--

CREATE TABLE relations (
    tenant_id text NOT NULL,
    from_id uuid NOT NULL,
    to_id uuid NOT NULL,
    type text NOT NULL,
    created_at text NOT NULL,
    created_by uuid
);

ALTER TABLE ONLY relations FORCE ROW LEVEL SECURITY;

--
-- Name: revision_entries; Type: TABLE
--

CREATE TABLE revision_entries (
    id text NOT NULL,
    tenant_id text NOT NULL,
    project_id uuid NOT NULL,
    record_kind text NOT NULL,
    record_key text NOT NULL,
    revision integer NOT NULL,
    author text NOT NULL,
    patch_format integer NOT NULL,
    reverse_patch bytea NOT NULL,
    source_hash bytea NOT NULL,
    target_hash bytea NOT NULL,
    restored_from_revision integer,
    created_at text NOT NULL,
    CONSTRAINT revision_entries_patch_format_positive CHECK ((patch_format > 0)),
    CONSTRAINT revision_entries_record_kind CHECK ((record_kind = ANY (ARRAY['entity'::text, 'context'::text, 'context-term'::text, 'issue-comment'::text, 'plan-entry'::text]))),
    CONSTRAINT revision_entries_revision_positive CHECK ((revision > 0)),
    CONSTRAINT revision_entries_source_hash_length CHECK ((octet_length(source_hash) = 32)),
    CONSTRAINT revision_entries_target_hash_length CHECK ((octet_length(target_hash) = 32))
);

ALTER TABLE ONLY revision_entries FORCE ROW LEVEL SECURITY;

--
-- Name: users; Type: TABLE
--

CREATE TABLE users (
    tenant_id text NOT NULL,
    id uuid NOT NULL,
    authentication_subject text NOT NULL,
    display_name text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);

ALTER TABLE ONLY users FORCE ROW LEVEL SECURITY;

--
-- Name: completion_observations completion_observations_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY completion_observations
    ADD CONSTRAINT completion_observations_pkey PRIMARY KEY (tenant_id, issue_id, completion_ordinal);

--
-- Name: completion_observations completion_observations_tenant_id_id_key; Type: CONSTRAINT
--

ALTER TABLE ONLY completion_observations
    ADD CONSTRAINT completion_observations_tenant_id_id_key UNIQUE (tenant_id, id);

--
-- Name: context_terms context_terms_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY context_terms
    ADD CONSTRAINT context_terms_pkey PRIMARY KEY (tenant_id, context_key, term);

--
-- Name: contexts contexts_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY contexts
    ADD CONSTRAINT contexts_pkey PRIMARY KEY (tenant_id, key);

--
-- Name: counters counters_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY counters
    ADD CONSTRAINT counters_pkey PRIMARY KEY (tenant_id, kind);

--
-- Name: entities entities_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (tenant_id, id);

--
-- Name: instruction_bundles instruction_bundles_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY instruction_bundles
    ADD CONSTRAINT instruction_bundles_pkey PRIMARY KEY (version);

--
-- Name: instruction_defaults instruction_defaults_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY instruction_defaults
    ADD CONSTRAINT instruction_defaults_pkey PRIMARY KEY (version, item_key);

--
-- Name: instruction_history instruction_history_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY instruction_history
    ADD CONSTRAINT instruction_history_pkey PRIMARY KEY (tenant_id, user_id, item_key, revision);

--
-- Name: instruction_overrides instruction_overrides_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY instruction_overrides
    ADD CONSTRAINT instruction_overrides_pkey PRIMARY KEY (tenant_id, user_id, item_key);

--
-- Name: instruction_personal_fragments instruction_personal_fragments_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY instruction_personal_fragments
    ADD CONSTRAINT instruction_personal_fragments_pkey PRIMARY KEY (tenant_id, user_id, item_key, revision);

--
-- Name: issue_breakdown_drafts issue_breakdown_drafts_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY issue_breakdown_drafts
    ADD CONSTRAINT issue_breakdown_drafts_pkey PRIMARY KEY (tenant_id, id);

--
-- Name: issue_comment_references issue_comment_references_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY issue_comment_references
    ADD CONSTRAINT issue_comment_references_pkey PRIMARY KEY (tenant_id, comment_id, issue_id);

--
-- Name: issue_comments issue_comments_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY issue_comments
    ADD CONSTRAINT issue_comments_pkey PRIMARY KEY (tenant_id, id);

--
-- Name: issue_comments issue_comments_tenant_id_reference_key; Type: CONSTRAINT
--

ALTER TABLE ONLY issue_comments
    ADD CONSTRAINT issue_comments_tenant_id_reference_key UNIQUE (tenant_id, reference);

--
-- Name: plan_entries plan_entries_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY plan_entries
    ADD CONSTRAINT plan_entries_pkey PRIMARY KEY (tenant_id, id);

--
-- Name: plan_entries plan_entries_tenant_id_reference_key; Type: CONSTRAINT
--

ALTER TABLE ONLY plan_entries
    ADD CONSTRAINT plan_entries_tenant_id_reference_key UNIQUE (tenant_id, reference);

--
-- Name: plan_entries plan_entries_tenant_id_short_reference_key; Type: CONSTRAINT
--

ALTER TABLE ONLY plan_entries
    ADD CONSTRAINT plan_entries_tenant_id_short_reference_key UNIQUE (tenant_id, short_reference);

--
-- Name: plan_entry_references plan_entry_references_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY plan_entry_references
    ADD CONSTRAINT plan_entry_references_pkey PRIMARY KEY (tenant_id, plan_entry_id, entity_id);

--
-- Name: plan_entry_supersessions plan_entry_supersessions_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY plan_entry_supersessions
    ADD CONSTRAINT plan_entry_supersessions_pkey PRIMARY KEY (tenant_id, plan_entry_id, superseded_entry_id);

--
-- Name: project_settings project_settings_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY project_settings
    ADD CONSTRAINT project_settings_pkey PRIMARY KEY (tenant_id, project_id);

--
-- Name: relations relations_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY relations
    ADD CONSTRAINT relations_pkey PRIMARY KEY (tenant_id, from_id, to_id, type);

--
-- Name: revision_entries revision_entries_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY revision_entries
    ADD CONSTRAINT revision_entries_pkey PRIMARY KEY (tenant_id, id);

--
-- Name: users users_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (tenant_id, id);

--
-- Name: completion_observations_tenant_issue_idx; Type: INDEX
--

CREATE INDEX completion_observations_tenant_issue_idx ON completion_observations USING btree (tenant_id, issue_id, completion_ordinal);

--
-- Name: context_terms_search_idx; Type: INDEX
--

CREATE INDEX context_terms_search_idx ON context_terms USING gin (to_tsvector('simple'::regconfig, ((term || ' '::text) || definition)));

--
-- Name: context_terms_tenant_context_key_idx; Type: INDEX
--

CREATE INDEX context_terms_tenant_context_key_idx ON context_terms USING btree (tenant_id, context_key);

--
-- Name: context_terms_tenant_id_idx; Type: INDEX
--

CREATE UNIQUE INDEX context_terms_tenant_id_idx ON context_terms USING btree (tenant_id, id);

--
-- Name: context_terms_tenant_short_reference_idx; Type: INDEX
--

CREATE UNIQUE INDEX context_terms_tenant_short_reference_idx ON context_terms USING btree (tenant_id, short_reference);

--
-- Name: contexts_search_idx; Type: INDEX
--

CREATE INDEX contexts_search_idx ON contexts USING gin (to_tsvector('simple'::regconfig, ((title || ' '::text) || summary)));

--
-- Name: contexts_tenant_id_idx; Type: INDEX
--

CREATE UNIQUE INDEX contexts_tenant_id_idx ON contexts USING btree (tenant_id, id);

--
-- Name: contexts_tenant_reference_idx; Type: INDEX
--

CREATE UNIQUE INDEX contexts_tenant_reference_idx ON contexts USING btree (tenant_id, reference);

--
-- Name: contexts_tenant_scope_entity_id_idx; Type: INDEX
--

CREATE UNIQUE INDEX contexts_tenant_scope_entity_id_idx ON contexts USING btree (tenant_id, scope_entity_id) WHERE (scope_entity_id IS NOT NULL);

--
-- Name: contexts_tenant_short_reference_idx; Type: INDEX
--

CREATE UNIQUE INDEX contexts_tenant_short_reference_idx ON contexts USING btree (tenant_id, short_reference);

--
-- Name: entities_search_idx; Type: INDEX
--

CREATE INDEX entities_search_idx ON entities USING gin (to_tsvector('simple'::regconfig, ((title || ' '::text) || body)));

--
-- Name: entities_tenant_reference_idx; Type: INDEX
--

CREATE UNIQUE INDEX entities_tenant_reference_idx ON entities USING btree (tenant_id, reference);

--
-- Name: entities_tenant_short_reference_idx; Type: INDEX
--

CREATE UNIQUE INDEX entities_tenant_short_reference_idx ON entities USING btree (tenant_id, short_reference);

--
-- Name: issue_breakdown_drafts_active_target_idx; Type: INDEX
--

CREATE UNIQUE INDEX issue_breakdown_drafts_active_target_idx ON issue_breakdown_drafts USING btree (tenant_id, target_id) WHERE (status = 'active'::text);

--
-- Name: issue_breakdown_drafts_target_idx; Type: INDEX
--

CREATE INDEX issue_breakdown_drafts_target_idx ON issue_breakdown_drafts USING btree (tenant_id, target_id, created_at DESC);

--
-- Name: issue_comment_references_tenant_issue_idx; Type: INDEX
--

CREATE INDEX issue_comment_references_tenant_issue_idx ON issue_comment_references USING btree (tenant_id, issue_id, "position");

--
-- Name: issue_comments_search_idx; Type: INDEX
--

CREATE INDEX issue_comments_search_idx ON issue_comments USING gin (to_tsvector('simple'::regconfig, body));

--
-- Name: issue_comments_tenant_issue_idx; Type: INDEX
--

CREATE INDEX issue_comments_tenant_issue_idx ON issue_comments USING btree (tenant_id, issue_id, created_at, reference);

--
-- Name: issue_comments_tenant_short_reference_idx; Type: INDEX
--

CREATE UNIQUE INDEX issue_comments_tenant_short_reference_idx ON issue_comments USING btree (tenant_id, short_reference);

--
-- Name: plan_entries_search_idx; Type: INDEX
--

CREATE INDEX plan_entries_search_idx ON plan_entries USING gin (to_tsvector('simple'::regconfig, body));

--
-- Name: plan_entries_tenant_plan_idx; Type: INDEX
--

CREATE INDEX plan_entries_tenant_plan_idx ON plan_entries USING btree (tenant_id, plan_id, created_at, reference);

--
-- Name: relations_tenant_to_id_idx; Type: INDEX
--

CREATE INDEX relations_tenant_to_id_idx ON relations USING btree (tenant_id, to_id);

--
-- Name: revision_entries_chain_idx; Type: INDEX
--

CREATE UNIQUE INDEX revision_entries_chain_idx ON revision_entries USING btree (tenant_id, project_id, record_kind, record_key, revision);

--
-- Name: revision_entries_project_idx; Type: INDEX
--

CREATE INDEX revision_entries_project_idx ON revision_entries USING btree (tenant_id, project_id);

--
-- Name: users_tenant_authentication_subject_idx; Type: INDEX
--

CREATE UNIQUE INDEX users_tenant_authentication_subject_idx ON users USING btree (tenant_id, authentication_subject);

--
-- Name: completion_observations completion_observations_tenant_id_issue_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY completion_observations
    ADD CONSTRAINT completion_observations_tenant_id_issue_id_fkey FOREIGN KEY (tenant_id, issue_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE;

--
-- Name: context_terms context_terms_tenant_id_context_key_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY context_terms
    ADD CONSTRAINT context_terms_tenant_id_context_key_fkey FOREIGN KEY (tenant_id, context_key) REFERENCES contexts(tenant_id, key) ON DELETE CASCADE;

--
-- Name: contexts contexts_tenant_id_scope_entity_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY contexts
    ADD CONSTRAINT contexts_tenant_id_scope_entity_id_fkey FOREIGN KEY (tenant_id, scope_entity_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE;

--
-- Name: instruction_defaults instruction_defaults_version_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY instruction_defaults
    ADD CONSTRAINT instruction_defaults_version_fkey FOREIGN KEY (version) REFERENCES instruction_bundles(version);

--
-- Name: issue_breakdown_drafts issue_breakdown_drafts_tenant_id_target_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY issue_breakdown_drafts
    ADD CONSTRAINT issue_breakdown_drafts_tenant_id_target_id_fkey FOREIGN KEY (tenant_id, target_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE;

--
-- Name: issue_comment_references issue_comment_references_tenant_id_comment_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY issue_comment_references
    ADD CONSTRAINT issue_comment_references_tenant_id_comment_id_fkey FOREIGN KEY (tenant_id, comment_id) REFERENCES issue_comments(tenant_id, id) ON DELETE CASCADE;

--
-- Name: issue_comment_references issue_comment_references_tenant_id_issue_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY issue_comment_references
    ADD CONSTRAINT issue_comment_references_tenant_id_issue_id_fkey FOREIGN KEY (tenant_id, issue_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE;

--
-- Name: issue_comments issue_comments_tenant_id_issue_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY issue_comments
    ADD CONSTRAINT issue_comments_tenant_id_issue_id_fkey FOREIGN KEY (tenant_id, issue_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE;

--
-- Name: plan_entries plan_entries_tenant_id_plan_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY plan_entries
    ADD CONSTRAINT plan_entries_tenant_id_plan_id_fkey FOREIGN KEY (tenant_id, plan_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE;

--
-- Name: plan_entry_references plan_entry_references_tenant_id_entity_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY plan_entry_references
    ADD CONSTRAINT plan_entry_references_tenant_id_entity_id_fkey FOREIGN KEY (tenant_id, entity_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE;

--
-- Name: plan_entry_references plan_entry_references_tenant_id_plan_entry_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY plan_entry_references
    ADD CONSTRAINT plan_entry_references_tenant_id_plan_entry_id_fkey FOREIGN KEY (tenant_id, plan_entry_id) REFERENCES plan_entries(tenant_id, id) ON DELETE CASCADE;

--
-- Name: plan_entry_supersessions plan_entry_supersessions_tenant_id_plan_entry_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY plan_entry_supersessions
    ADD CONSTRAINT plan_entry_supersessions_tenant_id_plan_entry_id_fkey FOREIGN KEY (tenant_id, plan_entry_id) REFERENCES plan_entries(tenant_id, id) ON DELETE CASCADE;

--
-- Name: plan_entry_supersessions plan_entry_supersessions_tenant_id_superseded_entry_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY plan_entry_supersessions
    ADD CONSTRAINT plan_entry_supersessions_tenant_id_superseded_entry_id_fkey FOREIGN KEY (tenant_id, superseded_entry_id) REFERENCES plan_entries(tenant_id, id) ON DELETE CASCADE;

--
-- Name: project_settings project_settings_tenant_id_project_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY project_settings
    ADD CONSTRAINT project_settings_tenant_id_project_id_fkey FOREIGN KEY (tenant_id, project_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE;

--
-- Name: relations relations_tenant_id_from_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY relations
    ADD CONSTRAINT relations_tenant_id_from_id_fkey FOREIGN KEY (tenant_id, from_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE;

--
-- Name: relations relations_tenant_id_to_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY relations
    ADD CONSTRAINT relations_tenant_id_to_id_fkey FOREIGN KEY (tenant_id, to_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE;

--
-- Name: completion_observations; Type: ROW SECURITY
--

ALTER TABLE completion_observations ENABLE ROW LEVEL SECURITY;

--
-- Name: context_terms; Type: ROW SECURITY
--

ALTER TABLE context_terms ENABLE ROW LEVEL SECURITY;

--
-- Name: contexts; Type: ROW SECURITY
--

ALTER TABLE contexts ENABLE ROW LEVEL SECURITY;

--
-- Name: counters; Type: ROW SECURITY
--

ALTER TABLE counters ENABLE ROW LEVEL SECURITY;

--
-- Name: entities; Type: ROW SECURITY
--

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;

--
-- Name: instruction_personal_fragments instruction_fragment_owner_isolation; Type: POLICY
--

CREATE POLICY instruction_fragment_owner_isolation ON instruction_personal_fragments USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (user_id = current_setting('app.instruction_user_id'::text, true)))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (user_id = current_setting('app.instruction_user_id'::text, true))));

--
-- Name: instruction_history; Type: ROW SECURITY
--

ALTER TABLE instruction_history ENABLE ROW LEVEL SECURITY;

--
-- Name: instruction_overrides; Type: ROW SECURITY
--

ALTER TABLE instruction_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: instruction_history instruction_owner_isolation; Type: POLICY
--

CREATE POLICY instruction_owner_isolation ON instruction_history USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (user_id = current_setting('app.instruction_user_id'::text, true)))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (user_id = current_setting('app.instruction_user_id'::text, true))));

--
-- Name: instruction_overrides instruction_owner_isolation; Type: POLICY
--

CREATE POLICY instruction_owner_isolation ON instruction_overrides USING (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (user_id = current_setting('app.instruction_user_id'::text, true)))) WITH CHECK (((tenant_id = current_setting('app.tenant_id'::text, true)) AND (user_id = current_setting('app.instruction_user_id'::text, true))));

--
-- Name: instruction_personal_fragments; Type: ROW SECURITY
--

ALTER TABLE instruction_personal_fragments ENABLE ROW LEVEL SECURITY;

--
-- Name: issue_breakdown_drafts; Type: ROW SECURITY
--

ALTER TABLE issue_breakdown_drafts ENABLE ROW LEVEL SECURITY;

--
-- Name: issue_comment_references; Type: ROW SECURITY
--

ALTER TABLE issue_comment_references ENABLE ROW LEVEL SECURITY;

--
-- Name: issue_comments; Type: ROW SECURITY
--

ALTER TABLE issue_comments ENABLE ROW LEVEL SECURITY;

--
-- Name: plan_entries; Type: ROW SECURITY
--

ALTER TABLE plan_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: plan_entry_references; Type: ROW SECURITY
--

ALTER TABLE plan_entry_references ENABLE ROW LEVEL SECURITY;

--
-- Name: plan_entry_supersessions; Type: ROW SECURITY
--

ALTER TABLE plan_entry_supersessions ENABLE ROW LEVEL SECURITY;

--
-- Name: project_settings; Type: ROW SECURITY
--

ALTER TABLE project_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: relations; Type: ROW SECURITY
--

ALTER TABLE relations ENABLE ROW LEVEL SECURITY;

--
-- Name: revision_entries; Type: ROW SECURITY
--

ALTER TABLE revision_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: completion_observations tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON completion_observations USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: context_terms tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON context_terms USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: contexts tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON contexts USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: counters tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON counters USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: entities tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON entities USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: issue_breakdown_drafts tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON issue_breakdown_drafts USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: issue_comment_references tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON issue_comment_references USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: issue_comments tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON issue_comments USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: plan_entries tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON plan_entries USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: plan_entry_references tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON plan_entry_references USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: plan_entry_supersessions tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON plan_entry_supersessions USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: project_settings tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON project_settings USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: relations tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON relations USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: revision_entries tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON revision_entries USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: users tenant_isolation; Type: POLICY
--

CREATE POLICY tenant_isolation ON users USING ((tenant_id = current_setting('app.tenant_id'::text, true))) WITH CHECK ((tenant_id = current_setting('app.tenant_id'::text, true)));

--
-- Name: users; Type: ROW SECURITY
--

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
