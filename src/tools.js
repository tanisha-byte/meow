'use strict';

// Every tool on the Bolna MCP server (https://mcp.bolna.ai/api/mcp), re-declared
// as Claude tool schemas. `tier` follows Bolna's own official classification
// (docs.bolna.ai/build-with-ai/mcp-tool-list): "Read" / "Write" / "Write ⚠".
//   read   -> executed immediately, no confirmation
//   write  -> Slack button with a native confirm dialog before it runs
//   danger -> Slack button with a stronger, red confirm dialog (irreversible,
//             spends money, or places a real call)

const API_KEY_PROP = {
  api_key: {
    type: 'string',
    description: "Optional: run this call against a different account than the one connected (e.g. a sub-account's sa-... key).",
  },
};

function tool(name, description, tier, properties, required, opts) {
  return {
    name,
    description,
    tier,
    warning: (opts && opts.warning) || null,
    input_schema: {
      type: 'object',
      properties: { ...properties, ...API_KEY_PROP },
      required: required || [],
    },
  };
}

const BOLNA_TOOLS = [
  // ---------- Agents ----------
  tool('list_agents', 'List agents in the account — ID, name, status, created date.', 'read', {
    page_number: { type: 'integer', minimum: 1, default: 1 },
    page_size: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
  }),

  tool('get_agent', 'Full config of one agent — prompts, LLM, voice, telephony, tools.', 'read', {
    agent_id: { type: 'string', minLength: 1 },
  }, ['agent_id']),

  tool('create_agent', 'Create a new agent, returns its ID. Additive — never touches an existing agent. If unsure of the shape, call get_agent on a similar existing agent first and adapt its tasks/tools_config.', 'write', {
    agent_config: {
      type: 'object',
      description: 'agent_name and tasks are required. tasks[].tools_config needs llm_agent, synthesizer, transcriber, input, output.',
      properties: {
        agent_name: { type: 'string', minLength: 1 },
        agent_type: { type: 'string' },
        agent_welcome_message: { type: 'string' },
        webhook_url: { type: 'string', format: 'uri' },
        calling_guardrails: { type: 'object', properties: { call_start_hour: { type: 'integer' }, call_end_hour: { type: 'integer' } } },
        tasks: {
          type: 'array', minItems: 1,
          items: {
            type: 'object',
            properties: {
              task_type: { type: 'string', enum: ['conversation', 'extraction', 'summarization'] },
              toolchain: { type: 'object', properties: { execution: { type: 'string', enum: ['parallel', 'sequential'] }, pipelines: { type: 'array' } } },
              task_config: { type: 'object' },
              tools_config: { type: 'object' },
            },
          },
        },
      },
      required: ['agent_name', 'tasks'],
    },
    agent_prompts: {
      type: 'object',
      description: 'Keyed by task_1, task_2, ... e.g. { "task_1": { "system_prompt": "..." } }',
    },
  }, ['agent_config', 'agent_prompts']),

  tool('update_agent', "Patch an agent's name, prompts, welcome message, webhook, voice, telephony provider, or calling guardrails. Only the fields you pass change.", 'danger', {
    agent_id: { type: 'string', minLength: 1 },
    agent_config: {
      type: 'object',
      properties: {
        agent_name: { type: 'string' },
        agent_welcome_message: { type: 'string' },
        webhook_url: { type: 'string', format: 'uri' },
        telephony_provider: { type: 'string', enum: ['twilio', 'plivo', 'exotel', 'vobiz', 'sip-trunk', 'default'] },
        calling_guardrails: { type: 'object', properties: { call_start_hour: { type: 'integer' }, call_end_hour: { type: 'integer' } } },
        synthesizer: { type: 'object', properties: { provider: { type: 'string' }, provider_config: { type: 'object' }, stream: { type: 'boolean' }, buffer_size: { type: 'integer' } }, required: ['provider', 'provider_config'] },
        ingest_source_config: { type: 'object' },
      },
    },
    agent_prompts: { type: 'object', description: '{ "task_1": { "system_prompt": "..." } }' },
  }, ['agent_id'], { warning: 'This changes a real, possibly live, agent.' }),

  tool('delete_agent', 'Permanently delete an agent and its history — batches, executions, everything. Cannot be undone.', 'danger', {
    agent_id: { type: 'string', minLength: 1 },
  }, ['agent_id'], { warning: 'Irreversible. Deletes the agent and ALL of its call history.' }),

  tool('stop_agent_queued_calls', "Cancel every queued or scheduled call for one agent that hasn't started ringing yet.", 'write', {
    agent_id: { type: 'string', minLength: 1 },
  }, ['agent_id']),

  // ---------- Calls & executions ----------
  tool('start_outbound_call', 'Place a real outbound call right now from an agent to a recipient. Spends account balance.', 'danger', {
    agent_id: { type: 'string', minLength: 1 },
    recipient_phone_number: { type: 'string', pattern: '^\\+[1-9]\\d{1,14}$' },
    from_phone_number: { type: 'string', pattern: '^\\+[1-9]\\d{1,14}$' },
    user_data: { type: 'object', description: 'Dynamic variables for prompt personalization.' },
  }, ['agent_id', 'recipient_phone_number'], { warning: 'Places a real call to a real phone number and spends balance.' }),

  tool('stop_call', "Cancel a single call that hasn't started ringing yet.", 'write', {
    execution_id: { type: 'string', minLength: 1 },
  }, ['execution_id']),

  tool('list_agent_executions', 'Call history for one agent. Defaults to the last 7 days; date range cannot exceed 7 days.', 'read', {
    agent_id: { type: 'string', minLength: 1 },
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
    page_number: { type: 'integer', minimum: 1, default: 1 },
    page_size: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    status: { type: 'string', enum: ['scheduled', 'queued', 'rescheduled', 'ringing', 'initiated', 'in-progress', 'call-disconnected', 'completed', 'balance-low', 'busy', 'no-answer', 'canceled', 'failed', 'stopped', 'error'] },
  }, ['agent_id']),

  tool('get_execution', 'Full call detail — transcript, status, cost, telephony data, latency breakdown.', 'read', {
    execution_id: { type: 'string', minLength: 1 },
  }, ['execution_id']),

  tool('get_execution_raw_logs', 'Raw per-component pipeline logs for one call — transcriber, LLM, and synthesizer timing and payloads. Use for deep debugging beyond get_execution.', 'read', {
    execution_id: { type: 'string', minLength: 1 },
  }, ['execution_id']),

  tool('list_batch_executions', 'Every call execution within one batch.', 'read', {
    batch_id: { type: 'string', minLength: 1 },
    page_number: { type: 'integer', minimum: 1, default: 1 },
    page_size: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
  }, ['batch_id']),

  // ---------- Batches ----------
  tool('list_batches', 'Batch campaigns for one agent — status and schedule.', 'read', {
    agent_id: { type: 'string', minLength: 1 },
    page_number: { type: 'integer', minimum: 1, default: 1 },
    page_size: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
  }, ['agent_id']),

  tool('get_batch', "One batch's status, schedule, and contact counts.", 'read', {
    batch_id: { type: 'string', minLength: 1 },
  }, ['batch_id']),

  tool('create_batch', 'Create a batch of outbound calls from a recipient list. Idle after creation — schedule_batch actually starts calling.', 'write', {
    agent_id: { type: 'string', minLength: 1 },
    recipients: {
      type: 'array', minItems: 1,
      items: { type: 'object', properties: { contact_number: { type: 'string', pattern: '^\\+[1-9]\\d{1,14}$' } }, required: ['contact_number'], additionalProperties: { type: 'string' } },
      description: 'Each recipient needs contact_number (E.164). Any other field becomes a {variable} in the prompt.',
    },
    from_phone_numbers: { type: 'array', items: { type: 'string', pattern: '^\\+[1-9]\\d{1,14}$' } },
    webhook_url: { type: 'string', format: 'uri' },
    retry_config: { type: 'object', properties: { enabled: { type: 'boolean' }, max_retries: { type: 'integer', minimum: 1 }, retry_intervals_minutes: { type: 'array', items: { type: 'integer', minimum: 1 } } } },
  }, ['agent_id', 'recipients']),

  tool('delete_batch', 'Permanently delete a batch and its recipient list.', 'danger', {
    batch_id: { type: 'string', minLength: 1 },
  }, ['batch_id'], { warning: 'Irreversible.' }),

  tool('schedule_batch', 'Start calling every recipient in a batch at a future time (at least 2 minutes out). Spends account balance.', 'danger', {
    batch_id: { type: 'string', minLength: 1 },
    scheduled_at: { type: 'string', format: 'date-time' },
    bypass_call_guardrails: { type: 'boolean', default: false },
  }, ['batch_id', 'scheduled_at'], { warning: 'Commits to placing real calls to every recipient and spending balance.' }),

  tool('stop_batch', 'Halt a running or scheduled batch — cancels calls not yet started.', 'write', {
    batch_id: { type: 'string', minLength: 1 },
  }, ['batch_id']),

  // ---------- Dispositions ----------
  tool('list_dispositions', 'Dispositions configured for one agent. Omit agent_id to see every disposition on the account.', 'read', {
    agent_id: { type: 'string', minLength: 1 },
  }),

  tool('get_disposition', "One disposition's field type, validation, and prompt.", 'read', {
    disposition_id: { type: 'string', minLength: 1 },
    agent_id: { type: 'string', minLength: 1 },
  }, ['disposition_id']),

  tool('create_disposition', 'Add a single structured-extraction disposition to an agent.', 'write', {
    agent_id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    question: { type: 'string', minLength: 1 },
    category: { type: 'string', default: 'General' },
    is_objective: { type: 'boolean', default: false },
    is_subjective: { type: 'boolean', default: false },
    subjective_type: { type: 'string', enum: ['text', 'timestamp', 'numeric', 'boolean', 'email', 'regex'], default: 'text' },
    subjective_type_config: { type: 'object', properties: { pattern: { type: 'string' }, description: { type: 'string' } } },
    objective_options: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, condition: { type: 'string' } }, required: ['value', 'condition'] } },
    model: { type: 'string', default: 'gpt-4.1-mini' },
    system_prompt: { type: 'string' },
  }, ['agent_id', 'name', 'question']),

  tool('bulk_create_dispositions', 'Add several dispositions to an agent in one call. All-or-nothing.', 'write', {
    agent_id: { type: 'string', minLength: 1 },
    dispositions: {
      type: 'array', minItems: 1,
      items: { type: 'object', properties: { name: { type: 'string' }, question: { type: 'string' }, category: { type: 'string' }, is_objective: { type: 'boolean' }, is_subjective: { type: 'boolean' } }, required: ['name', 'question'] },
    },
  }, ['agent_id', 'dispositions']),

  tool('update_disposition', "Change a disposition's field, validation, or prompt. May fork a private copy if the disposition is shared across agents.", 'write', {
    disposition_id: { type: 'string', minLength: 1 },
    agent_id: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    question: { type: 'string' },
    category: { type: 'string' },
    is_objective: { type: 'boolean' },
    is_subjective: { type: 'boolean' },
    subjective_type: { type: 'string', enum: ['text', 'timestamp', 'numeric', 'boolean', 'email', 'regex'] },
    objective_options: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, condition: { type: 'string' } } } },
  }, ['disposition_id']),

  tool('delete_disposition', 'Permanently delete a disposition. Past call results are unaffected — only future calls stop evaluating it.', 'danger', {
    disposition_id: { type: 'string', minLength: 1 },
  }, ['disposition_id'], { warning: 'Irreversible for the disposition definition (past extracted data is kept).' }),

  tool('test_dispositions', "Run an agent's dispositions against a transcript you provide and preview the extracted output. No real call.", 'read', {
    agent_id: { type: 'string', minLength: 1 },
    transcript: { type: 'string', minLength: 1, maxLength: 50000 },
    call_date: { type: 'string', format: 'date-time' },
  }, ['agent_id', 'transcript']),

  // ---------- Knowledge bases ----------
  tool('list_knowledgebases', 'Every knowledgebase on the account.', 'read', {}),

  tool('get_knowledgebase', "One knowledgebase's file name, status, and settings, by ID.", 'read', {
    rag_id: { type: 'string', minLength: 1 },
  }, ['rag_id']),

  tool('create_knowledgebase', 'Create a knowledgebase by scraping a URL for RAG. PDF upload is not supported here. Processing is async — check progress with get_knowledgebase.', 'write', {
    url: { type: 'string', format: 'uri' },
    chunk_size: { type: 'integer', default: 512 },
    overlapping: { type: 'integer', default: 128 },
    similarity_top_k: { type: 'integer', default: 15 },
    language_support: { type: 'string', enum: ['multilingual'] },
  }, ['url']),

  tool('delete_knowledgebase', 'Permanently delete a knowledgebase. Agents referencing it lose that RAG context.', 'danger', {
    rag_id: { type: 'string', minLength: 1 },
  }, ['rag_id'], { warning: 'Irreversible. Breaks any agent still using it for RAG.' }),

  // ---------- Phone numbers & inbound ----------
  tool('list_phone_numbers', 'Phone numbers on the account and their linked agent.', 'read', {}),

  tool('search_phone_numbers', 'Search available numbers to buy, by country or a 3-character pattern. Does not purchase anything.', 'read', {
    country: { type: 'string', enum: ['US', 'IN'] },
    pattern: { type: 'string', minLength: 3, maxLength: 3 },
    provider: { type: 'string', enum: ['twilio', 'plivo', 'vobiz'] },
  }, ['country']),

  tool('buy_phone_number', 'Purchase a phone number found via search_phone_numbers. Real recurring charge (~$5/mo). Not reversible after purchase.', 'danger', {
    country: { type: 'string', enum: ['US', 'IN'] },
    phone_number: { type: 'string', pattern: '^\\+[1-9]\\d{1,14}$' },
    provider: { type: 'string', enum: ['twilio', 'plivo', 'vobiz'] },
  }, ['country', 'phone_number'], { warning: 'Commits the account to a real, recurring charge (~$5/month) until deleted.' }),

  tool('delete_phone_number', 'Permanently release a phone number back to the pool. Stops billing but the number may not be recoverable.', 'danger', {
    phone_number_id: { type: 'string', minLength: 1 },
  }, ['phone_number_id'], { warning: 'Permanent. The number is not guaranteed to be recoverable afterward.' }),

  tool('setup_inbound_agent', 'Route inbound calls on a number to an agent, with an optional IVR menu.', 'write', {
    agent_id: { type: 'string', minLength: 1 },
    phone_number_id: { type: 'string', minLength: 1 },
    allow_multiple: { type: 'boolean', default: false },
    ivr_config: { type: 'object', properties: { enabled: { type: 'boolean' }, welcome_message: { type: 'string' }, timeout: { type: 'integer' }, max_retries: { type: 'integer' }, default_agent_id: { type: 'string' }, voice: { type: 'string' }, steps: { type: 'array' } }, required: ['enabled'] },
  }, ['agent_id', 'phone_number_id']),

  tool('unlink_inbound_agent', 'Remove inbound call routing from a phone number, so it no longer auto-answers with an agent.', 'write', {
    phone_number_id: { type: 'string', minLength: 1 },
  }, ['phone_number_id']),

  // ---------- SIP trunks ----------
  tool('list_sip_trunks', 'SIP trunks on the account, optionally filtered by active status.', 'read', {
    is_active: { type: 'boolean' },
  }),

  tool('get_sip_trunk', "One trunk's gateway, auth, and transport config.", 'read', {
    trunk_id: { type: 'string', minLength: 1 },
  }, ['trunk_id']),

  tool('create_sip_trunk', "Register a bring-your-own-telephony SIP trunk with its gateway and auth settings. auth_type 'userpass' needs auth_username/auth_password; 'ip-based' needs ip_identifiers.", 'write', {
    name: { type: 'string', minLength: 1 },
    provider: { type: 'string', minLength: 1 },
    auth_type: { type: 'string', enum: ['userpass', 'ip-based'] },
    auth_username: { type: 'string' },
    auth_password: { type: 'string' },
    gateways: { type: 'array', minItems: 1, items: { type: 'object', properties: { gateway_address: { type: 'string' }, port: { type: 'integer', default: 5060 }, priority: { type: 'integer', default: 1 } }, required: ['gateway_address'] } },
    ip_identifiers: { type: 'array', items: { type: 'object', properties: { ip_address: { type: 'string' } }, required: ['ip_address'] } },
    phone_numbers: { type: 'array', items: { type: 'object', properties: { phone_number: { type: 'string' }, name: { type: 'string' }, e164_check_enabled: { type: 'boolean' } }, required: ['phone_number'] } },
    transport: { type: 'string', enum: ['transport-udp', 'transport-tcp', 'transport-tls'], default: 'transport-udp' },
    media_encryption: { type: 'string', enum: ['no', 'sdes'], default: 'no' },
    inbound_enabled: { type: 'boolean', default: false },
    description: { type: 'string' },
  }, ['name', 'provider', 'auth_type', 'gateways']),

  tool('update_sip_trunk', 'Change a gateway, auth, or transport setting on a trunk. gateways/ip_identifiers fully replace the existing list — resend the complete array. provider and auth_type cannot change.', 'write', {
    trunk_id: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    is_active: { type: 'boolean' },
    gateways: { type: 'array', items: { type: 'object', properties: { gateway_address: { type: 'string' }, port: { type: 'integer' }, priority: { type: 'integer' } }, required: ['gateway_address'] } },
    ip_identifiers: { type: 'array', items: { type: 'object', properties: { ip_address: { type: 'string' } }, required: ['ip_address'] } },
    auth_username: { type: 'string' },
    auth_password: { type: 'string' },
    transport: { type: 'string', enum: ['transport-udp', 'transport-tcp', 'transport-tls'] },
    media_encryption: { type: 'string', enum: ['no', 'sdes'] },
    description: { type: 'string' },
  }, ['trunk_id']),

  tool('delete_sip_trunk', 'Permanently delete a SIP trunk. Cascades to all its gateways, IP identifiers, and phone numbers.', 'danger', {
    trunk_id: { type: 'string', minLength: 1 },
  }, ['trunk_id'], { warning: 'Irreversible. Cascades to every gateway, IP identifier, and number on the trunk.' }),

  tool('add_trunk_number', "Attach a DID number to a trunk. Then patch the agent's telephony provider to sip-trunk via update_agent to route calls through it.", 'write', {
    trunk_id: { type: 'string', minLength: 1 },
    phone_number: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    e164_check_enabled: { type: 'boolean', default: false },
  }, ['trunk_id', 'phone_number']),

  tool('remove_trunk_number', 'Detach a DID number from a trunk. If it was mapped to an agent, that mapping is removed too.', 'write', {
    trunk_id: { type: 'string', minLength: 1 },
    phone_number_id: { type: 'string', minLength: 1 },
  }, ['trunk_id', 'phone_number_id']),

  tool('list_trunk_numbers', 'DID numbers attached to one trunk.', 'read', {
    trunk_id: { type: 'string', minLength: 1 },
  }, ['trunk_id']),

  // ---------- Sub-accounts ----------
  tool('list_sub_accounts', 'Sub-accounts on the account, including their API keys.', 'read', {}),

  tool('create_sub_account', 'Create an isolated sub-account workspace with its own concurrency limits and auto-provisioned API key. Enterprise feature.', 'write', {
    name: { type: 'string', minLength: 1 },
    min_concurrency: { type: 'integer', minimum: 0 },
    max_concurrency: { type: 'integer', minimum: 0 },
    multi_tenant: { type: 'boolean', default: false },
  }, ['name', 'min_concurrency']),

  tool('update_sub_account', "Patch a sub-account's name or concurrency limits.", 'write', {
    sub_account_id: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    min_concurrency: { type: 'integer', minimum: 0 },
    max_concurrency: { type: 'integer', minimum: 0 },
  }, ['sub_account_id']),

  tool('delete_sub_account', 'Permanently delete a sub-account and everything inside it — agents, batches, executions.', 'danger', {
    sub_account_id: { type: 'string', minLength: 1 },
  }, ['sub_account_id'], { warning: 'Irreversible. Deletes every agent, batch, and execution inside this sub-account.' }),

  tool('get_sub_account_usage', 'Call volume and cost for one sub-account over a date range (defaults to month to date). Costs in cents.', 'read', {
    sub_account_id: { type: 'string', minLength: 1 },
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
  }, ['sub_account_id']),

  tool('get_all_sub_accounts_usage', 'Usage for every sub-account in the organization, in one call. Costs in cents.', 'read', {
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
  }),

  // ---------- Voice & providers ----------
  tool('list_tts_providers', 'Text-to-speech providers and models available to the account for a language.', 'read', {
    language: { type: 'string', minLength: 1, description: "BCP-47 code, e.g. 'en', 'hi'." },
  }, ['language']),

  tool('list_voices', 'Voices available for a specific TTS provider, model, and language. Call list_tts_providers first for provider_id/model_id.', 'read', {
    provider_id: { type: 'string', minLength: 1 },
    model_id: { type: 'string', minLength: 1 },
    language: { type: 'string', minLength: 1 },
    page: { type: 'integer', minimum: 1, default: 1 },
    page_size: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
  }, ['provider_id', 'model_id', 'language']),

  tool('list_providers', 'Telephony, LLM, transcriber, and TTS providers connected to the account. Secret values are masked.', 'read', {}),

  tool('remove_provider', "Disconnect a provider's credentials, by its provider_name from list_providers. Breaks any agent still using it.", 'danger', {
    provider_name: { type: 'string', minLength: 1 },
  }, ['provider_name'], { warning: 'Breaks every agent still relying on this provider.' }),

  // ---------- Violations ----------
  tool('list_violations', 'Flagged call violations — content policy, regulatory, or fraud — optionally filtered by status.', 'read', {
    status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'submitted'] },
    page_number: { type: 'integer', minimum: 1, default: 1 },
    page_size: { type: 'integer', minimum: 1, default: 20 },
  }),

  // ---------- Account ----------
  tool('get_user_info', 'Account profile, wallet balance, and concurrency limits.', 'read', {}),

  // ---------- Workflows ----------
  // A workflow is a multi-step, per-contact automation (call an agent,
  // branch on the outcome, wait, call an API, message over WhatsApp, retry)
  // — distinct from a single agent's own conversation. Edited as a draft,
  // then published as an immutable version before it can run.
  tool('create_workflow', 'Create a new (empty) workflow. Additive — save_workflow_draft adds the actual node graph.', 'write', {
    name: { type: 'string', minLength: 1, maxLength: 120 },
  }, ['name']),

  tool('list_workflows', 'List workflows, optionally filtered by name.', 'read', {
    name: { type: 'string', description: 'Case-insensitive substring filter.' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  }),

  tool('get_workflow', "A workflow's status plus its full draft/published version history (each version with its campaign/contact outcome totals).", 'read', {
    workflow_id: { type: 'string', minLength: 1 },
  }, ['workflow_id']),

  tool('rename_workflow', 'Rename a workflow.', 'write', {
    workflow_id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1, maxLength: 120 },
  }, ['workflow_id', 'name']),

  tool('delete_workflow', 'Permanently delete a workflow, including its draft and every published version.', 'danger', {
    workflow_id: { type: 'string', minLength: 1 },
  }, ['workflow_id'], { warning: 'Irreversible. Deletes the workflow and every published version.' }),

  tool('get_workflow_draft', "A workflow's current editable draft definition and its revision number (needed to save further edits without a conflict).", 'read', {
    workflow_id: { type: 'string', minLength: 1 },
  }, ['workflow_id']),

  tool('save_workflow_draft', "Overwrite a workflow's entire draft node graph. expected_revision must match the draft's current revision (from get_workflow_draft) or this fails with a 409 conflict. Call list_workflow_node_types first to see available node types and their config fields.", 'danger', {
    workflow_id: { type: 'string', minLength: 1 },
    expected_revision: { type: 'integer', minimum: 0 },
    definition: {
      type: 'object',
      description: "The node graph. entry_node_id and on_no_match are both required (despite on_no_match looking optional in some docs — the live API rejects a save without it). Each node in nodes[] needs id, type (start/agent/extraction/api/time/retry/aisensy_whatsapp/end), config, and (except 'end') a cases[] array of { when: {always:true} | {cmp, left:{var|const}, right:{var|const}}, then: {to: <node_id>} }.",
      properties: {
        entry_node_id: { type: 'string' },
        on_no_match: { type: 'string' },
        nodes: { type: 'array', items: { type: 'object' } },
      },
      required: ['entry_node_id', 'nodes'],
    },
  }, ['workflow_id', 'expected_revision', 'definition'], { warning: "Overwrites the entire draft node graph. Get the current revision from get_workflow_draft first, or this fails with a conflict." }),

  tool('validate_workflow', "Check a workflow's saved draft for errors (dangling case targets, unbounded cycles, unknown agent references) before publishing. Errors block publish_workflow; warnings don't.", 'read', {
    workflow_id: { type: 'string', minLength: 1 },
  }, ['workflow_id']),

  tool('publish_workflow', "Freeze a workflow's current draft as a new immutable published version, which run_workflow and new campaigns then use. Fails if the draft has unresolved validation errors.", 'danger', {
    workflow_id: { type: 'string', minLength: 1 },
  }, ['workflow_id'], { warning: 'Creates a new immutable published version that new campaigns/runs will use. Cannot be edited or undone.' }),

  tool('get_workflow_version', "Retrieve a specific published version of a workflow, including its full node graph.", 'read', {
    workflow_id: { type: 'string', minLength: 1 },
    version: { type: 'integer', minimum: 1 },
  }, ['workflow_id', 'version']),

  tool('run_workflow', "Run a single contact through a workflow's latest published version right now, creating a real execution. Fields the start node declares may go at the top level of `contact` or nested under contact.custom_fields; undeclared fields are rejected. Reusing the same reference_id returns the existing execution instead of starting a new one.", 'danger', {
    workflow_id: { type: 'string', minLength: 1 },
    contact: {
      type: 'object',
      properties: {
        reference_id: { type: 'string' },
        mobile_number: { type: 'string', pattern: '^\\+[1-9]\\d{1,14}$' },
        name: { type: 'string' },
        email: { type: 'string', format: 'email' },
        custom_fields: { type: 'object' },
      },
    },
  }, ['workflow_id', 'contact'], { warning: 'Places a real call or sends a real message to this contact right now.' }),

  tool('list_workflow_node_types', 'Every node type the workflow engine supports (start, agent, extraction, api, time, retry, aisensy_whatsapp, end), with each one’s config parameters, bounds, and defaults. Call this before authoring a definition for save_workflow_draft.', 'read', {}),

  // ---------- Workflow campaigns ----------
  // Runs many contacts through one workflow version as a batch.
  tool('create_workflow_campaign', 'Create a campaign pinned to a workflow version (defaults to the latest published at creation time). Starts as an empty draft — upload_workflow_campaign_entries adds contacts, then start_workflow_campaign (or scheduled_at here) actually dispatches.', 'write', {
    workflow_id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    version: { type: 'integer', minimum: 1, description: 'Published version to pin. Omit to pin the latest published version at creation time.' },
    binding: { type: 'object', description: 'Optional per-campaign overrides for agent and phone number mappings.' },
    scheduled_at: { type: 'string', format: 'date-time', description: 'Timezone-aware timestamp to start the campaign at. Omit to start manually.' },
  }, ['workflow_id', 'name']),

  tool('list_workflow_campaigns', 'List workflow campaigns, optionally filtered by workflow, status, or kind.', 'read', {
    workflow_id: { type: 'string' },
    status: { type: 'string', enum: ['draft', 'scheduled', 'running', 'paused', 'completed', 'aborted'] },
    kind: { type: 'string', enum: ['batch', 'continuous', 'api'] },
    sort_by: { type: 'string', enum: ['created_at', 'updated_at', 'name', 'entries_count', 'success_count', 'failure_count'] },
    order: { type: 'string', enum: ['asc', 'desc'] },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  }),

  tool('get_workflow_campaign', "A campaign's status and totals, plus a breakdown of entry counts by state and validation error counts.", 'read', {
    campaign_id: { type: 'string', minLength: 1 },
  }, ['campaign_id']),

  tool('delete_workflow_campaign', 'Permanently delete a campaign. Only allowed while it’s an empty draft that hasn’t started.', 'danger', {
    campaign_id: { type: 'string', minLength: 1 },
  }, ['campaign_id'], { warning: 'Irreversible.' }),

  tool('upload_workflow_campaign_entries', 'Add contacts to a campaign for it to run. Only reference_id, mobile_number, name, and email are standard fields — anything else the pinned workflow’s start node declares should go in custom_fields. Rows that fail validation are reported individually without blocking the ones that succeed.', 'write', {
    campaign_id: { type: 'string', minLength: 1 },
    entries: {
      type: 'array', minItems: 1,
      items: {
        type: 'object',
        properties: {
          reference_id: { type: 'string' },
          mobile_number: { type: 'string', pattern: '^\\+[1-9]\\d{1,14}$' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          custom_fields: { type: 'object' },
        },
      },
    },
  }, ['campaign_id', 'entries']),

  tool('list_workflow_campaign_entries', 'List the contacts uploaded to a campaign, optionally filtered by status.', 'read', {
    campaign_id: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['pending', 'failed_validation', 'dispatched', 'completed'] },
    sort_by: { type: 'string', enum: ['created_at', 'reference_id', 'status'] },
    order: { type: 'string', enum: ['asc', 'desc'] },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  }, ['campaign_id']),

  tool('get_workflow_campaign_entries_template', "The CSV header row a campaign's pinned workflow version expects for entry uploads (system fields plus any custom fields its start node declares).", 'read', {
    campaign_id: { type: 'string', minLength: 1 },
  }, ['campaign_id']),

  tool('start_workflow_campaign', 'Start a draft or scheduled campaign immediately, dispatching its pending entries as real calls/messages. Fails if there are no pending entries or it already started.', 'danger', {
    campaign_id: { type: 'string', minLength: 1 },
  }, ['campaign_id'], { warning: 'Commits to placing real calls/messages to every pending entry and spending balance.' }),

  tool('pause_workflow_campaign', 'Pause a scheduled or running campaign, halting new dispatches until resumed.', 'write', {
    campaign_id: { type: 'string', minLength: 1 },
  }, ['campaign_id']),

  tool('resume_workflow_campaign', "Resume a paused campaign's dispatching.", 'danger', {
    campaign_id: { type: 'string', minLength: 1 },
  }, ['campaign_id'], { warning: 'Resumes placing real calls/messages to remaining pending entries and spending balance.' }),

  tool('abort_workflow_campaign', 'Permanently terminate a campaign, cancelling any in-flight dispatching. Terminal — cannot be resumed or restarted afterward.', 'danger', {
    campaign_id: { type: 'string', minLength: 1 },
  }, ['campaign_id'], { warning: 'Irreversible — a terminal state. The campaign cannot be resumed or restarted after this.' }),

  tool('list_workflow_campaign_executions', 'List the per-contact executions a campaign has created, optionally filtered by status or outcome.', 'read', {
    campaign_id: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'cancelled', 'aborted'] },
    outcome: { type: 'string', enum: ['success', 'failure', 'neutral', 'none'] },
    sort_by: { type: 'string', enum: ['created_at', 'updated_at', 'status', 'outcome'] },
    order: { type: 'string', enum: ['asc', 'desc'] },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  }, ['campaign_id']),

  tool('get_workflow_campaign_report', 'Aggregated report for a campaign: execution counts by status, termination reasons, and a per-node funnel of attempt counts.', 'read', {
    campaign_id: { type: 'string', minLength: 1 },
  }, ['campaign_id']),

  // ---------- Workflow executions ----------
  // A single contact's run through a workflow, created by run_workflow or a campaign.
  tool('get_workflow_execution', 'A single contact’s progress through a workflow: current node, every node attempt in order, the most recent 100 timeline events, and outcome once terminal.', 'read', {
    execution_id: { type: 'string', minLength: 1 },
  }, ['execution_id']),

  tool('cancel_workflow_execution', 'Terminate a running workflow execution for a single contact.', 'write', {
    execution_id: { type: 'string', minLength: 1 },
    reason: { type: 'string', description: 'Free-form reason recorded on the cancellation.' },
  }, ['execution_id']),

  // ---------- Docs (no account data) ----------
  tool('search_docs', "Search Bolna's documentation for pages matching a query.", 'read', {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
  }, ['query']),

  tool('get_doc', "Fetch a Bolna documentation page's full content, given a URL or path from search_docs.", 'read', {
    url: { type: 'string', minLength: 1 },
  }, ['url']),
];

const BOLNA_TOOLS_BY_NAME = Object.fromEntries(BOLNA_TOOLS.map((t) => [t.name, t]));

// What Claude actually sees in the `tools` array of the Messages API call.
const CLAUDE_TOOLS = BOLNA_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}));

module.exports = { BOLNA_TOOLS, BOLNA_TOOLS_BY_NAME, CLAUDE_TOOLS };
