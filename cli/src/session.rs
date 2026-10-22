use crate::{CommandResult, config, semantics};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub session_id: Uuid,
    pub project_root: PathBuf,
    pub semantics: semantics::Identity,
    pub attempts_used: u32,
    pub validations_used: u32,
    #[serde(default)]
    pub runs_used: u32,
}

pub fn directory(id: Uuid) -> Result<PathBuf> {
    Ok(config::directory()?.join("sessions").join(id.to_string()))
}

pub fn workspace(session: &Session) -> PathBuf {
    session
        .project_root
        .join(".prover-client/sessions")
        .join(session.session_id.to_string())
}

pub fn start(semantics_id: &str) -> CommandResult {
    let session = Session {
        session_id: Uuid::new_v4(),
        project_root: current_root()?,
        semantics: semantics::select(semantics_id, &config::load()?)?,
        attempts_used: 0,
        validations_used: 0,
        runs_used: 0,
    };
    fs::create_dir_all(directory(session.session_id)?.parent().unwrap())?;
    fs::create_dir(directory(session.session_id)?)?;
    fs::create_dir_all(workspace(&session))?;
    save(&session)?;
    Ok((0, view(&session)?))
}

pub fn load(id: Uuid) -> Result<Session> {
    let session: Session = serde_json::from_slice(
        &fs::read(directory(id)?.join("session.json")).context("Unknown session ID")?,
    )?;
    ensure!(
        session.session_id == id,
        "Session ID does not match its directory"
    );
    Ok(session)
}

pub fn save(session: &Session) -> Result<()> {
    crate::api::write_json(
        &directory(session.session_id)?,
        "session.json",
        &serde_json::to_value(session)?,
    )
}

pub fn open(id: Uuid) -> Result<(Session, fs::File)> {
    let directory = directory(id)?;
    ensure!(directory.is_dir(), "Unknown session ID");
    let lock = lock(&directory)?;
    let session = load(id)?;
    ensure!(
        session.project_root.is_dir(),
        "Session project no longer exists"
    );
    Ok((session, lock))
}

pub fn current_root() -> Result<PathBuf> {
    Ok(std::env::current_dir()?.canonicalize()?)
}

pub fn lock(directory: &Path) -> Result<fs::File> {
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("lock"))?;
    file.lock()?;
    Ok(file)
}

pub fn view(session: &Session) -> Result<Value> {
    let mut value = serde_json::to_value(session)?;
    value["workspaceDir"] = json!(workspace(session));
    Ok(value)
}

pub fn budget(used: u32, limit: u32) -> Value {
    json!({"used": used, "limit": limit, "remaining": limit.saturating_sub(used)})
}
