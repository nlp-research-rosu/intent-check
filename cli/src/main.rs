mod api;
mod auth;
mod config;
mod help;
mod inputs;
mod semantics;
mod session;
mod workflow;

use clap::{Args, Parser, Subcommand};
use serde_json::{Value, json};
use std::{path::PathBuf, process};
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "intent-check", version, about = "intent-check CLI for the remote Intent Check service", after_help = help::ROOT)]
struct Cli {
    /// Project directory; automatically uses its repository root when inside a repo.
    #[arg(long, global = true)]
    project: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Connect this machine in the browser; save the credential without displaying it.
    #[command(after_help = help::LOGIN)]
    Login,
    /// Show the effective configuration and its file location.
    #[command(after_help = help::CONFIG)]
    Config,
    /// Check whether the configured Intent Check service is healthy.
    #[command(after_help = help::HEALTH)]
    Health,
    /// List supported language definitions and their versions.
    #[command(after_help = help::SEMANTICS)]
    Semantics {
        #[command(subcommand)]
        command: Option<SemanticsCommand>,
    },
    /// Execute a program using a supported language definition.
    #[command(after_help = help::RUN)]
    Run(RunArgs),
    /// Check verification inputs without proving their claims.
    #[command(after_help = help::validate())]
    Validate(ProofArgs),
    /// Create or inspect explicit verification sessions.
    #[command(subcommand)]
    Session(SessionCommand),
    /// Inspect or recover accepted server tasks without resubmitting them.
    #[command(subcommand, after_help = help::TASK)]
    Task(TaskCommand),
    /// Submit one proof attempt in an existing session.
    #[command(after_help = help::prove())]
    Prove(ProveArgs),
}

#[derive(Subcommand)]
enum SemanticsCommand {
    /// Download reference sources for a supported language definition.
    #[command(after_help = help::SEMANTICS_FETCH)]
    Fetch {
        /// Stable semantics ID returned by intent-check semantics.
        id: String,
    },
}

#[derive(Args)]
pub struct RunArgs {
    /// Session ID; resolves the project and pinned semantics.
    #[arg(long)]
    pub session: Uuid,
    /// Optional ID assertion; defaults to the session's pinned semantics.
    #[arg(long)]
    pub semantics: Option<String>,
    /// Program file to execute, relative to the session's project directory.
    #[arg(long)]
    pub program: PathBuf,
}

#[derive(Subcommand)]
enum SessionCommand {
    /// Create a new session with fresh budgets for the project.
    #[command(after_help = help::SESSION)]
    Start {
        /// Server-supported semantics ID to pin for this session.
        #[arg(long)]
        semantics: String,
    },
    /// Inspect a session without changing its state.
    Show { id: Uuid },
}

#[derive(Subcommand)]
pub enum TaskCommand {
    /// List this account's tasks, newest first.
    #[command(after_help = help::TASK)]
    List {
        #[arg(long)]
        status: Option<String>,
        /// Pagination cursor from the previous page's last task.
        #[arg(long)]
        before: Option<String>,
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
    },
    /// Fetch a task's current server response without waiting.
    Show { id: Uuid },
    /// Resume waiting and save results in the task's original evidence folder.
    #[command(after_help = help::TASK)]
    Wait {
        id: Uuid,
        /// Existing local session that submitted this task.
        #[arg(long)]
        session: Uuid,
    },
    /// Request cancellation and check whether it is confirmed.
    #[command(after_help = help::TASK)]
    Cancel { id: Uuid },
}

#[derive(Args)]
pub struct ProofArgs {
    /// Session ID; resolves the project and pinned semantics.
    #[arg(long)]
    pub session: Uuid,
    /// Optional ID assertion; defaults to the session's pinned semantics.
    #[arg(long)]
    pub semantics: Option<String>,
    /// Specification file containing the claims, relative to workspaceDir.
    #[arg(long)]
    pub spec: PathBuf,
    /// Module containing the claims in the specification file.
    #[arg(long)]
    pub spec_module: String,
    /// Optional proof helper file; requires --verification-module.
    #[arg(long, requires = "verification_module")]
    pub verification: Option<PathBuf>,
    /// Module containing the optional proof helpers.
    #[arg(long, requires = "verification")]
    pub verification_module: Option<String>,
    /// Additional source dependency; repeat for every file, including indirect imports.
    ///
    /// Imports are not discovered automatically. --spec and --verification
    /// already include their files; pass every other local dependency with
    /// --source on each validate and prove command.
    ///
    /// Use paths relative to the session workspaceDir and keep all files inside
    /// inputs/. Upload paths omit inputs/ and preserve its subdirectories.
    /// Do not upload bundled semantics
    /// sources: the server provides them through --semantics.
    #[arg(long)]
    pub source: Vec<PathBuf>,
    /// Prove only this claim label; repeat for multiple labels.
    #[arg(long)]
    pub claim: Vec<String>,
    /// Skip this claim label; repeat for multiple labels.
    #[arg(long)]
    pub exclude_claim: Vec<String>,
    /// Accept this selected claim without proving it; repeat for multiple labels.
    ///
    /// The selected claim is admitted without proof. Claims using it must name it
    /// in [depends(...)]; a false trusted claim can make them pass. Record it
    /// as an assumption for the proof audit.
    /// See the claim-selection example below when combining trust and filtering.
    #[arg(long)]
    pub trusted: Vec<String>,
}

#[derive(Args)]
pub struct ProveArgs {
    /// Stop symbolic execution at this diagnostic depth.
    ///
    /// Bounds rewrite steps along each execution path, not time: one step can
    /// still diverge. The Intent Check service's execution limits apply. Compare stdout residuals
    /// at increasing depths to diagnose progress; remove this bound before
    /// claiming proof success.
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..))]
    pub depth: Option<u64>,
    #[command(flatten)]
    pub proof: ProofArgs,
}

pub type CommandResult = anyhow::Result<(i32, Value)>;

fn main() {
    let (exit, value) = dispatch(Cli::parse()).unwrap_or_else(|error| {
        (
            1,
            json!({"status": "failure", "message": error.to_string()}),
        )
    });
    println!("{}", serde_json::to_string(&value).unwrap());
    process::exit(exit);
}

fn dispatch(cli: Cli) -> CommandResult {
    if let Some(project) = cli.project {
        let project = session::project_root(&project)?;
        let id = match &cli.command {
            Command::Run(args) => Some(args.session),
            Command::Validate(args) => Some(args.session),
            Command::Prove(args) => Some(args.proof.session),
            Command::Task(TaskCommand::Wait { session, .. }) => Some(*session),
            _ => None,
        };
        if let Some(id) = id {
            anyhow::ensure!(
                session::load(id)?.project_root == project,
                "--project does not match the session project"
            );
        }
        std::env::set_current_dir(project)?;
    }
    match cli.command {
        Command::Login => auth::login(),
        Command::Config => Ok((0, config::view()?)),
        Command::Health => {
            let config = config::load()?;
            Ok((0, api::Api::new(&config)?.health()?))
        }
        Command::Semantics {
            command: Some(SemanticsCommand::Fetch { id }),
        } => Ok((0, semantics::fetch(&id)?)),
        Command::Semantics { command: None } => {
            let config = config::load()?;
            Ok((0, api::Api::new(&config)?.semantics()?))
        }
        Command::Run(args) => workflow::run_program(args),
        Command::Validate(args) => workflow::validate(args),
        Command::Session(SessionCommand::Start { semantics }) => session::start(&semantics),
        Command::Session(SessionCommand::Show { id }) => {
            Ok((0, session::view(&session::load(id)?)?))
        }
        Command::Prove(args) => workflow::prove(args),
        Command::Task(command) => workflow::task(command),
    }
}
