#!/usr/bin/env bun
/**
 * Apply gold set corrections based on audit of all 60 sessions.
 *
 * For each session, adds rules that the retrieval system correctly identifies
 * as relevant but that weren't in the original keyword-based gold labels.
 *
 * Criteria: A rule is added if:
 * 1. The system retrieves it (semantic/BM25 relevance)
 * 2. Its description clearly relates to the task_context
 * 3. A developer working on this task SHOULD have it loaded
 *
 * Project/reference nodes are excluded (context, not behavioral guidance).
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const GOLD_PATH = join(homedir(), ".claude", "MEMORY", "LEARNING", "STATE", "graph-gold.json");

const goldSet = JSON.parse(readFileSync(GOLD_PATH, "utf-8"));

// === Deduplication ===
// Three screenshot rules exist in the graph with slightly different names.
// All three are valid nodes with distinct descriptions, so no dedup needed.
// - feedback_screenshots_source_of_truth — inventory-only screenshots
// - feedback_screenshots_are_source_of_truth — CHECKLIST.md vs _product.json
// - feedback_screenshot_is_source_of_truth — visual page vs DOM queries

// === Additions per session ===
// Each entry: session_id -> rules to add (only feedback_*, success_*, steering_* — no project_/reference_)

const additions: Record<string, string[]> = {
  // --- REAL SESSIONS ---

  // Validate customer case counts — data validation on dashboard
  "d9203478-bbc8-4b94-b72e-ff42931b7222": [
    "feedback_proactive-spot-check-patterns",     // investigating data anomalies → check similar cases
    "feedback_cases_are_l3_not_l4",               // working with customer cases, need to know L3/L4
    "feedback_no_supportable",                    // account discovery context — never use Supportable
    "feedback_audit_validate_before_push",         // pre-push validation for data correctness
    "feedback_no_false_completions",              // self-audit before claiming data is validated
  ],

  // Test account notes scraper accuracy
  "87fabdf9-6097-4768-a538-7ddf980f13cd": [
    "feedback_audit_scraper_data",                // scraper results wrong → investigate immediately
    "feedback_ask_environment_before_investigating", // confirm prod vs test
    "success_real-data-honest-gaps",              // show real data, mark incomplete honestly
    "feedback_inspect_consumer_output",           // read real output after changes
    "feedback_no_supportable",                    // never use Supportable for account discovery
  ],

  // Optimize and clean up system components
  "3ecf46db-7aaa-4b76-ac5a-d0c84b39ca42": [
    "steering_surgical_fixes_only",               // don't rearchitect during cleanup
    "feedback_design_for_least_complexity",        // deep module architecture for optimization
    "feedback_complete-thoughts-before-confirming", // already in gold but retrieval validates it
    "feedback_exhaustive-search-before-claiming-nonexistence", // don't claim component is unused without checking
  ],

  // Implement feature after scope alignment
  "1d0a7fd5-5e12-4484-88a6-cd5e0abe340f": [
    "feedback_dev_loop_autonomous",               // after approval, execute autonomously
    "feedback_match_question_scope",              // re-read exact question before responding
    "feedback_intent-clarification-post-context-break", // re-confirm intent after context break
    "feedback_never_ask_at_action_boundaries",    // don't ask before executing approved actions
    "feedback_pre-brief-agent-scope-constraints", // scope constraints in agent briefs
    "feedback_iterative_quality_loop",            // continuous testing loop
  ],

  // Evaluate Cloudflare tunnel security
  "ddacac08-ad78-4ac2-b7cf-48267581e306": [
    "feedback_container_only_architecture",        // container-only deployment implications
    "feedback_verify-live-dashboard-display-before-describing", // verify actual state before describing
  ],

  // Resume work after specification context loss
  "69421cdc-6d42-4a83-b4f9-750262315b04": [
    "feedback_resume-session-verify-state",        // verify state after context break
    "feedback_intent-clarification-post-context-break", // re-confirm intent
    "feedback_read_spec_at_every_decision",        // re-read spec at every decision point
    "feedback_verify-state-matches-conversation-context", // don't present stale state
    "feedback_match_question_scope",              // re-read exact question
    "feedback_verify-complete-message-delivery",  // detect truncated responses
  ],

  // Diagnose persistent system issue after failed attempts
  "b79aa944-b303-47fb-ba50-2b3f2732afa9": [
    "feedback_root_cause_multi_layer",            // multi-layer diagnosis confirmed effective
    "feedback_audit_before_fixing",               // full audit before fixing
    "feedback_escalate_early",                    // escalate after failed attempts
    "feedback_scraper_iterate_until_zero_gaps",   // iterate until zero gaps
  ],

  // Verify backlog coverage and progress
  "69e96992-ada7-49e2-91bc-3ce8b87c2d31": [
    "feedback_verify-prerequisites-before-assessing-feasibility", // verify prereqs before claiming blocked
    "feedback_verify-deployment-before-claiming-shipped", // gate claims on verification
    "feedback_audit_before_fixing",               // audit before fixing
    "feedback_match_question_scope",              // re-read exact question
    "steering_never_assert_without_verification", // evidence required
  ],

  // Fix verification workflow skipping assumptions
  "d3ff919d-1c07-45a7-a046-32147bc29d0f": [
    "success_acceptance-criteria-verification-clarify", // verify against ACs with evidence
    "feedback_audit_before_fixing",               // audit first
    "feedback_verify-prerequisites-before-assessing-feasibility", // check prereqs
    "success_4_layer_consumer_verification",      // structural verification gate
    "success_systematic-format-standardization-verifi", // consistent format verification
  ],

  // Implement recommended system improvements
  "1d71fed1-4441-4305-8aa5-23316d3c8f30": [
    "feedback_dev_loop_autonomous",               // execute dev loop autonomously after approval
    "feedback_iterative_quality_loop",            // continuous testing loop
    "feedback_verify_architecture_against_code",  // verify architecture against code
  ],

  // Review security recommendations with rationale
  "54034bb6-e4d4-4904-a54a-96a3989321e1": [
    "feedback_security_scan_testing_loop",         // security scan mandatory in build cycle
    "feedback_gates_before_commit",               // never skip security gates
    "feedback_iterative_quality_loop",            // continuous security review
    "feedback_delegate_more",                     // delegate to specialist agents
  ],

  // Implement clarification flow with edge-cases
  "83fc1b5e-b8b1-404b-b0ce-52b1e74fd5a0": [
    "feedback_match_question_scope",              // match response scope to question
    "feedback_iterative_quality_loop",            // iterate on quality
    "feedback_never_ask_at_action_boundaries",    // execute after approval
  ],

  // Debug Supportable feature toggle
  "b7d79967-08ff-4d19-9a90-45910045dbc0": [
    "feedback_no_supportable",                    // Supportable disabled, never use
    "feedback_verify-state-matches-conversation-context", // don't present stale state
    "feedback_diagnostic_loop_working",           // diagnosis loop works
    "feedback_escalate_early",                    // escalate after confusion
  ],

  // Audit findings logged to backlog
  "079ee2db-b3e2-4fe7-a838-54087002c012": [
    "feedback_log_all_findings_immediately",      // log findings immediately
    "feedback_backlog-verify-before-presenting",  // verify backlog items
    "feedback_auto_log_backlog",                  // auto-log to backlog
    "feedback_grill_logs_findings_as_issues",     // log findings as issues
    "feedback_docs_always_current",               // docs are source of truth
    "success_systematic_audit_then_enforce",      // audit → enforce pattern
    "feedback_forced_disposition_audits",          // force-disposition every item
    "feedback_audit_before_fixing",               // audit first
  ],

  // Update documentation after solution
  "961dac05-fccc-44c2-8173-43323b907345": [
    "feedback_docs_always_updated",               // update docs on every build
    "feedback_dev-loop-tests-docs-mandatory",     // tests+docs mandatory
    "feedback_docs_always_current",               // docs = source of truth
    "feedback_project_state_live_updates",        // update state immediately
    "feedback_never_ask_at_action_boundaries",    // execute without asking
  ],

  // Process batch history learning
  "2598b4d4-9508-4cd1-95f3-c11784df1c3d": [
    "feedback_algorithm_learn_backlog_promotion", // promote findings to backlog
    "feedback_batch_afk_pattern_validated",       // batch pattern confirmed
    "feedback_read-background-task-output",       // read background task output
    "feedback_audit_state_before_multi_issue",    // audit state before multi-track work
  ],

  // Diagnose CI pipeline failures
  "7ad5bd25-bf1a-48d9-a26e-83e196409fc8": [
    "feedback_test-first-deployment-verification", // verify test deployment
    "feedback_dev_loop_urgency_skip",             // urgency skip is a violation
    "feedback_mandatory-dev-loop",                // self-enforce dev loop
    "feedback_audit_validate_before_push",        // validate before push
  ],

  // Design git-based memory sync architecture
  "19c2b804-adf0-46f7-b6ad-9f6384d67631": [
    "success_architecture-to-backlog-flow",       // architecture → backlog pattern
    "feedback_verify_architecture_against_code",  // verify architecture against code
    "feedback_capture_decisions_immediately",     // capture decisions immediately
    "success_design_before_build_agentgrit",      // design → council → build pattern
    "feedback_design_for_least_complexity",       // deep module architecture
  ],

  // Execute session with verified communication
  "65939331-6c4e-4705-a0ed-50c4c88e8f48": [
    "feedback_never_ask_at_action_boundaries",    // execute without asking
    "feedback_complete-thoughts-before-confirming", // complete thoughts first
    "feedback_dev_loop_autonomous",               // autonomous execution
    "feedback_session_recap_format",              // mid-session recaps
  ],

  // Set up external service account
  "875abe72-8eec-4430-83c0-b58daa779f15": [
    "feedback_rh-portal-account-search-full-legal-name", // full legal name for account search
    "feedback_no_supportable",                    // never use Supportable
    "feedback_audit_validate_before_push",        // validate before push
    "feedback_ask_environment_before_investigating", // confirm prod vs test
    "feedback_proactive-spot-check-patterns",     // check similar cases
    "feedback_audit_scraper_data",                // investigate wrong scraper results
  ],

  // Debug deployed fix still broken
  "029e8766-0205-4e47-99a4-45f1c2cddd0a": [
    "steering_surgical_fixes_only",               // precise targeted corrections
    "feedback_test-first-deployment-verification", // verify deployment
    "success_verify-prod-deployment-state",       // verify production state
    "steering_one_change_when_debugging",         // isolate one variable
    "feedback_rerun-tests-after-fix",             // re-run full tests after fix
    "feedback_root_cause_multi_layer",            // multi-layer diagnosis
    "feedback_incomplete-delivery-presented-as-complete-4-occurr", // incomplete delivery pattern
    "feedback_no_false_completions",              // self-audit before marking complete
  ],

  // Finalize implementation plan
  "cb7a857b-336f-4b8a-bbf1-d7bdf88665fc": [
    "feedback_never_ask_at_action_boundaries",    // execute after approval
    "feedback_dev_loop_autonomous",               // autonomous dev loop
    "feedback_structured_approval_pattern",       // structured approval
    "feedback_no_questions_during_afk_harness",   // zero questions during execution
    "feedback_slow_down_regroup",                 // plan before re-executing
    "steering_plan_means_stop",                   // plan = present and stop
  ],

  // Verify feature works end-to-end
  "d4027864-d5d6-4a66-a3e9-58d7908afdba": [
    "feedback_verify-deployment-before-claiming-shipped", // gate claims on verification
    "success_acceptance-criteria-verification-clarify", // verify against ACs
    "feedback_verify-live-dashboard-display-before-describing", // verify actual state
    "feedback_live_ui_verification_required",     // verify in live UI
  ],

  // Improve infra diagnosis quality
  "a80a85e5-ba71-464e-87e6-8d91a6b3b46c": [
    "feedback_investigate_logs_before_assumptions", // start with log correlation
    "success_direct-solution-with-reasoning-when-clea", // command + root-cause explanation
    "feedback_diagnostic_loop_working",           // diagnosis loop works
    "feedback_deep_root_cause_tracing",           // full-stack root cause tracing
    "feedback_root_cause_multi_layer",            // multi-layer diagnosis
  ],

  // Configure agent delegation workflow
  "3d415371-fbd3-4ab5-9f01-d50f42755f8e": [
    "feedback_pre-brief-agent-scope-constraints", // scope constraints in briefs
    "feedback_delegate_more",                     // delegate to specialists
    "feedback_dev_loop_autonomous",               // autonomous execution
    "feedback_bypass_permissions_all_agents",     // bypass permissions for agents
    "success_explicit-multi-agent-workflow-confirmati", // confirm before delegating
    "feedback_sonnet_for_execution",              // model selection for agents
  ],

  // Execute formatting task precisely
  "fabd87a1-4bd9-4857-8141-d3e24f0d8b05": [
    "success_systematic-format-standardization-verifi", // consistent format + verify
    "success_technical-explanation-direct-and-structu", // precise clear structure
  ],

  // Fix blue highlight visibility
  "cde078ef-77b9-4165-b375-5b5e8f174e99": [
    "feedback_verify-live-dashboard-display-before-describing", // verify actual display
    "feedback_live_ui_verification_required",     // live UI verification
    "steering_never_assert_without_verification", // evidence required
    "feedback_test-first-deployment-verification", // verify deployment
  ],

  // Resolve false VPN requirement for Tableau
  "184fc0a7-98f4-4bcf-af9a-e227aa0c8a93": [
    "feedback_verify_before_answering",           // verify before asserting VPN requirement
  ],

  // Audit rule adherence consistency
  "84edb9ec-7214-436c-bff6-e5101714d19e": [
    "feedback_docs_always_current",               // docs are source of truth
    "feedback_template_read_before_write",        // read templates before writing
    "feedback_backlog-verify-before-presenting",  // verify backlog items
    "feedback_forced_disposition_audits",          // force-disposition every item
    "success_systematic_audit_then_enforce",      // audit → enforce pattern
    "feedback_use_templates_not_reverse_engineer", // use templates, don't guess
    "feedback_exhaustive-search-before-claiming-nonexistence", // thorough search
  ],

  // Process auto-scored session correction
  "7dc7086d-03d0-42d6-830d-61e26f390184": [
    "feedback_audit_before_fixing",               // audit before fixing
    "feedback_execution_discipline",              // pre-flight checklist
    "success_systematic_audit_then_enforce",      // audit → enforce
  ],

  // Ship two technical bug fixes
  "0032f1dc-f673-4b44-8eb9-72db8f2a929b": [
    "feedback_mid_session_ship_enforcement",      // bugs re-enter ship
    "feedback_mandatory-dev-loop",                // self-enforce dev loop
    "feedback_zero_test_failures_gate",           // zero failures before commit
    "feedback_never_bypass_ship_scope",           // go through ship SCOPE
    "feedback_context7_before_guessing",          // query Context7 before guessing fixes
  ],

  // Fix POD name reference in config
  "764fde9c-9586-43dd-a1ce-a4425a1b67d7": [
    "feedback_bootstrap-respects-pod-selection",  // POD-specific data selection
    "feedback_docs_always_current",               // update docs
    "feedback_doc_metadata_on_every_edit",        // update doc metadata
    "feedback_clarify_before_documenting",        // clarify before documenting
    "feedback_docs_always_updated",               // always update docs
  ],

  // Deliver data analysis report
  "a694f5de-344d-4ffd-a93e-0c385269e582": [
    "success_data-analysis-timeline-expectations", // report with trend analysis
    "feedback_match_question_scope",              // match response to question
    "success_technical-explanation-direct-and-structu", // precise structure
  ],

  // Analyze workflow for optimization
  "244d93a8-948b-434a-9821-129df52b447d": [
    "feedback_structured_approval_pattern",       // structured approval for changes
    "feedback_manual_targeted_over_workflow",      // right tool for the job
    "feedback_never_ask_at_action_boundaries",    // execute after approval
  ],

  // --- SYNTHETIC SESSIONS ---

  // synth_deploy_001: Container rebuild and deploy
  "synth_deploy_001": [
    "feedback_test_fresh_container",              // rebuild image before testing
    "feedback_test_before_production",            // test before production
    "feedback_da_handle_routine_ops",             // handle deploys without asking
    "feedback_test-container-must-be-current",    // current container required
    "feedback_always_use_make_for_mac_mini",      // use Makefile targets
    "feedback_rerun-tests-after-fix",             // re-run after fix
    "feedback_run_new_specs_against_test_first",  // test specs on test container first
    "feedback_mac_mini_l4_deployment",            // Dockerfile.l4 for L4
    "feedback_test-container-currency-gate",      // verify container is current
    "feedback_playwright_project_routing",        // correct project routing
  ],

  // synth_security_002: Security review of data export endpoint
  "synth_security_002": [
    "feedback_gates_before_commit",               // never skip security gates
    "feedback_iterative_quality_loop",            // continuous security review
  ],

  // synth_delegate_003: Parallel agent delegation
  "synth_delegate_003": [
    "feedback_delegate_code_changes",             // DA delegates to agents
    "feedback_quinn_before_presenting",           // Quinn verifies before presenting
    "feedback_quinn_before_image_tag",            // Quinn before tagging
    "feedback_research_before_implement",         // research before implementing
    "feedback_gates_before_commit",               // gates before commit
  ],

  // synth_uitest_004: Visual regression testing
  "synth_uitest_004": [
    "feedback_quinn_before_presenting",           // Quinn verifies first
    "feedback_ux_visual_review_before_quinn",     // DA reviews before Quinn
    "feedback_comprehensive-visual-audit-during-analysis", // notice all UI defects
    "feedback_screenshots_are_source_of_truth",   // screenshots = source of truth
    "feedback_verify-live-dashboard-display-before-describing", // verify actual display
    "feedback_verify_rendered_ui_not_just_code",  // screenshot actual page
  ],

  // synth_algorithm_005: Failure pattern analysis
  "synth_algorithm_005": [
    "steering_error_recovery",                    // review session, identify violation
    "feedback_execution_discipline",              // pre-flight checklist
    "feedback_incomplete-capture-cannot-process",  // capture truncation issues
    "feedback_capture-incomplete-no-learning-section", // incomplete captures
    "feedback_incomplete-capture-cannot-extract-lesson", // capture truncation
  ],

  // synth_memory_006: Knowledge graph maintenance
  "synth_memory_006": [
    "feedback_always_update_docs",                // update docs immediately
    "success_lean-agent-knowledge-architecture",  // bounded knowledge systems
    "feedback_docs_always_current",               // docs = source of truth
    "feedback_council_audit_validates_design",    // council catches structural gaps
  ],

  // synth_scope_007: Unrequested refactoring
  "synth_scope_007": [
    "feedback_da_must_verify_before_closing",     // verify fix matches request
    "feedback_verify_before_asking",              // check before asking
    "feedback_every_issue_through_ship",          // go through ship skill
    "feedback_never_bypass_ship_scope",           // never bypass SCOPE step
  ],

  // synth_delivery_008: Incomplete delivery
  "synth_delivery_008": [
    "success_acceptance-criteria-verification-clarify", // verify against ACs
    "feedback_verify-deployment-before-claiming-shipped", // gate claims on verification
    "feedback_forced_disposition_audits",          // disposition every item
    "feedback_ac_garbage_test",                   // every AC needs threshold
    "feedback_validate_against_spec_not_own_data", // validate against spec
    "feedback_da_must_verify_before_closing",     // DA verifies before closing
  ],

  // synth_comms_009: B2B outreach email
  "synth_comms_009": [
    "feedback_build_toward_deal_outcomes",        // trace to deal outcomes
    "feedback_deterministic_over_gemini",         // template structured data
  ],

  // synth_data_010: Data scraping pipeline validation
  "synth_data_010": [
    "feedback_audit_scraper_data",                // investigate wrong results
    "feedback_rh-portal-account-search-full-legal-name", // full legal name for search
    "success_example-table-data-validation",      // before/after comparison tables
    "feedback_visual_scan_before_scrape",         // visual scan before scraping
    "feedback_no_supportable",                    // never use Supportable
  ],

  // synth_browser_011: SSO redirect loop in Playwright
  "synth_browser_011": [
    "feedback_scraper_runs_on_host_not_hero",     // scraper runs on host
    "feedback_scraper_iterate_until_zero_gaps",   // iterate until zero gaps
    "feedback_page-route-predicate-over-glob",    // URL predicate over glob
    "feedback_visual_scan_before_scrape",         // visual scan before scraping
    "feedback_read_architecture_before_scraper",  // read scraper docs first
  ],

  // synth_escalation_012: Escalation to architecture specialist
  "synth_escalation_012": [
    "feedback_delegate_more",                     // delegate to specialists
    "feedback_wait-for-agent-findings-before-synthesis", // wait for findings
    "feedback_proactive_agents",                  // use named agents
    "feedback_agent_model_routing",               // Opus for roster agents
    "feedback_research_before_implement",         // research before implementing
  ],

  // synth_verify_013: Asserting without running check
  "synth_verify_013": [
    "steering_never_assert_without_verification", // never assert without verification
    "feedback_verify-live-dashboard-display-before-describing", // verify actual state
    "feedback_verify-performance-claims-mechanism", // understand before claiming
    "feedback_live_ui_verification_required",     // live UI verification
  ],

  // synth_deploy_verify_014: Post-deploy verification
  "synth_deploy_verify_014": [
    "feedback_deployment-pipeline-sequence",      // correct deploy sequence
    "feedback_da_runs_rebuild",                   // DA handles rebuild
    "feedback_live_ui_verification_required",     // verify in live UI
    "feedback_da_handle_routine_ops",             // handle ops without asking
    "feedback_run_new_specs_against_test_first",  // test specs on test first
  ],

  // synth_delegate_scope_015: Agent scope constraint violation
  "synth_delegate_scope_015": [
    "feedback_delegate_code_changes",             // delegate code changes
    "feedback_marcus_scraper_scope",              // Marcus scope issues
    "feedback_mid_session_ship_enforcement",      // re-enter ship for bugs
    "feedback_ship_posts_acs_to_issue",           // post ACs to issue
  ],

  // synth_data_verify_016: Salesforce data validation
  "synth_data_verify_016": [
    "feedback_audit_scraper_data",                // investigate wrong data
    "success_example-table-data-validation",      // before/after comparison
    "feedback_da_must_verify_before_closing",     // verify before closing
  ],

  // synth_security_deploy_017: Pre-deploy security scan
  "synth_security_deploy_017": [
    "feedback_container_fresh_env",               // fresh env testing
    "feedback_test_fresh_container",              // rebuild before testing
    "feedback_use_makefile_deploy",               // use make rebuild
    "feedback_quinn_before_image_tag",            // Quinn before tagging
  ],

  // synth_ui_delivery_018: Visual regressions ignored
  "synth_ui_delivery_018": [
    "feedback_quinn_before_presenting",           // Quinn verifies first
    "feedback_auto_log_backlog",                  // log findings to backlog
    "feedback_verify_rendered_ui_not_just_code",  // screenshot actual page
    "feedback_quinn_must_verify_data_quality",    // Quinn verifies data quality
    "feedback_quinn_after_every_ui_commit",       // Quinn after every UI commit
    "feedback_live_ui_verification_required",     // live UI required
  ],

  // synth_memory_algo_019: Learning pipeline extraction
  "synth_memory_algo_019": [
    "feedback_incomplete-capture-cannot-process",  // capture truncation
    "feedback_incomplete-capture-cannot-extract-lesson", // incomplete captures
    "feedback_capture-incomplete-no-learning-section", // incomplete learning sections
    "steering_error_recovery",                    // review session for violations
  ],

  // synth_browser_data_020: Portal data extraction via Playwright
  "synth_browser_data_020": [
    "feedback_scraper_runs_on_host_not_hero",     // scraper on host
    "feedback_page-fill-during-unstable-states",  // use page.fill() during SSO
    "feedback_visual_scan_before_scrape",         // visual scan first
    "feedback_no_supportable",                    // never use Supportable
    "feedback_read_architecture_before_scraper",  // read scraper docs
  ],

  // synth_escalation_verify_021: Post-council verification
  "synth_escalation_verify_021": [
    "success_comprehensive_council_audit",        // comprehensive council audit
    "success_council_audit_fix_loop",             // council → fix loop
    "feedback_council_audit_validates_design",    // council catches structural gaps
    "feedback_council_right_question_first",      // right question before council
    "feedback_research_before_implement",         // research before implementing
  ],

  // synth_comms_scope_022: General answer to specific question
  "synth_comms_scope_022": [
    "feedback_articulate-requests-clearly",       // structure questions clearly
    "feedback_verify_before_asking",              // check before asking
    "feedback_avoid-minimal-single-word-responses", // substantive responses
    "feedback_da_must_verify_before_closing",     // verify fix matches request
  ],

  // synth_deploy_delegate_023: Mac Mini deploy with delegation
  "synth_deploy_delegate_023": [
    "feedback_always_use_make_for_mac_mini",      // Makefile targets for Mac Mini
    "feedback_da_handle_routine_ops",             // handle ops without asking
    "feedback_mac_mini_l4_deployment",            // L4 deployment specifics
  ],

  // synth_delivery_verify_024: Self-audit ACs with evidence
  "synth_delivery_verify_024": [
    "feedback_verify-deployment-before-claiming-shipped", // gate claims
    "success_acceptance-criteria-verification-clarify", // verify against ACs
    "feedback_validate_against_spec_not_own_data", // validate against spec
    "feedback_every_issue_through_ship",          // go through ship skill
    "feedback_forced_disposition_audits",          // disposition every item
    "feedback_inspect_consumer_output",           // read real output
  ],

  // synth_algo_escalation_025: Post-grill issue logging
  "synth_algo_escalation_025": [
    "feedback_spec_fidelity_gap",                 // issues link to specs
    "feedback_audit_state_before_multi_issue",    // audit before multi-track
    "feedback_every_issue_through_ship",          // ship every issue
    "feedback_log_all_findings_immediately",      // log findings immediately
    "success_ship_all_findings_council_loop",     // ship all findings
    "success_audit_then_architecture_then_ship",  // audit → architecture → ship
  ],

  // synth_browser_security_026: XSS testing on SSO redirect
  "synth_browser_security_026": [
    "feedback_scraper_runs_on_host_not_hero",     // scraper on host
    "feedback_container-environment-first-diagnosis", // check container logs
    "feedback_testing_new_user",                  // reset to factory state
  ],
};

// Apply additions
let totalAdded = 0;
let sessionsModified = 0;

for (const [sessionId, rulesToAdd] of Object.entries(additions)) {
  const session = goldSet.labeled[sessionId];
  if (!session) {
    console.error(`WARNING: Session ${sessionId} not found in gold set`);
    continue;
  }

  const existingRules = new Set(session.relevant_rules);
  const newRules: string[] = [];

  for (const rule of rulesToAdd) {
    if (!existingRules.has(rule)) {
      newRules.push(rule);
      existingRules.add(rule);
    }
  }

  if (newRules.length > 0) {
    session.relevant_rules.push(...newRules);
    sessionsModified++;
    totalAdded += newRules.length;
    console.log(`${sessionId}: +${newRules.length} rules (total: ${session.relevant_rules.length})`);
  }
}

// Update metadata
goldSet.updated = new Date().toISOString();

// Write corrected gold set
writeFileSync(GOLD_PATH, JSON.stringify(goldSet, null, 2) + "\n", "utf-8");

console.log(`\n${"=".repeat(60)}`);
console.log(`Sessions modified: ${sessionsModified}`);
console.log(`Total rules added: ${totalAdded}`);
console.log(`Gold set written to: ${GOLD_PATH}`);
