use crate::{CommandResult, ProofArgs, ProveArgs, RunArgs, TaskCommand, api::Api, config, session};
use anyhow::{bail, ensure};
use serde_json::{Value, json};

pub fn run_program(args: RunArgs) -> CommandResult {
    let id = args.session;
    let (proof_session, lock) = session::open(id)?;
    let config = config::load()?;
    if proof_session.runs_used >= config.max_run_attempts {
        return exhausted("run", proof_session.runs_used, config.max_run_attempts);
    }
    let api = Api::new(&config)?;
    drop(lock);
    let upload = api.prepare_run(&proof_session.project_root, args)?;
    let (mut proof_session, lock) = session::open(id)?;
    if proof_session.runs_used >= config.max_run_attempts {
        return exhausted("run", proof_session.runs_used, config.max_run_attempts);
    }
    let evidence = crate::api::record_request(&upload, &proof_session, "run")?;
    let response = api.submit_run(&upload)?;
    proof_session.runs_used += 1;
    session::save(&proof_session)?;
    crate::api::record_submission(&response, &evidence)?;
    drop(lock);
    let task = api.complete(
        &response,
        config.poll_interval_seconds,
        evidence.clone(),
        &proof_session,
    )?;
    finish(
        &proof_session,
        task,
        evidence,
        session::budget(proof_session.runs_used, config.max_run_attempts),
    )
}

pub fn validate(args: ProofArgs) -> CommandResult {
    let id = args.session;
    let (proof_session, lock) = session::open(id)?;
    let root = session::workspace(&proof_session);
    let config = config::load()?;
    if proof_session.validations_used >= config.max_validation_attempts {
        return exhausted(
            "validation",
            proof_session.validations_used,
            config.max_validation_attempts,
        );
    }
    let api = Api::new(&config)?;
    drop(lock);
    let upload = api.prepare_proof(&root, args, None)?;
    let (mut proof_session, lock) = session::open(id)?;
    if proof_session.validations_used >= config.max_validation_attempts {
        return exhausted(
            "validation",
            proof_session.validations_used,
            config.max_validation_attempts,
        );
    }
    let evidence = crate::api::record_request(&upload, &proof_session, "validate")?;
    let response = api.submit_validation(&upload)?;
    proof_session.validations_used += 1;
    session::save(&proof_session)?;
    crate::api::record_submission(&response, &evidence)?;
    drop(lock);
    let task = api.complete(
        &response,
        config.poll_interval_seconds,
        evidence.clone(),
        &proof_session,
    )?;
    finish(
        &proof_session,
        task,
        evidence,
        session::budget(
            proof_session.validations_used,
            config.max_validation_attempts,
        ),
    )
}

pub fn prove(args: ProveArgs) -> CommandResult {
    let id = args.proof.session;
    let (proof_session, lock) = session::open(id)?;
    let root = session::workspace(&proof_session);
    let config = config::load()?;
    if proof_session.attempts_used >= config.max_proof_attempts {
        return exhausted(
            "proof",
            proof_session.attempts_used,
            config.max_proof_attempts,
        );
    }
    let api = Api::new(&config)?;
    drop(lock);
    let upload = api.prepare_proof(&root, args.proof, args.depth)?;
    let (mut proof_session, lock) = session::open(id)?;
    if proof_session.attempts_used >= config.max_proof_attempts {
        return exhausted(
            "proof",
            proof_session.attempts_used,
            config.max_proof_attempts,
        );
    }
    let evidence = crate::api::record_request(&upload, &proof_session, "prove")?;
    let response = api.submit_proof(&upload)?;
    proof_session.attempts_used += 1;
    session::save(&proof_session)?;
    crate::api::record_submission(&response, &evidence)?;
    drop(lock);
    let task = api.complete(
        &response,
        config.poll_interval_seconds,
        evidence.clone(),
        &proof_session,
    )?;
    finish(
        &proof_session,
        task,
        evidence,
        session::budget(proof_session.attempts_used, config.max_proof_attempts),
    )
}

pub fn task(command: TaskCommand) -> CommandResult {
    let config = config::load()?;
    let api = Api::new(&config)?;
    match command {
        TaskCommand::List {
            status,
            before,
            limit,
        } => Ok((0, api.tasks(status.as_deref(), before.as_deref(), limit)?)),
        TaskCommand::Show { id } => Ok((0, json!({"task": api.task(&id.to_string())?}))),
        TaskCommand::Cancel { id } => {
            let result = api.cancel_task(&id.to_string())?;
            let exit = i32::from(result["cancellation"]["cancellationConfirmed"] != true);
            Ok((exit, result))
        }
        TaskCommand::Wait {
            id,
            session: session_id,
        } => {
            let proof_session = session::load(session_id)?;
            let root = proof_session.project_root.join(".intent/runs");
            crate::storage::intent(&proof_session.project_root, false)?;
            crate::storage::safe_parent(&proof_session.project_root, &root)?;
            let id = id.to_string();
            for entry in std::fs::read_dir(&root)? {
                let entry = entry?;
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                let request_path = entry.path().join("request.json");
                let result_path = entry.path().join("result.json");
                if crate::storage::safe_parent(&proof_session.project_root, &request_path).is_err()
                    || crate::storage::safe_parent(&proof_session.project_root, &result_path)
                        .is_err()
                {
                    continue;
                }
                let Some(manifest) = std::fs::read(&request_path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                else {
                    continue;
                };
                if manifest["session_id"] != proof_session.session_id.to_string() {
                    continue;
                }
                let (used, limit) = match manifest["operation"].as_str() {
                    Some("prove") => (proof_session.attempts_used, config.max_proof_attempts),
                    Some("validate") => (
                        proof_session.validations_used,
                        config.max_validation_attempts,
                    ),
                    Some("run") => (proof_session.runs_used, config.max_run_attempts),
                    _ => continue,
                };
                let evidence = entry.path();
                let Some(snapshot) = std::fs::read(&result_path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                else {
                    continue;
                };
                let accepted = &snapshot["task"];
                if accepted["id"] != id {
                    continue;
                }
                ensure!(
                    accepted["semantics"]["id"] == proof_session.semantics.id
                        && accepted["semantics"]["commit"] == proof_session.semantics.commit,
                    "Saved task semantics identity is missing or mismatched"
                );
                let task = api.complete(
                    accepted,
                    config.poll_interval_seconds,
                    evidence.clone(),
                    &proof_session,
                )?;
                return finish(&proof_session, task, evidence, session::budget(used, limit));
            }
            bail!(
                "Task {id} has no saved evidence in session {session_id}; use task show to inspect its server state"
            )
        }
    }
}

fn finish(
    proof_session: &session::Session,
    task: Value,
    evidence: std::path::PathBuf,
    budget: Value,
) -> CommandResult {
    let tool_runs = task.get("toolRuns").and_then(Value::as_array);
    let last_run = tool_runs.and_then(|runs| runs.last());
    let exit = last_run
        .and_then(|run| run.get("exitCode"))
        .and_then(Value::as_i64)
        .and_then(|code| i32::try_from(code).ok());
    let timed_out = task["status"] == "timed_out"
        || last_run.and_then(|run| run["outcome"].as_str()) == Some("timeout");
    // The Intent Check service can reuse a completed result without executing a tool in this task.
    let completed_without_run = tool_runs.is_some_and(Vec::is_empty)
        && task["status"] == "completed"
        && !task["result"].is_null()
        && task["error"].is_null();
    let mut response = json!({"task": task, "sessionId": proof_session.session_id,
        "budget": budget, "evidenceDir": evidence});
    let manifest: Value = serde_json::from_slice(&std::fs::read(evidence.join("request.json"))?)?;
    if let Some(id) = manifest["proof_attempt_id"].as_str() {
        response["proofDir"] = json!(proof_session.project_root.join(".intent/proofs").join(id));
    }
    if exit.is_none() {
        response["exitCode"] = Value::Null;
        if !completed_without_run {
            let error = if timed_out {
                "Intent Check service task timed out."
            } else {
                "Backend did not provide a final tool exit code."
            };
            response["error"] = json!(error);
        }
    }
    Ok((exit.unwrap_or(i32::from(!completed_without_run)), response))
}

fn exhausted(phase: &str, used: u32, limit: u32) -> CommandResult {
    Ok((
        20,
        json!({"status": "exhausted", "phase": phase,
        "budget": session::budget(used, limit),
        "message": "Attempt limit reached; stop and ask the user for help"}),
    ))
}
